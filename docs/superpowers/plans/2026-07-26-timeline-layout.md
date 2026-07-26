# Timeline Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pending-day/commit planning loop with a to-scale bottom timeline strip plus a right panel that holds only the focused day, so the trip is always visible, the map follows the day you're editing, and any single day can be edited without disturbing the rest of the plan.

**Architecture:** Days stay stored as lengths (`targetKm`), so there is **no storage schema change**; boundaries are cumulative sums and every edit is *local* (the neighbouring day absorbs the delta). New pure modules (`boundaries.js`, `strip-geometry.js`) hold the math so it is unit-testable without a DOM; `ui.js` becomes a thin facade over four focused render modules (`strip.js`, `day-panel.js`, `places.js`, `plans-bar.js`). `main.js` replaces four pieces of pending state with a single `focusedDayIndex`.

**Tech Stack:** Vite 8, vanilla ES modules, Leaflet 1.9, Turf 7, Vitest 4 (`environment: 'node'`, per-file `jsdom` for DOM tests).

**Spec:** `docs/superpowers/specs/2026-07-26-timeline-layout-design.md`

**Conventions this codebase already locks — do not change them:**
- Break/row identity is `name@km` (`breakKey`, `poiKey`, `townKey`); favorites alone use kind-prefixed `kind:name@km` (`favKey`).
- `ui.js` imports no data modules, no Leaflet, no Turf — `main.js` owns domain logic and passes plain values + callbacks in. New UI modules follow the same rule.
- `map.js` is the only module that touches Leaflet's `[lat, lng]` order; everything crossing its boundary is `[lng, lat]`.
- Escape every interpolated value with `esc()` — OSM names are untrusted.
- **Windows:** never edit source with PowerShell `Get-Content`/`Set-Content` (mojibake on BOM-less UTF-8 em dashes and emoji) — use the Edit/Write tools. Commit multi-line messages with `git commit -F <file>`, not `-m`.

**Run the suite with:** `npm test` (from `C:\Users\Michel\claude_shared\planner-app`). A single file: `npx vitest run src/boundaries.test.js`.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `src/boundaries.js` | create | Pure boundary math: `MIN_DAY_KM`, `boundaryBounds`, `clampBoundaryKm`. Shared by the model and the strip's live drag preview. |
| `src/boundaries.test.js` | create | Unit tests for the above. |
| `src/itinerary.js` | modify | Gains `moveBoundary`, `splitDay`, `deleteDay`; `editDay` becomes local; `setTownChoice` snaps. |
| `src/itinerary.test.js` | modify | Rewrites ripple assertions as local ones; adds coverage for the new operations. |
| `src/ui-util.js` | create | Shared render helpers moved out of `ui.js`: `esc`, `round1`, `townKey`, `poiKey`, `BREAK_GLYPH`, `FAV_GLYPH`, `debounce`. |
| `src/strip-geometry.js` | create | Pure km↔px mapping, block layout, label tiers, handle hit-testing. |
| `src/strip-geometry.test.js` | create | Unit tests for the above. |
| `src/strip.js` | create | The bottom timeline: render + pointer/keyboard interaction. Emits `onFocusDay`, `onMoveBoundary`, `onAddDay`. |
| `src/strip.test.js` | create | jsdom render + interaction tests. |
| `src/day-panel.js` | create | The focused day editor: distance, overnight, legs with `✎`/`×`, split, delete, focus stepper. |
| `src/day-panel.test.js` | create | jsdom render tests. |
| `src/places.js` | create | Left panel: favorites, overnight candidates, food, sights; row actions, hover↔marker wiring, 40-row cap. |
| `src/places.test.js` | create | jsdom render tests incl. the cap footer. |
| `src/plans-bar.js` | create | Header plans control (moved verbatim from `ui.js`). |
| `src/ui.js` | modify | Shrinks to a facade composing the four modules; keeps re-exporting `townKey`/`poiKey` (the cross-module key contract test imports them from here). |
| `src/main.js` | modify | `focusedDayIndex` replaces `pendingTarget`/`pendingTown`/`selectedDayIndex`/`customStopDraft`; owns the camera policy. |
| `src/map.js` | modify | Gains `focusRange`, `setRouteHighlight`, draggable boundary pins; loses `setGhost`. |
| `index.html` | modify | Four zones: header, left, map, right, plus the strip. |
| `src/style.css` | modify | Grid shell + strip styles; delete pending-block and day-mode rules. |
| `README.md` | modify | Describe the timeline loop instead of the slider/commit loop. |

---

## Task 1: Pure boundary math

**Files:**
- Create: `src/boundaries.js`
- Test: `src/boundaries.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/boundaries.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { MIN_DAY_KM, boundaryBounds, clampBoundaryKm } from './boundaries.js';

const TOTAL_KM = 650;

// Days as the itinerary exposes them: startKm/endKm already chained.
function days(...ends) {
  let prev = 0;
  return ends.map((endKm) => {
    const day = { startKm: prev, endKm };
    prev = endKm;
    return day;
  });
}

describe('MIN_DAY_KM', () => {
  it('is 5 km', () => {
    expect(MIN_DAY_KM).toBe(5);
  });
});

describe('boundaryBounds', () => {
  it('keeps the edited day and its neighbour at least MIN_DAY_KM long', () => {
    const list = days(80, 160, 240, 320);
    expect(boundaryBounds(list, 1, { totalKm: TOTAL_KM })).toEqual({ min: 85, max: 235 });
  });

  it('measures the first boundary from km 0', () => {
    const list = days(80, 160);
    expect(boundaryBounds(list, 0, { totalKm: TOTAL_KM })).toEqual({ min: 5, max: 155 });
  });

  it('lets the last boundary run to the end of the route', () => {
    const list = days(80, 160);
    expect(boundaryBounds(list, 1, { totalKm: TOTAL_KM })).toEqual({ min: 85, max: TOTAL_KM });
  });

  it('never returns a max below its min for a squeezed day', () => {
    // Days 0 and 1 together span only 8 km — less than 2 × MIN_DAY_KM — so the
    // raw window would be inverted (min 5, max 3). Anything wider than
    // 2 × MIN_DAY_KM leaves a valid window and never reaches the guard.
    const list = days(4, 8, 300);
    const bounds = boundaryBounds(list, 0, { totalKm: TOTAL_KM });
    expect(bounds.min).toBe(5);
    expect(bounds.max).toBe(bounds.min);
  });
});

describe('clampBoundaryKm', () => {
  it('passes a value inside the window through', () => {
    expect(clampBoundaryKm(days(80, 160, 240), 1, 200, { totalKm: TOTAL_KM })).toBe(200);
  });

  it('clamps to the upper bound', () => {
    expect(clampBoundaryKm(days(80, 160, 240), 1, 500, { totalKm: TOTAL_KM })).toBe(235);
  });

  it('clamps to the lower bound', () => {
    expect(clampBoundaryKm(days(80, 160, 240), 1, 10, { totalKm: TOTAL_KM })).toBe(85);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/boundaries.test.js`
Expected: FAIL — `Failed to resolve import "./boundaries.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/boundaries.js`:

```js
// Pure boundary math, shared by the itinerary model and the timeline strip's
// live drag preview. A plan's days are stored as lengths (targetKm); a
// *boundary* is where a day ends — the cumulative sum of lengths up to it.
//
// Editing is local: moving boundary i changes days i and i+1 only, so the rest
// of the trip (and every overnight town past it) stays put.

/** Shortest day we allow, in km. A boundary can never squeeze past this. */
export const MIN_DAY_KM = 5;

/**
 * The km window boundary `index` may be moved to.
 *
 * The lower bound keeps day `index` at least `minDayKm` long. The upper bound
 * keeps the NEXT day at least `minDayKm` long — except for the last boundary,
 * which has no next day and may run to the end of the route (moving it extends
 * or shrinks the plan itself).
 *
 * @param {Array<{startKm: number, endKm: number}>} days
 * @param {number} index - 0-based day index
 * @param {{totalKm: number, minDayKm?: number}} opts
 * @returns {{min: number, max: number}} - max is never below min, so a squeezed
 *   day yields a single legal position rather than an inverted window.
 */
export function boundaryBounds(days, index, { totalKm, minDayKm = MIN_DAY_KM } = {}) {
  const prevEnd = index === 0 ? 0 : days[index - 1].endKm;
  const isLast = index === days.length - 1;
  const min = prevEnd + minDayKm;
  const max = isLast ? totalKm : days[index + 1].endKm - minDayKm;
  return { min, max: Math.max(min, max) };
}

/** `km` clamped into boundaryBounds(days, index, opts). */
export function clampBoundaryKm(days, index, km, opts) {
  const { min, max } = boundaryBounds(days, index, opts);
  return Math.min(Math.max(km, min), max);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/boundaries.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/boundaries.js src/boundaries.test.js
git commit -m "feat: pure boundary math for local day editing"
```

---

## Task 2: `moveBoundary` and local `editDay`

**Files:**
- Modify: `src/itinerary.js`
- Test: `src/itinerary.test.js:51-90` (rewrite the `editDay` describe block), `src/itinerary.test.js:472-493` (one expectation)

- [ ] **Step 1: Write the failing test**

In `src/itinerary.test.js`, **replace the whole `describe('createItinerary - editDay', ...)` block** (currently lines 51-90) with:

```js
describe('createItinerary - moveBoundary', () => {
  it('moves one boundary and lets the next day absorb the delta', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addDay(80); // boundaries at 80 / 160 / 240 / 320

    itinerary.moveBoundary(2, 265);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });
    expect(days[1]).toMatchObject({ startKm: 80, endKm: 160 });
    expect(days[2]).toMatchObject({ startKm: 160, endKm: 265, targetKm: 105 });
    expect(days[3]).toMatchObject({ startKm: 265, endKm: 320, targetKm: 55 });
  });

  it('leaves days beyond the neighbour completely untouched', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    [80, 80, 80, 80, 80].forEach((km) => itinerary.addDay(km));
    // TOTAL_KM is 380 in this file, so day 4 is clamped from the start: {320, 380}.

    itinerary.moveBoundary(1, 130);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });    // before the boundary: still
    expect(days[2]).toMatchObject({ startKm: 130, endKm: 240 }); // the neighbour: absorbs the 30 km
    expect(days[3]).toMatchObject({ startKm: 240, endKm: 320 }); // beyond: untouched
    expect(days[4]).toMatchObject({ startKm: 320, endKm: 380 }); // beyond: untouched, still clamped
  });

  it('clamps so the edited day keeps MIN_DAY_KM', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.moveBoundary(0, 1);

    expect(itinerary.getDays()[0].endKm).toBe(5);
  });

  it('clamps so the neighbour keeps MIN_DAY_KM', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.moveBoundary(0, 300);

    const days = itinerary.getDays();
    expect(days[0].endKm).toBe(155);
    expect(days[1]).toMatchObject({ startKm: 155, endKm: 160, targetKm: 5 });
  });

  it('extends the plan when the last boundary moves out', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);

    itinerary.moveBoundary(0, 120);

    expect(itinerary.getDays()[0]).toMatchObject({ endKm: 120, targetKm: 120 });
    expect(itinerary.totalPlannedKm()).toBe(120);
  });

  it('clamps the last boundary to totalKm', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);

    itinerary.moveBoundary(0, TOTAL_KM + 100);

    expect(itinerary.getDays()[0].endKm).toBe(TOTAL_KM);
  });

  it('rounds to one decimal so stored lengths stay tidy', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80.1); // fractional, so the assignment-site rounding actually matters
    itinerary.addDay(80);

    itinerary.moveBoundary(0, 76.2345);

    const days = itinerary.getDays();
    expect(days[0].targetKm).toBe(76.2);
    expect(days[1].targetKm).toBe(83.9);
  });

  // Both of these pin the position-derived arithmetic above. A day clamped at
  // totalKm stores a targetKm larger than its span, and the earlier delta-based
  // version shrank that length without moving the boundary — so the first drag of
  // a day added near Dresden did nothing visible.
  it('moves the boundary on the first drag even when the stored length overshot the route', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(300);
    itinerary.addDay(200); // endKm clamps to 380 while targetKm stays 200

    itinerary.moveBoundary(1, 350);

    expect(itinerary.getDays()[1]).toMatchObject({ startKm: 300, endKm: 350, targetKm: 50 });
  });

  it("preserves the neighbour's end and normalises its inflated length", () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.hydrate([{ targetKm: 100 }, { targetKm: 400 }]); // day 1 clamped to {100, 380}

    itinerary.moveBoundary(0, 150);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ endKm: 150 });
    // 230 is day 1's real span. Normalising an inflated neighbour is intended, not
    // incidental: a drag is explicit intent on this boundary pair, unlike hydrate,
    // where the stored plan must survive intact for the route-changed banner.
    expect(days[1]).toMatchObject({ startKm: 150, endKm: TOTAL_KM, targetKm: 230 });
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(() => itinerary.moveBoundary(5, 50)).toThrow();
  });

  it('throws on a non-finite endKm', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(() => itinerary.moveBoundary(0, Number.NaN)).toThrow();
  });
});

describe('createItinerary - editDay (local, typed distance)', () => {
  it('sets the edited day length and lets the neighbour absorb it', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.editDay(0, 100);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 100, targetKm: 100 });
    expect(days[1]).toMatchObject({ startKm: 100, endKm: 160, targetKm: 60 });
    expect(days[2]).toMatchObject({ startKm: 160, endKm: 240, targetKm: 80 });
  });

  it('clamps a length that would starve the neighbour', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.editDay(0, 350);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 155 });
    expect(days[1]).toMatchObject({ startKm: 155, endKm: 160 });
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(() => itinerary.editDay(5, 50)).toThrow();
  });

  it('throws on an invalid targetKm', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(() => itinerary.editDay(0, -10)).toThrow();
  });
});
```

Then in `describe('createItinerary - break re-bucketing across day edits', ...)`, change the day-1 expectation — under local semantics day 1 absorbs the 20 km instead of sliding:

```js
    // Shorten day 0 to 60: day0 = (0,60], day1 = (60,160]; the break moves to day 1.
    itinerary.editDay(0, 60);
    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 60 });
    expect(days[1]).toMatchObject({ startKm: 60, endKm: 160 });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/itinerary.test.js`
Expected: FAIL — `itinerary.moveBoundary is not a function`, plus the `editDay` local expectations failing against today's ripple behaviour.

- [ ] **Step 3: Write minimal implementation**

In `src/itinerary.js`, add the import at the top of the file:

```js
import { clampBoundaryKm } from './boundaries.js';
```

Add this helper next to the existing `clamp` at the top:

```js
// Stored lengths are user-facing numbers that get persisted, so keep them at one
// decimal — snapping to a town at km 76.2345 must not write 76.2345 to storage.
function round1(n) {
  return Math.round(n * 10) / 10;
}
```

Add `moveBoundary` and replace `editDay` (currently lines 125-131):

```js
  // Moves the boundary at the END of days[index] to endKm. Local: the delta is
  // handed to the next day, so days beyond the neighbour never move. The last
  // boundary has no neighbour, so moving it extends or shrinks the plan — that
  // is the append/trim gesture.
  function moveBoundary(index, endKm) {
    assertValidIndex(index);
    if (typeof endKm !== 'number' || !Number.isFinite(endKm)) {
      throw new Error(`endKm must be a finite number, got: ${endKm}`);
    }
    const day = days[index];
    const target = clampBoundaryKm(days, index, endKm, { totalKm: total });
    // Rounded delta purely as the no-op guard: it absorbs sub-0.05 km drag jitter
    // that would otherwise rewrite lengths for no visible movement.
    if (round1(target - day.endKm) === 0) return toPublicDay(day, index);
    const next = days[index + 1];
    // Derive both lengths from the boundary POSITIONS rather than adding a delta
    // to the stored length. A day clamped at totalKm carries a targetKm larger
    // than its real span (addDay and hydrate both permit it), and a delta applied
    // to that inflated length shrinks it without moving the boundary — the drag
    // looks stuck until the overshoot burns off. Positions can't drift that way.
    const nextEnd = next ? next.endKm : null;
    day.targetKm = round1(target - day.startKm);
    if (next) next.targetKm = round1(nextEnd - target);
    recomputeFrom(index);
    return toPublicDay(days[index], index);
  }

  // The typed-distance path: setting a day's length is moving its boundary to
  // start + length, with the same local semantics and the same clamps.
  function editDay(index, targetKm) {
    assertValidIndex(index);
    assertValidTargetKm(targetKm);
    const startKm = index === 0 ? 0 : days[index - 1].endKm;
    return moveBoundary(index, startKm + targetKm);
  }
```

Add `moveBoundary` to the returned object (alongside `editDay`) and to the JSDoc `@returns` block:

```js
 *   moveBoundary: (index: number, endKm: number) => object,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all files. The `clamping`, `setTownChoice`, `removeLastDay`, `hydrate` and break describes are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/itinerary.js src/itinerary.test.js
git commit -F - <<'EOF'
feat: local boundary editing in the itinerary model

moveBoundary hands the delta to the neighbouring day, so editing one day no
longer rewrites every day after it. editDay keeps its name and becomes the
typed-distance path onto the same operation; its ripple tests are rewritten
deliberately.
EOF
```

---

## Task 3: `splitDay` and `deleteDay`

**Files:**
- Modify: `src/itinerary.js`
- Test: `src/itinerary.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/itinerary.test.js`:

```js
describe('createItinerary - splitDay', () => {
  it('splits a day in half, preserving the total', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(100);
    itinerary.addDay(80);

    itinerary.splitDay(0);

    const days = itinerary.getDays();
    expect(days).toHaveLength(3);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 50 });
    expect(days[1]).toMatchObject({ startKm: 50, endKm: 100 });
    expect(days[2]).toMatchObject({ startKm: 100, endKm: 180 });
  });

  it('gives the overnight town to the second half and none to the first', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(100);
    itinerary.setTownChoice(0, { name: 'Lenzen' });

    itinerary.splitDay(0);

    const days = itinerary.getDays();
    expect(days[0].townChoice).toBeNull();
    expect(days[1].townChoice).toEqual({ name: 'Lenzen' });
  });

  it('refuses to split a day shorter than two minimum days', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(9);

    expect(itinerary.splitDay(0)).toBeNull();
    expect(itinerary.getDays()).toHaveLength(1);
  });

  it('handles an odd length without losing a tenth of a km', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(75.5);

    itinerary.splitDay(0);

    const days = itinerary.getDays();
    expect(days[0].targetKm + days[1].targetKm).toBe(75.5);
    expect(days[1].endKm).toBe(75.5);
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    expect(() => itinerary.splitDay(0)).toThrow();
  });
});

describe('createItinerary - deleteDay', () => {
  it('merges a middle day into the next one and leaves the rest put', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    [80, 80, 80, 80].forEach((km) => itinerary.addDay(km));

    itinerary.deleteDay(1);

    const days = itinerary.getDays();
    expect(days).toHaveLength(3);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });
    expect(days[1]).toMatchObject({ startKm: 80, endKm: 240, targetKm: 160 });
    expect(days[2]).toMatchObject({ startKm: 240, endKm: 320 });
  });

  it('keeps the surviving day its overnight town', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.setTownChoice(1, { name: 'Lenzen' });

    itinerary.deleteDay(0);

    expect(itinerary.getDays()[0].townChoice).toEqual({ name: 'Lenzen' });
  });

  it('truncates the plan when the last day is deleted', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(60);

    itinerary.deleteDay(1);

    const days = itinerary.getDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });
  });

  it('empties the plan when the only day is deleted', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);

    itinerary.deleteDay(0);

    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('is the inverse of splitDay', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(100);
    itinerary.addDay(80);

    itinerary.splitDay(0);
    itinerary.deleteDay(0);

    const days = itinerary.getDays();
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 100, targetKm: 100 });
    expect(days[1]).toMatchObject({ startKm: 100, endKm: 180 });
  });

  it('keeps every break, re-bucketed across the merge', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addBreak(makeBreak({ name: 'Stop', routeDistanceKm: 70 }));

    itinerary.deleteDay(0);

    const day = itinerary.getDays()[0];
    expect(itinerary.getBreaks()).toHaveLength(1);
    expect(itinerary.breaksInRange(day.startKm, day.endKm).map((b) => b.name)).toEqual(['Stop']);
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(() => itinerary.deleteDay(3)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/itinerary.test.js`
Expected: FAIL — `itinerary.splitDay is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/itinerary.js`, add the import of `MIN_DAY_KM`:

```js
import { clampBoundaryKm, MIN_DAY_KM } from './boundaries.js';
```

Add both operations after `moveBoundary`, and make `removeLastDay` delegate:

```js
  // Inserts a boundary at the day's midpoint, turning one day into two that sum
  // to the original — so nothing downstream moves. The SECOND half keeps the
  // overnight town, because its end is where the original day ended (that is
  // still where you sleep); the new first half starts with none. Returns null
  // when the day is too short to split.
  function splitDay(index) {
    assertValidIndex(index);
    const day = days[index];
    const length = day.endKm - day.startKm;
    if (length < 2 * MIN_DAY_KM) return null;
    const first = round1(length / 2);
    const second = round1(length - first);
    days.splice(
      index,
      1,
      { targetKm: first, startKm: 0, endKm: 0, townChoice: null },
      { targetKm: second, startKm: 0, endKm: 0, townChoice: day.townChoice ?? null },
    );
    recomputeFrom(index);
    return toPublicDay(days[index], index);
  }

  // Removes the boundary at the END of days[index] by merging the day into the
  // next one, which keeps its own end — so the trip past it is untouched. The
  // last day has no next day, so deleting it truncates the plan. Breaks are
  // plan-level and re-bucket themselves from the new ranges.
  function deleteDay(index) {
    assertValidIndex(index);
    if (index === days.length - 1) {
      days.pop();
      return;
    }
    const next = days[index + 1];
    next.targetKm = round1(next.targetKm + days[index].targetKm);
    days.splice(index, 1);
    recomputeFrom(index);
  }

  function removeLastDay() {
    if (days.length) deleteDay(days.length - 1);
  }
```

Delete the old `removeLastDay` (the bare `days.pop()` version), and add both new names to the returned object and the JSDoc `@returns`:

```js
 *   splitDay: (index: number) => object|null,
 *   deleteDay: (index: number) => void,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. The existing `removeLastDay / reset` describe still passes through the delegation.

- [ ] **Step 5: Commit**

```bash
git add src/itinerary.js src/itinerary.test.js
git commit -m "feat: splitDay and deleteDay as local, inverse day operations"
```

---

## Task 4: Overnight towns snap the boundary

**Files:**
- Modify: `src/itinerary.js:133-137`
- Test: `src/itinerary.test.js` (extend the `setTownChoice` describe)

- [ ] **Step 1: Write the failing test**

Append to the existing `describe('createItinerary - setTownChoice', ...)` block in `src/itinerary.test.js`:

```js
  it('snaps the boundary to the chosen town and lets the neighbour absorb it', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.setTownChoice(0, { name: 'Boizenburg/Elbe', routeDistanceKm: 76.2, offsetKm: 0.33 });

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ endKm: 76.2, targetKm: 76.2 });
    expect(days[1]).toMatchObject({ startKm: 76.2, endKm: 160, targetKm: 83.8 });
  });

  it('clamps a snap that would starve the neighbour, keeping the town', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(8); // next boundary at km 88, so the upper clamp is 83

    itinerary.setTownChoice(0, { name: 'Too Close', routeDistanceKm: 86 });

    const days = itinerary.getDays();
    expect(days[0].endKm).toBe(83);
    // The panel derives its "stopped at" note from this mismatch.
    expect(days[0].townChoice.routeDistanceKm).toBe(86);
  });

  it('leaves the boundary alone for a town with no route position', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);

    itinerary.setTownChoice(0, { name: 'Nowhere' });

    expect(itinerary.getDays()[0].endKm).toBe(80);
  });

  it('leaves the boundary alone when the town choice is cleared', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.setTownChoice(0, { name: 'Boizenburg/Elbe', routeDistanceKm: 76.2 });

    itinerary.setTownChoice(0, null);

    const day = itinerary.getDays()[0];
    expect(day.townChoice).toBeNull();
    expect(day.endKm).toBe(76.2);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/itinerary.test.js`
Expected: FAIL — `expected 80 to be 76.2` on the first new test.

- [ ] **Step 3: Write minimal implementation**

Replace `setTownChoice` in `src/itinerary.js`:

```js
  // Choosing where you sleep is choosing where the day ends, so a town choice
  // snaps the boundary to the town's position along the route — a day's km then
  // means the distance you actually ride. The town's perpendicular offsetKm is
  // never folded in; the UI shows it separately. Snapping clamps like any
  // boundary move, and the day panel derives its "stopped at" note by comparing
  // townChoice.routeDistanceKm against endKm. Clearing a choice leaves the
  // boundary where it is.
  function setTownChoice(index, town) {
    assertValidIndex(index);
    days[index].townChoice = town ?? null;
    const km = town?.routeDistanceKm;
    if (typeof km === 'number' && Number.isFinite(km)) moveBoundary(index, km);
    return toPublicDay(days[index], index);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. The three original `setTownChoice` tests use towns without `routeDistanceKm`, so they are unaffected.

- [ ] **Step 5: Write the failing storage test**

Snapping is what first puts fractional lengths into storage, so pin the round-trip and the unchanged schema version. Append to `src/storage.test.js` — the double is the existing factory `createFakeStorage()` (do not add another), `PLANS_KEY` is already defined at the top of that file, and the persisted field is `schemaVersion`, not `version`:

```js
describe('createPlanStore - snapped fractional lengths', () => {
  it('round-trips a fractional targetKm through a save and reload', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'v1' });
    store.load();
    store.saveActivePlan({
      days: [
        { targetKm: 76.2, townChoice: { name: 'Boizenburg/Elbe', routeDistanceKm: 76.2 } },
        { targetKm: 83.8, townChoice: null },
      ],
      breaks: [],
    });

    const reloaded = createPlanStore({ storage, routeVersion: 'v1' });
    reloaded.load();
    const days = reloaded.getActivePlan().days;
    expect(days[0].targetKm).toBe(76.2);
    expect(days[1].targetKm).toBe(83.8);
  });

  it('still writes schema version 2 — the timeline work needs no migration', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'v1' });
    store.load();
    store.saveActivePlan({ days: [{ targetKm: 76.2, townChoice: null }], breaks: [] });

    expect(JSON.parse(storage.getItem(PLANS_KEY)).schemaVersion).toBe(2);
  });
});
```

The double, the key constant and the schema field name above were all checked against the real `src/storage.test.js` and `src/storage.js`. Do not add a second double.

- [ ] **Step 6: Run the storage tests**

Run: `npx vitest run src/storage.test.js`
Expected: PASS with no production change — `normalizeDay` already passes `targetKm` through untouched, and this is the regression guard proving no migration is needed.

- [ ] **Step 7: Commit**

```bash
git add src/itinerary.js src/itinerary.test.js src/storage.test.js
git commit -m "feat: overnight town choice snaps the day boundary to the town"
```

---

## Task 5: Extract shared render helpers

**Files:**
- Create: `src/ui-util.js`
- Modify: `src/ui.js`

No new tests: this is a pure move, and `src/itinerary.test.js`'s `cross-module key contract` describe already imports `townKey`/`poiKey` **from `./ui.js`** — it must keep passing, which is exactly the regression guard for this task.

- [ ] **Step 1: Create the shared module**

Create `src/ui-util.js` by moving these verbatim out of `src/ui.js`: `round1` (line 10), `townKey` (16), `poiKey` (30), `BREAK_GLYPH` (43), `FAV_GLYPH` (47), `esc` (52), `debounce` (61). Keep their comments. Add a header:

```js
// Render helpers shared by the panel modules (strip, day panel, places, plans
// bar). No DOM, no data-module imports — same contract as the render modules
// themselves: main.js owns domain logic.
```

Each moved function/const gets `export`.

- [ ] **Step 2: Import them back into `ui.js`**

At the top of `src/ui.js`, replace the deleted definitions with:

```js
import { round1, townKey, poiKey, BREAK_GLYPH, FAV_GLYPH, esc, debounce } from './ui-util.js';

// Re-exported: src/itinerary.test.js's cross-module key contract test imports
// these from here, and main.js has always taken them from ui.js.
export { townKey, poiKey };
```

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS — in particular `cross-module key contract > ui townKey/poiKey and itinerary breakKey produce identical keys`.

- [ ] **Step 4: Verify the app still boots**

Run: `npm run dev` and load the printed URL. Expected: the app renders exactly as before (this task changes no behaviour). Stop the server.

- [ ] **Step 5: Commit**

```bash
git add src/ui-util.js src/ui.js
git commit -m "refactor: extract shared render helpers into ui-util.js"
```

---

## Task 6: Strip geometry

**Files:**
- Create: `src/strip-geometry.js`
- Test: `src/strip-geometry.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/strip-geometry.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { kmToX, xToKm, labelTier, stripLayout, hitTestHandle } from './strip-geometry.js';

const TOTAL_KM = 650;
const WIDTH = 1300; // 2 px per km, so the arithmetic is obvious

function days(...ends) {
  let prev = 0;
  return ends.map((endKm, index) => {
    const day = { index, startKm: prev, endKm };
    prev = endKm;
    return day;
  });
}

describe('kmToX / xToKm', () => {
  it('maps km onto the axis width', () => {
    expect(kmToX(0, { totalKm: TOTAL_KM, width: WIDTH })).toBe(0);
    expect(kmToX(325, { totalKm: TOTAL_KM, width: WIDTH })).toBe(650);
    expect(kmToX(TOTAL_KM, { totalKm: TOTAL_KM, width: WIDTH })).toBe(WIDTH);
  });

  it('clamps out-of-route values onto the axis', () => {
    expect(kmToX(-40, { totalKm: TOTAL_KM, width: WIDTH })).toBe(0);
    expect(kmToX(900, { totalKm: TOTAL_KM, width: WIDTH })).toBe(WIDTH);
  });

  it('round-trips through xToKm', () => {
    const km = 412.5;
    const x = kmToX(km, { totalKm: TOTAL_KM, width: WIDTH });
    expect(xToKm(x, { totalKm: TOTAL_KM, width: WIDTH })).toBeCloseTo(km, 6);
  });

  it('degrades to 0 rather than NaN for a zero width', () => {
    expect(kmToX(100, { totalKm: TOTAL_KM, width: 0 })).toBe(0);
    expect(xToKm(100, { totalKm: 0, width: WIDTH })).toBe(0);
  });
});

describe('labelTier', () => {
  it('degrades detail as a block narrows', () => {
    expect(labelTier(120)).toBe('full');
    expect(labelTier(64)).toBe('full');
    expect(labelTier(63)).toBe('km');
    expect(labelTier(30)).toBe('km');
    expect(labelTier(29)).toBe('number');
    expect(labelTier(14)).toBe('number');
    expect(labelTier(13)).toBe('none');
  });
});

describe('stripLayout', () => {
  it('lays blocks out to scale, contiguously', () => {
    const layout = stripLayout(days(80, 160, 265, 320), { totalKm: TOTAL_KM, width: WIDTH });

    expect(layout.blocks).toHaveLength(4);
    expect(layout.blocks[0]).toMatchObject({ index: 0, x: 0, width: 160 });
    expect(layout.blocks[2]).toMatchObject({ index: 2, x: 320, width: 210 });
    // Contiguous: each block starts where the previous one ended.
    layout.blocks.slice(1).forEach((block, i) => {
      expect(block.x).toBeCloseTo(layout.blocks[i].x + layout.blocks[i].width, 6);
    });
  });

  it('tags each block with the label tier its width allows', () => {
    const layout = stripLayout(days(80, 85), { totalKm: TOTAL_KM, width: WIDTH });
    expect(layout.blocks[0].tier).toBe('full'); // 160 px
    expect(layout.blocks[1].tier).toBe('none'); // 10 px
  });

  it('fills the trailing remainder out to Dresden', () => {
    const layout = stripLayout(days(80, 160), { totalKm: TOTAL_KM, width: WIDTH });
    expect(layout.remainder).toMatchObject({ x: 320, width: 980, startKm: 160, endKm: TOTAL_KM });
  });

  it('makes the remainder the whole axis for an empty plan', () => {
    const layout = stripLayout([], { totalKm: TOTAL_KM, width: WIDTH });
    expect(layout.blocks).toEqual([]);
    expect(layout.remainder).toMatchObject({ x: 0, width: WIDTH, startKm: 0 });
  });

  it('leaves no remainder once the plan reaches Dresden', () => {
    const layout = stripLayout(days(TOTAL_KM), { totalKm: TOTAL_KM, width: WIDTH });
    expect(layout.remainder.width).toBe(0);
  });

  // Real data note (found reviewing Task 2): route.meta.json carries
  // totalKm 650.24, while boundary edits quantize lengths to the 0.1 km grid, so
  // a finished plan tops out at km 650.2 and leaves 0.04 km un-closable. A bare
  // `width > 0` check would render a one-pixel dashed sliver with a "+ add a day"
  // button in it forever. main.js already treats within-0.5 km as arrived
  // (DRESDEN_EPSILON_KM), so use the same tolerance here.
  it('treats a sub-epsilon remainder as finished, so an off-grid totalKm leaves no sliver', () => {
    const layout = stripLayout(days(650.2), { totalKm: 650.24, width: WIDTH });
    expect(layout.remainder.width).toBe(0);
  });
});

describe('hitTestHandle', () => {
  it('finds the boundary handle under the pointer', () => {
    const layout = stripLayout(days(80, 160), { totalKm: TOTAL_KM, width: WIDTH });
    expect(hitTestHandle(160, layout)).toBe(0);
    expect(hitTestHandle(320, layout)).toBe(1);
  });

  it('accepts a near miss inside the tolerance', () => {
    const layout = stripLayout(days(80, 160), { totalKm: TOTAL_KM, width: WIDTH });
    expect(hitTestHandle(168, layout)).toBe(0);
  });

  it('returns null outside the tolerance', () => {
    const layout = stripLayout(days(80, 160), { totalKm: TOTAL_KM, width: WIDTH });
    expect(hitTestHandle(240, layout)).toBeNull();
  });

  it('picks the nearer of two crowded handles', () => {
    const layout = stripLayout(days(80, 85), { totalKm: TOTAL_KM, width: WIDTH });
    // handles at 160 and 170
    expect(hitTestHandle(168, layout)).toBe(1);
    expect(hitTestHandle(162, layout)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/strip-geometry.test.js`
Expected: FAIL — `Failed to resolve import "./strip-geometry.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/strip-geometry.js`:

```js
// Pure geometry for the bottom timeline strip: no DOM, no Leaflet, no data
// modules. The strip maps the WHOLE route onto the axis width, so every km has
// exactly one x and 650 km always fits — the strip can never overflow.

/** Widest block that still can't carry a label, and the tiers above it. */
const TIER_FULL_PX = 64;   // number + km + break glyphs
const TIER_KM_PX = 30;     // number + km
const TIER_NUMBER_PX = 14; // number only
const HANDLE_TOLERANCE_PX = 12;

// Boundary edits quantize lengths to the 0.1 km grid while the real route is
// 650.24 km long, so a finished plan stops ~0.04 km short of Dresden. Without a
// tolerance the strip would render a permanent one-pixel dashed remainder with an
// "+ add a day" button inside it. Mirrors main.js's DRESDEN_EPSILON_KM.
const FINISHED_EPSILON_KM = 0.5;

function positive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Route km -> x on the axis, clamped to the axis. */
export function kmToX(km, { totalKm, width } = {}) {
  if (!positive(totalKm) || !positive(width)) return 0;
  const clamped = Math.min(Math.max(km, 0), totalKm);
  return (clamped / totalKm) * width;
}

/** x on the axis -> route km, clamped to the route. */
export function xToKm(x, { totalKm, width } = {}) {
  if (!positive(totalKm) || !positive(width)) return 0;
  const clamped = Math.min(Math.max(x, 0), width);
  return (clamped / width) * totalKm;
}

/**
 * How much label a block of `width` px can carry. A 5 km day is ~11 px wide on
 * a 1400 px axis, so labels must degrade rather than overflow.
 * @returns {'full'|'km'|'number'|'none'}
 */
export function labelTier(width) {
  if (width >= TIER_FULL_PX) return 'full';
  if (width >= TIER_KM_PX) return 'km';
  if (width >= TIER_NUMBER_PX) return 'number';
  return 'none';
}

/**
 * Pixel layout for the strip: one block per day plus the trailing unplanned
 * remainder. Blocks are contiguous and to scale.
 *
 * @param {Array<{startKm: number, endKm: number}>} days
 * @param {{totalKm: number, width: number}} opts
 * @returns {{blocks: Array<{index: number, x: number, width: number, startKm: number, endKm: number, tier: string}>,
 *            remainder: {x: number, width: number, startKm: number, endKm: number}}}
 */
export function stripLayout(days, { totalKm, width } = {}) {
  const list = Array.isArray(days) ? days : [];
  const blocks = list.map((day, index) => {
    const x = kmToX(day.startKm, { totalKm, width });
    const w = kmToX(day.endKm, { totalKm, width }) - x;
    return { index, x, width: w, startKm: day.startKm, endKm: day.endKm, tier: labelTier(w) };
  });
  const plannedKm = list.length ? list[list.length - 1].endKm : 0;
  const x = kmToX(plannedKm, { totalKm, width });
  const axisWidth = positive(width) ? width : 0;
  // Within the arrival tolerance the plan counts as finished, so the remainder
  // collapses rather than leaving an un-closable sliver (see FINISHED_EPSILON_KM).
  const arrived = totalKm - plannedKm <= FINISHED_EPSILON_KM;
  const remainderWidth = arrived ? 0 : Math.max(0, axisWidth - x);
  return {
    blocks,
    remainder: { x, width: remainderWidth, startKm: plannedKm, endKm: totalKm },
  };
}

/**
 * Index of the boundary handle within `tolerance` px of `x`, or null. Handles
 * sit at each block's right edge; when two are crowded together the nearer one
 * wins.
 */
export function hitTestHandle(x, layout, { tolerance = HANDLE_TOLERANCE_PX } = {}) {
  let best = null;
  for (const block of layout.blocks || []) {
    const dist = Math.abs(x - (block.x + block.width));
    if (dist <= tolerance && (best === null || dist < best.dist)) best = { index: block.index, dist };
  }
  return best ? best.index : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/strip-geometry.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/strip-geometry.js src/strip-geometry.test.js
git commit -m "feat: pure geometry for the timeline strip"
```

---

## Task 7: Strip rendering

**Files:**
- Create: `src/strip.js`, `src/strip.test.js`
- Modify: `package.json` (add `jsdom` dev dependency)

- [ ] **Step 1: Install jsdom**

Run: `npm install --save-dev jsdom`
Expected: `package.json` gains `"jsdom"` under `devDependencies`. The global vitest environment stays `node`; DOM test files opt in per file with a docblock comment.

- [ ] **Step 2: Write the failing test**

Create `src/strip.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStrip } from './strip.js';

const TOTAL_KM = 650;
const WIDTH = 1300;

function days(...ends) {
  let prev = 0;
  return ends.map((endKm, index) => {
    const day = { index, startKm: prev, endKm, targetKm: endKm - prev, townChoice: null };
    prev = endKm;
    return day;
  });
}

let el;
let callbacks;

function mount() {
  el = document.createElement('div');
  document.body.appendChild(el);
  callbacks = {
    onFocusDay: vi.fn(),
    onMoveBoundary: vi.fn(),
    onAddDay: vi.fn(),
  };
  return createStrip({ el, callbacks, measureWidth: () => WIDTH });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('createStrip - summary', () => {
  it('reports planned, remaining, day count and average', () => {
    const strip = mount();
    strip.render({ days: days(80, 160, 265, 320), totalKm: TOTAL_KM, focusedIndex: 2, breaks: [] });

    const summary = el.querySelector('.strip__summary').textContent;
    expect(summary).toContain('320 / 650 km planned');
    expect(summary).toContain('330 km to Dresden');
    expect(summary).toContain('4 days');
    expect(summary).toContain('80 km/day');
  });

  it('invites a first day when the plan is empty', () => {
    const strip = mount();
    strip.render({ days: [], totalKm: TOTAL_KM, focusedIndex: null, breaks: [] });

    expect(el.querySelector('.strip__summary').textContent).toContain('0 / 650 km planned');
    expect(el.querySelector('[data-action="add-day"]')).not.toBeNull();
  });
});

describe('createStrip - blocks', () => {
  it('draws one block per day, to scale and contiguous', () => {
    const strip = mount();
    strip.render({ days: days(80, 160, 265, 320), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const blocks = [...el.querySelectorAll('.strip__block')];
    expect(blocks).toHaveLength(4);
    expect(blocks[0].style.left).toBe('0px');
    expect(blocks[0].style.width).toBe('160px');
    expect(blocks[2].style.left).toBe('320px');
    expect(blocks[2].style.width).toBe('210px');
  });

  it('marks the focused block', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 1, breaks: [] });

    const focused = el.querySelectorAll('.strip__block--focused');
    expect(focused).toHaveLength(1);
    expect(focused[0].dataset.dayIndex).toBe('1');
  });

  it('shows km and the overnight town at full tier', () => {
    const strip = mount();
    const list = days(80);
    list[0].townChoice = { name: 'Brackede' };
    strip.render({ days: list, totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const block = el.querySelector('.strip__block');
    expect(block.textContent).toContain('80 km');
    expect(block.textContent).toContain('Brackede');
  });

  it('drops the label on a block too narrow for one, keeping a tooltip', () => {
    const strip = mount();
    strip.render({ days: days(80, 85), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const narrow = el.querySelectorAll('.strip__block')[1];
    expect(narrow.querySelector('.strip__block-label')).toBeNull();
    expect(narrow.getAttribute('title')).toContain('5 km');
  });

  it('escapes an overnight town name', () => {
    const strip = mount();
    const list = days(80);
    list[0].townChoice = { name: '<script>x</script>' };
    strip.render({ days: list, totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    expect(el.querySelector('.strip__block').innerHTML).not.toContain('<script>');
  });

  it('places break glyphs at their km inside the day', () => {
    const strip = mount();
    strip.render({
      days: days(100),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      breaks: [{ name: 'Café', kind: 'food', routeDistanceKm: 50 }],
    });

    const glyph = el.querySelector('.strip__glyph');
    expect(glyph.textContent).toBe('☕');
    expect(glyph.style.left).toBe('100px'); // km 50 at 2 px/km
  });

  it('shows breaks past the last day on the remainder', () => {
    const strip = mount();
    strip.render({
      days: days(80),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      breaks: [{ name: 'Later', kind: 'sight', routeDistanceKm: 300 }],
    });

    const glyph = el.querySelector('.strip__remainder .strip__glyph');
    expect(glyph).not.toBeNull();
    expect(glyph.textContent).toBe('📷');
  });
});

describe('createStrip - focus and add', () => {
  it('focuses the day whose block is clicked', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    el.querySelectorAll('.strip__block')[1].click();

    expect(callbacks.onFocusDay).toHaveBeenCalledWith(1);
  });

  it('appends a day from the add button', () => {
    const strip = mount();
    strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    el.querySelector('[data-action="add-day"]').click();

    expect(callbacks.onAddDay).toHaveBeenCalledWith(null);
  });

  it('adds a day ending at the clicked km on the remainder', () => {
    const strip = mount();
    strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    // The km comes from the pointer's position on the AXIS, so stub that rect.
    el.querySelector('.strip__axis').getBoundingClientRect = () => ({ left: 0, width: WIDTH, top: 0, height: 46 });
    el.querySelector('.strip__remainder').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, clientX: 560 }),
    );

    // x = 560 on a 1300 px axis over 650 km -> km 280
    expect(callbacks.onAddDay).toHaveBeenCalledWith(280);
  });

  it('hides the remainder once the plan reaches Dresden', () => {
    const strip = mount();
    strip.render({ days: days(TOTAL_KM), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    expect(el.querySelector('.strip__remainder')).toBeNull();
    expect(el.querySelector('.strip__finish')).not.toBeNull();
  });
});

describe('createStrip - handles', () => {
  it('gives every boundary an accessible slider handle', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const handles = [...el.querySelectorAll('.strip__handle')];
    expect(handles).toHaveLength(2);
    expect(handles[0].getAttribute('role')).toBe('slider');
    expect(handles[0].getAttribute('aria-valuenow')).toBe('80');
    expect(handles[0].getAttribute('aria-valuemin')).toBe('5');
    expect(handles[0].getAttribute('aria-valuemax')).toBe('155');
    expect(handles[0].getAttribute('aria-label')).toContain('Day 1 end');
  });

  it('lets the last handle run to the end of the route', () => {
    const strip = mount();
    strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    expect(el.querySelector('.strip__handle').getAttribute('aria-valuemax')).toBe('650');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/strip.test.js`
Expected: FAIL — `Failed to resolve import "./strip.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `src/strip.js`:

```js
// The bottom timeline strip: the whole trip drawn to scale in kilometres. Owns
// its own DOM and interaction; emits intent through callbacks. No Leaflet, no
// data modules — main.js passes plain days/breaks in (same contract as ui.js).

import { esc, round1, BREAK_GLYPH } from './ui-util.js';
import { boundaryBounds } from './boundaries.js';
import { stripLayout, kmToX, xToKm } from './strip-geometry.js';

// jsdom (and a first paint before layout settles) reports clientWidth 0; a
// plausible width keeps the strip renderable and the geometry tests honest.
const FALLBACK_WIDTH = 1000;

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.el - container the strip owns outright.
 * @param {Object} opts.callbacks
 * @param {(index: number) => void} opts.callbacks.onFocusDay
 * @param {(index: number, endKm: number, opts: {commit: boolean}) => void} opts.callbacks.onMoveBoundary
 * @param {(endKm: number|null) => void} opts.callbacks.onAddDay - endKm from a
 *   remainder click, or null to append a default-length day.
 * @param {() => number} [opts.measureWidth] - axis width in px; injectable for tests.
 */
export function createStrip({ el, callbacks = {}, measureWidth } = {}) {
  let state = { days: [], totalKm: 0, focusedIndex: null, breaks: [] };

  el.classList.add('strip');
  el.innerHTML = `
    <div class="strip__summary"></div>
    <div class="strip__axis" data-strip-axis></div>
    <div class="strip__scale"></div>`;

  const summaryEl = el.querySelector('.strip__summary');
  const axisEl = el.querySelector('.strip__axis');
  const scaleEl = el.querySelector('.strip__scale');

  const width = measureWidth || (() => axisEl.clientWidth || FALLBACK_WIDTH);

  function axisOpts() {
    return { totalKm: state.totalKm, width: width() };
  }

  function summary() {
    const { days, totalKm } = state;
    const planned = days.length ? days[days.length - 1].endKm : 0;
    const remaining = Math.max(0, totalKm - planned);
    const avg = days.length ? round1(planned / days.length) : 0;
    const right = days.length
      ? `${days.length} ${days.length === 1 ? 'day' : 'days'} · ⌀ ${avg} km/day`
      : 'no days yet';
    return `
      <span><b>${round1(planned)} / ${round1(totalKm)} km planned</b> · ${round1(remaining)} km to Dresden</span>
      <span>${right}</span>`;
  }

  // Glyphs for the breaks inside [startKm, endKm], positioned by km relative to
  // the container's own left edge.
  function glyphs(startKm, endKm, containerX) {
    const opts = axisOpts();
    return state.breaks
      .filter((b) => b.routeDistanceKm > (startKm === 0 ? -1 : startKm) && b.routeDistanceKm <= endKm)
      .map((b) => {
        const x = kmToX(b.routeDistanceKm, opts) - containerX;
        const glyph = BREAK_GLYPH[b.kind] || '☕';
        return `<span class="strip__glyph" style="left:${round1(x)}px" title="${esc(b.name)}">${glyph}</span>`;
      })
      .join('');
  }

  function blockLabel(block, day) {
    const km = `${round1(day.endKm - day.startKm)} km`;
    const town = day.townChoice ? `<span class="strip__block-town">🛏 ${esc(day.townChoice.name)}</span>` : '';
    if (block.tier === 'full') {
      return `<span class="strip__block-label"><b>${block.index + 1}</b> <span class="strip__block-km">${km}</span>${town}</span>`;
    }
    if (block.tier === 'km') {
      return `<span class="strip__block-label"><b>${block.index + 1}</b> <span class="strip__block-km">${km}</span></span>`;
    }
    if (block.tier === 'number') {
      return `<span class="strip__block-label"><b>${block.index + 1}</b></span>`;
    }
    return '';
  }

  function handle(index) {
    const day = state.days[index];
    const { min, max } = boundaryBounds(state.days, index, { totalKm: state.totalKm });
    const x = kmToX(day.endKm, axisOpts());
    const town = day.townChoice ? ` (${day.townChoice.name})` : '';
    const label = `Day ${index + 1} end, km ${round1(day.endKm)}${town}, arrow keys adjust`;
    return `
      <button type="button" class="strip__handle" data-boundary-index="${index}"
              style="left:${round1(x)}px" role="slider" tabindex="0"
              aria-valuenow="${round1(day.endKm)}" aria-valuemin="${round1(min)}" aria-valuemax="${round1(max)}"
              aria-label="${esc(label)}" title="${esc(label)}"></button>`;
  }

  function render(next) {
    state = {
      days: next.days || [],
      totalKm: next.totalKm || 0,
      focusedIndex: next.focusedIndex ?? null,
      breaks: next.breaks || [],
    };
    summaryEl.innerHTML = summary();

    const layout = stripLayout(state.days, axisOpts());
    const blocks = layout.blocks
      .map((block) => {
        const day = state.days[block.index];
        const focused = block.index === state.focusedIndex ? ' strip__block--focused' : '';
        const town = day.townChoice ? ` — ${day.townChoice.name}` : '';
        const title = `Day ${block.index + 1} · ${round1(day.endKm - day.startKm)} km · km ${round1(day.startKm)} → ${round1(day.endKm)}${town}`;
        return `
          <div class="strip__block${focused}" data-day-index="${block.index}" role="button" tabindex="0"
               style="left:${round1(block.x)}px;width:${round1(block.width)}px" title="${esc(title)}">
            ${blockLabel(block, day)}
            ${block.tier === 'full' ? glyphs(day.startKm, day.endKm, block.x) : ''}
          </div>`;
      })
      .join('');

    const { remainder } = layout;
    const tail =
      remainder.width > 0
        ? `<div class="strip__remainder" style="left:${round1(remainder.x)}px;width:${round1(remainder.width)}px">
             ${glyphs(remainder.startKm, remainder.endKm, remainder.x)}
             <button type="button" class="strip__add" data-action="add-day">+ add a day</button>
             <span class="strip__flag">⚑ Dresden</span>
           </div>`
        : '<span class="strip__finish">⚑ Dresden reached</span>';

    axisEl.innerHTML = blocks + tail + state.days.map((_, i) => handle(i)).join('');
    scaleEl.innerHTML = `<span>km 0 · Hamburg</span><span>km ${round1(state.totalKm)} · Dresden</span>`;
  }

  // --- Interaction -------------------------------------------------------
  axisEl.addEventListener('click', (e) => {
    if (e.target.closest('.strip__handle')) return; // dragging, not focusing
    if (e.target.closest('[data-action="add-day"]')) {
      callbacks.onAddDay?.(null);
      return;
    }
    const block = e.target.closest('[data-day-index]');
    if (block) {
      callbacks.onFocusDay?.(Number(block.dataset.dayIndex));
      return;
    }
    const remainder = e.target.closest('.strip__remainder');
    if (remainder) {
      // Measure against the AXIS, not the remainder, so the km is absolute along
      // the route regardless of where the remainder starts.
      const rect = axisEl.getBoundingClientRect();
      const km = xToKm(e.clientX - rect.left, { totalKm: state.totalKm, width: rect.width || width() });
      callbacks.onAddDay?.(round1(km));
    }
  });

  return { render };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/strip.test.js`
Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/strip.js src/strip.test.js
git commit -m "feat: render the trip as a to-scale timeline strip"
```

---

## Task 8: Strip drag and keyboard

**Files:**
- Modify: `src/strip.js`
- Test: `src/strip.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/strip.test.js`:

```js
describe('createStrip - keyboard adjustment', () => {
  it('moves a boundary 1 km with an arrow key', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const handle = el.querySelector('.strip__handle');
    handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(callbacks.onMoveBoundary).toHaveBeenCalledWith(0, 81, { commit: true });
  });

  it('moves 5 km with shift held', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const handle = el.querySelector('.strip__handle');
    handle.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }),
    );

    expect(callbacks.onMoveBoundary).toHaveBeenCalledWith(0, 75, { commit: true });
  });

  it('clamps a keyboard nudge at the neighbour floor', () => {
    const strip = mount();
    strip.render({ days: days(150, 155), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const handle = el.querySelector('.strip__handle');
    handle.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );

    // max is 155 - 5 = 150, so the boundary can't move right at all.
    expect(callbacks.onMoveBoundary).toHaveBeenCalledWith(0, 150, { commit: true });
  });

  // Found reviewing Task 2: when a pair of days together spans less than
  // 2 x MIN_DAY_KM, boundaryBounds collapses the window to a single legal
  // position, so a drag to the RIGHT can snap the boundary LEFT — the handle
  // jumps the opposite way to the gesture. Rare (needs a sub-10 km pair) but
  // jarring. A drag on a degenerate window should do nothing at all.
  it('does not move a boundary whose window has collapsed to one position', () => {
    const strip = mount();
    strip.render({ days: days(6, 9), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });
    const handle = el.querySelector('.strip__handle');
    el.querySelector('.strip__axis').getBoundingClientRect = () => ({ left: 0, width: WIDTH, top: 0, height: 46 });

    handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
  });

  it('ignores keys that aren't arrows', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    el.querySelector('.strip__handle').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }),
    );

    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
  });
});

describe('createStrip - pointer drag', () => {
  function drag(handle, xs) {
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    handle.dispatchEvent(
      new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: xs[0] }),
    );
    xs.slice(1).forEach((x) => {
      handle.dispatchEvent(
        new window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x }),
      );
    });
    handle.dispatchEvent(
      new window.PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: xs[xs.length - 1] }),
    );
  }

  it('previews during the drag and commits once on release', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });
    const handle = el.querySelector('.strip__handle');
    // Handle sits at x=160; axis starts at clientX 0 in this stub.
    el.querySelector('.strip__axis').getBoundingClientRect = () => ({ left: 0, width: WIDTH, top: 0, height: 40 });

    drag(handle, [160, 200, 240]);

    const calls = callbacks.onMoveBoundary.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.slice(0, -1).every(([, , opts]) => opts.commit === false)).toBe(true);
    const last = calls[calls.length - 1];
    expect(last[0]).toBe(0);
    expect(last[1]).toBe(120); // x=240 -> km 120 at 2 px/km
    expect(last[2]).toEqual({ commit: true });
  });

  it('does not focus the day when a handle is dragged', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 1, breaks: [] });
    const handle = el.querySelector('.strip__handle');
    el.querySelector('.strip__axis').getBoundingClientRect = () => ({ left: 0, width: WIDTH, top: 0, height: 40 });

    drag(handle, [160, 200]);

    expect(callbacks.onFocusDay).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/strip.test.js`
Expected: FAIL — `onMoveBoundary` never called.

- [ ] **Step 3: Write the implementation**

In `src/strip.js`, import the clamp helper alongside `boundaryBounds`:

```js
import { boundaryBounds, clampBoundaryKm } from './boundaries.js';
```

Add below the existing `axisEl.addEventListener('click', ...)` block:

```js
  // --- Boundary drag ------------------------------------------------------
  // Pointer events (not mouse) so touch and pen work; the handle captures the
  // pointer so a fast drag that leaves the strip keeps tracking. The model is
  // updated live for feedback but persisted only once, on release — main.js
  // keys that off `commit`.
  let dragging = null;

  function kmAtClientX(clientX) {
    const rect = axisEl.getBoundingClientRect();
    const x = clientX - rect.left;
    const km = (x / (rect.width || width())) * state.totalKm;
    return round1(km);
  }

  axisEl.addEventListener('pointerdown', (e) => {
    const handleEl = e.target.closest('.strip__handle');
    if (!handleEl) return;
    e.preventDefault();
    const index = Number(handleEl.dataset.boundaryIndex);
    dragging = { index, moved: false };
    handleEl.setPointerCapture?.(e.pointerId);
    handleEl.classList.add('strip__handle--dragging');
  });

  axisEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragging.moved = true;
    const km = clampBoundaryKm(state.days, dragging.index, kmAtClientX(e.clientX), {
      totalKm: state.totalKm,
    });
    callbacks.onMoveBoundary?.(dragging.index, round1(km), { commit: false });
  });

  function endDrag(e) {
    if (!dragging) return;
    const { index } = dragging;
    dragging = null;
    el.querySelector('.strip__handle--dragging')?.classList.remove('strip__handle--dragging');
    const km = clampBoundaryKm(state.days, index, kmAtClientX(e.clientX), { totalKm: state.totalKm });
    callbacks.onMoveBoundary?.(index, round1(km), { commit: true });
  }

  axisEl.addEventListener('pointerup', endDrag);
  axisEl.addEventListener('pointercancel', endDrag);

  // --- Keyboard adjustment ------------------------------------------------
  // The accessible replacement for the removed slider: arrows nudge 1 km,
  // Shift+arrows 5 km, both clamped exactly like a drag.
  axisEl.addEventListener('keydown', (e) => {
    const handleEl = e.target.closest('.strip__handle');
    if (!handleEl) return;
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const index = Number(handleEl.dataset.boundaryIndex);
    const step = e.shiftKey ? 5 : 1;
    const target = state.days[index].endKm + dir * step;
    const km = clampBoundaryKm(state.days, index, target, { totalKm: state.totalKm });
    callbacks.onMoveBoundary?.(index, round1(km), { commit: true });
  });
```

Guard the block click so a drag never also focuses — at the top of the existing click listener, replace the handle check with:

```js
    if (e.target.closest('.strip__handle')) return; // dragging, not focusing
    if (justDragged) {
      justDragged = false;
      return;
    }
```

and declare `let justDragged = false;` next to `let dragging = null;`, setting `justDragged = dragging.moved;` inside `endDrag` before clearing `dragging`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/strip.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/strip.js src/strip.test.js
git commit -F - <<'EOF'
feat: drag and keyboard adjustment for strip boundaries

Pointer events with capture so touch works; live preview during the drag and a
single commit on release, so a drag persists once rather than per pixel. Arrow
keys nudge 1 km (5 with shift) as the accessible replacement for the slider.
EOF
```

---

## Task 9: Layout shell and mount the strip

The app runs with the strip live at the end of this task; the old right-panel controls remain until Task 10, so nothing is unreachable in between.

**Files:**
- Modify: `index.html`, `src/style.css`, `src/main.js`

- [ ] **Step 1: Restructure `index.html`**

Replace the `<body>` contents with the four zones plus the strip:

```html
  <body>
    <header id="app-header">
      <div id="app-title">
        Elberadweg Day Planner <span>Hamburg → Dresden</span>
      </div>
      <div id="plans"></div>
    </header>
    <div id="app-body">
      <aside id="panel-left">
        <div id="places"></div>
      </aside>
      <div id="map"></div>
      <aside id="panel">
        <div id="banner" class="banner" hidden></div>
        <div id="day-panel"></div>
      </aside>
    </div>
    <div id="strip"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
```

The removed `#panel-left-header`, `#favorites`, `#pois`, `#towns`, `#controls`, `#itinerary` and `#panel-footer` are replaced by `#places`, `#day-panel` and `#strip`. The OSM attribution moves into the strip's scale line (Task 13 wires the text; keep the credit visible — ODbL requires it).

- [ ] **Step 2: Replace the layout shell in `src/style.css`**

Replace the `body` rule and the `#map` / panel-shell rules (lines 49-97) with a rows-then-columns shell:

```css
body {
  margin: 0;
  font-family: var(--sans);
  font-size: 14px;
  color: var(--text);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  /* Header, then the three-column body, then the timeline strip. */
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100vh;
  overflow: hidden;
}

#app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 16px;
  height: 46px;
  background: #1d1a14;
  border-bottom: 1px solid var(--line);
}

#app-title {
  font-family: var(--serif);
  font-size: 17px;
}

#app-title span {
  font-family: var(--sans);
  font-size: 10px;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-left: 10px;
}

#app-body {
  display: flex;
  min-height: 0;
}

#map {
  flex: 1 1 auto;
  height: 100%;
  background: #e7e4dd;
}

#panel,
#panel-left {
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, #1d1a14 0%, var(--bg) 220px);
  scrollbar-width: thin;
  scrollbar-color: var(--surface-hi) transparent;
}

#panel {
  flex: 0 0 380px;
  width: 380px;
  border-left: 1px solid var(--line);
  box-shadow: -18px 0 40px -24px rgba(0, 0, 0, 0.7);
}

#panel-left {
  flex: 0 0 340px;
  width: 340px;
  border-right: 1px solid var(--line);
  box-shadow: 18px 0 40px -24px rgba(0, 0, 0, 0.7);
}
```

Delete the `panel-in` / `panel-in-left` keyframes and the two `animation:` lines (the panels no longer slide in; the strip is the entrance now), and drop those selectors from the `prefers-reduced-motion` block.

- [ ] **Step 3: Add the strip styles**

Append to `src/style.css`:

```css
/* --- Timeline strip ------------------------------------------------------
   The trip, drawn to scale: 650 km always fits the width, so this can never
   overflow. Blocks and handles are absolutely positioned from px values that
   strip-geometry.js computes. */
#strip {
  border-top: 1px solid var(--line);
  background: #1d1a14;
  padding: 10px 16px 9px;
  user-select: none;
}

.strip__summary {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 8px;
}

.strip__summary b {
  color: var(--text);
}

.strip__axis {
  position: relative;
  height: 46px;
}

.strip__block,
.strip__remainder {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 5px;
  overflow: hidden;
}

.strip__block {
  background: var(--surface);
  border: 1px solid var(--line);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.strip__block:hover {
  background: var(--surface-hi);
}

.strip__block--focused {
  background: #232c3d;
  border-color: var(--river);
  box-shadow: inset 0 0 0 1px var(--river);
}

.strip__block:focus-visible,
.strip__handle:focus-visible {
  outline: 2px solid var(--river);
  outline-offset: 1px;
}

.strip__block-label {
  display: block;
  padding: 4px 6px;
  font-size: 11px;
  white-space: nowrap;
}

.strip__block-km {
  color: var(--text-dim);
}

.strip__block-town {
  display: block;
  font-size: 10px;
  color: var(--town);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.strip__glyph {
  position: absolute;
  bottom: 2px;
  font-size: 10px;
  transform: translateX(-50%);
  pointer-events: none;
}

.strip__remainder {
  border: 1px dashed var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  cursor: copy;
}

.strip__add {
  font: inherit;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
}

.strip__add:hover {
  color: var(--text);
  border-color: var(--river);
}

.strip__flag,
.strip__finish {
  font-size: 11px;
  color: var(--text-faint);
}

.strip__finish {
  position: absolute;
  right: 0;
  bottom: 4px;
  color: var(--done);
}

/* The boundary itself: a thin grab bar straddling two blocks. 10 px wide, but
   -7px insets give it a ~24 px touch target. */
.strip__handle {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 10px;
  margin-left: -5px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: var(--river);
  opacity: 0.85;
  cursor: col-resize;
  touch-action: none;
}

.strip__handle::after {
  content: "";
  position: absolute;
  inset: -7px;
}

.strip__handle:hover,
.strip__handle--dragging {
  opacity: 1;
  box-shadow: 0 0 0 3px rgba(91, 147, 255, 0.25);
}

.strip__scale {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-faint);
  margin-top: 5px;
}
```

- [ ] **Step 4: Mount the strip in `src/main.js`**

Add the import:

```js
import { createStrip } from './strip.js';
```

After the `createUI(...)` call, add:

```js
  // The strip owns the whole-trip view. Boundary drags fire continuously with
  // commit:false for live feedback and once with commit:true on release, so a
  // drag writes to storage exactly once.
  const strip = createStrip({
    el: document.getElementById('strip'),
    callbacks: {
      onFocusDay: handleFocusDay,
      onMoveBoundary: handleMoveBoundary,
      onAddDay: handleAddDay,
    },
  });
```

Add `focusedDayIndex` next to the existing state declarations, and these handlers next to the other callbacks:

```js
  // --- Focus (which day the panels and the map are pointed at) ------------
  // Exactly one day is focused whenever the plan has any days; the default is
  // the last one. Not persisted — a reload or plan switch focuses the last day.
  let focusedDayIndex = null;

  function clampFocus() {
    const count = itinerary.getDays().length;
    focusedDayIndex = count ? Math.min(focusedDayIndex ?? count - 1, count - 1) : null;
  }

  function focusedDay() {
    if (focusedDayIndex == null) return null;
    return itinerary.getDays()[focusedDayIndex] ?? null;
  }

  function handleFocusDay(index) {
    focusedDayIndex = index;
    renderAll();
  }

  function handleMoveBoundary(index, endKm, { commit } = {}) {
    itinerary.moveBoundary(index, endKm);
    if (commit) persistPlan();
    renderAll();
  }

  // A remainder click gives an absolute end km; the + button gives null, meaning
  // "another day the length of the last one" (80 km for the first day).
  function handleAddDay(endKm) {
    const days = itinerary.getDays();
    const startKm = itinerary.totalPlannedKm();
    const fallback = days.length ? days[days.length - 1].targetKm : DEFAULT_TARGET_KM;
    const length = endKm == null ? fallback : Math.max(MIN_DAY_KM, endKm - startKm);
    itinerary.addDay(length);
    focusedDayIndex = itinerary.getDays().length - 1;
    persistPlan();
    renderAll();
  }
```

Import `MIN_DAY_KM`:

```js
import { MIN_DAY_KM } from './boundaries.js';
```

Add the strip render to `renderAll`, and clamp focus first:

```js
  function renderAll() {
    clampFocus();
    renderStrip();
    renderCommitted();
    renderPending();
    renderFavoritesSection();
  }

  function renderStrip() {
    strip.render({
      days: itinerary.getDays(),
      totalKm,
      focusedIndex: focusedDayIndex,
      breaks: itinerary.getBreaks(),
    });
  }
```

- [ ] **Step 5: Verify in the browser**

Run: `npm run dev`, open the URL with an existing multi-day plan in localStorage (or commit three days with the old controls).

Expected: the strip appears along the bottom with one to-scale block per day; clicking a block highlights it; dragging a boundary resizes that day and its neighbour only, with the numbers updating live; the `+ add a day` button appends a day; clicking the dashed remainder adds a day ending near the clicked point. Confirm in DevTools that `localStorage['elberadweg-plans']` updates once per drag (watch `updatedAt`), not continuously.

- [ ] **Step 6: Commit**

```bash
git add index.html src/style.css src/main.js
git commit -m "feat: grid layout shell with the timeline strip mounted"
```

---

## Task 10: The focused day panel

**Files:**
- Create: `src/day-panel.js`, `src/day-panel.test.js`
- Modify: `src/main.js`, `src/ui.js`, `src/style.css`

- [ ] **Step 1: Write the failing test**

Create `src/day-panel.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDayPanel } from './day-panel.js';

let el;
let callbacks;

function mount() {
  el = document.createElement('div');
  document.body.appendChild(el);
  callbacks = {
    onEditDay: vi.fn(),
    onSplitDay: vi.fn(),
    onDeleteDay: vi.fn(),
    onFocusDay: vi.fn(),
    onRemoveBreak: vi.fn(),
    onEditBreak: vi.fn(),
  };
  return createDayPanel({ el, callbacks });
}

const DAY = { index: 2, targetKm: 105, startKm: 160, endKm: 265, townChoice: { name: 'Rosenhof', routeDistanceKm: 265, offsetKm: 0.4 } };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('createDayPanel - empty plan', () => {
  it('invites a first day', () => {
    const panel = mount();
    panel.render({ day: null, dayCount: 0, breaks: [], fromName: 'Hamburg' });
    expect(el.textContent).toContain('No days yet');
  });
});

describe('createDayPanel - header', () => {
  it('names the day, where it starts from, and its km range', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen (Elbe)' });

    expect(el.querySelector('.day-panel__title').textContent).toContain('Day 3');
    expect(el.textContent).toContain('from Lenzen (Elbe)');
    expect(el.textContent).toContain('km 160 → 265');
    expect(el.textContent).toContain('3 of 4');
  });

  it('escapes the previous overnight name', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: '<img src=x>' });
    expect(el.innerHTML).not.toContain('<img src=x>');
  });
});

describe('createDayPanel - distance', () => {
  it('shows the day length and reports a typed change', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const input = el.querySelector('[data-day-distance]');
    expect(input.value).toBe('105');
    input.value = '90';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(callbacks.onEditDay).toHaveBeenCalledWith(2, 90);
  });

  it('ignores a non-positive distance', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const input = el.querySelector('[data-day-distance]');
    input.value = '0';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(callbacks.onEditDay).not.toHaveBeenCalled();
  });
});

describe('createDayPanel - overnight', () => {
  it('shows the chosen town and its off-route detour', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const overnight = el.querySelector('.day-panel__overnight').textContent;
    expect(overnight).toContain('Rosenhof');
    expect(overnight).toContain('0.4 km off route');
  });

  it('prompts when no town is chosen', () => {
    const panel = mount();
    panel.render({ day: { ...DAY, townChoice: null }, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    expect(el.querySelector('.day-panel__overnight').textContent).toContain('none chosen');
  });

  it('explains a boundary that could not reach the town', () => {
    const panel = mount();
    const day = { ...DAY, endKm: 263, townChoice: { name: 'Rosenhof', routeDistanceKm: 265 } };
    panel.render({ day, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const note = el.querySelector('.day-panel__snap-note').textContent;
    expect(note).toContain('km 265');
    expect(note).toContain('km 263');
  });
});

describe('createDayPanel - legs', () => {
  const breaks = [
    { name: 'Café Elbterrasse', kind: 'food', routeDistanceKm: 195, note: '15 min coffee' },
    { name: 'Grenzturm', kind: 'sight', routeDistanceKm: 213 },
  ];

  it('lists legs as distance since the previous stop', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

    const legs = [...el.querySelectorAll('.day-card__leg')].map((li) => li.textContent.replace(/\s+/g, ' ').trim());
    expect(legs[0]).toContain('35 km');
    expect(legs[0]).toContain('Café Elbterrasse');
    expect(legs[0]).toContain('15 min coffee');
    expect(legs[1]).toContain('18 km');
    expect(legs[2]).toContain('52 km');
    expect(legs[2]).toContain('Rosenhof');
  });

  it('reads a break at the very start as "at the start"', () => {
    const panel = mount();
    const day = { index: 0, targetKm: 80, startKm: 0, endKm: 80, townChoice: null };
    panel.render({
      day,
      dayCount: 1,
      breaks: [{ name: 'Five Guys', kind: 'food', routeDistanceKm: 0 }],
      fromName: 'Hamburg',
    });

    const first = el.querySelector('.day-card__leg').textContent;
    expect(first).toContain('at the start');
    expect(first).not.toContain('0 km →');
  });

  it('removes a break', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

    el.querySelector('[data-action="remove-break"]').click();

    expect(callbacks.onRemoveBreak).toHaveBeenCalledWith('Café Elbterrasse@195');
  });
});

describe('createDayPanel - day operations', () => {
  it('splits and deletes the focused day', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    el.querySelector('[data-action="split-day"]').click();
    expect(callbacks.onSplitDay).toHaveBeenCalledWith(2);

    el.querySelector('[data-action="delete-day"]').click();
    expect(callbacks.onDeleteDay).toHaveBeenCalledWith(2);
  });

  it('disables split on a day too short to split', () => {
    const panel = mount();
    const day = { index: 0, targetKm: 8, startKm: 0, endKm: 8, townChoice: null };
    panel.render({ day, dayCount: 1, breaks: [], fromName: 'Hamburg' });

    expect(el.querySelector('[data-action="split-day"]').disabled).toBe(true);
  });

  it('steps focus between days', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    el.querySelector('[data-action="focus-prev"]').click();
    expect(callbacks.onFocusDay).toHaveBeenCalledWith(1);

    el.querySelector('[data-action="focus-next"]').click();
    expect(callbacks.onFocusDay).toHaveBeenCalledWith(3);
  });

  it('disables the stepper at the ends', () => {
    const panel = mount();
    panel.render({
      day: { index: 0, targetKm: 80, startKm: 0, endKm: 80, townChoice: null },
      dayCount: 1,
      breaks: [],
      fromName: 'Hamburg',
    });

    expect(el.querySelector('[data-action="focus-prev"]').disabled).toBe(true);
    expect(el.querySelector('[data-action="focus-next"]').disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/day-panel.test.js`
Expected: FAIL — `Failed to resolve import "./day-panel.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/day-panel.js`. First move three functions out of `src/ui.js` verbatim — they belong to the legs and the stop prompt, which now live here:

- `breakEditButton` (`src/ui.js:507-515`)
- `startBreakEdit` (`src/ui.js:521-558`) — it closed over `ui.js`'s `callbacks`; give it a second parameter `callbacks` and call it as `startBreakEdit(edit, callbacks)`. Keep its comment about the unchanged-value restore path: a plain blur must not eat the user's next click, and that behaviour is load-bearing.
- `renderCustomStopPrompt` (`src/ui.js:414-458`) — drop its `selectedDay` parameter (there is no day mode any more; the focused day is always the target) and read the day from the render argument instead. Keep the `data-km` guard that stops an unrelated re-render wiping half-typed text.

Then:

```js
// The focused day, and only the focused day: its length, its overnight town, its
// legs, and the two operations that change the shape of the plan around it
// (split, delete). Bounded content by construction — one day — so this panel can
// never outgrow the window the way the old scrolling itinerary did.

import { esc, round1, poiKey, BREAK_GLYPH } from './ui-util.js';
import { MIN_DAY_KM } from './boundaries.js';

const SNAP_EPSILON_KM = 0.05;

export function createDayPanel({ el, callbacks = {} }) {
  let current = { day: null, dayCount: 0 };

  function legs(day, breaks) {
    const lines = [];
    let prevKm = day.startKm;
    for (const b of breaks) {
      const glyph = BREAK_GLYPH[b.kind] || '☕';
      const legKm = round1(b.routeDistanceKm - prevKm);
      // A break sitting exactly at the day's start has no leg to speak of; a
      // bare "0 km →" reads as a bug, so say where it is instead.
      const dist =
        legKm <= 0
          ? '<span class="day-card__leg-dist">at the start</span>'
          : `<span class="day-card__leg-dist">${legKm} km</span> →`;
      const note = b.note ? ` <span class="day-card__leg-note">· ${esc(b.note)}</span>` : '';
      lines.push(`
        <li class="day-card__leg">
          <span class="day-card__leg-text">${dist} ${glyph} ${esc(b.name)}${note}</span>
          <span class="leg-actions">
            ${breakEditButton(b)}
            <button type="button" class="row-remove" data-action="remove-break"
                    data-break-key="${esc(poiKey(b))}" title="Remove break" aria-label="Remove break">×</button>
          </span>
        </li>`);
      prevKm = b.routeDistanceKm;
    }
    const finalKm = round1(day.endKm - prevKm);
    const endName = day.townChoice ? esc(day.townChoice.name) : 'day end';
    lines.push(`
      <li class="day-card__leg day-card__leg--end">
        <span class="day-card__leg-text"><span class="day-card__leg-dist">${finalKm} km</span> → 🛏 ${endName}</span>
      </li>`);
    return `<ol class="day-card__legs">${lines.join('')}</ol>`;
  }

  function overnight(day) {
    if (!day.townChoice) {
      return `<span class="day-panel__overnight-name day-panel__overnight-name--none">none chosen</span>
              <span class="day-panel__hint">pick one from the left, or drag the pin on the map</span>`;
    }
    const town = day.townChoice;
    const offset =
      typeof town.offsetKm === 'number' ? ` · ${round1(town.offsetKm)} km off route` : '';
    return `<span class="day-panel__overnight-name">🛏 ${esc(town.name)}</span>
            <span class="day-panel__hint">km ${round1(day.endKm)}${offset}</span>`;
  }

  // The boundary clamps at MIN_DAY_KM from its neighbour, so a town very close
  // to the next overnight can't be reached exactly. Say so rather than showing a
  // day length that silently disagrees with the town's position.
  function snapNote(day) {
    const km = day.townChoice?.routeDistanceKm;
    if (typeof km !== 'number' || Math.abs(km - day.endKm) <= SNAP_EPSILON_KM) return '';
    return `<p class="day-panel__snap-note">${esc(day.townChoice.name)} sits at km ${round1(km)};
      keeping every day at least ${MIN_DAY_KM} km stopped this boundary at km ${round1(day.endKm)}.</p>`;
  }

  function render({ day, dayCount, breaks = [], fromName = 'your last stop', customStopDraft = null }) {
    current = { day, dayCount };
    if (!day) {
      el.innerHTML = `
        <div class="day-panel day-panel--empty">
          <h2 class="day-panel__title">No days yet</h2>
          <p class="day-panel__hint">Click the strip below, or hit <b>+ add a day</b>, to plan your first day out of Hamburg.</p>
        </div>`;
      return;
    }
    const length = round1(day.endKm - day.startKm);
    const canSplit = length >= 2 * MIN_DAY_KM;
    el.innerHTML = `
      <div class="day-panel">
        <div class="day-panel__head">
          <h2 class="day-panel__title">Day ${day.index + 1}</h2>
          <div class="day-panel__stepper">
            <span>${day.index + 1} of ${dayCount}</span>
            <button type="button" class="row-edit" data-action="focus-prev" aria-label="Previous day"
                    ${day.index === 0 ? 'disabled' : ''}>‹</button>
            <button type="button" class="row-edit" data-action="focus-next" aria-label="Next day"
                    ${day.index >= dayCount - 1 ? 'disabled' : ''}>›</button>
          </div>
        </div>
        <div class="day-panel__from">from ${esc(fromName)} · km ${round1(day.startKm)} → ${round1(day.endKm)}</div>

        <label class="day-panel__field">
          <span>Distance</span>
          <input type="number" min="${MIN_DAY_KM}" step="1" value="${length}" data-day-distance
                 aria-label="Day ${day.index + 1} distance in km" /> km
        </label>

        <div class="day-panel__field day-panel__overnight">
          <span>Overnight</span>
          ${overnight(day)}
        </div>
        ${snapNote(day)}

        <h3 class="day-panel__section">Legs <span class="pois__count">${length} km total</span></h3>
        ${legs(day, breaks)}

        <div id="custom-stop-prompt"${customStopDraft ? '' : ' hidden'}></div>
        <p class="day-panel__hint">Click the route on the map to add a stop to this day.</p>
        <div class="day-panel__actions">
          <button type="button" class="btn btn--sm" data-action="split-day" ${canSplit ? '' : 'disabled'}
                  title="${canSplit ? 'Split this day in two' : `Too short to split (needs ${2 * MIN_DAY_KM} km)`}">Split day</button>
          <button type="button" class="btn btn--sm btn--danger" data-action="delete-day">Delete day</button>
        </div>
      </div>`;
    // Built after the innerHTML swap so the prompt's own listeners survive it.
    renderCustomStopPrompt(customStopDraft, day, callbacks, el.querySelector('#custom-stop-prompt'));
  }

  el.addEventListener('change', (e) => {
    if (!e.target.matches('[data-day-distance]') || !current.day) return;
    const value = Number(e.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    callbacks.onEditDay?.(current.day.index, value);
  });

  el.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-action="edit-break"]');
    if (edit) return startBreakEdit(edit, callbacks);
    const remove = e.target.closest('[data-action="remove-break"]');
    if (remove) return callbacks.onRemoveBreak?.(remove.dataset.breakKey);
    if (!current.day) return;
    const index = current.day.index;
    if (e.target.closest('[data-action="split-day"]')) return callbacks.onSplitDay?.(index);
    if (e.target.closest('[data-action="delete-day"]')) return callbacks.onDeleteDay?.(index);
    if (e.target.closest('[data-action="focus-prev"]')) return callbacks.onFocusDay?.(index - 1);
    if (e.target.closest('[data-action="focus-next"]')) return callbacks.onFocusDay?.(index + 1);
  });

  return { render };
}
```

`startBreakEdit` takes `callbacks` as a second parameter now (it used to close over `ui.js`'s `callbacks`); update its `callbacks.onEditBreak` call site accordingly. Keep its comment about the unchanged-value restore path — that behaviour (a plain blur must not eat the next click) is load-bearing.

- [ ] **Step 4: Add the panel styles**

Append to `src/style.css`:

```css
/* --- Focused day panel --------------------------------------------------- */
.day-panel {
  padding: 14px var(--pad) 20px;
}

.day-panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.day-panel__title {
  font-family: var(--serif);
  font-size: 26px;
  font-weight: 600;
  margin: 0;
}

.day-panel__stepper {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-faint);
}

.day-panel__from {
  font-size: 12px;
  font-style: italic;
  color: var(--text-dim);
  margin: 2px 0 14px;
}

.day-panel__field {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 8px 10px;
  margin-bottom: 7px;
  font-size: 12px;
  color: var(--text-dim);
}

.day-panel__field > span:first-child {
  flex: 1;
}

.day-panel__field input[type="number"] {
  width: 68px;
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  text-align: right;
  color: var(--text);
  background: var(--surface-hi);
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 3px 6px;
}

.day-panel__overnight {
  flex-wrap: wrap;
}

.day-panel__overnight-name {
  color: var(--town);
  font-size: 13px;
}

.day-panel__overnight-name--none {
  color: var(--text-faint);
  font-style: italic;
}

.day-panel__hint {
  flex: 1 0 100%;
  font-size: 11px;
  color: var(--text-faint);
  margin: 2px 0 0;
}

.day-panel__snap-note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--town);
  background: rgba(246, 167, 35, 0.09);
  border-left: 2px solid var(--town);
  border-radius: 0 6px 6px 0;
  padding: 6px 9px;
  margin: 0 0 8px;
}

.day-panel__section {
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin: 16px 0 6px;
  display: flex;
  justify-content: space-between;
}

.day-panel__actions {
  display: flex;
  gap: 6px;
  margin-top: 14px;
}
```

- [ ] **Step 5: Wire it into `main.js` and drop the old sections**

In `src/main.js`, import and create the panel next to the `createStrip` call from Task 9:

```js
import { createDayPanel } from './day-panel.js';

  const dayPanel = createDayPanel({
    el: document.getElementById('day-panel'),
    callbacks: {
      onEditDay: handleEditDay,
      onSplitDay: handleSplitDay,
      onDeleteDay: handleDeleteDay,
      onFocusDay: handleFocusDay,
      onRemoveBreak: handleRemoveBreak,
      onEditBreak: handleEditBreak,
      onAddCustomStop: handleAddCustomStop,
      onCancelCustomStop: handleCancelCustomStop,
    },
  });
```

Then replace the `renderCommitted` / `renderPending` / `renderDayMode` trio with a single focused-day render, and add the three new handlers:

```js
  function renderDayPanel() {
    const day = focusedDay();
    dayPanel.render({
      day,
      dayCount: itinerary.getDays().length,
      breaks: day ? breaksForDay(day) : [],
      fromName: day ? fromNameFor(day.index) : 'Hamburg',
      customStopDraft,
    });
  }

  // "from X" for a day: the previous day's overnight town, "Hamburg" for day 0,
  // "your last stop" when the previous day has no town chosen.
  function fromNameFor(index) {
    if (index === 0) return 'Hamburg';
    return itinerary.getDays()[index - 1].townChoice?.name ?? 'your last stop';
  }

  function handleSplitDay(index) {
    if (!itinerary.splitDay(index)) return; // too short — model refused
    persistPlan();
    renderAll();
  }

  function handleDeleteDay(index) {
    itinerary.deleteDay(index);
    focusedDayIndex = null; // clampFocus picks the nearest surviving day
    persistPlan();
    renderAll();
  }

  function handleEditDay(index, target) {
    itinerary.editDay(index, target);
    persistPlan();
    renderAll();
  }
```

`renderAll` becomes:

```js
  function renderAll() {
    clampFocus();
    renderStrip();
    renderDayPanel();
    renderPlaces();
    map.setDayPins(
      itinerary.getDays().map((day) => ({ index: day.index, coord: pointAtDistance(route, day.endKm) })),
    );
    map.setBreakMarkers(itinerary.getBreaks());
  }
```

(`renderPlaces` arrives in Task 11; until then keep calling the existing `renderPending` and `renderFavoritesSection` so the left panel still works.)

Delete `pendingTarget`, `pendingTown`, `selectedDayIndex`, `selectedDay`, `exitDayMode`, `pendingStartKm`, `pendingFromName`, `handlePendingChange`, `handleCommit`, `handleRemoveLast`, `handleAddStops`, `handleExitDayMode`, and the `renderDayMode` function.

**Keep** `hasReachedDresden` (the strip's finish state uses it), `DEFAULT_TARGET_KM` (the first day's fallback length), and `customStopDraft` with `handleAddCustomStop` / `handleCancelCustomStop` — the stop-label prompt survives the removal of day mode, it just renders inside the day panel now and always targets the focused day. Change `handleCancelCustomStop` and `handleAddCustomStop` to call `renderAll()` instead of `renderPending()`, and make `handleAddCustomStop` read the focused day rather than `selectedDay()`.

In `src/ui.js`, delete `renderControls`, `renderCustomStopPrompt`, `renderPendingBreaks`, `renderItinerary`, `dayLegs`, `dayFromName`, `setPendingTarget`, the `controlsEl.innerHTML` block and every listener bound to it, and remove them from the returned object.

- [ ] **Step 6: Run the suite and verify in the browser**

Run: `npm test` — expected PASS.
Run: `npm run dev` — expected: the right panel shows only the focused day; clicking a strip block switches it; typing a distance resizes locally; Split and Delete work; `‹ ›` steps between days; a break at km 0 reads "at the start".

- [ ] **Step 7: Commit**

```bash
git add src/day-panel.js src/day-panel.test.js src/main.js src/ui.js src/style.css
git commit -F - <<'EOF'
feat: right panel holds only the focused day

Replaces the pending-day controls and the scrolling itinerary with a single
day editor: distance, overnight, legs, split, delete, and a focus stepper.
Removes the commit flow, day mode and the pending-breaks list.
EOF
```

---

## Task 11: The left panel

**Files:**
- Create: `src/places.js`, `src/places.test.js`
- Modify: `src/main.js`, `src/ui.js`, `src/style.css`

- [ ] **Step 1: Write the failing test**

Create `src/places.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPlaces } from './places.js';

let el;
let callbacks;

function mount() {
  el = document.createElement('div');
  document.body.appendChild(el);
  callbacks = {
    onSelectTown: vi.fn(),
    onSelectPoi: vi.fn(),
    onToggleBreak: vi.fn(),
    onToggleFavorite: vi.fn(),
    onPoiRowHover: vi.fn(),
  };
  return createPlaces({ el, callbacks });
}

function town(name, km, offsetKm = 0.5) {
  return { name, place: 'village', routeDistanceKm: km, offsetKm, lat: 53, lng: 10 };
}

function poi(name, km, kind = 'food') {
  return { name, kind, category: 'cafe', routeDistanceKm: km, offsetKm: 0.2, lat: 53, lng: 10 };
}

const STRETCH = { dayNumber: 3, startKm: 160, endKm: 265, fromName: 'Lenzen' };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('createPlaces - scoping', () => {
  it('says which day the lists belong to', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: [], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.querySelector('.places__scope').textContent).toContain('Day 3');
    expect(el.querySelector('.places__scope').textContent).toContain('km 160 → 265');
  });
});

describe('createPlaces - overnight candidates', () => {
  it('lists candidates with day-relative distance', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [town('Rosenhof', 265, 0.4)],
      food: [], sights: [], favorites: [],
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    const row = el.querySelector('[data-place-section="town"]');
    expect(row.textContent).toContain('Rosenhof');
    expect(row.textContent).toContain('105 km from Lenzen');
    expect(row.textContent).toContain('0.4 km off route');
  });

  it('chooses a town as the overnight on a body click', () => {
    const places = mount();
    const t = town('Rosenhof', 265);
    places.render({ ...STRETCH, towns: [t], food: [], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    el.querySelector('[data-place-section="town"] .town__name').click();

    expect(callbacks.onSelectTown).toHaveBeenCalledWith(t);
  });

  it('marks the town that is already the overnight choice', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [town('Rosenhof', 265)],
      selectedTownKey: 'Rosenhof@265',
      food: [], sights: [], favorites: [],
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    expect(el.querySelector('[data-place-section="town"]').classList.contains('town--selected')).toBe(true);
  });
});

describe('createPlaces - row actions', () => {
  it('toggles a break and a favorite without triggering the body action', () => {
    const places = mount();
    const p = poi('Café Elbterrasse', 195);
    places.render({ ...STRETCH, towns: [], food: [p], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    const row = el.querySelector('[data-place-section="food"]');
    row.querySelector('[data-action="break"]').click();
    row.querySelector('[data-action="fav"]').click();

    expect(callbacks.onToggleBreak).toHaveBeenCalledWith(p);
    expect(callbacks.onToggleFavorite).toHaveBeenCalledWith(p);
    expect(callbacks.onSelectPoi).not.toHaveBeenCalled();
  });

  it('reflects break and favorite state on the buttons', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [], sights: [], favorites: [],
      food: [poi('Café Elbterrasse', 195)],
      breakKeys: new Set(['Café Elbterrasse@195']),
      favoriteKeys: new Set(['food:Café Elbterrasse@195']),
    });

    const row = el.querySelector('[data-place-section="food"]');
    expect(row.querySelector('[data-action="break"]').getAttribute('aria-pressed')).toBe('true');
    expect(row.querySelector('[data-action="fav"]').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('createPlaces - the 40-row cap', () => {
  const many = Array.from({ length: 451 }, (_, i) => poi(`Place ${i}`, 161 + i * 0.2));

  it('renders 40 rows and says how many there are', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many, sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(40);
    expect(el.querySelector('.places__more').textContent).toContain('showing 40 nearest of 451');
  });

  it('expands to the full list when asked', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many, sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    el.querySelector('[data-action="show-all"]').click();

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(451);
    expect(el.querySelector('.places__more')).toBeNull();
  });

  it('collapses back to 40 when the focused day changes', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many, sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });
    el.querySelector('[data-action="show-all"]').click();

    places.render({ ...STRETCH, dayNumber: 4, startKm: 265, endKm: 320, towns: [], food: many, sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(40);
  });

  it('shows no footer when a section fits', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many.slice(0, 12), sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.querySelector('.places__more')).toBeNull();
  });
});

describe('createPlaces - missing POI data', () => {
  it('says the data is missing instead of pretending the stretch is empty', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [town('Rosenhof', 265)],
      food: [], sights: [], favorites: [],
      poisMissing: true,
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    expect(el.querySelector('.pois__note').textContent).toContain('npm run build:data');
    expect(el.querySelector('.pois--food')).toBeNull();
    // The candidate list is independent of POI data and must still render.
    expect(el.querySelector('[data-place-section="town"]')).not.toBeNull();
  });
});

describe('createPlaces - favorites', () => {
  it('tags each favorite with the day that covers it', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [], food: [], sights: [],
      favorites: [poi('Grenzturm', 213, 'sight'), poi('Far Away', 600, 'sight')],
      days: [{ index: 0, startKm: 0, endKm: 265 }],
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    const rows = [...el.querySelectorAll('[data-place-section="fav"]')];
    expect(rows[0].textContent).toContain('Day 1');
    expect(rows[1].textContent).toContain('beyond plan');
  });

  it('invites a first favorite when there are none', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: [], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.textContent).toContain('Nothing starred yet');
  });
});

describe('createPlaces - hover', () => {
  it('reports a hovered POI once and clears on exit', () => {
    const places = mount();
    const p = poi('Café Elbterrasse', 195);
    places.render({ ...STRETCH, towns: [], food: [p], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    const row = el.querySelector('[data-place-section="food"]');
    row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    expect(callbacks.onPoiRowHover).toHaveBeenCalledTimes(1);

    row.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: el }));
    expect(callbacks.onPoiRowHover).toHaveBeenLastCalledWith(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/places.test.js`
Expected: FAIL — `Failed to resolve import "./places.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/places.js`, consolidating what `ui.js` did across three containers into one. Move these verbatim as private helpers: `townMeta` (`src/ui.js:23-26`), `poiMeta` (`src/ui.js:36-39`), `rowActions` (`492-503`), `dayTagFor` (`651-658`), `highlightPoiRow` (`716-729`). The row markup comes from `renderTowns` (`575-581`), `poiRow` (`587-600`) and `favoriteRow` (`660-677`) with one change: every row carries `data-place-section` + `data-place-index` instead of `data-town-index` / `data-poi-index` / `data-fav-index`, so a single delegated listener replaces the three `wireRowList` calls.

```js
// The left panel: everything you can choose from, windowed to the focused day's
// stretch — favorites, overnight candidates, food, sights. One delegated
// listener serves all four sections. No Leaflet, no data modules: main.js
// windows the lists and passes them in.

import { esc, round1, townKey, poiKey, FAV_GLYPH } from './ui-util.js';

// Presentation-only stopgap: a dense stretch can hold 450+ food POIs, and a
// panel that scrolls 50,000 px is unusable. Ranking/grouping is a separate
// project — until then, show the nearest 40 and say how many there are.
const ROW_CAP = 40;

export function createPlaces({ el, callbacks = {} }) {
  // Rendered rows, per section, so a delegated click can resolve back to the
  // record without re-deriving it (the windowing functions return fresh objects
  // each render, so reference equality can't be used).
  let lists = { fav: [], town: [], food: [], sight: [] };
  let expanded = new Set();
  let scopeKey = '';
  // Last render arguments, so "show all" can re-render the same state with one
  // more section expanded without main.js having to be involved.
  let lastArgs = {};

  function section(name, label, items, emptyText, renderRow) {
    const capped = expanded.has(name) ? items : items.slice(0, ROW_CAP);
    const body = capped.length
      ? capped.map(renderRow).join('')
      : `<p class="pois__empty">${esc(emptyText)}</p>`;
    const more =
      items.length > capped.length
        ? `<p class="places__more">showing ${capped.length} nearest of ${items.length} ·
             <button type="button" data-action="show-all" data-section="${name}">show all</button></p>`
        : '';
    return `
      <details class="pois pois--${name}" open>
        <summary class="pois__summary">${label} <span class="pois__count">(${items.length})</span></summary>
        <div class="pois__body">${body}${more}</div>
      </details>`;
  }

  function townRow(town, i, { startKm, fromName, selectedTownKey, breakKeys, favoriteKeys }) {
    const selected = townKey(town) === selectedTownKey ? ' town--selected' : '';
    const isBreak = breakKeys.has(townKey(town));
    // Favorites use the kind-prefixed key shape; towns carry no kind of their
    // own, so build the lookup the way main.js snapshots them.
    const isFav = favoriteKeys.has(`town:${townKey(town)}`);
    return `
      <div class="town${selected}" role="button" tabindex="0"
           data-place-section="town" data-place-index="${i}">
        <span class="town__name">${esc(town.name)}</span>
        <span class="town__place">${esc(town.place)}</span>
        ${rowActions(town.name, isBreak, isFav)}
        <span class="town__meta">${townMeta(town, startKm, fromName)}</span>
      </div>`;
  }

  function poiRow(poi, i, kind, { startKm, fromName, breakKeys, favoriteKeys }) {
    const hours = poi.openingHours ? `<span class="poi__hours">${esc(poi.openingHours)}</span>` : '';
    const isBreak = breakKeys.has(poiKey(poi));
    const isFav = favoriteKeys.has(`${kind}:${poiKey(poi)}`);
    return `
      <div class="poi poi--${kind}" role="button" tabindex="0"
           data-place-section="${kind}" data-place-index="${i}" data-poi-key="${esc(poiKey(poi))}">
        <span class="poi__name">${esc(poi.name)}</span>
        <span class="poi__cat">${esc(poi.category.replace(/_/g, ' '))}</span>
        ${rowActions(poi.name, isBreak, isFav)}
        <span class="poi__meta">${poiMeta(poi, startKm, fromName)}</span>
        ${hours}
      </div>`;
  }

  function favRow(fav, i, { days, breakKeys }) {
    const glyph = FAV_GLYPH[fav.kind] || '⭐';
    const cat = fav.category ? `<span class="poi__cat">${esc(fav.category.replace(/_/g, ' '))}</span>` : '';
    const tag = dayTagFor(fav, days);
    const beyond = tag === 'beyond plan' ? ' fav-day--beyond' : '';
    // ⭐ is always active here (every row IS a favorite); ☕ reflects whether the
    // place is currently a committed break, matched on the non-prefixed key.
    return `
      <div class="poi poi--fav" role="button" tabindex="0"
           data-place-section="fav" data-place-index="${i}">
        <span class="poi__name">${glyph} ${esc(fav.name)}</span>
        ${cat}
        ${rowActions(fav.name, breakKeys.has(poiKey(fav)), true)}
        <span class="poi__meta">km ${round1(fav.routeDistanceKm)} <span class="fav-day${beyond}">${tag}</span></span>
      </div>`;
  }

  function render(args = {}) {
    lastArgs = args;
    const {
      dayNumber = null,
      startKm = 0,
      endKm = 0,
      fromName = 'your last stop',
      towns = [],
      selectedTownKey = null,
      food = [],
      sights = [],
      favorites = [],
      days = [],
      breakKeys,
      favoriteKeys,
      poisMissing = false,
    } = args;
    const breakSet = breakKeys instanceof Set ? breakKeys : new Set(breakKeys || []);
    const favSet = favoriteKeys instanceof Set ? favoriteKeys : new Set(favoriteKeys || []);
    // A different stretch is a different question — collapse expanded sections
    // back to the cap so switching days never inherits a 451-row list.
    const nextScope = `${startKm}:${endKm}`;
    if (nextScope !== scopeKey) {
      scopeKey = nextScope;
      expanded = new Set();
    }
    lists = { fav: favorites, town: towns, food, sight: sights };

    const ctx = { startKm, fromName, selectedTownKey, breakKeys: breakSet, favoriteKeys: favSet };
    const scope = dayNumber
      ? `<span><b>On the way</b> · Day ${dayNumber}</span>
         <span class="places__scope-range">km ${round1(startKm)} → ${round1(endKm)}</span>`
      : '<span><b>On the way</b></span><span class="places__scope-range">no day focused</span>';

    // POI data is optional (build:data may never have run); the food and sight
    // sections say so rather than pretending the stretch is empty.
    const poiSections = poisMissing
      ? '<p class="pois__note">No POI data — run npm run build:data</p>'
      : section('food', '☕ Food on the way', food, 'No food stops on this stretch.', (p, i) => poiRow(p, i, 'food', ctx)) +
        section('sight', '📷 Worth seeing', sights, 'No sights on this stretch.', (p, i) => poiRow(p, i, 'sight', ctx));

    el.innerHTML = `
      <div class="places__scope">${scope}</div>
      ${section('fav', '⭐ Favorites', favorites, 'Nothing starred yet — hit ⭐ on any place.', (f, i) => favRow(f, i, { days, breakKeys: breakSet }))}
      ${section('town', '🛏 Overnight options', towns, 'No towns near this stretch.', (t, i) => townRow(t, i, ctx))}
      ${poiSections}`;
  }

  // One delegated listener for all four sections. A body click runs the section's
  // select callback; a click on a nested [data-action] button runs break/fav and
  // stops there, so the body action doesn't also fire.
  el.addEventListener('click', (e) => {
    const showAll = e.target.closest('[data-action="show-all"]');
    if (showAll) {
      expanded.add(showAll.dataset.section);
      render(lastArgs); // scope is unchanged, so `expanded` survives
      return;
    }
    const row = e.target.closest('[data-place-section]');
    if (!row) return;
    const place = lists[row.dataset.placeSection]?.[Number(row.dataset.placeIndex)];
    if (!place) return;
    const action = e.target.closest('[data-action]');
    if (action) {
      e.stopPropagation();
      if (action.dataset.action === 'break') callbacks.onToggleBreak?.(place);
      else if (action.dataset.action === 'fav') callbacks.onToggleFavorite?.(place);
      return;
    }
    if (row.dataset.placeSection === 'town') callbacks.onSelectTown?.(place);
    else callbacks.onSelectPoi?.(place);
  });

  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-place-section]');
    if (!row || e.target !== row) return; // inner action buttons handle their own keys
    e.preventDefault();
    row.click();
  });
```

The hover listeners move across from `src/ui.js:326-343` unchanged apart from the selector (`[data-place-section]` instead of `[data-poi-index]`, resolving through `lists`), and the module returns `{ render, highlightPoiRow }`.

Note the `show-all` handler calls `expanded.add(...)` and then re-renders through `callbacks.onExpandSection` — `main.js` wires that to `renderPlaces()`. This keeps the module free of a self-render path, matching how every other panel here works.

- [ ] **Step 4: Wire into `main.js`, delete the old left-panel code**

In `src/main.js` replace `renderPending` / `drawPois` / `renderFavoritesSection` with:

```js
  // The left panel is scoped to the focused day: candidates, food and sights all
  // come from that stretch. With no days yet, only favorites make sense.
  function renderPlaces() {
    const day = focusedDay();
    const breakKeys = new Set(itinerary.getBreaks().map(breakKey));
    const favoriteKeys = new Set(favorites.list().map(favKey));
    const favs = favorites.list();
    const startKm = day ? day.startKm : 0;
    const endKm = day ? day.endKm : 0;
    const food = day && !poisMissing ? poisInRange(poiData, startKm, endKm, { kind: 'food' }) : [];
    const sights = day && !poisMissing ? poisInRange(poiData, startKm, endKm, { kind: 'sight' }) : [];

    places.render({
      dayNumber: day ? day.index + 1 : null,
      startKm,
      endKm,
      fromName: day ? fromNameFor(day.index) : 'Hamburg',
      towns: day ? townsNear(towns, day.endKm) : [],
      selectedTownKey: day?.townChoice ? townKey(day.townChoice) : null,
      food,
      sights,
      favorites: favs,
      days: itinerary.getDays(),
      breakKeys,
      favoriteKeys,
      poisMissing,
    });
    map.setPoiMarkers([...food, ...sights]);
    map.setFavoriteMarkers(favs);
  }
```

`handleSelectTown` becomes: set the town on the **focused** day (which snaps the boundary), persist, re-render, pan the map.

```js
  function handleSelectTown(town) {
    const day = focusedDay();
    if (!day) return;
    itinerary.setTownChoice(day.index, town);
    persistPlan();
    renderAll();
    map.panTo([town.lng, town.lat]);
  }
```

Delete `ui.js`'s `renderTowns`, `renderPois`, `renderFavorites`, `renderPoisNote`, `highlightPoiRow`, `rowActions`, `wireRowList`, `poiRow`, `poiSection`, `favoriteRow`, `dayTagFor`, `townMeta`, `poiMeta` and the hover listeners, along with their entries in the returned object. `main.js` now calls `places.highlightPoiRow(...)` for the marker-hover path.

- [ ] **Step 5: Move the left-panel CSS**

The existing `.poi`, `.town`, `.row-action*`, `.pois__*` rules already match the moved markup, so keep them. Add:

```css
.places__scope {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 10px var(--pad);
  background: #1d1a14;
  border-bottom: 1px solid var(--line-soft);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.places__scope b {
  color: var(--text);
}

.places__scope-range {
  color: var(--river);
  letter-spacing: 0.04em;
  text-transform: none;
}

.places__more {
  font-size: 11px;
  color: var(--text-faint);
  text-align: center;
  margin: 8px 0 2px;
}

.places__more button {
  font: inherit;
  color: var(--river);
  background: none;
  border: none;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
}
```

- [ ] **Step 6: Run the suite and verify**

Run: `npm test` — expected PASS.
Run: `npm run dev` — expected: left panel headed with the focused day and its km range; the four sections present; food capped at 40 with the footer; `show all` expands; switching focus collapses it again; clicking a candidate sets the overnight town **and** resizes the day (the strip block visibly changes width).

- [ ] **Step 7: Commit**

```bash
git add src/places.js src/places.test.js src/main.js src/ui.js src/style.css
git commit -F - <<'EOF'
feat: one left panel scoped to the focused day

Overnight candidates join favorites, food and sights in a single container, all
windowed to the focused day's stretch. Each section caps at 40 rows with a
"showing 40 nearest of N" footer as a stopgap until the lists are properly
tamed.
EOF
```

---

## Task 12: Plans bar into the header

**Files:**
- Create: `src/plans-bar.js`
- Modify: `src/ui.js`, `src/main.js`, `src/style.css`

- [ ] **Step 1: Move the module**

Create `src/plans-bar.js` holding `renderPlans`, the `currentPlans` / `activePlanId` tracking, `activePlanName`, and the two `plansEl` listeners — all four moved verbatim from `src/ui.js:222-259` (state + listeners) and `src/ui.js:684-705` (`renderPlans`), with `plansEl` renamed to `el` and `renderPlans` renamed to `render`:

```js
// The plans control: a dropdown of every plan, a rename field, and
// New / Duplicate / Delete. Trip-level, so it lives in the app header rather
// than in the day panel.

import { esc } from './ui-util.js';

export function createPlansBar({ el, callbacks = {} }) {
  // The bar is re-rendered wholesale by render(); currentPlans/activePlanId
  // track what's shown so an empty rename can revert to the canonical name and
  // Delete can label its confirm with the active plan's name.
  let currentPlans = [];
  let activePlanId = null;

  function activePlanName() { /* verbatim from ui.js:225-228 */ }

  el.addEventListener('change', (e) => { /* verbatim from ui.js:230-244 */ });
  el.addEventListener('click', (e) => { /* verbatim from ui.js:246-259 */ });

  function render({ plans = [], activePlanId: activeId = null } = {}) {
    /* verbatim from ui.js:684-705 */
  }

  return { render };
}
```

The four `/* verbatim */` bodies are copied byte-for-byte from those line ranges — no logic changes, only the `plansEl` → `el` rename. Confirm afterwards that `git diff` shows no behavioural edit inside them.

- [ ] **Step 2: Compose it from `ui.js`**

`ui.js` is now only a facade. Its whole body becomes:

```js
// Facade over the panel modules. main.js talks to this one object, so the
// render surface stays in one place while each module owns a single area.

import { createStrip } from './strip.js';
import { createDayPanel } from './day-panel.js';
import { createPlaces } from './places.js';
import { createPlansBar } from './plans-bar.js';
import { townKey, poiKey } from './ui-util.js';

// Re-exported: src/itinerary.test.js's cross-module key contract test imports
// these from here, and main.js has always taken them from ui.js.
export { townKey, poiKey };

export function createUI({ stripEl, dayPanelEl, placesEl, plansEl, bannerEl, callbacks = {} }) {
  const strip = createStrip({ el: stripEl, callbacks });
  const dayPanel = createDayPanel({ el: dayPanelEl, callbacks });
  const places = createPlaces({ el: placesEl, callbacks });
  const plansBar = createPlansBar({ el: plansEl, callbacks });

  // The route-changed banner is the only DOM the facade owns itself: two lines,
  // and no module to justify.
  function hideBanner() {
    bannerEl.hidden = true;
    bannerEl.innerHTML = '';
  }

  function showBanner(message) {
    bannerEl.innerHTML = `
      <span>${message}</span>
      <button type="button" class="banner__dismiss" aria-label="Dismiss">×</button>`;
    bannerEl.hidden = false;
    bannerEl.querySelector('.banner__dismiss').addEventListener('click', hideBanner);
  }

  return {
    renderStrip: strip.render,
    renderDay: dayPanel.render,
    renderPlaces: places.render,
    renderPlans: plansBar.render,
    highlightPoiRow: places.highlightPoiRow,
    showBanner,
    hideBanner,
  };
}
```

Then in `src/main.js`: delete the standalone `createStrip`, `createDayPanel` and `createPlaces` calls from Tasks 9-11 (the facade owns all three now), pass every callback through the single `createUI(...)` call, and update the element names:

```js
  const ui = createUI({
    stripEl: document.getElementById('strip'),
    dayPanelEl: document.getElementById('day-panel'),
    placesEl: document.getElementById('places'),
    plansEl: document.getElementById('plans'),
    bannerEl: document.getElementById('banner'),
    callbacks: {
      onFocusDay: handleFocusDay,
      onMoveBoundary: handleMoveBoundary,
      onAddDay: handleAddDay,
      onEditDay: handleEditDay,
      onSplitDay: handleSplitDay,
      onDeleteDay: handleDeleteDay,
      onRemoveBreak: handleRemoveBreak,
      onEditBreak: handleEditBreak,
      onAddCustomStop: handleAddCustomStop,
      onCancelCustomStop: handleCancelCustomStop,
      onSelectTown: handleSelectTown,
      onSelectPoi: handleSelectPoi,
      onToggleBreak: handleToggleBreak,
      onToggleFavorite: handleToggleFavorite,
      onPoiRowHover: (poi) => map.setPoiHighlight(poi),
      onSelectPlan: handleSelectPlan,
      onRenamePlan: handleRenamePlan,
      onNewPlan: handleNewPlan,
      onDuplicatePlan: handleDuplicatePlan,
      onDeletePlan: handleDeletePlan,
    },
  });
```

Rename the call sites accordingly: `strip.render(...)` → `ui.renderStrip(...)`, `dayPanel.render(...)` → `ui.renderDay(...)`, `places.render(...)` → `ui.renderPlaces(...)`, and the map-hover path to `ui.highlightPoiRow(...)`. `onSelectFavorite` is gone — a favorite row's body click resolves to `onSelectPoi` inside `places.js`.

- [ ] **Step 3: Style the header plans bar**

Replace the `.plans__bar` rule so it sits inline in the header (`display: flex; align-items: center; gap: 6px;` with no card background or bottom border), keeping `.plans__select`, `.plans__name` and `.plans__actions` as they are.

- [ ] **Step 4: Run the suite and verify**

Run: `npm test` — expected PASS.
Run: `npm run dev` — expected: plans control in the top-right; switch, rename, New, Duplicate, Delete all behave as before, and switching a plan focuses the new plan's last day.

- [ ] **Step 5: Commit**

```bash
git add src/plans-bar.js src/ui.js src/main.js src/style.css
git commit -m "refactor: plans bar into the header, ui.js becomes a facade"
```

---

## Task 13: The map follows the focused day

**Files:**
- Modify: `src/map.js`, `src/main.js`, `src/style.css`

- [ ] **Step 1: Extend `map.js`**

Add to `createMap`:

```js
  // The focused day's stretch, drawn thick over the muted full route so the
  // rest of the trip stays as context rather than competing with it.
  let highlightLayer = null;

  function setRouteHighlight(coords) {
    if (highlightLayer) {
      map.removeLayer(highlightLayer);
      highlightLayer = null;
    }
    if (!coords || coords.length < 2) return;
    highlightLayer = L.polyline(coords.map(toLatLng), {
      renderer,
      color: '#2563eb',
      weight: 7,
      opacity: 0.95,
      lineCap: 'round',
    }).addTo(map);
  }

  // Frames a stretch. `animate` is false while a boundary is being dragged and
  // when the user prefers reduced motion.
  function focusRange(coords, { animate = true } = {}) {
    if (!coords || !coords.length) return;
    const bounds = L.latLngBounds(coords.map(toLatLng));
    map.fitBounds(bounds, { padding: [48, 48], animate, maxZoom: 13 });
  }

  function fitWholeRoute({ animate = true } = {}) {
    map.fitBounds(routeLayer.getBounds(), { padding: [28, 28], animate });
  }

  /** True when `lngLat` sits inside the viewport shrunk by `inset` (0..0.5). */
  function isWellInsideView(lngLat, inset = 0.12) {
    const bounds = map.getBounds().pad(-inset);
    return bounds.contains(toLatLng(lngLat));
  }

  // Draggable boundary pins: the map's twin of the strip handles. Dragging emits
  // the snapped route km continuously (commit false) and once on release.
  function setDayPins(pins, { draggable = false, onDragBoundary } = {}) {
    dayPinLayer.clearLayers();
    (pins || []).forEach(({ index, coord }) => {
      const marker = L.marker(toLatLng(coord), {
        icon: numberedPinIcon(String(index + 1), 'day'),
        zIndexOffset: 500,
        draggable,
        title: draggable ? `Day ${index + 1} — drag to move this overnight` : `Day ${index + 1}`,
      });
      if (draggable && typeof onDragBoundary === 'function') {
        marker.on('drag', (e) => onDragBoundary(index, [e.latlng.lng, e.latlng.lat], false));
        marker.on('dragend', (e) => onDragBoundary(index, [e.target.getLatLng().lng, e.target.getLatLng().lat], true));
      }
      marker.addTo(dayPinLayer);
    });
  }
```

Mark the route dashed and muted by changing `ROUTE_STYLE` to `{ color: '#2563eb', weight: 3, opacity: 0.5, dashArray: '7 6' }`. Delete `setGhost`, `GHOST_ICON` and their entry in the returned object; add `setRouteHighlight`, `focusRange`, `fitWholeRoute`, `isWellInsideView`. Replace the initial `map.fitBounds(...)` call with `fitWholeRoute({ animate: false })`. Also delete the `.ghost-icon` rules from `style.css`.

- [ ] **Step 2: Add the map overlay controls**

In `index.html`, inside `<div id="map">`, add:

```html
      <div id="map-controls">
        <button type="button" class="map-btn" data-action="focus-day">⤢ this day</button>
        <button type="button" class="map-btn" data-action="whole-route">⤢ whole route</button>
      </div>
```

Style `#map-controls` as an absolutely positioned column at `top: 10px; right: 10px; z-index: 500` (above Leaflet's panes) with `.map-btn` matching the dark translucent chips from the mockup.

- [ ] **Step 3: Own the camera policy in `main.js`**

```js
  // Camera policy: fit the focused stretch when focus changes; during a drag
  // only pan when the moving end is about to leave the viewport, then fit on
  // release. A manual pan/zoom hands control back to the user until focus moves.
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let cameraFollows = true;
  let lastFocusedFramed = null;

  function focusedCoords(day) {
    if (!day) return [];
    const step = Math.max(1, (day.endKm - day.startKm) / 60);
    const coords = [];
    for (let km = day.startKm; km < day.endKm; km += step) coords.push(pointAtDistance(route, km));
    coords.push(pointAtDistance(route, day.endKm));
    return coords;
  }

  function renderCamera({ dragging = false } = {}) {
    const day = focusedDay();
    map.setRouteHighlight(focusedCoords(day));
    if (!day) {
      if (cameraFollows) map.fitWholeRoute({ animate: !prefersReducedMotion });
      return;
    }
    if (!cameraFollows) return;
    if (dragging) {
      // Don't fight the drag: only nudge when the boundary nears the edge.
      if (!map.isWellInsideView(pointAtDistance(route, day.endKm))) {
        map.panTo(pointAtDistance(route, day.endKm));
      }
      return;
    }
    if (lastFocusedFramed === day.index && !dragging) return;
    lastFocusedFramed = day.index;
    map.focusRange(focusedCoords(day), { animate: !prefersReducedMotion });
  }
```

Call `renderCamera()` at the end of `renderAll`, and `renderCamera({ dragging: true })` from `handleMoveBoundary` when `commit` is false (with a plain `renderCamera()` on commit, after resetting `lastFocusedFramed = null` so the release reframes). Wire the two overlay buttons: `focus-day` sets `cameraFollows = true; lastFocusedFramed = null; renderCamera();`, `whole-route` sets `cameraFollows = false; map.fitWholeRoute();`.

A manual pan or zoom hands control back to the user, which means telling a *user* move apart from one the app just made. Add this to `map.js` — every programmatic move goes through `moveProgrammatically`, so the `dragend`/`zoomend` handler can tell the difference:

```js
  // fitBounds/panTo also fire dragend/zoomend, which would look exactly like the
  // user taking over. Flag our own moves and clear the flag once they settle.
  let programmatic = false;

  function moveProgrammatically(fn) {
    programmatic = true;
    fn();
    map.once('moveend zoomend', () => {
      programmatic = false;
    });
  }

  map.on('dragend zoomend', () => {
    if (!programmatic && typeof onUserMove === 'function') onUserMove();
  });
```

Take `onUserMove` in `createMap`'s options, and wrap the bodies of `focusRange`, `fitWholeRoute` and `panTo` in `moveProgrammatically(() => { ... })`. In `main.js`, pass `onUserMove: () => { cameraFollows = false; }`.

Replace `handleRouteClick` entirely — a route click now always adds a stop to the focused day:

```js
  // A route click adds a stop to the focused day. Moving a boundary is dragging
  // its pin or its strip handle — the click no longer means two different things
  // depending on a mode.
  function handleRouteClick(lngLat) {
    const day = focusedDay();
    if (!day) return;
    const { distanceKm } = snap(route, lngLat);
    const km = Math.round(distanceKm * 10) / 10;
    const lower = day.startKm === 0 ? -1 : day.startKm;
    if (km <= lower || km > day.endKm) return;
    const [lng, lat] = pointAtDistance(route, km);
    customStopDraft = { km, lat, lng };
    renderAll();
  }
```

`customStopDraft` and the label prompt are already in place from Task 10 — this step only changes what a route click means (any focused day, not just one in day mode).

Wire the draggable pins:

```js
    map.setDayPins(
      itinerary.getDays().map((day) => ({ index: day.index, coord: pointAtDistance(route, day.endKm) })),
      {
        draggable: true,
        onDragBoundary: (index, lngLat, commit) => {
          const { distanceKm } = snap(route, lngLat);
          handleMoveBoundary(index, Math.round(distanceKm * 10) / 10, { commit });
        },
      },
    );
```

- [ ] **Step 4: Verify in the browser**

Run: `npm run dev`. Expected: the focused day's stretch is thick and blue against the dashed rest; focusing another day reframes the map; dragging a strip handle keeps the endpoint visible without the map jumping, then reframes on release; dragging a numbered pin resizes the day; a manual pan stops the auto-fit until `⤢ this day`; `⤢ whole route` zooms out; clicking the route adds a stop to the focused day and the label prompt appears in the day panel.

- [ ] **Step 5: Commit**

```bash
git add index.html src/map.js src/main.js src/style.css
git commit -F - <<'EOF'
feat: map follows the focused day

Fits the focused stretch and draws it over a muted dashed route; numbered pins
become draggable boundaries. During a drag the camera only nudges when the
moving end nears the viewport edge, and a manual pan hands control back until
focus changes. Route clicks now mean exactly one thing: add a stop.
EOF
```

---

## Task 14: Cleanup, docs and a full verification pass

**Files:**
- Modify: `src/style.css`, `README.md`, `docs/superpowers/plans/2026-07-26-timeline-layout.md`

- [ ] **Step 1: Delete dead CSS**

Remove every rule for markup that no longer exists: `#pending-block`, `#pending-heading`, `.controls__*`, `.pending-break*`, `#day-mode`, `.day-mode__hint`, `.summary*` (the strip owns progress now), `.itinerary__*`, `.day-list`, `.day-card` shell rules that the day panel doesn't use, `#panel-left-header`, `#panel-footer`, `.ghost-icon*`, and the `input[type="range"]` slider block. Keep `.day-card__leg*`, `.leg-actions`, `.row-edit`, `.row-remove`, `.poi*`, `.town*`, `.row-action*`, `.banner*`, `.pin-icon*`, `.break-marker*`, `.fav-marker*`, `.town-icon*`, `.poi-marker*`.

Verify nothing was over-deleted:

```bash
grep -o 'class="[^"]*"' src/*.js index.html | grep -o '[a-z][a-z0-9_-]*' | sort -u > /tmp/used-classes.txt
grep -o '^\.[a-z][a-z0-9_-]*' src/style.css | sed 's/^\.//' | sort -u > /tmp/styled-classes.txt
comm -23 /tmp/used-classes.txt /tmp/styled-classes.txt
```

Expected: only class names that are intentionally unstyled (BEM element names used purely as hooks). Anything surprising means a rule was deleted too eagerly.

- [ ] **Step 2: Move the OSM attribution**

The `#panel-footer` credit is gone, so put the ODbL credit in the strip's scale line — in `strip.js`'s `render`, the scale becomes:

```js
    scaleEl.innerHTML = `
      <span>km 0 · Hamburg</span>
      <span class="strip__credit">Route &amp; town data © OpenStreetMap contributors (ODbL) · right-bank Elberadweg</span>
      <span>km ${round1(state.totalKm)} · Dresden</span>`;
```

Add the assertion to `src/strip.test.js`:

```js
  it('keeps the OpenStreetMap credit visible', () => {
    const strip = mount();
    strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });
    expect(el.querySelector('.strip__scale').textContent).toContain('OpenStreetMap');
  });
```

- [ ] **Step 3: Update the README**

Rewrite the bullet list and the "How it works" paragraph: the slider/commit loop becomes the strip loop (add a day, drag its boundary, pick where you sleep), describe local editing ("editing one day resizes its neighbour, never the whole trip"), town snapping, split/delete, the focused-day panel, the always-visible to-scale strip, and the keyboard handles. Delete the ghost-marker and "commit the day" sentences. Keep the localStorage, data-provenance and quick-start sections as they are.

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, every file. Report the final test count in the commit message.

- [ ] **Step 5: Manual verification pass**

At 1512 x 900 with a fresh localStorage, walk the list and confirm each one:

- [ ] Empty state: strip is all dashed remainder, day panel says "No days yet", map fits the whole route.
- [ ] `+ add a day` appends 80 km and focuses it; the day panel and left panel populate.
- [ ] The itinerary is visible **without scrolling** — the whole point of the project.
- [ ] Drag the day 3/4 boundary right: day 3 grows, day 4 shrinks, days 1–2 and everything past day 4 unchanged.
- [ ] Drag a boundary to its limits: it stops 5 km from each neighbour.
- [ ] Tab to a handle, press `→` and `Shift+→`: 1 km and 5 km moves.
- [ ] Pick an overnight candidate: the block resizes to the town's km and the neighbour absorbs it.
- [ ] Type a distance in the day panel: same local behaviour.
- [ ] Split a day, then delete the first half: back where you started.
- [ ] Delete a middle day: it merges into the next, the rest of the trip stays put.
- [ ] Add a break with ☕, give it a note with ✎, remove it with ×.
- [ ] Click the route: a stop is added to the focused day after the label prompt.
- [ ] Reload: the plan comes back and the last day is focused.
- [ ] Switch plans: the day panel, left panel and strip all repoint.
- [ ] `localStorage` writes once per drag, not per pointermove.
- [ ] Plan a route all the way to Dresden: the remainder disappears and the finish marker shows.

- [ ] **Step 6: Commit and push**

```bash
git add -A
git commit -F - <<'EOF'
chore: remove dead pending-day styles, update README for the timeline loop

Deletes the slider, pending-block, day-mode and itinerary-card CSS that no
longer has markup, moves the OpenStreetMap credit into the strip's scale line,
and rewrites the README around the new loop.
EOF
git push
```

---

## Notes for whoever executes this

- **Task order matters.** Tasks 1-8 leave the running app untouched (new modules plus a model change that the old UI still drives correctly). Task 9 is the first visible change, and the app stays usable from there on because the old right-panel controls survive until Task 10 replaces them.
- **The one behaviour change to defend deliberately:** `editDay` goes from ripple to local. If a test fails because a downstream day didn't move, that is the feature.
- **Don't reintroduce a mode.** Every "should this be enabled right now?" question in the new UI should be answerable from `focusedDayIndex` alone.
- **`persistPlan()` is never called mid-drag.** If you find yourself passing `commit` around more widely, that is fine; writing to storage on every `pointermove` is not.
