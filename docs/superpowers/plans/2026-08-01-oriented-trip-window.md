# Oriented Trip Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make a trip an oriented window on the road — a `startKm` and a `destinationKm`, either order — so a rider can start near home and ride Dresden → Hamburg, with distances read from their own start and the day's climb shown on the strip.

**Architecture:** Storage grows two fields per plan; `itinerary.js` and `boundaries.js` become direction-aware; a single `tripKm()` helper translates absolute route km into rider-relative km at every display site; `strip-geometry.js` maps the trip's window rather than the whole road; the map gains a one-shot picking mode; the strip gains a vertical resize handle.

**Tech Stack:** Vanilla JS ESM, Leaflet 1.9, Turf 7, vitest 4 (`npm test`), Vite 8.

**Spec:** `docs/superpowers/specs/2026-08-01-oriented-trip-window-design.md`

**Baseline:** 592 tests passing in 18 files at `b1d778d`. (An earlier figure of 1076 came from running vitest in the main checkout, which swept up duplicate test files inside `.claude/worktrees/` — a stale merged worktree has since been removed. Always run the suite from inside the feature worktree.)

---

## The one invariant to hold in your head

**Stored and computed km are ABSOLUTE route km. Only displayed km are trip-relative.**

Every bug this feature can produce is a violation of that sentence in one direction or the other: an absolute km rendered to a user, or a trip-relative km written to storage. `tripKm()` is the only conversion, it is one-way, and it is called only from markup-producing code.

---

## Phase ordering and why

| Phase | Tasks | Visible to a user? |
| --- | --- | --- |
| 1 — oriented model + storage v4 | 1–4 | No. Every plan spans the whole road, as today. |
| 2 — display translation | 5–6 | No, if phase 1 defaulted correctly. |
| 3 — strip rescale, stubs, climb label | 7–9 | Only once a window is narrower than the road. |
| 4 — picking UI | 10–13 | Yes — this is the feature. |
| 5 — resizable strip | 14–15 | Yes, and independent of 1–4. |

Do not merge before phase 4. Phase 5 may be pulled forward if the profile needs to be readable sooner.

---

## File Structure

**Create:**
- `src/trip.js` — the oriented-window value object and its arithmetic: `createTrip({startKm, destinationKm})` → `{startKm, destinationKm, direction, tripKm, contains, clampKm}`. Pure. This is where `direction` is derived once so that nothing else re-derives it.
- `src/trip.test.js`
- `src/strip-resize.js` — the drag-to-resize behaviour, separated from `strip.js` because that file is already the largest interaction owner in the app and this is an independent gesture.
- `src/strip-resize.test.js`

**Modify:** `src/itinerary.js`, `src/boundaries.js`, `src/strip-geometry.js`, `src/strip.js`, `src/strip-markup.js`, `src/day-panel.js`, `src/places.js`, `src/map.js`, `src/storage.js`, `src/elevation.js`, `src/ui-util.js`, `src/main.js`, `src/style.css`, `index.html`, and each of their test files.

**Why a new `src/trip.js`:** `direction` is needed by itinerary, boundaries, strip-geometry, elevation and every display site. Deriving `destinationKm >= startKm ? 1 : -1` in six places is six chances to get a `>=` wrong on an equal-km edge case. One object, derived once, passed down — the same trade `routeIndex` already makes.

---

## Phase 1 — the oriented model

### Task 1: `createTrip` — the window and its arithmetic

**Files:**
- Create: `src/trip.js`
- Test: `src/trip.test.js`

- [x] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { createTrip } from './trip.js';

describe('createTrip', () => {
  const up = createTrip({ startKm: 149.3, destinationKm: 797.6 });   // Hamburg -> Dresden
  const down = createTrip({ startKm: 797.6, destinationKm: 149.3 }); // Dresden -> Hamburg

  it('derives direction from the order of the ends', () => {
    expect(up.direction).toBe(1);
    expect(down.direction).toBe(-1);
  });

  it('reports the trip length as a positive distance either way', () => {
    expect(up.lengthKm).toBeCloseTo(648.3, 1);
    expect(down.lengthKm).toBeCloseTo(648.3, 1);
  });

  it('translates absolute km into km from the rider’s start', () => {
    expect(up.tripKm(149.3)).toBeCloseTo(0, 6);
    expect(up.tripKm(229.3)).toBeCloseTo(80, 6);
    expect(down.tripKm(797.6)).toBeCloseTo(0, 6);
    expect(down.tripKm(717.6)).toBeCloseTo(80, 6);
  });

  it('translates back, so a picked display km can become storage km', () => {
    expect(up.absoluteKm(80)).toBeCloseTo(229.3, 6);
    expect(down.absoluteKm(80)).toBeCloseTo(717.6, 6);
  });

  it('round-trips any km through both translations', () => {
    for (const km of [149.3, 300, 500.5, 797.6]) {
      expect(up.absoluteKm(up.tripKm(km))).toBeCloseTo(km, 6);
      expect(down.absoluteKm(down.tripKm(km))).toBeCloseTo(km, 6);
    }
  });

  it('knows which absolute km lie inside the window, whichever way it runs', () => {
    expect(up.contains(200)).toBe(true);
    expect(up.contains(100)).toBe(false);
    expect(down.contains(200)).toBe(true);
    expect(down.contains(900)).toBe(false);
  });

  it('includes both endpoints', () => {
    expect(up.contains(149.3)).toBe(true);
    expect(up.contains(797.6)).toBe(true);
  });

  it('clamps an absolute km into the window regardless of direction', () => {
    expect(up.clampKm(50)).toBeCloseTo(149.3, 6);
    expect(up.clampKm(900)).toBeCloseTo(797.6, 6);
    expect(down.clampKm(900)).toBeCloseTo(797.6, 6);
    expect(down.clampKm(50)).toBeCloseTo(149.3, 6);
  });

  it('advances a km along the trip by a positive distance', () => {
    expect(up.advance(149.3, 80)).toBeCloseTo(229.3, 6);
    expect(down.advance(797.6, 80)).toBeCloseTo(717.6, 6);
  });

  it('never advances past the destination', () => {
    expect(up.advance(760, 80)).toBeCloseTo(797.6, 6);
    expect(down.advance(180, 80)).toBeCloseTo(149.3, 6);
  });

  // A zero-length window is the degenerate case every consumer would divide by.
  it('treats an equal-ended window as forward with zero length', () => {
    const nil = createTrip({ startKm: 300, destinationKm: 300 });
    expect(nil.lengthKm).toBe(0);
    expect(nil.direction).toBe(1);
  });

  it('defaults to the whole road when given nothing', () => {
    const whole = createTrip({ totalKm: 1026.5 });
    expect(whole.startKm).toBe(0);
    expect(whole.destinationKm).toBe(1026.5);
    expect(whole.direction).toBe(1);
  });

  it('is frozen, so no consumer can shift the window under another', () => {
    expect(() => { up.startKm = 0; }).toThrow();
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run src/trip.test.js`
Expected: FAIL — `Failed to resolve import "./trip.js"`.

- [x] **Step 3: Implement**

```js
// src/trip.js
//
// The trip: an oriented window on the road. A startKm, a destinationKm, and the
// arithmetic that follows from their order.
//
// THE INVARIANT THIS FILE EXISTS TO PROTECT: stored and computed km are absolute
// route km; only DISPLAYED km are relative to the rider's start. tripKm() is the
// one-way conversion, and it belongs to markup-producing code only.
//
// direction is derived once, here, because itinerary, boundaries, strip-geometry,
// elevation and every display site all need it — and six copies of
// `destinationKm >= startKm ? 1 : -1` is six chances to get an equal-km edge wrong.

import { round1 } from './ui-util.js';

export function createTrip({ startKm = 0, destinationKm, totalKm } = {}) {
  const start = Number.isFinite(startKm) ? startKm : 0;
  const end = Number.isFinite(destinationKm)
    ? destinationKm
    : Number.isFinite(totalKm)
      ? totalKm
      : 0;

  // An equal-ended window has no direction to derive; forward keeps every
  // consumer's sign arithmetic defined rather than producing 0 and NaN downstream.
  const direction = end >= start ? 1 : -1;
  const lengthKm = Math.abs(end - start);
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);

  return Object.freeze({
    startKm: start,
    destinationKm: end,
    direction,
    lengthKm,

    /** Absolute route km -> km as the rider counts it, from their own start. */
    tripKm: (absoluteKm) => (absoluteKm - start) * direction,

    /** km as the rider counts it -> absolute route km. */
    absoluteKm: (riderKm) => start + riderKm * direction,

    contains: (absoluteKm) => absoluteKm >= lo && absoluteKm <= hi,

    clampKm: (absoluteKm) => Math.min(Math.max(absoluteKm, lo), hi),

    /** Move `distanceKm` further along the trip, never past the destination. */
    advance: (absoluteKm, distanceKm) => {
      const next = absoluteKm + distanceKm * direction;
      return direction === 1 ? Math.min(next, end) : Math.max(next, end);
    },
  });
}

/** Whether swapping to these ends would reverse an existing trip's direction. */
export function wouldReverse(trip, { startKm = trip.startKm, destinationKm = trip.destinationKm }) {
  return createTrip({ startKm, destinationKm }).direction !== trip.direction;
}
```

- [x] **Step 4: Run to verify it passes**

Run: `npx vitest run src/trip.test.js`
Expected: PASS, 13 tests.

- [x] **Step 5: Test `wouldReverse` too**

```js
import { wouldReverse } from './trip.js';

describe('wouldReverse', () => {
  const up = createTrip({ startKm: 149.3, destinationKm: 797.6 });

  it('is false for a same-direction change', () => {
    expect(wouldReverse(up, { destinationKm: 600 })).toBe(false);
  });

  it('is true for a destination behind the start', () => {
    expect(wouldReverse(up, { destinationKm: 100 })).toBe(true);
  });

  it('is true for a start beyond the destination', () => {
    expect(wouldReverse(up, { startKm: 900 })).toBe(true);
  });
});
```

Run: `npx vitest run src/trip.test.js` → PASS, 16 tests.

- [x] **Step 6: Commit**

```bash
git add src/trip.js src/trip.test.js
git commit -m "feat(trip): the oriented window and its arithmetic"
```

---

### Task 2: `itinerary.js` chains along the trip

**Files:**
- Modify: `src/itinerary.js`
- Test: `src/itinerary.test.js`

`createItinerary({ totalKm })` becomes `createItinerary({ trip })`.

- [x] **Step 1: Read every existing test before changing anything**

`src/itinerary.test.js` has `const TOTAL_KM = 380` at the top and ~120 cases built on an ascending km-0 origin. **Read them.** The change you are making is exactly the kind that makes tests pass for the wrong reason: if a test asserts `days[0].startKm === 0` and the new default trip starts at 0, it passes while testing nothing about direction.

Add a `trip` helper to the file and convert the existing suite to build its itinerary through it, keeping every assertion's *intent*:

```js
import { createTrip } from './trip.js';

const TOTAL_KM = 380;
const WHOLE = createTrip({ startKm: 0, destinationKm: TOTAL_KM });
```

- [x] **Step 2: Write the failing NEW tests — direction is what needs proving**

```js
describe('createItinerary - oriented trips', () => {
  const DOWN = createTrip({ startKm: 300, destinationKm: 100 }); // 200 km downstream

  it('starts day 1 at the trip start, not at km 0', () => {
    const it_ = createItinerary({ trip: createTrip({ startKm: 149.3, destinationKm: 797.6 }) });
    it_.addDay(80);
    expect(it_.getDays()[0].startKm).toBeCloseTo(149.3, 6);
    expect(it_.getDays()[0].endKm).toBeCloseTo(229.3, 6);
  });

  it('walks DOWN in absolute km on a downstream trip', () => {
    const it_ = createItinerary({ trip: DOWN });
    it_.addDay(80);
    it_.addDay(80);
    const days = it_.getDays();
    expect(days[0].startKm).toBe(300);
    expect(days[0].endKm).toBe(220);
    expect(days[1].startKm).toBe(220);
    expect(days[1].endKm).toBe(140);
  });

  it('clamps the last day at the destination, downstream', () => {
    const it_ = createItinerary({ trip: DOWN });
    it_.addDay(500);
    expect(it_.getDays()[0].endKm).toBe(100);
  });

  it('reports planned distance as a positive number downstream', () => {
    const it_ = createItinerary({ trip: DOWN });
    it_.addDay(80);
    expect(it_.totalPlannedKm()).toBeCloseTo(80, 6);
  });

  it('buckets breaks by absolute km on a downstream trip', () => {
    const it_ = createItinerary({ trip: DOWN });
    it_.addDay(80); // 300 -> 220
    it_.addBreak({ name: 'Café', kind: 'cafe', routeDistanceKm: 260 });
    const day = it_.getDays()[0];
    expect(it_.breaksInRange(day.startKm, day.endKm)).toHaveLength(1);
  });
});
```

Note the last one: `breaksInRange(300, 220)` receives a start greater than its end. Whatever it does today, it must handle that — normalise inside, and say so in its comment.

- [x] **Step 3: Run to verify the new tests fail**

Run: `npx vitest run src/itinerary.test.js`
Expected: FAIL on the oriented cases.

- [x] **Step 4: Implement**

Replace `totalKm` with `trip` throughout:

```js
export function createItinerary({ trip }) {
  // …
  // Recomputes startKm/endKm for days[index..] by chaining along the TRIP, which
  // may run downstream: absolute km then DECREASE day by day. targetKm is always a
  // positive distance ridden; the direction lives in the trip.
  function reflow(index) {
    let prevEnd = index === 0 ? trip.startKm : days[index - 1].endKm;
    for (let i = index; i < days.length; i++) {
      days[i].startKm = prevEnd;
      days[i].endKm = trip.advance(prevEnd, days[i].targetKm);
      prevEnd = days[i].endKm;
    }
  }

  function totalPlannedKm() {
    return days.length ? Math.abs(days[days.length - 1].endKm - trip.startKm) : 0;
  }
```

and `breaksInRange` normalises:

```js
  /**
   * Breaks with routeDistanceKm inside the given absolute-km span.
   *
   * The span arrives in TRIP order, so on a downstream trip `from` is greater than
   * `to`. Normalised here rather than at each of the four call sites.
   */
  function breaksInRange(from, to) {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    // … existing lowerBound/upperBound logic against lo/hi …
  }
```

- [x] **Step 5: Run the whole file**

Run: `npx vitest run src/itinerary.test.js`
Expected: PASS. If an old test needed its numbers changed rather than its construction, stop and check you have not changed its intent.

- [x] **Step 6: Commit**

```bash
git add src/itinerary.js src/itinerary.test.js
git commit -m "feat(itinerary): chain days along an oriented trip"
```

---

### Task 3: `boundaries.js` becomes signed

**Files:**
- Modify: `src/boundaries.js`
- Test: `src/boundaries.test.js`

- [x] **Step 1: Read `boundaries.test.js` in full first**

~130 cases, all ascending from km 0. Same hazard as Task 2, worse: this file owns `MIN_DAY_KM` enforcement, and a sign error here lets a day become negative-length without any test noticing.

- [x] **Step 2: Write the failing tests**

```js
describe('boundaries - downstream trips', () => {
  const DOWN = createTrip({ startKm: 300, destinationKm: 100 });

  it('keeps MIN_DAY_KM as a distance, not a signed difference', () => {
    const days = [
      { startKm: 300, endKm: 220, targetKm: 80 },
      { startKm: 220, endKm: 100, targetKm: 120 },
    ];
    const w = boundaryWindow(days, 0, { trip: DOWN });
    // Boundary 0 may sit between 5 km past the start and 5 km short of day 2's end.
    expect(w.min).toBeCloseTo(105, 6);
    expect(w.max).toBeCloseTo(295, 6);
  });

  it('refuses a window with no legal position, downstream', () => {
    const days = [
      { startKm: 300, endKm: 297, targetKm: 3 },
      { startKm: 297, endKm: 295, targetKm: 2 },
    ];
    expect(boundaryWindow(days, 0, { trip: DOWN })).toBeNull();
  });

  it('clamps a proposed boundary into the window, downstream', () => {
    const days = [
      { startKm: 300, endKm: 220, targetKm: 80 },
      { startKm: 220, endKm: 100, targetKm: 120 },
    ];
    expect(clampBoundaryKm(days, 0, 50, { trip: DOWN })).toBeCloseTo(105, 6);
  });

  it('counts arrival by distance ridden, downstream', () => {
    const trip = createTrip({ startKm: 300, destinationKm: 100 });
    expect(Math.abs(100 - trip.startKm) >= trip.lengthKm - ARRIVED_EPSILON_KM).toBe(true);
  });
});
```

- [x] **Step 3: Run to verify they fail**, then implement.

Every comparison in `rawBounds`, `boundaryWindow`, `boundaryBounds` and `clampBoundaryKm` moves from raw km ordering to trip-relative distance. The cleanest form is to convert to rider km at the top, do the existing ascending arithmetic there, and convert back:

```js
/**
 * The km window boundary `index` may be moved to, in ABSOLUTE route km.
 *
 * All the arithmetic below happens in RIDER km (0 at the trip start, always
 * ascending), so the existing ordering logic is unchanged and only the two
 * conversions are new. Doing it the other way — sprinkling `* direction` through
 * the comparisons — is what makes sign bugs.
 */
export function boundaryWindow(days, index, { trip, minDayKm = MIN_DAY_KM } = {}) {
  const rider = days.map((d) => ({ startKm: trip.tripKm(d.startKm), endKm: trip.tripKm(d.endKm) }));
  const window = riderWindow(rider, index, { lengthKm: trip.lengthKm, minDayKm });
  if (!window) return null;
  return {
    min: trip.absoluteKm(window.min),
    max: trip.absoluteKm(window.max),
  };
}
```

`riderWindow` is the existing body, renamed, with `totalKm` → `lengthKm`. **Note the min/max swap:** in absolute km on a downstream trip, `absoluteKm(window.min)` is the LARGER number. Whether callers need `min <= max` in absolute terms is the thing to check — `handleMarkup`'s `aria-valuemin`/`aria-valuemax` do, so sort there, not here.

- [x] **Step 4: Run, then commit**

```bash
git add src/boundaries.js src/boundaries.test.js
git commit -m "feat(boundaries): do boundary maths in rider km, both directions"
```

---

### Task 4: Storage v4

**Files:**
- Modify: `src/storage.js`
- Test: `src/storage.test.js`

- [x] **Step 1: Write the failing tests**

```js
describe('storage v4 - trip window', () => {
  it('defaults a v3 plan to the whole road', () => {
    const storage = fakeStorage({ 'elberadweg-plans': v3Blob() });
    const store = createPlanStore({ storage, routeId: ROUTE_ID, totalKm: 1026.5 });
    store.load();
    const plan = store.getActivePlan();
    expect(plan.startKm).toBe(0);
    expect(plan.destinationKm).toBe(1026.5);
  });

  it('round-trips a window through save and load', () => {
    const storage = fakeStorage({});
    const store = createPlanStore({ storage, routeId: ROUTE_ID, totalKm: 1026.5 });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], startKm: 797.6, destinationKm: 149.3 });
    const reloaded = createPlanStore({ storage, routeId: ROUTE_ID, totalKm: 1026.5 });
    reloaded.load();
    expect(reloaded.getActivePlan().startKm).toBe(797.6);
    expect(reloaded.getActivePlan().destinationKm).toBe(149.3);
  });

  it('gives a fresh plan the whole road', () => {
    const storage = fakeStorage({});
    const store = createPlanStore({ storage, routeId: ROUTE_ID, totalKm: 1026.5 });
    store.load();
    expect(store.createPlan('Second').destinationKm).toBe(1026.5);
  });

  it('carries the window through a duplicate', () => {
    const storage = fakeStorage({});
    const store = createPlanStore({ storage, routeId: ROUTE_ID, totalKm: 1026.5 });
    const meta = store.load();
    store.saveActivePlan({ days: [], breaks: [], startKm: 200, destinationKm: 400 });
    const copy = store.duplicatePlan(meta.activePlanId);
    expect(copy.startKm).toBe(200);
    expect(copy.destinationKm).toBe(400);
  });

  it('repairs a stored window that is not finite', () => {
    const storage = fakeStorage({ 'elberadweg-plans': v4BlobWith({ startKm: null, destinationKm: 'x' }) });
    const store = createPlanStore({ storage, routeId: ROUTE_ID, totalKm: 1026.5 });
    store.load();
    expect(store.getActivePlan().startKm).toBe(0);
    expect(store.getActivePlan().destinationKm).toBe(1026.5);
  });
});
```

- [x] **Step 2: Implement**

`SCHEMA_VERSION = 4`, `PREVIOUS_SCHEMA_VERSION` accepts 3 **and** 2. `createPlanStore` takes `totalKm` so it can default the window. `normalizePlan` gains:

```js
    // Absolute route km. A plan that predates the window spans the whole road,
    // which is exactly what it did before the field existed.
    startKm: Number.isFinite(plan.startKm) ? plan.startKm : 0,
    destinationKm: Number.isFinite(plan.destinationKm) ? plan.destinationKm : totalKm ?? 0,
```

`emptyPlan`, `duplicatePlan` and `saveActivePlan` all carry the two fields.

**Do not touch the `routeId` archive logic.** A window change is not a corridor change, and v3 → v4 must not archive anything.

- [x] **Step 3: Run, then commit**

```bash
git add src/storage.js src/storage.test.js
git commit -m "feat(storage): schema v4 carries each plan's trip window"
```

---

## Phase 2 — display translation

### Task 5: Wire the trip through `main.js`

**Files:** `src/main.js`

- [x] **Step 1: Build the trip from the active plan**

```js
  // The trip is derived from the active plan, so switching plans switches windows.
  let trip = createTrip({
    startKm: bootPlan.startKm,
    destinationKm: bootPlan.destinationKm,
    totalKm: meta.totalKm,
  });
```

`createItinerary({ trip })`, and every `boundaryWindow`/`clampBoundaryKm` call passes `{ trip }` instead of `{ totalKm }`. `hydrateActivePlan` rebuilds `trip` from the plan it loads. `saveActivePlan` persists `trip.startKm` / `trip.destinationKm`.

- [x] **Step 2: Run the app, confirm nothing changed**

Run: `npm run dev`, open it, add days.
Expected: identical to `997c525` — the window is the whole road, so every number matches. **This is the checkpoint for phase 1.** If anything differs, phase 1 has a bug and phase 2 will bury it.

- [x] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat: derive the trip from the active plan"
```

---

### Task 6: `tripKm` at every display site

**Files:** `src/ui-util.js`, `src/strip-markup.js`, `src/day-panel.js`, `src/places.js`, `src/map.js`, plus their tests.

- [x] **Step 1: Enumerate the sites before editing any**

```bash
git grep -n "startKm\|endKm\|routeDistanceKm\|totalKm" -- src/*.js | grep -v test | grep -vE "^src/(trip|boundaries|itinerary|storage|elevation|strip-geometry)\.js"
```

Every hit inside a template literal or a `textContent` assignment is a display site. Write the list into this plan's ledger before touching code — the failure mode is a *missed* site, and a list you wrote down is checkable where memory is not.

- [x] **Step 2: Test-drive each module's translation**

For `strip-markup.js`:

```js
it('labels a block with km from the rider start, not absolute route km', () => {
  const trip = createTrip({ startKm: 149.3, destinationKm: 797.6 });
  const html = axisMarkup(
    { days: [{ index: 0, startKm: 149.3, endKm: 229.3, targetKm: 80, townChoice: null }],
      totalKm: 648.3, focusedIndex: 0, breaks: [], trip },
    layout, axis,
  );
  expect(html).toContain('80 km');
  expect(html).not.toContain('229.3');
});
```

and equivalents in `day-panel.test.js` (`km 0 → 80`, not `km 149.3 → 229.3`), `places.test.js` (a town's row km), `map.test.js` (a day pin's tooltip).

- [x] **Step 3: Implement**

Each of those modules takes `trip` in its render arguments and calls `trip.tripKm(...)` wherever a km reaches markup. `ui-util.js` gains nothing — `trip.js` already owns the conversion, and a second copy in `ui-util` is how the two drift apart.

- [x] **Step 4: Sweep**

Re-run the grep from step 1. Every remaining raw `startKm`/`endKm` in markup-producing code must be either converted or deliberately absolute with a comment saying why.

- [x] **Step 5: Commit**

```bash
git add src/ && git commit -m "feat: show distances from the rider's own start"
```

---

## Phase 3 — the strip

### Task 7: `strip-geometry.js` maps the window

**Files:** `src/strip-geometry.js`, `src/strip-geometry.test.js`

- [x] **Step 1: Write the failing tests**

```js
describe('kmToX - oriented windows', () => {
  const up = { startKm: 149.3, endKm: 797.6, width: 1000 };
  const down = { startKm: 797.6, endKm: 149.3, width: 1000 };

  it('puts the trip start at x=0 and the destination at the full width', () => {
    expect(kmToX(149.3, up)).toBeCloseTo(0, 6);
    expect(kmToX(797.6, up)).toBeCloseTo(1000, 6);
    expect(kmToX(797.6, down)).toBeCloseTo(0, 6);
    expect(kmToX(149.3, down)).toBeCloseTo(1000, 6);
  });

  it('runs left-to-right in trip order on a downstream trip', () => {
    expect(kmToX(700, down)).toBeLessThan(kmToX(300, down));
  });

  it('clamps outside the window, either direction', () => {
    expect(kmToX(50, up)).toBe(0);
    expect(kmToX(900, down)).toBe(0);
  });

  it('round-trips through xToKm', () => {
    for (const opts of [up, down]) {
      expect(xToKm(kmToX(400, opts), opts)).toBeCloseTo(400, 3);
    }
  });
});
```

- [x] **Step 2: Implement**

```js
/** Route km -> x on the axis, clamped to the trip window. */
export function kmToX(km, { startKm = 0, endKm, width } = {}) {
  if (!positive(width) || !Number.isFinite(km) || !Number.isFinite(endKm)) return 0;
  const span = endKm - startKm;
  if (span === 0) return 0;
  const lo = Math.min(startKm, endKm);
  const hi = Math.max(startKm, endKm);
  const clamped = Math.min(Math.max(km, lo), hi);
  return ((clamped - startKm) / span) * width;
}
```

`xToKm` inverts it. `stripLayout` takes `{ startKm, endKm, width }`; its `remainder` runs from the last day's end to `endKm`, and `arrived` compares `Math.abs`.

**`hitTestHandle` needs no change** — it works in px.

- [x] **Step 3: Run, commit.**

### Task 8: The strip renders a window, with stubs

**Files:** `src/strip.js`, `src/strip-markup.js`, `src/style.css`, tests

- [x] Tests: the summary counts down to the destination using trip length; the scale line names the trip's own ends; a stub appears at an end only when the road continues past it, with the remaining distance in its title; no stub when an end is the road's end.
- [x] Implement: `axisOpts()` returns `{ startKm, endKm, width, height, elevationPoints }`; `elevationPointsFor` passes the window (and its memo key gains both ends); `scaleMarkup` uses the trip's ends; a `stubMarkup(side, km, name)` renders the caps.
- [x] `elevation.js`: relax `profilePoints`'s `endKm <= startKm` guard to allow a descending window, with a test proving a downstream profile is the mirror of the upstream one.
- [x] Commit.

### Task 9: Per-day climb on the block, direction-aware

**Files:** `src/elevation.js`, `src/strip-geometry.js`, `src/strip-markup.js`, tests

- [x] Tests: `ascentBetween` swaps ascent and descent when the span is given in descending order (the same stretch is 487 m up one way and 487 m down the other); the `full` tier renders `↑ 340 m` on the second line; the climb is in the block `title` at every tier; a block below the new `full` threshold drops the climb before it drops the town.
- [x] Implement: `ascentBetween(profile, fromKm, toKm)` stops normalising with `min/max` and instead reports relative to the direction it was asked in. `TIER_FULL_PX` 88 → **112**, measured in Chromium at the real 11px Archivo with `1 80 km` / `🛏 Hitzacker · ↑ 340 m` — do the measurement, do not trust the number.
- [x] Commit.

---

## Phase 4 — picking

> **Expanded from outcomes into steps at the start of Task 10**, as the Self-Review's
> placeholder scan required, against the code phases 1–3 actually produced rather than
> the shape this plan guessed at. Three things the expansion had to settle, all recorded
> here because they are the reason the steps below are not the placeholder's steps:
>
> 1. **`main.js` has no test file.** Every guard the placeholder left in a click handler
>    would have been unverifiable. So the guard chain moved into `trip.js`
>    (`proposeEnd`) and the day-trimming into `itinerary.js` (`fitDaysToLength`), both
>    pure and both unit-tested; `main.js` keeps only wiring and wording, which the
>    browser pass verifies and the ledger quotes.
> 2. **A window can shrink a plan, so Tasks 11 and 12 could not split the way the
>    placeholder split them.** The moment a control can move an end, the guards and the
>    reflow must both exist or the branch carries a state that strands days. Task 11
>    therefore lands the controls **and** the full guard chain **and** the reflow; Task
>    12 lands what the spec adds on top — the town snap, the picked names, and the
>    direction named in the refusal. Each task leaves the app correct.
> 3. **A picked NAME is derived, never stored** (see Task 12, Step 1). No schema bump,
>    and no second source for a fact the km already carry.

### Task 10: Picking mode on the map

**Files:**
- Modify: `src/map.js`, `src/style.css`, `src/main.js`
- Test: `src/map.test.js`

Two changes that belong in one task and in this order: the map learns to be *armed*
for a pick, and its start pin stops being a fact about the road. The pin second,
because Task 11 makes the start user-movable and a pin nailed to
`routeFeature.geometry.coordinates[0]` is then visibly wrong on every window a rider
builds — and on a downstream whole-road trip it already is, sitting at the rider's
DESTINATION with the origin's name on it.

- [x] **Step 1: Write the failing picking tests** (`src/map.test.js`)

```js
describe('createMap - picking mode', () => {
  function clickAt(lat, lng) {
    capturedMap.fire('click', { latlng: L.latLng(lat, lng) });
  }

  it('sends a click to onRouteClick when nothing is armed', () => {
    const onRouteClick = vi.fn();
    const onPickPoint = vi.fn();
    createMap({ routeFeature: ROUTE, onRouteClick, onPickPoint });

    clickAt(53.3, 10.5);

    expect(onRouteClick).toHaveBeenCalledWith([10.5, 53.3]);
    expect(onPickPoint).not.toHaveBeenCalled();
  });

  // The exclusivity IS the feature: a route click already means "add a custom stop to
  // the focused day", so an armed click that also did that would drop a 📌 on the plan
  // every time the rider chose where to begin.
  it('sends an armed click to onPickPoint INSTEAD, never to onRouteClick', () => {
    const onRouteClick = vi.fn();
    const onPickPoint = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onRouteClick, onPickPoint });

    api.setPickingMode('start');
    clickAt(53.3, 10.5);

    expect(onPickPoint).toHaveBeenCalledWith([10.5, 53.3], 'start');
    expect(onRouteClick).not.toHaveBeenCalled();
  });

  it('reports the end it was armed for, not a fixed one', () => {
    const onPickPoint = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onPickPoint });

    api.setPickingMode('destination');
    clickAt(53.3, 10.5);

    expect(onPickPoint).toHaveBeenCalledWith([10.5, 53.3], 'destination');
  });

  // main.js owns the mode (it holds the prompt, the two controls' pressed state and
  // the Escape path), so nothing here disarms itself — and a mode that could be armed
  // and not cleared would leave every later click picking instead of adding stops.
  it('stays armed until it is disarmed, and then routes clicks normally again', () => {
    const onRouteClick = vi.fn();
    const onPickPoint = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onRouteClick, onPickPoint });

    api.setPickingMode('start');
    clickAt(53.3, 10.5);
    clickAt(53.0, 11.4);
    expect(onPickPoint).toHaveBeenCalledTimes(2);
    expect(onRouteClick).not.toHaveBeenCalled();

    api.setPickingMode(null);
    clickAt(52.5, 12.3);
    expect(onPickPoint).toHaveBeenCalledTimes(2);
    expect(onRouteClick).toHaveBeenCalledTimes(1);
  });

  it('marks the container while armed and unmarks it after', () => {
    const api = createMap({ routeFeature: ROUTE });
    const container = capturedMap.getContainer();

    api.setPickingMode('start');
    expect(container.classList.contains('map--picking')).toBe(true);
    api.setPickingMode(null);
    expect(container.classList.contains('map--picking')).toBe(false);
  });
});
```

**Kills:** the exclusivity test kills two independent `if`s in place of the branch (both
callbacks fire); the `'destination'` test kills a hardcoded `'start'` in the report; the
stays-armed test kills a self-clearing one-shot inside `map.js` (the second armed click
would reach `onRouteClick`) **and** a `setPickingMode` that cannot clear; the container
test kills `classList.add` without the matching remove. Note the shape of all five:
each asserts what did **not** happen as well as what did, because a mutant that fires
both callbacks passes every "was called" assertion on its own.

- [x] **Step 2: Implement picking mode** (`src/map.js`)

```js
  // Which end of the trip the next route click resolves, or null.
  //
  // main.js owns this mode; this is a plain setter and a plain report. A one-shot that
  // cleared itself here would be a second owner of the same fact, and the two would
  // disagree the first time a pick was REFUSED — the control would go unpressed while
  // the map still believed it was armed, or the reverse.
  let pickingMode = null;

  function setPickingMode(mode) {
    pickingMode = mode ?? null;
    map.getContainer().classList.toggle('map--picking', pickingMode !== null);
  }
```

and the click listener, which stops being registered conditionally (either callback may
be absent; the branch is what matters):

```js
  // One handler, two exclusive destinations — see setPickingMode. While a pick is armed
  // a route click means the pick and NOTHING else.
  map.on('click', (e) => {
    const lngLat = [e.latlng.lng, e.latlng.lat];
    if (pickingMode) {
      if (typeof onPickPoint === 'function') onPickPoint(lngLat, pickingMode);
      return;
    }
    if (typeof onRouteClick === 'function') onRouteClick(lngLat);
  });
```

`setPickingMode` joins the returned control surface, and `onPickPoint` joins
`createMap`'s options and its JSDoc.

- [x] **Step 3: The crosshair, and the cascade trap under it** (`src/style.css`)

```css
/* Armed for a pick (spec §6): the cursor is the only thing on the map that says the
   next click means something different.

   The id is load-bearing, not habit. Leaflet's own `.leaflet-grab` sits on this very
   element and `.leaflet-interactive` on the route line, both single-class selectors —
   and leaflet.css is imported from src/map.js, which the module graph reaches AFTER
   main.js's own `import './style.css'`. Equal specificity, later sheet: a plain
   `.map--picking` would lose, silently, to the grab cursor it is trying to replace. */
#map.map--picking,
#map.map--picking .leaflet-interactive {
  cursor: crosshair;
}

/* Nothing on the map may eat an armed click. A POI dot, a ⭐ or a day pin sitting over
   the route would otherwise swallow the pick and the rider would press again, harder,
   at the same place. */
#map.map--picking .leaflet-marker-pane {
  pointer-events: none;
}
```

- [x] **Step 4: Write the failing start-pin tests** — the three existing ones move to
      the setter, plus three new

`createMap - the start pin` currently builds its pin at construction from
`originName`; all three cases keep their assertions and change how the pin is made.
**Record the change in the ledger**: `originName` leaves `createMap`'s options
entirely, so the module holds no place name and no km of its own.

```js
describe('createMap - the start pin follows the trip', () => {
  const HAMBURG = [9.99, 53.55];
  const PRAGUE = [13.74, 51.05];

  it('draws no start pin until it is told where the rider starts', () => {
    createMap({ routeFeature: ROUTE });

    expect(startPin()).toBeUndefined();
  });

  it('names the rider’s own start, which downstream is the road’s far end', () => {
    const api = createMap({ routeFeature: ROUTE });

    api.setStartPin({ coord: PRAGUE, name: 'Prague' });

    expect(startPin().options.title).toBe('Start — Prague');
    expect(startPin().options.icon.options.html).toContain('P');
    expect(startPin().getLatLng().lng).toBeCloseTo(13.74, 6);
  });

  it('claims nothing for a start that has no name', () => {
    const api = createMap({ routeFeature: ROUTE });

    api.setStartPin({ coord: HAMBURG, name: null });

    expect(startPin().options.title).toBe('Start');
    expect(startPin().options.icon.options.html).not.toContain('H'); // no stale initial
  });

  // The pin MOVES rather than multiplying. Every render calls this, so a missing
  // clearLayers leaves one pin per render standing on the map — each with the name it
  // had at the time, which is a trip's whole history drawn at once.
  it('keeps exactly one pin across renders, at the newest position', () => {
    const api = createMap({ routeFeature: ROUTE });

    api.setStartPin({ coord: PRAGUE, name: 'Prague' });
    api.setStartPin({ coord: HAMBURG, name: 'Hamburg' });

    const pins = createdMarkers.filter((m) =>
      (m.options.icon?.options?.className || '').includes('pin-icon--start'),
    );
    const live = pins.filter((m) => capturedMap.hasLayer(m) || m._map);
    expect(live).toHaveLength(1);
    expect(live[0].options.title).toBe('Start — Hamburg');
  });
});
```

**Kills:** the no-pin-yet test kills a leftover construction-time pin (there would be
one before any setter call, at the ROAD's origin); the Prague test kills a pin still
built from `coordinates[0]` (wrong coord) and a title/glyph that ignores its argument;
the one-pin test kills the missing `clearLayers()`. `createdMarkers` collects every
marker ever built (the file's init hook never forgets one), which is why that last test
filters to the ones still on a map rather than counting the array — an assertion on
`createdMarkers.length` alone would pass under the mutant it exists to catch.

- [x] **Step 5: Implement the start pin as a setter** (`src/map.js`)

Delete the construction-time block at `map.js:398-413` (`const startCoord = …` and its
`L.marker(...).addTo(map)`), drop `originName` from the destructured options and the
JSDoc, and add a layer group beside the other four:

```js
  const startPinLayer = L.layerGroup().addTo(map);

  /**
   * The pin for where the RIDER starts, at `coord` ([lng, lat]) with `name` as the
   * place it sits in — both from main.js, which is the only module that knows the
   * trip's window and the corridor's names.
   *
   * It used to be built once, at construction, from the route's first coordinate: the
   * ROAD's origin, which on a downstream trip is the rider's destination and on any
   * offset trip is 149 km of road they never ride. The pin is trip state, so it is
   * rebuilt with every render, in its own layer group — the same clear-and-rebuild
   * discipline setDayPins uses. No draggable marker lives in this group, so clearing
   * it cannot disturb an in-flight pin drag the way rebuilding the day pins would.
   *
   * `title` is a DOM property, not markup, so an OSM place name needs no escaping here
   * — unlike every tooltip in this file, which Leaflet renders as HTML.
   */
  function setStartPin({ coord, name } = {}) {
    startPinLayer.clearLayers();
    if (!coord) return;
    L.marker(toLatLng(coord), {
      icon: numberedPinIcon(name ? name.trim().charAt(0).toUpperCase() : '•', 'start'),
      zIndexOffset: 400,
      title: name ? `Start — ${name}` : 'Start',
    }).addTo(startPinLayer);
  }
```

- [x] **Step 6: Wire both into `main.js`**

`createMap`'s call loses `originName: ORIGIN_NAME` and gains nothing else yet —
**`onPickPoint` has no handler until Task 11, and the mode has no way to be armed, so
picking is exercised by unit tests only in this task.** Stated rather than left to be
found: the browser proof for picking lands with the control that arms it.

The pin needs a name for the rider's own start, which is the first half of a helper
Task 12 finishes:

```js
  // What to call one end of the trip: the RIDER's ends, not the road's — on a
  // downstream trip the start IS the road's destination.
  //
  // Derived from the km, never stored. Spec's own definition is "a startKm, a
  // destinationKm, and nothing else", and a stored name would be a second source for
  // something the km already say. Task 12 adds the town half; until then an end that
  // is not a road end has no name, and every consumer already has a word for that.
  //
  // The road-end test is rounded to 0.1 km because that is the gate strip-markup's
  // `roadContinues` uses to decide whether an end is a road end (and so whether to
  // draw a stub past it). Two questions — "what is this end called" and "is there
  // road past it" — sharing one comparison. Change one, change the other, or the app
  // will name one end two ways on one screen.
  function nameForTripEnd(tripEnd) {
    const km = tripEnd === 'start' ? trip.startKm : trip.destinationKm;
    if (round1(km) <= 0) return ORIGIN_NAME;
    if (round1(totalKm - km) <= 0) return DESTINATION_NAME;
    return null;
  }

  function renderStartPin() {
    map.setStartPin({ coord: pointAtKm(routeIndex, trip.startKm), name: nameForTripEnd('start') });
  }
```

`renderAll` calls it inside the `if (!dragging)` block: the trip's start cannot move
during a boundary drag, and the pins that can are rebuilt below it either way.

`fromNameFor(0)` stops naming the road: `return nameForTripEnd('start') ?? 'your start';`
— one line, and it fixes today's lie (`from Cuxhaven · km 0 → 648.3` on a plan starting
in Hamburg, and `from Cuxhaven` on a whole-road plan ridden from Prague). The ledger
assigned this to Task 12; the helper it needs arrives here, and leaving a known-wrong
line on the branch for one commit is worse than the overlap. Task 12 gives the same
helper towns, which is the half that needs the 3 km lookup.

- [x] **Step 7: Run, verify in the browser, commit**

Run: `npx vitest run --exclude '**/.cache/**'` — map 26 → ~34.

**Persisted:** nothing. The picking mode is transient by design (a reload cancels it,
which is right); the pin is derived from the window storage already carries.

**Browser verification** (playwright over `vite preview`, the seeded-plan scripts from
Tasks 6/8 in the session scratchpad, zero console errors):
- whole road → the pin sits at Cuxhaven's coordinate, glyph `C`, title `Start — Cuxhaven`
  (the identity checkpoint: the pin has not moved for the default plan);
- offset forward 149.3 → 797.6 → the pin has moved 149 km up the road to the rider's
  start, glyph `•`, title `Start` (no town lookup yet);
- the same window downstream 797.6 → 149.3 → the pin is at the **Prague** end, glyph
  `P`, title `Start — Prague` — the pin at the far end of the road from where it used
  to be is the whole point of this step;
- exactly one `.pin-icon--start` in the DOM after adding days, dragging a boundary and
  switching plans;
- `getComputedStyle` on the container reports `crosshair` after `setPickingMode('start')`
  is driven from the page (the cascade trap in Step 3 is invisible to jsdom, and a lost
  crosshair is exactly the class of failure this plan keeps recording).

```bash
git add src/map.js src/map.test.js src/style.css src/main.js
git commit -m "feat(map): arm a route click for a pick, and let the start pin follow the trip"
```

---

### Task 11: Trip setup, the two controls, and the guards under them

**Files:**
- Modify: `src/trip.js`, `src/itinerary.js`, `src/ui-util.js`, `src/ui.js`,
  `src/strip.js`, `src/strip-markup.js`, `src/day-panel.js`, `src/main.js`,
  `src/style.css`, `index.html`
- Test: `src/trip.test.js`, `src/itinerary.test.js`, `src/ui.test.js`,
  `src/strip.test.js`, `src/day-panel.test.js`

Three commits, in this order, the way Tasks 7 and 8 landed: the model that makes a pick
safe, then the controls that make one, then the wiring that applies it.

#### 11a — the model

- [x] **Step 1: Write the failing `proposeEnd` tests** (`src/trip.test.js`)

The guard ORDER is the point of this function, so it is what the tests are built round.

```js
import { createTrip, wouldReverse, proposeEnd } from './trip.js';

describe('proposeEnd', () => {
  const UP = createTrip({ startKm: 149.3, destinationKm: 797.6, totalKm: 1026.5 });
  const DOWN = createTrip({ startKm: 797.6, destinationKm: 149.3, totalKm: 1026.5 });
  const GUARDS = { dayCount: 3, minLengthKm: 5 };

  it('answers a good pick with the trip it makes', () => {
    const out = proposeEnd(UP, 'start', 200, GUARDS);
    expect(out.ok).toBe(true);
    expect(out.trip.startKm).toBe(200);
    expect(out.trip.destinationKm).toBe(797.6); // the other end untouched
    expect(out.trip.totalKm).toBe(1026.5);      // and the road it is measured on
  });

  it('moves the end it was asked for and never the other one', () => {
    const out = proposeEnd(UP, 'destination', 600, GUARDS);
    expect(out.trip.startKm).toBe(149.3);
    expect(out.trip.destinationKm).toBe(600);
  });

  it('pulls a pick past the end of the road onto it', () => {
    expect(proposeEnd(UP, 'destination', 2000, GUARDS).trip.destinationKm).toBe(1026.5);
  });

  // THE ORDER TEST. A pick landing on the trip's other end makes a ZERO-length window,
  // and createTrip calls an equal-ended window forward — so on a downstream trip
  // wouldReverse asked first answers "reversal" and sends the rider to Reset trip over
  // a window they only need to nudge.
  it('refuses a zero-length pick as too short, not as a reversal, downstream', () => {
    const out = proposeEnd(DOWN, 'destination', 797.6, GUARDS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('too-short');
  });

  it('refuses a window under the minimum in both directions', () => {
    expect(proposeEnd(UP, 'destination', 152, GUARDS).reason).toBe('too-short');   // 2.7 km
    expect(proposeEnd(DOWN, 'destination', 795, GUARDS).reason).toBe('too-short'); // 2.6 km
  });

  it('refuses a flip once there are days, and reports the window it would have made', () => {
    const out = proposeEnd(UP, 'destination', 100, GUARDS);
    expect(out.reason).toBe('would-reverse');
    expect(out).toMatchObject({ startKm: 149.3, destinationKm: 100 });
  });

  it('refuses a start pushed past the destination too', () => {
    expect(proposeEnd(UP, 'start', 900, GUARDS).reason).toBe('would-reverse');
  });

  // Spec §8: with no days a flip is free — that is trip setup, not a mistake.
  it('allows a flip while the plan has no days', () => {
    const out = proposeEnd(UP, 'destination', 100, { dayCount: 0, minLengthKm: 5 });
    expect(out.ok).toBe(true);
    expect(out.trip.direction).toBe(-1);
  });

  it('refuses a pick that is not a number instead of letting wouldReverse throw', () => {
    expect(proposeEnd(UP, 'start', NaN, GUARDS)).toMatchObject({ ok: false, reason: 'not-a-number' });
    expect(() => proposeEnd(UP, 'start', undefined, GUARDS)).not.toThrow();
  });

  it('throws on an end it does not recognise rather than moving the other one', () => {
    expect(() => proposeEnd(UP, 'finish', 600, GUARDS)).toThrow(/start.*destination/);
  });

  it('throws when nobody said how short is too short', () => {
    expect(() => proposeEnd(UP, 'start', 200, { dayCount: 0 })).toThrow(/minLengthKm/);
  });
});
```

**Kills:** the order test kills the two guards swapped, and it is the single most
important assertion in phase 4 — it is also why the fixture is DOWNSTREAM, since on a
forward trip a zero-length window keeps direction `+1` and the swap is invisible. The
both-directions test kills a signed length comparison (`destinationKm - startKm <
minLengthKm` is negative downstream, so every short downstream pick would pass). The
no-days test kills a `dayCount` the guard ignores; the flip tests kill dropping the
reversal guard. The `not.toThrow()` kills removing the finite check (`wouldReverse`
throws by design). The good-pick tests are what give the refusal tests discriminating
power — without them a mutant that refused everything would pass all five refusals.

- [x] **Step 2: Implement `proposeEnd`** (`src/trip.js`, beside `wouldReverse`)

```js
/**
 * A proposed new end for a trip, answered: the trip it would make, or the reason it is
 * refused. Spec §8's three guards, in the ONE order that gives each refusal its own
 * reason — which is why this is a function and not three lines in a click handler.
 *
 * 1. **Finite.** `wouldReverse` throws on a non-finite end by design (it used to fail
 *    OPEN downstream, waving a NaN pick through the very guard that exists to refuse
 *    it), so a pick that is not a number must never reach it.
 * 2. **Long enough.** A pick landing on the trip's other end makes a zero-length
 *    window, and an equal-ended window is FORWARD here — so downstream `wouldReverse`
 *    would call that a reversal and point the rider at Reset trip. Length first, and
 *    the refusal says what is actually wrong: too short.
 * 3. **Not a flip, once there are days.** With no days a flip is trip setup.
 *
 * @param {object} trip - the trip being changed, from createTrip().
 * @param {'start'|'destination'} tripEnd - which end the pick moves. Exactly one, ever:
 *   each control owns one end, which is also what keeps the strip's elevation memo key
 *   honest — both of its ends are pinned by a test that moves one at a time.
 * @param {number} km - the picked ABSOLUTE route km.
 * @param {{dayCount?: number, minLengthKm: number}} opts - `minLengthKm` is required and
 *   validated: MIN_DAY_KM belongs to boundaries.js, which this module deliberately does
 *   not import, and a defaulted guard is a guard a caller can forget.
 * @returns {{ok: true, trip: object}
 *   | {ok: false, reason: 'not-a-number', km: number}
 *   | {ok: false, reason: 'too-short', lengthKm: number, minLengthKm: number}
 *   | {ok: false, reason: 'would-reverse', startKm: number, destinationKm: number}}
 */
export function proposeEnd(trip, tripEnd, km, { dayCount = 0, minLengthKm } = {}) {
  if (tripEnd !== 'start' && tripEnd !== 'destination') {
    throw new Error(`proposeEnd needs tripEnd 'start' or 'destination', got: ${tripEnd}`);
  }
  if (!Number.isFinite(minLengthKm)) {
    throw new Error(`proposeEnd needs a finite minLengthKm, got: ${minLengthKm}`);
  }
  if (!Number.isFinite(km)) return { ok: false, reason: 'not-a-number', km };

  const ends =
    tripEnd === 'start'
      ? { startKm: km, destinationKm: trip.destinationKm }
      : { startKm: trip.startKm, destinationKm: km };
  // Built before the length is judged, so the length judged is the one the trip would
  // really have: createTrip pulls both ends onto the road.
  const next = createTrip({ ...ends, totalKm: trip.totalKm });
  if (next.lengthKm < minLengthKm) {
    return { ok: false, reason: 'too-short', lengthKm: next.lengthKm, minLengthKm };
  }
  if (dayCount > 0 && wouldReverse(trip, ends)) {
    return { ok: false, reason: 'would-reverse', ...ends };
  }
  return { ok: true, trip: next };
}
```

- [x] **Step 3: Write the failing `fitDaysToLength` tests** (`src/itinerary.test.js`)

```js
import { createItinerary, breakKey, fitDaysToLength } from './itinerary.js';

describe('fitDaysToLength', () => {
  const FIVE = [80, 80, 80, 80, 80].map((targetKm) => ({ targetKm, townChoice: null }));

  it('leaves a plan that still fits alone', () => {
    const out = fitDaysToLength(FIVE, 400);
    expect(out.days.map((d) => d.targetKm)).toEqual([80, 80, 80, 80, 80]);
    expect(out.dropped).toBe(0);
  });

  it('clamps the day that straddles the finish, drops the rest, and counts them', () => {
    const out = fitDaysToLength(FIVE, 180);
    expect(out.days.map((d) => d.targetKm)).toEqual([80, 80, 20]);
    expect(out.dropped).toBe(2);
  });

  it('drops a day with nothing left to ride rather than storing a zero', () => {
    const out = fitDaysToLength(FIVE, 160);
    expect(out.days.map((d) => d.targetKm)).toEqual([80, 80]);
    expect(out.dropped).toBe(3);
  });

  // hydrate REFUSES a non-positive targetKm by dropping the whole plan, so a 0.04 km
  // day is not a small day — it is the loss of every day in the plan on the next
  // reload. What is left is rounded to the grid the plan stores lengths on before it
  // is believed.
  it('rounds what is left before believing it, so no 0.04 km day is stored', () => {
    const out = fitDaysToLength(FIVE, 160.04);
    expect(out.days.map((d) => d.targetKm)).toEqual([80, 80]);
    expect(out.dropped).toBe(3);
  });

  it('keeps the overnight town of the day it clamps', () => {
    const days = [{ targetKm: 80, townChoice: { name: 'Hitzacker', routeDistanceKm: 229.3 } }];
    const out = fitDaysToLength(days, 60);
    expect(out.days[0]).toEqual({ targetKm: 60, townChoice: { name: 'Hitzacker', routeDistanceKm: 229.3 } });
  });

  it('drops everything for a window with no room at all', () => {
    expect(fitDaysToLength(FIVE, 0)).toEqual({ days: [], dropped: 5 });
  });
});
```

**Kills:** the straddle test kills "return the entries unchanged" (both halves), "drop
the straddler instead of clamping it" (`[80, 80]`, dropped 3), "clamp to `lengthKm`
rather than to what is LEFT" (`[80, 80, 180]`) and a `dropped` hardcoded at 0. The
160 test kills `room < 0` in place of `room <= 0` (a stored 0 km day). The 160.04 test
kills the missing `round1` on the remaining room. The town test kills dropping
`townChoice` while clamping — the day panel already has a sentence for a town that no
longer sits on the boundary, and losing the choice silently is the worse of the two.

- [x] **Step 4: Implement `fitDaysToLength`** (`src/itinerary.js`, module level beside
      `breakKey`)

```js
/**
 * Day entries trimmed to a window `lengthKm` long, and how many no longer fit.
 *
 * Spec §8: a window that shrinks below the planned distance "clamps the last day and
 * drops days that no longer fit, reporting how many". Both halves are one walk, so
 * they are one function — a caller recomputing the count from two array lengths would
 * be right only by luck.
 *
 * Lengths only: no trip, no absolute km, no direction, because a length is the same
 * number whichever way the trip runs. The entries are the STORED shape
 * (`{targetKm, townChoice}`) — what hydrate takes and what persistPlan writes.
 *
 * Deliberately does NOT floor a clamped day at MIN_DAY_KM: it cannot be reached with a
 * window shorter than that (proposeEnd refuses those), and flooring would extend a day
 * past the finish it was just trimmed to.
 */
export function fitDaysToLength(entries, lengthKm) {
  const days = [];
  let ridden = 0;
  for (const entry of entries) {
    // Rounded to the 0.1 km grid the plan stores lengths on, so "nothing left" and
    // "0.04 km left" are the same answer. A day of 0 km is what hydrate refuses, and
    // it drops the WHOLE plan rather than that one day.
    const room = round1(lengthKm - ridden);
    if (room <= 0) break;
    const targetKm = Math.min(entry.targetKm, room);
    days.push({ targetKm, townChoice: entry.townChoice ?? null });
    ridden = round1(ridden + targetKm);
  }
  return { days, dropped: entries.length - days.length };
}
```

- [x] **Step 5: Run and commit 11a**

Run: `npx vitest run --exclude '**/.cache/**' src/trip.test.js src/itinerary.test.js`
— trip 16 → ~27, itinerary 124 → ~130.

```bash
git add src/trip.js src/trip.test.js src/itinerary.js src/itinerary.test.js
git commit -m "feat(trip): answer a proposed trip end with the trip it makes or the reason it cannot"
```

#### 11b — the two controls

- [x] **Step 6: The trip headline, in words** (`src/ui-util.js`)

```js
// Which way along the road the km run. The corridor is a river and its km ascend
// towards the source, so an ascending trip rides upstream — the one place that
// assumption is written down. A corridor that is not a river would name its own two
// words in route.meta.json; nothing needs that yet.
const DIRECTION_WORD = { 1: 'upstream', '-1': 'downstream' };

/**
 * The trip in one line: `Hamburg → Dresden · 648.3 km upstream`.
 *
 * The direction is in WORDS because the sign of a subtraction is not something a rider
 * should have to infer (spec §6a) — and the same sentence serves the empty-plan setup
 * step and the confirmation after a pick, so the two cannot describe one trip
 * differently. Names are the caller's (main.js resolves them); an unnamed end reads as
 * its role, which is all anything knows about it.
 */
export function tripHeadline(trip, { startName, destinationName } = {}) {
  const from = esc(startName ?? 'your start');
  const to = esc(destinationName ?? 'your finish');
  return `${from} → ${to} · ${round1(trip.lengthKm)} km ${DIRECTION_WORD[trip.direction]}`;
}
```

> **Open question for the controller:** spec §6a's own example sentence is *"Hamburg →
> Dresden · 649 km **downstream**"*, but Hamburg → Dresden is 149.3 → 797.6, i.e.
> ascending km — and §1's model comment says `+1 upstream, -1 downstream`, while the
> Problem section says guidebooks run "source-to-sea", which is descending km. Two of
> the three agree that Hamburg → Dresden is **upstream**; §6a's example is the odd one
> out and reads like a slip. This plan implements `+1 = upstream`, so the app will say
> *"Hamburg → Dresden · 648.3 km upstream"*. **Recommendation: correct §6a's example
> when the spec's outcome section is appended (Task 16).** If the controller wants the
> spec's word kept as written, only `DIRECTION_WORD` changes — but then the app tells
> Michel he is riding downstream to Dresden, which is up the Elbe.
>
> **RULED (controller, 2026-08-01): the implementation is correct — `+1` is upstream. Keep it; the spec's §6a example is wrong and gets corrected at Task 16.**
> Settled against the data rather than the prose: `src/data/elevation.json` gives km 0
> (Cuxhaven) an elevation of **5 m** and the road's far end (Prague) **205 m**, so
> ascending km climbs toward the source. Cuxhaven is the mouth. Riding Hamburg →
> Dresden therefore is upstream, and the app saying *"648.3 km upstream"* is telling
> the truth. Note the product consequence, worth carrying into Task 11's wording: this
> means Michel's own trip runs **against** the direction guidebooks describe
> (source-to-sea), so "upstream" is the word most Elberadweg literature will not have
> prepared a user for — the setup step naming it in words is doing real work, not
> decoration.

- [x] **Step 7: The picking prompt** (`index.html`, `src/ui.js`, `src/ui.test.js`,
      `src/style.css`)

`index.html`, inside `#map` alongside `#map-controls` — the prompt belongs where the
rider is looking and where the click will land:

```html
        <div id="pick-banner" class="banner banner--pick" role="status" aria-live="polite" hidden></div>
```

`src/ui.js`:

```js
/**
 * The picking line above the map: what to click, what was picked, and the one
 * refinement a pick can offer (spec §6.3's "Start at Hamburg instead?").
 *
 * Not createBanner, deliberately. That one is a dismissable WARNING about the route
 * data, and main.js's renderBanner shows or hides it from plan state on every save — a
 * prompt parked in it would be wiped by the first persist. This one is owned entirely
 * by the picking flow: role="status" so it is announced, no × (a dismiss that left the
 * mode armed would be a lie — Escape and the control itself are the way out), and an
 * optional action button, which is the only interactive thing the flow needs.
 */
export function createPickBanner({ el }) {
  function hide() {
    el.hidden = true;
    el.innerHTML = '';
    el.classList.remove('banner--error');
  }

  function show(text, { tone = 'hint', action = null } = {}) {
    el.classList.toggle('banner--error', tone === 'error');
    el.innerHTML =
      `<span>${esc(text)}</span>` +
      (action
        ? `<button type="button" class="btn btn--sm btn--primary" data-action="pick-action">${esc(action.label)}</button>`
        : '');
    el.hidden = false;
    // Spent before the callback runs: the offer is taken, and whatever the callback
    // does next reports itself in this same line.
    el.querySelector('[data-action="pick-action"]')?.addEventListener('click', () => {
      hide();
      action.onPress();
    });
  }

  return { show, hide };
}
```

Tests (`src/ui.test.js`), each naming its mutant:

- shows the text and unhides — kills a `show` that forgets `hidden = false`.
- **escapes the text and the action label**, with `<img src=x onerror="alert(1)">` and
  `querySelector('img')` null: both interpolate into ELEMENT CONTENT, where that
  payload really does parse into an element, so the assertion can fail. (Contrast the
  stub-title case in Task 8's fix round, where the same payload inside `title="…"`
  proved nothing.) Town names reach the action label from OSM, so this is the live path.
- the action button calls `onPress` exactly once, and the banner is **already hidden
  when it runs** (`onPress` records `el.hidden`) — kills hiding after the callback,
  which leaves a spent offer on screen over whatever the callback just said.
- `hide()` empties as well as hides — `.banner` carries its own padding and border, so
  a hidden-but-populated banner reappears as a stray box (same reason createBanner's
  own test asserts it).
- `tone: 'error'` adds the class and a later `tone: 'hint'` removes it — kills
  `classList.add` without the toggle, which would leave every later hint red.
- no action → no button — kills always rendering one (`undefined` as its label).

`src/style.css`:

```css
/* The picking prompt, over the map it is about. z-index matches #map-controls, and it
   stops short of them so the two never overlap. */
.banner--pick {
  position: absolute;
  top: 10px;
  left: 10px;
  max-width: calc(100% - 260px);
  z-index: 1001;
  margin: 0;
  align-items: center;
  background: rgba(91, 147, 255, 0.14);
  border-color: rgba(91, 147, 255, 0.4);
  border-left-color: var(--river);
  color: #d8e4ff;
}

/* A refused pick (spec §8). Same box, so the answer arrives where the prompt was. */
.banner--error {
  background: rgba(240, 112, 95, 0.14);
  border-color: rgba(240, 112, 95, 0.45);
  border-left-color: var(--day);
  color: #ffd9d2;
}
```

- [x] **Step 8: The scale line's ends become controls** (`src/strip-markup.js`,
      `src/strip.js`, `src/style.css`, `src/strip.test.js`)

Spec §6: the controls live on the endpoint labels the strip already shows, because
editing a value where it is displayed needs no new vocabulary. So the **text does not
change** — `km 0 · Cuxhaven` becomes the label of a button carrying exactly that text.
Which is also why every existing scale-line assertion in `strip.test.js`
(`toContain('km 0 · Cuxhaven')`, `'km 0 · start'`, `'km 0 · Prague'`, …) stays green:
`textContent` is unaffected. That is the evidence the change is additive; say so in the
ledger rather than leaving the reader to wonder which tests moved.

```js
/**
 * One end of the trip, as a control that arms a pick for it (spec §6).
 *
 * The visible text is the label the scale line always showed. What pressing it does
 * lives in `title`, and `aria-pressed` makes it what it is: a toggle, because a second
 * press cancels.
 *
 * **The accessible name is also where the remaining road becomes TEXT.** The edge stub
 * past this end is `aria-hidden` and its figure was available to a pointer only — the
 * debt Task 8 recorded and assigned here. It belongs on this control: the road past an
 * end is exactly what pressing it can claim. The stub keeps the pointer half, so the
 * two halves say the same sentence to two kinds of reader rather than one of them
 * saying nothing.
 */
function endControlMarkup(state, tripEnd, kmLabel, name) {
  const past = roadPast(state, tripEnd);
  const more = roadContinues(past)
    ? ` ${round1(past.remainingKm)} km of road continues to ${past.name}.`
    : '';
  const role = tripEnd === 'start' ? 'start' : 'finish';
  const armed = state.picking === tripEnd;
  const label = `Trip ${role}: km ${kmLabel}, ${name}.${more} Press to set it on the map.`;
  return `<button type="button" class="strip__end" data-action="set-${role}"
                  aria-pressed="${armed}" aria-label="${esc(label)}"
                  title="Set where your trip ${role === 'start' ? 'starts' : 'finishes'}">km ${kmLabel} · ${esc(name)}</button>`;
}
```

`scaleMarkup` swaps its two `<span>`s for `endControlMarkup(state, 'start', 0, origin)`
and `endControlMarkup(state, 'destination', round1(state.trip.lengthKm), destination)`.
**The arrived case keeps its own `⚑ … reached` span** — that end is the flag, and
turning the flag into a button would put a control inside a status. So on an arrived
trip the finish control is the flag's neighbour, not the flag. (Simplest form: render
the control either way and let the `⚑ reached` span follow it; the scale line is a
flex row with room for both at 10px.)

`strip.js` gains the state and the listener:

```js
      // null is MEANINGFUL here, so the fallback is `?? null` and not `?? state.picking`:
      // main.js cancels a pick by rendering with picking: null, and `null ?? state.picking`
      // would keep the control pressed for ever. An argument-less render still preserves
      // it, because `next` defaults to `state` — the same shape focusedIndex uses.
      picking: next.picking ?? null,
      endNames: next.endNames ?? state.endNames,
```

```js
  // The scale line is not a drag surface, so it gets its own plain click listener and
  // none of the axis's suppressClick machinery.
  scaleEl.addEventListener('click', (e) => {
    const control = e.target.closest('[data-action^="set-"]');
    if (!control) return;
    callbacks.onPickEnd?.(control.dataset.action === 'set-start' ? 'start' : 'destination');
  });
```

Test obligations (`src/strip.test.js`), each with its mutant:

- pressing the left label emits `onPickEnd('start')`, the right one `'destination'` —
  kills both controls reporting one end, and kills reading the DOM order instead of the
  action.
- `picking: 'start'` renders `aria-pressed="true"` on the start control **and `"false"`
  on the finish control** — kills pressing both, and kills a truthiness bug that presses
  whichever renders first.
- a second render with `picking: null` clears both — kills the `?? state.picking`
  fallback trap named above, which no other test can see.
- an argument-less `render()` (the resize path) keeps the pressed state and the names —
  kills a bare-state rebuild, the same hole the origin/destination names already have a
  test for.
- **the start control's accessible name carries the road behind the rider, on an
  offset-forward window**: contains `149.3` and `Cuxhaven`; **and downstream it carries
  228.9 and Prague** — two tests, one per direction, each asserting the NUMBER and the
  NAME. Kills dropping the road clause, and kills `roadPast` asked for the wrong end
  (which reads perfectly plausibly, and is the bug `roadPast`'s own doc comment warns
  about). A test asserting only "contains km" would pass under the swap.
- a whole-road trip's controls carry **no** road clause — kills appending it
  unconditionally, which would read "0 km of road continues to Cuxhaven".
- the existing scale-line `textContent` assertions still pass, unchanged.

`style.css` for `.strip__end`: `appearance: none; background: none; border: 0; padding: 0;
font: inherit; color: inherit; cursor: pointer;` plus a dotted underline so it reads as
editable, `:focus-visible` matching the app's other controls, and
`[aria-pressed="true"]` in `--river` with a solid underline so the armed end is obvious
from across the room.

- [x] **Step 9: The empty plan becomes trip setup** (`src/day-panel.js`,
      `src/style.css`, `src/day-panel.test.js`)

```js
    if (!day) {
      el.innerHTML = `
        <div class="day-panel day-panel--empty">
          <h2 class="day-panel__title">Where are you riding?</h2>
          <dl class="trip-setup">
            <div class="trip-setup__row">
              <dt>Start</dt>
              <dd>${esc(startName ?? 'anywhere on the road')}<span class="day-panel__hint">km ${round1(trip.startKm)} of the road</span></dd>
              <button type="button" class="btn btn--sm" data-action="set-start"
                      aria-pressed="${picking === 'start'}">Set start</button>
            </div>
            <div class="trip-setup__row">
              <dt>Finish</dt>
              <dd>${esc(destinationName ?? 'anywhere on the road')}<span class="day-panel__hint">km ${round1(trip.destinationKm)} of the road</span></dd>
              <button type="button" class="btn btn--sm" data-action="set-finish"
                      aria-pressed="${picking === 'destination'}">Set finish</button>
            </div>
          </dl>
          <p class="trip-setup__headline">${tripHeadline(trip, { startName, destinationName })}</p>
          <p class="day-panel__hint">Both ends default to the whole road, so you can skip this and
            just add a day. Click the strip below to pick where day 1 ends — or add one here and
            drag its boundary afterwards.</p>
          <div class="day-panel__actions">
            <button type="button" class="btn btn--sm btn--primary" data-action="add-day">+ add a first day</button>
          </div>
        </div>`;
      renderCustomStopPrompt(null, null, trip, callbacks, promptEl);
      // The setup step has controls now, and pressing one re-renders. Without this a
      // keyboard user has to Tab back to `Set start` to press it a second time — which
      // is the documented way to cancel.
      restoreFocus(focusTarget);
      return;
    }
```

`render`'s signature gains `startName = null, destinationName = null, picking = null`,
and the click listener gains the two actions above the `if (!current.day) return;`
guard (there is no focused day when this panel is the only thing on screen — the same
reason `add-day` already sits there):

```js
    if (e.target.closest('[data-action="set-start"]')) return callbacks.onPickEnd?.('start');
    if (e.target.closest('[data-action="set-finish"]')) return callbacks.onPickEnd?.('destination');
```

> **Open question for the controller:** spec §6a's mock shows *"Start — not set"*, but
> the paragraph under it says both ends default to the road's ends so the step can be
> skipped, and storage gives every plan a real window. There is no state in which an
> end is "not set", so this step shows the ends it actually has, named. **The two-state
> design in §6a (setup step, then "the panel switches to the normal add-your-first-day
> state") collapses into one state for the same reason**, and the setup step keeps the
> `+ add a first day` button throughout. **Recommendation: adopt this and correct §6a
> when the outcome is appended.** An app that says "not set" about a window it is
> already using and drawing would be lying about its own state, which is the failure
> this whole branch has been recording.
>
> **RULED (controller, 2026-08-01): adopted. One state, ends shown named; §6a corrected at Task 16.**
> The reasoning is the same one that has caught six unfalsifiable assertions on this
> branch — a surface must not claim something the state cannot be in. "Not set" was
> written before storage v4 decided every plan carries a real window, so §6a is
> describing a draft of the model that no longer exists rather than expressing a
> preference. Note for Task 11: because there is no empty state to escape, the setup
> step must not read as a *blocking* step either — a user happy with the whole road
> should be able to ignore it entirely and press `+ add a first day`, which is exactly
> what keeping that button throughout achieves.

Test obligations (`src/day-panel.test.js`):

- the empty panel names both ends, their km and the headline; `upstream` for an
  ascending trip and `downstream` for a descending one — **two tests over the same
  fixture with the ends swapped**, because a single one would pass under a hardcoded
  word. This is also the only direct test of `tripHeadline`.
- unnamed ends read as `anywhere on the road` / `your start` rather than `undefined` or
  `null` — kills interpolating a missing name.
- `Set start` emits `onPickEnd('start')` and `Set finish` emits `'destination'` — kills
  one action for both.
- `picking: 'destination'` presses the finish button and not the start one.
- focus survives a re-render on the pressed control — kills the missing `restoreFocus`.
- **the existing empty-state expectation changes**: `expect(el.textContent).toContain('No days yet')`
  becomes the setup step's own text. Record it in the ledger as a deliberate
  expectation change, with the reason (spec §6a replaces that state).

- [x] **Step 10: Commit 11b**

```bash
git add src/ui-util.js src/ui.js src/ui.test.js src/strip.js src/strip-markup.js \
        src/strip.test.js src/day-panel.js src/day-panel.test.js src/style.css index.html
git commit -m "feat(strip): the trip's own ends become the controls that set them"
```

#### 11c — wiring: a pick becomes a window

- [x] **Step 11: `main.js`**

```js
  // Which end the next route click resolves, or null. The app owns it: the two controls'
  // pressed state, the prompt and the Escape path all read it, and the map only reflects
  // it (see map.js's setPickingMode).
  let picking = null;

  function handlePickEnd(tripEnd) {
    // A second press on the armed control cancels — spec §6, and the reason both
    // controls are toggles rather than plain buttons.
    picking = picking === tripEnd ? null : tripEnd;
    map.setPickingMode(picking);
    if (picking) {
      pickBanner.show(
        `Click the route where your trip ${picking === 'start' ? 'starts' : 'finishes'} · Esc to cancel`,
      );
    } else {
      pickBanner.hide();
    }
    // The pressed state is RENDERED, not toggled in place: the strip rebuilds its scale
    // line and the day panel its setup step on every render, so a class set by hand here
    // would survive exactly until the next one.
    renderAll();
  }

  function handlePickPoint(lngLat, tripEnd) {
    picking = null;
    map.setPickingMode(null);
    applyPickedEnd(tripEnd, round1(snap(route, lngLat).distanceKm));
  }

  // The one path from a picked km to a new window: the guards, the reflow, the save and
  // the sentence saying what happened. Three callers — a map pick, the snap offer
  // (Task 12) and Finish here (Task 13) — so a guard added here covers all three.
  function applyPickedEnd(tripEnd, km) {
    const decided = proposeEnd(trip, tripEnd, km, {
      dayCount: itinerary.getDays().length,
      minLengthKm: MIN_DAY_KM,
    });
    if (!decided.ok) return refusePick(tripEnd, decided);
    const dropped = setTripWindow(decided.trip);
    persistPlan();
    renderAll();
    reportPick(tripEnd, km, dropped);
  }

  // The same three steps loadPlanIntoModel takes, with the days coming from memory
  // rather than from storage. A trip is fixed at construction — which is what lets every
  // day chain off the window without re-passing it — so a new window means a new
  // itinerary, replayed from the lengths the plan already has, trimmed to what still
  // fits (spec §8). Returns how many days did not.
  //
  // Breaks ride along untouched: they are absolute km and plan-level, so a window change
  // invalidates none of them (spec's "changing your start does not invalidate a single
  // favorite"). One consequence worth knowing: a break now outside the window keeps its
  // km and its row is simply not drawn — the strip filters glyphs to the window — and it
  // comes back if the window widens again.
  function setTripWindow(nextTrip) {
    const entries = itinerary
      .getDays()
      .map((d) => ({ targetKm: d.targetKm, townChoice: d.townChoice }));
    const breaks = itinerary.getBreaks();
    const fitted = fitDaysToLength(entries, nextTrip.lengthKm);
    trip = nextTrip;
    itinerary = createItinerary({ trip });
    itinerary.hydrate({ days: fitted.days, breaks });
    // A boundary gesture in flight belongs to the itinerary that just left — the same
    // reason a plan switch bumps this (see handleMoveBoundary).
    planGeneration += 1;
    customStopDraft = null; // its day may be gone, and its km may be off the trip
    lastFramedStretch = null; // every day's stretch moved
    return fitted.dropped;
  }
```

The two message paths, and one line of honesty about them: **the guards are unit-tested
in `trip.test.js`; their WORDING is `main.js`'s, which has no test harness, so it is
verified in the browser and the exact sentences are quoted into the ledger.**

```js
  function reportPick(tripEnd, km, dropped) {
    const dropText = dropped
      ? ` · ${dropped} ${dropped === 1 ? 'day' : 'days'} no longer ${dropped === 1 ? 'fits' : 'fit'} and ${dropped === 1 ? 'was' : 'were'} dropped`
      : '';
    // The trip itself is the confirmation, in the same sentence the setup step uses: a
    // rider who has just moved an end wants to know what the trip IS now, and "km 0" —
    // which is what a start always becomes — would tell them nothing.
    pickBanner.show(`${tripHeadline(trip, endNames())}${dropText}`);
  }

  function refusePick(tripEnd, decided) {
    const role = tripEnd === 'start' ? 'start' : 'finish';
    if (decided.reason === 'too-short') {
      pickBanner.show(
        `That ${role} would leave a trip of ${round1(decided.lengthKm)} km — a trip needs at least ${MIN_DAY_KM} km.`,
        { tone: 'error' },
      );
      return;
    }
    if (decided.reason === 'would-reverse') {
      // Spec §6's sentence, with the direction NAMED rather than merely refused. Task 12
      // gives endLabel the town half; a whole-road trip is already named by both road
      // ends, so the common case reads right from here.
      pickBanner.show(
        `That would reverse the trip. Reset the trip to ride ${endLabel(decided.startKm)} → ${endLabel(decided.destinationKm)} instead.`,
        { tone: 'error' },
      );
      return;
    }
    // 'not-a-number' is a bug upstream, not a choice a rider made.
    console.warn('planner-app: ignored a pick with no finite km', decided);
  }
```

`endLabel(km)` names a km for a message: `nameAtKm(km)` (Task 10's `nameForTripEnd`
logic, applied to an arbitrary km) and, failing that, **not a km at all** — `'your
start'`, `'your finish'` or `'the point you picked'` depending on which of the current
trip's ends it is. **Deliberately never an absolute km:** it would be the only absolute
km on screen, which spec §2 names as worse than all-absolute because nothing marks it
as different. The unnamed case reads a little awkwardly ("ride your finish → the point
you picked"), and that is the trade taken.

`renderStrip` and `renderDayPanel` gain `picking` and the two names (Task 12 makes the
names find towns; until then they are the road's ends or null):

```js
  function endNames() {
    return { startName: nameForTripEnd('start'), destinationName: nameForTripEnd('destination') };
  }
```

`createMap` gains `onPickPoint: handlePickPoint`; `createPickBanner` is mounted on
`#pick-banner`; the `#map-controls` event guard is extended to cover the prompt, and
that is not cosmetic — **the prompt sits inside the Leaflet container, so without it
pressing its action button would also be a map click**, which either picks a km under
the button or drops a custom stop on the focused day. Extract the existing loop into a
helper applied to both elements, keeping the `click` handler's `stopPropagation` as
well.

Escape:

```js
  // Escape cancels a pick. Owned at the document because when a pick is armed the
  // pointer is over the MAP, and nothing there holds focus to hang a handler on. The two
  // editors that own Esc for themselves — the day panel's break-note editor and its
  // custom-stop prompt — both stopPropagation, so this cannot steal theirs.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !picking) return;
    handlePickEnd(picking); // the toggle IS the cancel; one path, one place
  });
```

- [x] **Step 12: Run the whole suite, verify in the browser, commit 11c**

Run: `npx vitest run --exclude '**/.cache/**'` and `npx vite build`.

**Persisted:** the window, through the path storage already has — `persistPlan` names
`trip.startKm` / `trip.destinationKm` on every save, so a pick is durable the moment it
is applied. **Nothing new is persisted, and no schema change:** the trimmed day lengths
go through the same `days` array, and the picking mode is transient (a reload cancels
it, which is right). The one thing to check in storage is that a pick which drops days
writes the SHORTER list — a persist that wrote the pre-trim lengths would restore the
dropped days on reload.

**Browser verification** (real chromium, production build, zero console errors):
1. **Arming.** `Set start` on the scale line presses (`aria-pressed="true"`), the cursor
   over the route is a crosshair, and the prompt reads *"Click the route where your trip
   starts · Esc to cancel"*. Escape cancels: pressed state gone, cursor back, prompt
   gone, **window unchanged in storage**. A second press on the control does the same.
2. **A pick that works.** On the default whole-road plan with three 80 km days, arm
   `Set start`, click near Hamburg → the strip rescales, the scale line reads `km 0 · start`,
   day 1 starts at the click, the start pin has moved there, and the prompt reads the
   headline. Reload → the window survives.
3. **A pick that drops days.** With five 80 km days, `Set finish` clicked ~180 km along
   → three days remain (80 / 80 / 20) and the prompt says two days were dropped. Reload
   → still three days.
4. **A pick refused as too short**, and **a pick refused as a reversal**: quote both
   sentences verbatim into the ledger, and confirm the window and the days are
   untouched afterwards (the refusal path must not persist).
5. **A picking click creates no custom stop.** Arm, click on the route inside the
   focused day, and confirm the day gains no 📌 — the exclusivity from Task 10, end to
   end. Then click the same place unarmed and confirm the stop prompt DOES appear.
6. **Pressing the prompt's own button is not a pick** (Task 12 supplies the button; if
   11c has no action button yet, defer this one and say so).
7. **The setup step.** A fresh plan (no days) shows both ends, their km, the headline
   and `+ add a first day`; `Set finish` there arms the same mode; setting both ends in
   either order leaves a coherent trip; and on an empty plan a **flip is allowed** —
   set start to Dresden and finish to Hamburg and confirm the strip runs Dresden →
   Hamburg with `downstream` in the headline.
8. **The elevation profile changes when only ONE end moves** — the memo key's per-end
   paths, which Task 8's fix round pinned with two tests precisely because these two
   controls are each half of it. **Observe the drawn path, not a climb figure:** read
   the first and last `y` of `.strip__elevation-line`'s `d` (Task 8's browser bullets
   quote them as `42.9 → 28.4` and its mirror), because moving one end changes which km
   are SAMPLED. Ascent totals are the wrong instrument here — the spec's own §4 example
   was corrected at `584a88c` for claiming this corridor trades 487 m each way when its
   median weaker-side ratio is 0.947, so two different stretches of the Elbe can report
   nearly the same climb and a stale memo would pass unnoticed.

```bash
git add src/main.js
git commit -m "feat: pick a start and a finish on the map"
```

---

### Task 12: Town snapping, and the ends by name

**Files:**
- Modify: `src/towns.js`, `src/strip-markup.js`, `src/main.js`
- Test: `src/towns.test.js`, `src/strip.test.js`

What Task 11 left neutral, this task names. Everything here rests on one decision, so it
comes first.

- [x] **Step 1: One lookup, two tolerances** (`src/towns.js`, `src/towns.test.js`)

**A picked name is DERIVED from the km, never stored.** Spec's own definition of a trip
is "a `startKm`, a `destinationKm`, and nothing else"; a stored name would be a second
source for something the km already say, and this branch's ledger is a list of what
happens when one fact has two owners. So: **no new persisted field, no schema bump, no
migration.** A start that sits where a town sits is named by that town; move it 3 km and
the name goes, because that is the truth.

```js
/**
 * The town sitting closest to `km` along the route, within `withinKm`, or null.
 *
 * Two callers, two tolerances, one rule: main.js offers a 3 km snap after a pick (spec
 * §6.3) and NAMES a trip end with the same lookup at 0.05 km — "the town this end IS"
 * is "the town near enough to be the same place", and 0.05 is the half-step of the
 * 0.1 km grid every stored km sits on.
 *
 * Ranked by distance ALONG the route, tie-broken by the perpendicular offset, and
 * deliberately not by townsNear's offset-weighted score: that ranking answers "where
 * could I sleep near the end of this day", where a detour is worth trading against
 * being early; this one answers "what is this point called", where the closest name
 * wins outright.
 *
 * Symmetric in km, so it needs no trip and no direction — the same reason townsNear
 * needs none (places.js's header names that exception). `townsInRange` is NOT used
 * here: it is ascending-only and would need poisInRange's direction treatment first.
 */
export function nearestTown(towns, km, { withinKm = 3 } = {}) { … }
```

Implement with `lowerBound`/`upperBound` over the window, exactly as `townsNear` does,
then a single min-scan.

Tests (`src/towns.test.js`, over the file's existing `TOWNS` fixture):

- **picks the closest ALONG the route, which is where it differs from `townsNear`.** Km
  50 is the fixture's own disagreement case: `townsNear`'s weighted score ranks
  `Craghill` first (54, offset 1 → 5.5) ahead of `Brambury` (51, offset 4 → 7), while
  distance alone ranks Brambury first (1 against 4). So
  `expect(nearestTown(TOWNS, 50).name).toBe('Brambury')` is the one assertion that kills
  a `nearestTown` implemented by reusing `townsNear` — and the fixture already carries
  the comment explaining why those two towns are there.
- answers null outside the window: `nearestTown(TOWNS, 66, { withinKm: 3 })` is null,
  while `withinKm: 6` finds `Elmswick` (61) — kills a hardcoded radius and kills
  ignoring `withinKm` altogether.
- the naming tolerance: `nearestTown(TOWNS, 28.04, { withinKm: 0.05 })` is `Oakdale`
  and `nearestTown(TOWNS, 28.06, { withinKm: 0.05 })` is null — both sides of the edge,
  and the second is the one that catches a `<=`-for-`<` slip in the window.
- a tie along the route goes to the smaller offset — needs two fixture towns at one km,
  so add a pair to the fixture (recording the fixture change) or assert it over a local
  array. Kills a tie-break that takes whichever comes first, which would make the name
  depend on the data build's ordering.
- a non-finite km answers null rather than scanning — kills the missing guard, which
  would make `lowerBound(towns, NaN)` decide the answer.

- [x] **Step 2: A picked name reaches the strip** (`src/strip-markup.js`,
      `src/strip.test.js`)

```js
function endName(state, tripEnd) {
  // The name main.js resolved for this end — a town the rider's end sits in, or the
  // road's own name when the end is a road end. It wins because it is the answer to
  // exactly this question, computed where the town data lives.
  const named = state.endNames?.[tripEnd];
  if (named) return named;
  const past = roadPast(state, tripEnd);
  if (!roadContinues(past)) return past.name;
  return tripEnd === 'start' ? ORIGIN_FALLBACK : DESTINATION_FALLBACK;
}
```

Additive: with no `endNames` (which is how most of `strip.test.js` renders) every
existing case behaves exactly as before, including the pinned `startKm: 0.04` pair. The
road-end branch below it is what stops a town 40 m from Cuxhaven renaming the road's
origin — main.js's helper answers `Cuxhaven` there for the same reason, and its comment
names this gate.

Test obligations (`src/strip.test.js`):

- with `endNames: { start: 'Hamburg', destination: 'Dresden' }` on the 149.3 → 797.6
  window, **all three sites read the picked names**: the scale line (`km 0 · Hamburg`,
  `km 648.3 · Dresden`), the summary (`488.3 km to Dresden`) and the remainder's flag
  (`⚑ Dresden`). Kills converting the scale line only — which is the shape of the bug
  Task 8's ledger entry describes ("0 km to **Prague**" while the scale line had
  stopped saying it).
- an end with no name still reads `start` / `finish` — kills interpolating `null`.
- the whole-road cases are unchanged — kills a picked name that outranks the road's own
  name at a road end.

- [x] **Step 3: The names, and the offer** (`src/main.js`)

`nameForTripEnd` gains the town half, and a general form for an arbitrary km:

```js
  const NAME_TOLERANCE_KM = 0.05; // the 0.1 km grid's half-step: "near enough to BE there"
  const SNAP_OFFER_KM = 3; // spec §6.3. At whole-route zoom a click is worth ±2 km.

  function nameAtKm(km) {
    if (round1(km) <= 0) return ORIGIN_NAME;
    if (round1(totalKm - km) <= 0) return DESTINATION_NAME;
    return nearestTown(towns, km, { withinKm: NAME_TOLERANCE_KM })?.name ?? null;
  }

  function nameForTripEnd(tripEnd) {
    return nameAtKm(tripEnd === 'start' ? trip.startKm : trip.destinationKm);
  }
```

That one line lights up everything Task 11 left neutral, because every consumer already
goes through the helper: the strip's scale line, summary and flag; the map's start pin;
day 1's `from X`; the places panel's `X km from …`; the setup step; the headline in the
prompt; and `endLabel`'s named case in the refusal.

`reportPick` gains the offer:

```js
    // Spec §6.3: at whole-route zoom one pixel is ~0.7 km, so a click is worth ±2 km.
    // Name the town within SNAP_OFFER_KM and let one press take it.
    const town = offerSnap ? nearestTown(towns, km, { withinKm: SNAP_OFFER_KM }) : null;
    const gap = town ? round1(trip.tripKm(town.routeDistanceKm) - trip.tripKm(km)) : 0;
    if (town && gap !== 0) {
      pickBanner.show(
        `${tripHeadline(trip, endNames())}${dropText} · ${town.name} is ${Math.abs(gap)} km ` +
          `${gap < 0 ? 'behind' : 'past'} your ${role} — use it instead?`,
        { action: { label: `Use ${town.name}`, onPress: () => applyPickedEnd(tripEnd, round1(town.routeDistanceKm), { offerSnap: false }) } },
      );
      return;
    }
```

Three things about that, each deliberate:

- **The offer measures in RIDER km, not the spec's absolute `(km 149.3)`.** Spec §6.3
  writes *"Start at Hamburg (km 149.3) instead?"*, and 149.3 is an absolute route km — on
  a trip starting at Hamburg the strip reads `km 0 · Hamburg`, so that figure would be
  the only absolute km on screen. Spec §2 names that as worse than all-absolute,
  "because nothing marks it as different". The offset from the pick says the same thing
  in the rider's own units, and it is the number that actually helps: *"Hamburg is 2.8
  km behind your start"*.
- **The offer takes the same path as any other pick** (`applyPickedEnd`), so a snap that
  would flip or shorten the trip is refused by the same guards with the same words.
  `offerSnap: false` on that second call is what stops a snap that lands 0.4 km from
  another town offering that one next.
- **The offer survives re-renders and is cancelled by anything that starts a new pick**,
  because the prompt is written by explicit calls rather than by `renderAll`. Escape
  hides it (extend the Escape handler's second branch), and pressing it spends it (the
  banner hides before the callback runs, from Task 11's `createPickBanner`).

`handleResetTrip` needs one line of thought and no change: it deliberately keeps the
window ("reset empties the plan you made for a trip, it does not undo the trip"), which
is exactly what the refused-flip message points at — and after a reset the plan has no
days, so the flip the rider wanted is then free. **Confirm that end to end in the
browser**; it is the escape hatch the refusal promises, and nothing tests the promise.

- [x] **Step 4: Run, verify in the browser, commit**

Run: `npx vitest run --exclude '**/.cache/**'` — towns 15 → ~21, strip +4.

**Persisted:** nothing new. This is the whole point of Step 1 — say so in the ledger,
because "where does the picked name live" is the first question a reviewer will ask.

**Browser verification** (real chromium, production build, zero console errors):
- **the snap.** Arm `Set start`, click ~2.8 km short of Hamburg → the prompt names
  Hamburg and its offset, `Use Hamburg` presses once, and afterwards the scale line reads
  `km 0 · Hamburg`, the start pin's title is `Start — Hamburg` with an `H` glyph, day 1's
  panel header reads `from Hamburg · km 0 → 80`, and the left panel's rows read `… km
  from Hamburg`. **That last one is the lie the ledger has been tracking since Task 5**
  (`from Cuxhaven` on a plan starting in Hamburg) — quote the before and after.
- **a pick with no town within 3 km** offers nothing and reads `km 0 · start`, with day
  1 reading `from your start`. The absence is as important as the presence: an offer for
  a town 12 km away would move the start somewhere the rider did not click.
- **pressing `Use Hamburg` is not a map click** — the guard from Task 11 Step 11. Confirm
  the focused day gains no 📌 and the start lands on Hamburg exactly.
- **the refusal names the direction:** on a Hamburg → Dresden plan with days, arm `Set
  finish` and click near Cuxhaven → *"That would reverse the trip. Reset the trip to ride
  Hamburg → Cuxhaven instead."* Then Reset trip and repeat the same pick → now allowed,
  and the strip runs downstream. Quote both sentences.
- **downstream naming:** on a 797.6 → 149.3 window the scale line reads `km 0 · Dresden`
  … `km 648.3 · Hamburg`, the summary counts down to Hamburg, the flag says Hamburg, and
  the start pin is at Dresden. The mirror of the forward case is the feature.
- **the stub figure is now text:** read the start control's `aria-label` in all three
  configurations and confirm it carries the same distance and name the stub's title does
  (149.3 km to Cuxhaven forward, 228.9 km to Prague downstream, and no clause at all on
  the whole road).

```bash
git add src/towns.js src/towns.test.js src/strip-markup.js src/strip.test.js src/main.js
git commit -m "feat: name the trip's ends after the towns they sit in, and offer the nearest one after a pick"
```

---

### Task 13: `Finish here` on a day card

**Files:**
- Modify: `src/day-panel.js`, `src/main.js`
- Test: `src/day-panel.test.js`

The "after planning some days, select this stop as destination" from the original
brainstorm (spec §6). Small, because Tasks 11 and 12 built everything under it: this is
one button and one call into `applyPickedEnd`.

- [x] **Step 1: Write the failing tests** (`src/day-panel.test.js`)

```js
describe('createDayPanel - Finish here', () => {
  it('offers to finish the trip at this day’s end', () => {
    const onFinishHere = vi.fn();
    const panel = mountPanel({ onFinishHere });
    panel.render({ day: DAY_1_OF_3, trip: UP, dayCount: 3 });

    el.querySelector('[data-action="finish-here"]').click();

    expect(onFinishHere).toHaveBeenCalledWith(0);
  });

  it('names the day whose end it would use, not the focused index', () => {
    const onFinishHere = vi.fn();
    const panel = mountPanel({ onFinishHere });
    panel.render({ day: DAY_2_OF_3, trip: UP, dayCount: 3 });

    el.querySelector('[data-action="finish-here"]').click();

    expect(onFinishHere).toHaveBeenCalledWith(1);
  });

  // A day already ending at the finish has nothing to offer, and a button that does
  // nothing is worse than no button.
  it('is disabled on a day that already ends at the trip’s finish', () => {
    const panel = mountPanel({});
    panel.render({ day: LAST_DAY_AT_DESTINATION, trip: UP, dayCount: 3 });

    expect(el.querySelector('[data-action="finish-here"]').disabled).toBe(true);
  });

  it('is enabled on the last day when the plan stops short of the finish', () => {
    const panel = mountPanel({});
    panel.render({ day: LAST_DAY_SHORT_OF_DESTINATION, trip: UP, dayCount: 3 });

    expect(el.querySelector('[data-action="finish-here"]').disabled).toBe(false);
  });

  it('is enabled on a downstream day that ends short of the finish', () => {
    const panel = mountPanel({});
    panel.render({ day: DOWNSTREAM_DAY_1, trip: DOWN, dayCount: 2 });

    expect(el.querySelector('[data-action="finish-here"]').disabled).toBe(false);
  });
});
```

**Kills:** the two emit tests kill a hardcoded index and a button wired to the wrong
callback. The disabled pair kills both halves of the predicate — a button always
enabled (which offers a no-op on the last day of a completed plan) and one always
disabled (which is the feature missing). The downstream case kills an absolute-km
comparison: `day.endKm === trip.destinationKm` happens to work, but
`day.endKm >= trip.destinationKm` — the shape someone writes without thinking — is true
for **every** downstream day, disabling the button across the whole plan.

- [x] **Step 2: Implement** (`src/day-panel.js`)

In `.day-panel__actions`, before `Split day`:

```js
        // Rider km on both sides, and the predicate is "does this day already end where
        // the trip does". In absolute km the comparison inverts downstream; in rider km
        // the day's end and the trip's length are two distances from one origin, which
        // is the same question whichever way the trip runs.
        const atFinish = round1(trip.tripKm(day.endKm)) >= round1(trip.lengthKm);
```

```html
          <button type="button" class="btn btn--sm" data-action="finish-here" ${atFinish ? 'disabled' : ''}
                  title="${atFinish ? 'This day already ends at your finish' : `Finish the trip at km ${round1(trip.tripKm(day.endKm))}, dropping any later days`}">Finish here</button>
```

plus `if (e.target.closest('[data-action="finish-here"]')) return callbacks.onFinishHere?.(index);`
in the click listener, below the `current.day` guard with the other day actions.

- [x] **Step 3: Wire it** (`src/main.js`)

```js
  // Spec §6: after planning a few days, make one of them the destination. The day's own
  // end is already a legal position on the trip, so the only guard that can bite is the
  // length one — a first day of 3 km cannot become a 3 km trip. It goes through
  // applyPickedEnd anyway, because a second copy of the guards is how the two drift.
  function handleFinishHere(index) {
    const day = itinerary.getDays()[index];
    if (!day) return;
    applyPickedEnd('destination', round1(day.endKm));
  }
```

`fitDaysToLength` does the dropping for free: the new `lengthKm` is exactly the plan's
reach through that day, so every later day finds no room and `reportPick` says how many
went. **No new persistence, no new state** — the window is written by the `persistPlan`
inside `applyPickedEnd`, and the trimmed day list with it.

One consequence to state rather than discover: **`Finish here` on a day whose overnight
town sits past its boundary keeps that town**, because `fitDaysToLength` keeps the
straddling day's choice and this day is not even clamped. The day panel's existing snap
note explains any mismatch.

- [x] **Step 4: Run, verify in the browser, commit**

Run: `npx vitest run --exclude '**/.cache/**'` — day-panel +5.

**Browser verification:** on a five-day whole-road plan, `Finish here` on day 3 →
`destinationKm` becomes day 3's end, days 4 and 5 are gone, the prompt says two days
were dropped, the strip rescales to the new window with a `road continues … to Prague`
cap at the right-hand end that was not there before, the scale line names day 3's
overnight town if it has one, and the button is then **disabled** on the new last day.
Reload → three days and the new window. Then the same on a downstream plan, where the
new cap appears at the right-hand end and names **Cuxhaven**.

```bash
git add src/day-panel.js src/day-panel.test.js src/main.js
git commit -m "feat(day-panel): finish the trip at this day's end"
```

---

### Standing conventions for all four tasks

- **An assertion that would pass under its own inversion is worthless.** Five are
  recorded in the ledger, all of them assertions (a payload that could not escape its
  `title` context; a memo test that moved both window ends and so pinned neither; a row
  cap pinned by count only, so keeping the LAST 40 passed; a map cap pinned only against
  an ascending fixture; an ordering assertion standing in for a conversion assertion).
  Every obligation above names the mutation it must kill; run them.
- **The same failure wears the clothes of a browser verification, so apply the rule
  there too: before writing one, ask what value the instrument would report if the thing
  under test were broken. If you cannot answer, the instrument is wrong — not the test.**
  Task 11's obligation 8 is this feature's example and was caught in review rather than
  in use: verifying that the elevation memo re-samples when one window end moves, by
  comparing ASCENT TOTALS, on a corridor whose median weaker-side ratio is 0.947. Two
  different stretches of the Elbe report nearly the same climb, so a stale memo would
  have reported "fine". The px-level `d` attribute answers differently when the memo is
  stale; the climb figure does not. **Every browser bullet in these four tasks should be
  read that way before it is run** — several assert a NAME and a NUMBER together for
  exactly this reason (the road-past clause, the two directions of `roadPast`), and the
  ones that quote a figure verbatim into the ledger are the ones that can be checked
  afterwards by somebody who was not watching.
- **Mutation trees go in the session scratchpad, outside the project — and the hazard is
  not `.cache`, it is ANY sibling copy.** Read the ledger's corrected form before you
  run one; the short version, because these four tasks will run five sweeps between
  them:
  - `vitest` 4 here does not exclude `.cache/`, and it does not exclude anything else
    either. A `.verify-*` tree beside `src/` produced **40 files / 1646 tests** *with*
    `--exclude '**/.cache/**'` already applied, and `vitest run src/strip.test.js`
    reported **247 tests for a 126-test file** while two agents' trees existed. Naming
    the copy differently does not help.
  - **The damage is one-directional, which is why "outside the project" is the rule and
    not a preference.** Your in-worktree copy lands in every *other* agent's full-suite
    discovery, manufacturing failures and inflated counts that neither party owns and
    that you cannot see. The `--exclude` flags only ever protect the person who
    remembers to type them — keep typing them on any count you record, but do not
    mistake them for protection.
  - Outside the project `vite` will not resolve, so the tree needs a `node_modules`
    junction — and **unlink the junction before deleting the tree**
    (`[System.IO.Directory]::Delete(path, false)`; `cmd /c rmdir` tripped over path
    escaping here). A recursive delete otherwise follows it into the shared
    `node_modules` and destroys it under every concurrent agent. Check the real
    `node_modules` is intact afterwards.
- **Browser probes and screenshots go in the scratchpad too.** Phase 4 has a browser
  pass in every task, each wanting a seeding script (`smoke-oriented.mjs` /
  `smoke-lists.mjs` / `smoke-climb.mjs` are the ones to extend, all in the session
  scratchpad). Do not leave them in the worktree root: `probe-dblclick.mjs`,
  `probe-target.mjs`, `smoke-resize.mjs` and four `resize-*.png` are sitting there
  untracked as this is written. They miss vitest discovery (not `*.test.js`), so the
  cost is smaller than a mutation tree's — but every concurrent agent reads them in
  `git status`, and an untracked file beside `src/` is one `git add -A` away from being
  committed by somebody who did not make it.
- **One mutation at a time.** Batching is what made Task 8's `Math.abs` gap hard to
  attribute.
- **Record every changed expectation.** Three are expected across these tasks: the
  three `createMap - the start pin` cases (construction → setter), the day panel's
  empty-state `'No days yet'`, and nothing else — if a fourth appears, stop and check
  whether the change or the test is wrong.

---

## Phase 5 — the resizable strip

### Task 14: `strip-resize.js`

**Files:** Create `src/strip-resize.js`, `src/strip-resize.test.js`

- [x] Tests: a drag on the handle changes the height; the height clamps at 46 px and at 45% of the viewport; the value persists to `localStorage` under `elberadweg-strip-height`; a double-click resets to 46; a stored height outside the bounds is repaired on load; `pointercancel` mid-drag leaves a sane height.
- [x] Implement as its own module taking `{ el, storage, onResize, measureViewport }`, mirroring `strip.js`'s pointer-capture discipline — capture on a stable element, not the handle, for the same reason documented there.

### Task 15: Wire it up

- [x] `main.js` mounts it, and its `onResize` re-renders the strip. The `ResizeObserver` currently watching width must watch height too, or a resize will move the handle without redrawing the profile.
- [x] Verify in the browser at 46 px, mid-range and maximum: the profile rescales, the day labels stay put, the map shrinks, and a reload restores the height.
- [x] Commit.

---

## Task 16: Review, verify, merge

- [x] `npm test` — run from inside the worktree; expect >650 tests passing (592 baseline + this feature's new tests; the plan's original ">1150" figure was based on a polluted count).
- [x] `npm run build`.
- [x] Grep sweep: no raw absolute km in display code; no `totalKm` left in `itinerary`/`boundaries`/`strip-geometry` signatures.
- [x] Browser: Hamburg → Dresden, then Dresden → Hamburg, and confirm the climb figures swap.
- [x] Two-stage review — spec conformance, then quality.
- [x] Merge to `master` with `--no-ff`, push.
- [x] Append the outcome to the spec.

---

## Self-Review

**Spec coverage:** §1 model → Tasks 1–3. §2 translation → Tasks 5–6. §3 rescale → Tasks 7–8. §4 direction+elevation → Tasks 8–9. §5 climb label → Task 9. §6 picking → Tasks 10–12. §6a setup → Task 11. §6b resize → Tasks 14–15. §7 storage → Task 4. §8 guards → Tasks 3, 12, 13.

**Gaps found while reviewing, now closed:**
- Nothing covered `breaksInRange` receiving a descending span. Task 2 does.
- `boundaryWindow` returning absolute km means `min` can exceed `max` downstream, which would make `aria-valuemin > aria-valuemax`. Called out in Task 3 and assigned to `handleMarkup`.
- A picking click would also have created a custom stop. Task 10 makes the paths exclusive.
- Nothing re-rendered the strip on a height change. Task 15.

**Placeholder scan:** Tasks 10–13 are specified as outcomes plus test obligations rather than full code. That is deliberate and it is a real gap in this plan's detail — they depend on the exact shape phases 1–3 settle into, and writing their code now would be guessing. **Whoever executes Task 10 should expand tasks 10–13 into full steps first**, in the style of Tasks 1–4.

**Type consistency:** `createTrip` returns `{startKm, destinationKm, direction, lengthKm, tripKm, absoluteKm, contains, clampKm, advance}`, used under those names in itinerary, boundaries, strip-geometry, strip-markup and main. `createItinerary({trip})`, `boundaryWindow(days, index, {trip})`, `kmToX(km, {startKm, endKm, width})`, `ascentBetween(profile, fromKm, toKm, {thresholdM})` — consistent across every task that names them.

## Ledger

- **Baseline corrected:** 592 tests in 18 files at `b1d778d`, not 1076 — the old figure counted duplicate suites in stale worktrees. Stale `timeline-layout` worktree (clean, fully merged) removed.
- **Task 1 done** (`5780f74`, +16 tests → 608). Deviations from the plan's snippet, all from the quality review and adopted by the controller:
  - `createTrip` **throws** when neither `destinationKm` nor `totalKm` is finite, instead of silently defaulting the destination to 0 (which turned a forgotten route length into a reversed trip to km 0 and would have zero-collapsed every day once Task 2 swaps `clamp(…, 0, total)` for `trip.advance`). Matches `boundaries.js`'s documented throw-on-missing-totalKm posture.
  - `wouldReverse` **throws on a non-finite proposed end** — it previously failed *open* on downstream trips (`wouldReverse(down, {destinationKm: NaN}) === false`), letting the refused-flip guard pass the exact state it exists to refuse.
  - The trip **keeps `totalKm`** on the frozen object and **clamps both ends into `[0, totalKm]`** when it is finite — this is spec §8's "both ends clamped" requirement, which no other task owned, and Task 8's stubs need `totalKm` anyway.
  - Consequence for **Task 4**: `createPlanStore`'s new `totalKm` argument is **required and validated finite**, not `?? 0` — the store cannot say where a window-less plan ends, and under a zero fallback every such plan would collapse to a zero-length trip at km 0 (both ends clamped into `[0, 0]` by `createTrip`), stranding all its days. Requiring `totalKm` turns that caller mistake into a boot-time throw. (An earlier wording here claimed the zero fallback produced "the failure `createTrip` refuses" — wrong twice over: 0/0 is an equal-ended LEGAL window, and `createTrip` refuses non-finite ends, not reversed trips; reversal is the feature.)
  - The unused `round1` import from the plan snippet was dropped; no rounding in `trip.js` (rounding is display work, and it would break the round-trip property the tests pin).
- **Task 2 done** (`692ebe4` + fix `33daf7b`, itinerary 98 → 117 tests, suite 649). Deviations, all reviewed and adopted:
  - Signed arithmetic via `rideKm`/`alongKm`, COMPOSED from `trip.tripKm`/`trip.absoluteKm` (delegation, not duplication — a convention change in trip.js propagates automatically).
  - `breaksInRange` normalises a descending span in RIDER km, not absolute min/max — the plan-sketch's `Math.min/max` on absolute km would have inverted the `(start, end]` ownership downstream (handing the shared km to the wrong neighbour). Results now sorted in trip order (a downstream day card would otherwise list stops backwards). One old expectation changed under authorization: reversed-bounds no longer means "empty range".
  - Construction throws on a missing/underspecified trip (hydrate's try/catch would otherwise swallow the TypeError into a silent empty plan). Guard duck-types `advance` + `tripKm`; Task 3 must add `absoluteKm` (now load-bearing).
  - **Critical caught by review:** the first commit's `{ totalKm: trip.destinationKm }` boundaries stopgap CORRUPTED plans — `moveBoundary`/`editDay`/`setTownChoice` on offset-forward or downstream trips wrote `targetKm <= 0` (boundaries.js:52 hardcodes a km-0 origin), and `hydrate` then dropped the whole plan on reload. Fixed by converting to rider km around `clampBoundaryKm` (boundaries.js untouched); Task 3 lifts that conversion INTO boundaries.js, whose other callers (`strip.js`, `strip-markup.js`) still pass absolute km. A parameterised invariant battery (no stored `targetKm <= 0` after any public op, hydrate round-trip preserves day count, both trip shapes) now guards the whole class.
  - Three latent `main.js` km-semantics bugs found by the same review are on Task 5's checklist: the arrival check compares rider km to the ROAD length; `:609` mixes rider and absolute km; `breaksForDay`'s origin-widening keys on absolute km 0 instead of the trip start.
- **Task 3 done** (`8b026f8` + fix `93d7427`, boundaries 16 → 29 tests). All three exports take `{ trip }`; conversion + duck-type guard fused in `riderDays()`; `rawBounds` byte-identical modulo `totalKm`→`lengthKm`. **The plan contradicts itself on bound ordering and the PROSE won:** the Step-2 snippet's `min 105 / max 295` numbers are pre-decision numeric ordering; the implemented contract is TRIP-ORDERED bounds (downstream `min` — closest to the rider's start — is the numerically LARGER absolute km), per the Step-3 "sort in handleMarkup, not here" prose. Do not "restore" the snippet's numbers. Two subtleties found and pinned: the MIN_DAY_KM floor and the proposal clamp must both act in RIDER km (absolute-km forms pick the inverted window's illegal end / pull toward the road's origin). The `{ totalKm: Infinity }` tolerance is RETIRED (no trip createTrip can build carries an infinite length; a caller wanting an unclamped last boundary now throws). Two authorized whole-road stopgap trips live in strip.js (`stopgapTrip()`) and strip-markup.js — **Task 8 must delete both** (checklist: `git grep -n createTrip -- src/strip*.js` must come back empty of stopgaps). itinerary's construction guard gained `absoluteKm` (closing Task 2's ledger note). The plan's fourth suggested test ("counts arrival by distance ridden") was deliberately not written — it asserts a pure expression over `trip` and belongs to trip.test.js. Seam for Tasks 8/12: `proposeKm` rounds an ABSOLUTE km, so once a trip start sits off the 0.1 km grid its output is "very nearly legal" and anything trusting it without re-clamping inherits up to 0.05 km of slack (moveBoundary re-clamps today). **Aria-sort ownership rule:** Task 6 says delete `handleMarkup`'s numeric sort (dead once aria values are rider km, which ascend by construction over trip-ordered bounds); Task 8 says pin it with a downstream-axis test — whichever task converts the aria values to rider km OWNS THE DELETION and the other obligation dissolves; do not pin then delete. Post-hoist correction: it is `axisMarkup` (not `handleMarkup`) that throws on an axis without a finite totalKm, and it now throws with zero days too — Task 8's new strip-markup tests must build axes with a real trip or finite totalKm.
- **Task 14 done, pulled forward** (`7ce213b` + fixes `df67841`, `9f6343d`; strip-resize 52 tests; suite 721 in 20 files). Self-contained gesture module `createStripResize({el, storage, onResize, measureViewport})` → `{height(), remeasure()}`; creates its own `.strip__resize` handle; capture on `el` (a resize drag's captured events never traverse axisEl, so the two modules on one element cannot fight — verified both directions); per-move clamping 46 px–45% live viewport; persists once per gesture; keyboard: arrows 8/24 px, Enter/Home/End (Enter is the dblclick's keyboard twin, NOT APG-splitter Enter, which is a collapse toggle; PageUp/PageDown deliberately rejected — they're slider-pattern keys, and a swallowed key that moves nothing is worse than one the page keeps); absent stored value deliberately NOT written (46 is the default, not a preference); `remeasure` repair is PERMANENT by design. Cross-module consequence, deliberate: the handle now takes focus on press, so pressing it with a day-panel break-note editor open commits the note via blur — a consistency gain (the handle behaves like every other click target), recorded here because nothing else writes it down. Harness note: raising the shared test viewport to 1000 is what WOULD have made the fallback seam test tautological; its injection moved to 600→270 to stay ahead of that. Residuals on Task 15: window-resize listener (the stripEl ResizeObserver cannot see height-only window changes), live createStrip+createStripResize seam test, one-line mid-drag keypress guard (`if (dragging) return` in keydown — the active pointer should be authoritative), and the "the pattern lists them" attribution fix.
- **Task 4 done** (`41bb8b8` + fix `75951ae`, storage 59 → 74 tests, suite 653). `READABLE_SCHEMA_VERSIONS = Set([4,3,2])` replaces `PREVIOUS_SCHEMA_VERSION`; `totalKm` required + finite-validated; no clamping/sorting in storage (createTrip owns it). Quality review adopted: `saveActivePlan` PRESERVES an omitted window (reset-on-omit made a forgetful future save path — Tasks 11/13 — silently destroy the user's window; stale-but-visible beats gone-and-silent; also means a stored window survives a same-corridor rebuild that changes totalKm). `normalizePlan(plan, wholeRoad)` takes the fallback WINDOW, built by a factory-local `wholeRoad()` helper, so the three default sites agree by construction. Each window end repairs independently. Mutation-verified on scratchpad copies (never broken source on disk). Task 16 carries three small folds: pin single-ruined-end repair; document omitted-ends behaviour in the public JSDoc; unify fallbackWindow/wholeRoad naming. **Correction after Task 5:** preserve-on-omit is now UNREACHABLE from the app — `persistPlan` names the window on every save, so a road-shortening rebuild commits `createTrip`'s clamp on the first save after boot (the "stored window survives a rebuild" claim above holds only until then). Deliberate: an unridable window preserved is less honest than the clamp committed; the guarantee still protects any FUTURE save path that omits the window.
- **Task 5 done** (`63445bf` + polish `b1a44cf`; itinerary 117 → 124; suite 725 in 20 files; browser checkpoint PASSED on real chromium, re-run after the polish round with line-for-line identical output — zero console errors, endpoints/day-add/drag/keyboard/breaks/reload-persistence/plan-switching/arrival-at-destination all exercised, storage v4 blobs verified). Phase 1 closed. Beyond the checklist: `focusedCoords` handed a trip-ordered span to route.js's ascending-only `stretchCoords` (would have blanked every downstream day's highlight AND frozen the camera) — min/max at the call site; `dayOwnsKm`/`includeFrom` give a break exactly at the rider's start to day 1 in both directions with zero slack behind. Spec review found three surviving km-0 widening copies (strip-markup `breaksIn`, day-panel `draftForDay`, places `dayTagFor`) + `poisInRange` descending-span emptiness — all assigned to Task 6, whose scope now includes main.js and pois.js. `fromNameFor`/origin-name staleness → Task 12; the static construction-time start pin in map.js → Task 10. Polish round: `itinerary.dayOwnsKm(index, km)` + `breaksForDay(index)` own the day-ownership rule (one internal `spanOwnsRiderKm`; `includeFrom` deleted as a dead option; the index-0 start-line exception is pinned as INDEX-0-ONLY, not a zero-length rule); `loadPlanIntoModel(plan)` owns the trip+itinerary+hydrate triple. `breaksInRange` currently has zero app callers — do NOT delete it on that argument alone (strip-markup's `breaksIn` is span-keyed and Task 6/8 will likely re-caller it; it also pins the convention independently of day indexing); revisit after Tasks 6 and 8. Task 6 must have day-panel RECEIVE day-ownership answers rather than re-spell the predicate (`day-panel.js:100-101` re-decides a draft's day — the exact question main.js now delegates).
- **Task 6 done** (`d208790` + fix round `52a117b`; pois 13 → 15, strip 75 → **86**, day-panel 62 → 67, places 55 → 62; suite **750 in 20 files**, zero failures; `npx vite build` clean; browser-verified on real chromium — see the browser sub-bullet). Phase 2 closed: every km a user reads is now counted from their own start, in their own direction. (Counts corrected after review: places was 55, not 53 — `it.each` over three glyph kinds is three tests, which a grep for `it(` misses.)
  - **Display-site enumeration** (the plan's Step-1 grep, every hit classified before any edit; `git grep -n "startKm\|endKm\|routeDistanceKm\|totalKm" -- src/*.js` minus tests and the model/geometry files). **136 hits** (an earlier "76" here was an eyeballed miscount of the same output; the per-file classifications below were unaffected), of which **29 are display sites** (a km that reaches a template literal, `textContent`, an aria attribute or the live region), **8 are structural sites that need a fix of a different kind** (a predicate, a span order, a step's orientation, a fallback origin), and the rest are geometry, identity keys or model plumbing that stay absolute.
  - `strip-markup.js` — DISPLAY: `:107` block-label length; `:147-148` aria min/max widening; `:151` aria-label km; `:156` aria-valuenow/min/max; `:169-177` summary planned / total / remaining / ⌀; `:216` block title length + `km X → Y`; `:264-265` scale-line total (the literal `km 0` at `:261` is already the rider's own start). STRUCTURAL-FIX: `:46-50` `breaksIn` (which breaks a block names — km-0 widening copy 1 of 3); `:205` the stopgap `createTrip`. DELIBERATELY ABSOLUTE: `:67` glyph-layer extent filter and `:70`/`:149` `kmToX` positions — axis geometry, absolute until Task 8 rescales the axis.
  - `strip.js` — DISPLAY: `:396` the keyboard handler's live-region announcement (**missed on the first pass and caught by spec review**: it was filed under "emitted to callbacks" below, but `settled` is SPOKEN to the user, and it said "km 230.3" while the aria-valuenow on the very same handle read 81. A wrong LABEL in an enumeration is how a display site survives a sweep that reads the enumeration). STRUCTURAL-FIX: `:391` the arrow-key step, also mislabelled as "emitted" — it added the step to the ABSOLUTE km, which downstream steps towards the road's origin, so ArrowRight counted the slider DOWN. STRUCTURAL: `:48`/`:160` state (gains `trip`); `:127` `stopgapTrip` (now the fallback for a caller that names only a road length). DELIBERATELY ABSOLUTE: `:94-106` elevation memo/window, `:114` `axisOpts`, `:200` `xToKm`, `:204` `stripLayout`, `:260`/`:265`/`:296` the km emitted to callbacks (absolute is the contract).
  - `day-panel.js` — DISPLAY: `:144`/`:151` draft prompt km + "into the day"; `:255`/`:274` leg and final-leg distances; `:299` overnight hint km; `:307-309` snap-note km (its `Math.abs` comparison stays absolute — a tolerance, not a number on screen); `:346` day length (also the Distance input's value and the split threshold); `:360` `km X → Y` header. STRUCTURAL-FIX: `:100-101` `draftForDay` (km-0 widening copy 2 of 3).
  - `places.js` — DISPLAY: `:33-34` town "X km from" + secondary km; `:40-41` POI ditto; `:152` favorite-row km; `:195` scope range. STRUCTURAL-FIX: `:62-68` `dayTagFor` (km-0 widening copy 3 of 3); `:160-161` the no-day `startKm`/`endKm` = 0 fallback (the road's origin is BEHIND an offset rider). DELIBERATELY ABSOLUTE: `:183` `scopeKey` (an identity string for collapsing expanded sections, never rendered).
  - `map.js` — **zero display km, contrary to the plan's expectation of "day-pin tooltips".** `:504` reads `Day N — drag to move this overnight` and `:409` `Start — <origin>`; every tooltip is a place name. `:569` is a `name@km` identity key. No change, no test.
  - `main.js` — STRUCTURAL-FIX: `:386-387` the `day ? day.startKm : 0` fallback; `:388-389` `poisInRange` handed a trip-ordered (descending) span. The rest is model plumbing or geometry: `:374` `ascentBetween` (Task 9), `:397` `townsNear`, `:416`/`:463` `pointAtKm`, `:439-440` `stretchCoords` min/max, `:467` the framed-stretch identity key, `:622-664` boundary/add-day (already rider-aware from Task 5).
  - `pois.js` — STRUCTURAL-FIX: `:6-8` `poisInRange`'s binary search over a descending span.
  - Not display code, checked and left: `favorites.js`, `route.js`, `sorted-range.js`, `towns.js`, `ui-util.js` — identity keys, pure geometry and model helpers. One observation for a later task: `favorites.js:86` sorts the favorites list by ABSOLUTE km, so a downstream trip lists it back-to-front (an ordering, not a number; `itinerary` already sorts breaks by trip order).
  - **Conversion is at the templates, never in the data.** Each display module takes `trip` in its render arguments and calls `trip.tripKm` where a km reaches markup; the arguments themselves stay ABSOLUTE (a day, a break, a stretch), so no converted km is ever passed between modules and nothing can convert twice. Day lengths and "X km from" distances derive through the trip as well — a local `rideKm(trip, from, to) = tripKm(to) − tripKm(from)`, three copies of a one-liner, because `endKm − startKm` is the same number forwards and its NEGATION downstream. **Follow-up for Task 16:** `trip.rideKm(from, to)` on the frozen trip object would retire all four compositions (itinerary.js has the fourth, internal).
  - **All three km-0-widening copies are gone, not fixed** — the day-ownership rule now has one owner in both directions. `day-panel`'s `draftForDay` receives `draftOnDay` (main.js asks `itinerary.dayOwnsKm`); `places`'s `dayTagFor` receives `dayNumberForKm(km) → number|null` (main.js loops `dayOwnsKm` over the days it already holds) and `places.render`'s `days` argument is deleted with it. Both answers are shaped so a caller that FORGETS them fails loudly (a missing function throws; a missing boolean hides the prompt) rather than silently tagging every favorite "beyond plan".
  - **`strip-markup`'s `breaksIn` is the deliberate exception**: converted in place to rider km with the exception keyed on INDEX 0, not km 0, and normalised end-for-end exactly as `spanOwnsRiderKm` is. Rationale, since it cuts against the paragraph above: this module is pure markup with no itinerary to ask, and a block's break names label the glyph cluster inside its own BOX — a span, not a day index — so `breaksInRange` (still callerless) is its shape, not `breaksForDay`. Feeding it a per-day array parallel to `days` would add an index-alignment invariant for Task 8 to maintain, and a forgotten one would silently un-name every break.
  - **The aria sort is deleted, per the ownership rule.** `handleMarkup` announces rider km, in which `boundaryBounds`' trip-ordered pair ascends by construction (boundaries.js floors `max` at `min` in rider km, so an inverted window cannot reach the DOM). Pinned by a downstream-axis test asserting the handles' aria triples by VALUE (`80 / 5 / 175` and `180 / 85 / 648.3`) — Task 8's obligation to pin it is therefore discharged, and it must not be re-added. The first version of that test asserted only `valuemin <= valuenow <= valuemax` and quality review showed it could not fail: the widening that keeps valuenow inside its range collapses an unconverted pair around the value, so bounds left in absolute km still come out ordered (a rider at km 80 reported with a range of 80–622.6). **An ordering assertion is not a conversion assertion.**
  - **Two bugs fixed beyond the translation**, both invisible on a whole-road trip: `poisInRange` normalises its span (a trip-ordered span descends downstream, the binary search answered `[]`, and Food/Sights were empty for every day of such a trip — regression test in pois.test.js); the summary line counts against `trip.lengthKm` rather than the road's `totalKm` (a 648 km trip on a 1026 km road could never read as finished, and the last day's absolute endKm overstated "planned" by the trip's own start).
  - **`map.js` unchanged: it displays no km at all.** The plan expected day-pin tooltips to carry km; they read `Day N — drag to move this overnight`. Verified by grep and by reading every `title`/`bindTooltip` — the only `routeDistanceKm` in the file is a POI identity key. No test written for an absence.
  - **Deliberately absolute, each with a comment saying why** (the Step-4 sweep's answer): the strip's axis (`axisOpts`, `kmToX` block/handle/glyph positions, the elevation window and its memo key, `xToKm` from the pointer) — all whole-road GEOMETRY until Tasks 7/8 rescale it, and none of it is read as a number; the km the strip emits to `onMoveBoundary`/`onAddDay` (absolute is the callback contract — but NOT the keyboard handler's announcement or its step, both of which review reclassified; see the `strip.js` line above); `places`' `scopeKey` and the custom-stop prompt's `dataset.km` (identities, never rendered); `snapNote`'s `Math.abs` gap (a tolerance, the same size either way round); `main.js`'s `pointAtKm`/`stretchCoords`/framed-stretch key.
  - **Browser-verified on real chromium** (playwright, `vite preview` over the production build), zero console errors or warnings in all three runs: (1) the default whole-road plan renders line-for-line what it rendered before this change — the identity checkpoint; (2) a seeded v4 plan with an OFFSET-FORWARD window (149.3 → 797.6) and (3) the same window DOWNSTREAM (797.6 → 149.3) both read `160 / 648.3 km planned · 488.3 km to Prague`, `km 648.3` on the scale line, `Day 1 · 80 km · km 0 → 80 · 📌 Seeded stop`, aria `now=80 min=5 max=155`, a `80` Distance field, legs `20 km → 📌 Seeded stop` / `60 km → 🛏 day end`, and non-empty Food (82) / Sights (26) / Overnight (8). Identical numbers in both directions is the feature. The seeding script is in the session scratchpad (`smoke-oriented.mjs`) and is worth re-running at Task 8; nothing in the app can build a narrow window until Task 11.
  - **Three flags for later tasks, all outside this task's file scope:**
    - `boundaries.js:37-43` still says "A caller that needs them numerically ordered sorts them itself — `strip-markup.js` does". It no longer does; it converts instead. **Prose fix owed** (Task 8 or 16) — the ordering CONTRACT is unchanged, only the named consumer's behaviour.
    - `.meta__abs` (places.js + style.css:725) now holds a rider km, so the class name reads as a lie. Purely presentational (margin/colour/opacity); renaming needs style.css, which Task 6 did not own.
    - **List ORDER, not km:** `favorites.js:86` sorts by absolute km and `poisInRange` returns stored (ascending) order, so on a downstream trip the Favorites, Food and Sights lists run back-to-front against the ride. For Food/Sights that also picks the wrong 40 under `ROW_CAP` — "the first 40 along the stretch" becomes the LAST 40 the rider meets — and any fix must keep `map.js`'s `POI_MAP_CAP` selecting the same set. `itinerary` already sorts breaks by trip order (`byTripOrder`); nothing else does.
  - **Fix round after spec review** (`52a117b`, strip 82 → 86, suite 750): both findings were in the keyboard handler's ten lines, and both were real.
    - The live-region announcement now speaks `trip.tripKm(settled)`. It is the one display site the first pass missed, and it slipped through *because the enumeration mislabelled it* — filed as "km emitted to a callback", so the Step-4 sweep read the label and moved on. The lesson for the remaining tasks is narrow and worth stating: **the sweep can only be as right as the classification, so a line's label is itself the thing to double-check** — an aria attribute and a live region are both display, and neither looks like display in a grep.
    - The arrow-key step now steps in rider km (`trip.absoluteKm(trip.tripKm(day.endKm) + direction * step)`), so ArrowRight always means "further from the rider's start". This was nominally Task 8's (a control's orientation follows the axis), fixed here because it sits in the same ten lines as the announcement and a known-inverted control left on the branch is one nobody re-finds. The km handed to `onMoveBoundary` stays ABSOLUTE and downstream it now decreases — which is the invariant working, not a bug.
    - Three tests drive it, on a strip wired to a **real itinerary** (a keyboard nudge is only observable once something applies the move and re-renders; the announcement is read back from the state that render left): the announcement and `aria-valuenow` agree at rider 81 on an offset-forward trip; ArrowRight on a DOWNSTREAM trip raises the reported km 80 → 81 while the emitted absolute km falls 717.6 → 716.6; Shift+ArrowLeft downstream lands on 75.
    - A fourth test pins **`breaksIn` against `dayOwnsKm` on one shared fixture** — a break exactly on the boundary two downstream days share is named by the block that ENDS on it, and the model says the same of the same km. That agreement is the whole justification for strip-markup keeping its own span-keyed copy of the rule, and until now nothing checked it. It passed on the first run: a guard, not a fix.
  - **For Task 8, recorded here because Task 6 cannot test it:** `blockLabelMarkup`'s rider-km conversion is currently **unobservable on a downstream trip** — `stripLayout` gives a descending day a negative width, which clamps to 0 px and yields `labelTier('none')`, so no label renders at all and only the block's `title` can be asserted. Once Task 7/8 maps the axis to the window and downstream blocks have real width, **add the label assertion** (`80 km`, not `-80 km`) alongside the existing title assertion in `createStrip - oriented trips`.
  - **Quality-review round** (`e65ab6d`, strip 86, day-panel 68, places 63, suite **752**): three of the tests this entry credited did not pin what they claimed, each confirmed by a mutation that survived the whole file. Mutations were run against a throwaway copy of `src/` under `.cache/mut` (vitest's default exclude ignores `.cache`, and `--root .cache/mut` still discovers it), so no broken source ever sat in the shared worktree — the discipline the Task 4 entry set.
    - **aria bounds** — see the corrected sort bullet above: ordering held under absolute bounds, values do not.
    - **`breaksIn`'s behind-the-rider edge:** widening the start line to `at >= lo - 100` passed all 86. Day 1 owns its start LINE, not the road behind it, and only the model's half of that was pinned (`dayOwnsKm(0, 301) === false`). The start-line test now also places a break 3.2 km BEHIND the rider's start and asserts no block names it — reachable, not theoretical: the Favorites list is not windowed to the trip, so a favorite starred behind the start can be ☕'d onto the plan.
    - **`places`' no-day fallback:** the test rendered no places, so `startKm = trip.startKm` mutated back to `0` passed. It now renders one town and asserts it measures 20 km from the rider's start rather than 169.3 from the road's origin.
    - **`mountLive` now drives a real `createItinerary`** instead of re-implementing `moveBoundary`'s clamp-and-refuse in the harness (the copy could drift from the model the app actually uses; folding it proved they agreed — all 86 numbers unchanged). It also owns a whole-road trip now. **Honest revision of the cost this was meant to reduce:** it does NOT turn Task 8's fallback deletion into a harness change. 48 `strip.render(...)` sites in this file, only 4 of which pass a trip, so **44 still reach the whole-road fallback** — the bulk of the file renders directly rather than through `mountLive`, and markup tests are exactly the ones that do. Task 8 either hand-edits those 44 or lifts a whole-road render helper first; the fold's real win is the retired clamp.
    - **The loud-failure posture is now true rather than documented:** `day-panel` and `places` throw on a missing trip in the model's own voice (`… needs a trip (see createTrip in src/trip.js)`). Both headers already claimed there was no fallback, and neither delivered — day-panel's empty-plan branch returned before touching the trip, and `places` handed its own `startKm`/`endKm` rendered a row-less panel in silence, saving the TypeError for the first starred place. One test each.
    - `elevationPointsFor` gained its own in-place marker; it was the only absolute site with none, and it is the one Task 8 is guaranteed to edit (window + memo key).
  - **Task 6 SPLIT the "arrived" semantics, and Task 7 owns closing it.** The summary and scale-line TEXT now count the trip, while `stripLayout`'s `arrived`/`remainder` still count the road — they were one number before this task and are two now. Measured on a completed offset-forward trip (149.3 → 797.6, one 648.3 km day): the summary reads `0 km to Prague` while the axis still draws a 289.9 px remainder carrying "+ add a day", and the scale line never says "reached". The plan already assigns `stripLayout`'s `remainder`/`arrived` to Task 7 (its remainder runs to the window's end, `arrived` compares `Math.abs`), which closes this by construction — recorded because until then the strip contradicts itself on any window narrower than the road, and because `strip-markup`'s `tailBox` comment ("Both the axis … and the scale line (has the trip arrived?) turn on the same rounded width") now describes a path with two different meanings of arrival on its two ends.

- **Tasks 7 and 8 done** (`fd0b8e3` then `179be69`; strip-geometry 16 → **34**, elevation 25 → **28**, strip 86 → **115**; suite **802 in 20 files**, zero failures; `npx vite build` clean; browser-verified on real chromium in four configurations — see the browser sub-bullet). Phase 3's first two thirds closed: **a windowed trip now looks like one.**
  - **Interleaved as two commits, in order, as asked.** Task 7's commit necessarily touched `strip.js` beyond the geometry — `axisOpts`, `kmAtClientX` and `layoutForPointer` had to start passing `{startKm, endKm, width}` or the suite would have been red at that commit. That is the whole of the overlap; the profile's own window, the fallback deletion, the stubs and the naming all landed in Task 8. In between, the strip drew a window axis with a whole-road elevation profile — knowingly wrong, invisible to a user (nothing in the app can build a narrow window until Task 11), and stated here rather than left to be found.
  - **THE ARRIVED SPLIT IS HEALED**, and the browser says so: on the completed offset-forward window (149.3 → 797.6 in one 648.3 km day) the strip now reads `648.3 / 648.3 km planned · 0 km to finish`, has **no remainder element and no "+ add a day" button at all**, and the scale line says `⚑ km 648.3 · finish reached`. Before this task the same plan drew 289.9 px of dashed remainder with an add button in it beside "0 km to Prague", and never said "reached". `stripLayout`'s remainder now runs to the WINDOW's end and `arrived` compares `Math.abs`.
    - **The `Math.abs` was pinned only by accident and now is not.** A mutation to the signed form (`endKm - plannedKm`) passed 749 of 750 tests, and the one failure was incidental (a test reading `.strip__flag`, which is null when there is no remainder). Signed, `149.3 − 717.6` is hugely negative and therefore "within tolerance", so **an 80 km plan on a 648 km downstream window collapsed its remainder and read as finished on day 1** — taking away the only way to add a second day. Two direct tests now bite: `does not mistake an unfinished downstream window for a finished one` (geometry) and `still offers a downstream trip its remainder and its add button` (strip).
  - **The last stopgap is gone.** `tripFor()` deleted; `render()` throws `strip render needs a trip (see createTrip in src/trip.js)`. `git grep -n createTrip -- src/strip*.js` now returns only `strip.test.js` and a doc reference, per Task 3's checklist. `state.totalKm` went with it — the road's length reaches the strip only on the trip, so the axis, the stubs and the window cannot describe two different roads. `main.js`'s `renderStrip` therefore stops passing `totalKm`.
    - **The fallback-deletion cost, actually paid: 0 of the 44 sites were hand-edited.** `mount()` in strip.test.js became a thin wrapper whose `render` consumes the `totalKm` the fixture already names and builds `createTrip({startKm: 0, destinationKm: totalKm, totalKm})` from it; an explicit `trip` in the render args wins. `totalKm` never reaches strip.js. Two tests that call `createStrip` directly pass a trip by hand, deliberately, so the requirement is exercised without the harness. The ledger's "either hand-edit those 44 or lift a helper" is settled in favour of the helper, and the throw itself is pinned by `createStrip - a trip is required`.
  - **Edge stub decisions** (spec §3), all of which turn on ONE answer: `roadPast(state, which)` returns how much road is left past a trip end and the name of the road end it runs to, and `roadContinues()` (rounded, so a cap never reads "0 km") decides both whether a cap is drawn AND whether that end is already named by the road. The two therefore cannot disagree about whether a trip end is a road end, which is the class of contradiction this phase existed to close.
    - **Which road end lies past a trip end follows the DIRECTION, not the trip end's own role.** A downstream trip starts at the road's destination, so the road behind its start runs to *Prague* (228.9 km) and the road past its finish runs to *Cuxhaven* (149.3 km) — the exact mirror of the forward window. Getting this backwards labels the caps with each other's names and reads as perfectly plausible; a mutation to `which === 'start'` alone is caught by three tests.
    - **A trip with no `totalKm` reports 0 km past both ends** — no caps, and both ends keep the road's names. That is deliberate and it is what the strip drew before windows existed: as far as it knows, the trip IS the road. `createTrip` keeps `totalKm` null when nobody supplies one, and inventing an end for road it cannot measure would be worse than saying nothing. One test pins it.
    - **A span, not a button, and `aria-hidden`.** Extending the trip is `Set start`/`Set finish`'s job (Task 11); a draggable cap would be a second silent way to do it. It does take pointer events (unlike the glyph layer) because the title is the only place the remaining road is named — and at `-12px` it covers no part of the drag surface. **New guard:** `startDrag` now returns early on `.strip__stub`, because a cap sits 2 px outside the axis, which is well inside `HANDLE_TOLERANCE_PX` of a boundary standing on that edge — and **a finished plan always leaves its last boundary standing on the right edge**, so this was reachable rather than theoretical. Pinned by a fixture whose 4 km first day puts boundary 0 at x 8.
    - **`aria-hidden` is a judgement, not a win:** the remaining road is genuinely useful and is now available only to a pointer. An empty span's title is announced by nothing anyway, so this labels the situation honestly rather than creating it — but **Tasks 11/12 own putting it into text**, since that is where the trip's ends become real controls.
  - **Naming the trip's own ends.** An end sitting on a road end keeps that road end's name, which on a **whole-road downstream trip swaps them** (`km 0 · Prague` … `km 1026.5 · Cuxhaven`); any other end reads the existing `ORIGIN_FALLBACK`/`DESTINATION_FALLBACK` ('start'/'finish'). **Tasks 11/12 replace those two fallbacks with the town the rider picked** — documented at `endName` in strip-markup.js, not only here.
    - **Deviation, deliberate:** the plan assigned naming to the scale line only, but `summaryMarkup`'s "X km to <destination>" and the remainder's `⚑ <destination>` flag name the same end, and the ledger's own symptom quote for the arrived split — "0 km to **Prague**" — was the summary telling exactly the lie the scale line was about to stop telling. All three go through `endName`. Using one rule in one place and the road's name in the other is the "one plan contradicting itself" this codebase argues against.
  - **Break glyphs are filtered to the window** (`trip.contains`, inclusive of both ends) rather than to the road. `kmToX` clamps, so a stop on road the rider is not riding piled up on the nearer end of the axis and read as a stop standing on their own start line. This was not in the task brief; it is a direct consequence of the rescale and would have shipped as a visible phantom.
  - **`profilePoints` refuses only a ZERO-length window now** (`startKm === endKm`, was `endKm <= startKm`). A descending window comes back point-mirrored — same x, the y from the far column — proven against the upstream profile over the same span, plus a sub-stretch case. Zero-length stays refused because every column would sample the same km and the flat line would read as terrain.
  - **Downstream rendering obligations from earlier entries, discharged:** the `80 km` blockLabelMarkup assertion is in (`puts the positive distance on a downstream block's own label, not just its title`) — observable at last, because the window axis gives a descending day real width instead of the negative width that clamped to 0 px and yielded `labelTier('none')`. `handleMarkup`'s aria sort was NOT re-added. `proposeKm`'s re-clamp discipline is untouched. `boundaries.js:37-43`'s prose now says callers convert to rider km rather than sorting.
  - **Prose fixed while in range** (the stale-after-change class): `strip-geometry.js`'s header and `labelTier`'s doc; `tailBox`'s mixed-semantics comment; `glyphLayerMarkup`'s and `handleMarkup`'s "absolute until Task 8" notes; strip-markup's module header; `strip.test.js:61-63`'s corrected harness comment and the `oriented trips` describe's "the axis still maps the whole road"; style.css's strip header, which also still said "650 km always fits". One more found by reading: the `.strip__range` title said "Elevation range along the whole route" with no hint that the number no longer describes what is on screen — it now says the range **is** the vertical scale, fixed so days and trips stay comparable.
  - **Mutation-verified**, on a throwaway copy of `src/` under `.cache/mut` (removed afterwards; no broken source ever sat in the shared worktree). Eight mutations, all caught: the stub press-guard; `roadPast`'s direction; **the memo key's two new ends as a PAIR** (see the correction in the fix round below — individually they were NOT pinned, and this bullet originally implied they were); `endName`'s neutralisation; the glyph window filter; `arrived`'s `Math.abs` (see above — this one exposed a real gap); the empty plan's remainder starting at the rider's start rather than km 0; `kmToX` ignoring the window's start.
  - **Browser-verified on real chromium** (playwright, `vite preview` over the production build), **zero console errors or warnings in all four runs**, axis 1392 px wide:
    - **(a) whole road, 0 → 1026.5 — the identity checkpoint.** `stubs: []`. Blocks `0px +108.5px` / `108.5px +108.5px` (80 km of 1026.5 on 1392 px), scale `km 0 · Cuxhaven … km 1026.5 · Prague`, summary `160 / 1026.5 km planned · 866.5 km to Prague`, glyph at 27.1 px, profile 45.1 → 13.8, flag `⚑ Prague`. A 60 px drag moved the boundary 44.3 km and ArrowRight then read 125.3.
    - **(b) offset forward, 149.3 → 797.6.** Caps at **both** ends: `road continues 149.3 km to Cuxhaven` at `left − 12 px`, `road continues 228.9 km to Prague` at `+2 px past the right edge`, 10 px wide, both `aria-hidden`. Blocks `0px +171.8px` — the same 80 km day is 63 px wider than on the road-scaled axis, and it now starts at the axis's left edge instead of **202.5 px** in (149.3 of 1026.5 km on the 1392 px browser axis; an earlier "189 px" here was the 1300 px test-harness figure, the one number in (a)–(d) that did not reconcile at 1392). Scale `km 0 · start … km 648.3 · finish`, summary `488.3 km to finish`, flag `⚑ finish`, glyph at 42.9 px, profile 42.9 → 28.4 (a slice, not the road). The same 60 px drag now moves 28 km, not 44.3 — the rescale, in one number.
    - **(c) the same window downstream, 797.6 → 149.3.** Every number identical to (b) — which is the feature — with the caps **mirrored** (228.9 to Prague on the left, 149.3 to Cuxhaven on the right) and the profile **mirrored** (28.4 → 42.9). Blocks run left to right in ride order; drag → 108, ArrowRight → 109, live region `Day 1 end, km 109`.
    - **(d) the completed offset window** — the arrived heal, quoted above. Block `0px +1392px`, i.e. the plan fills the axis.
    - Looked at, not only queried: 4× crops of both axis edges (`smoke-stub-zoom.mjs` in the scratchpad) show the cap as a dimmed full-height rounded bar separated from the axis by a 2 px gap, plainly outside day 1's block on the left and outside the dashed remainder on the right.
  - **One flag for Task 12, now visibly the same lie the scale line just stopped telling:** on the completed offset window the day panel header reads `from Cuxhaven · km 0 → 648.3`. `main.js`'s `fromNameFor(0)` returns `ORIGIN_NAME` for day 1 regardless of where the trip starts. Already assigned to Task 12 by the Task 5 entry; recorded again because it is now the only place on screen still naming the road's origin as the rider's own start, and it sits beside a strip that no longer does.
  - **Residual for Task 9, unchanged by this task:** `TIER_FULL_PX` is still 88 and still measured against a whole-road axis. A narrower window is only ever kinder to labels (noted at `labelTier`), so nothing degrades — but Task 9's re-measurement to 112 should be done at a window's px/km, not the road's.
  - **Residual for Task 15:** the strip's `ResizeObserver` still watches width only, and the profile now depends on the window as well as the box — a height-only change still needs the argument-less `render()` path that Task 15 owns.
  - **Fix round after both reviews** (`e05b949`; strip-geometry 34 → **37**, strip 115 → **121**; suite **811 in 20 files**). Spec review passed clean; quality review passed "with fixes". Neither found a defect in shipped behaviour — but one **reachable-today** inconsistency and five test holes, two of them assertions that could not fail.
    - **The arrival heal stopped one epsilon short, and a drag reaches it.** `summaryMarkup` computed `remaining` exactly while `stripLayout`'s `arrived` was tolerant to `ARRIVED_EPSILON_KM`, so in the 0.1–0.5 km band the strip contradicted itself again — inverted this time. Measured on window 149.3 → 797.9 with one 648.3 km day: `0.3 km to finish` beside `⚑ finish reached`, no remainder, no add button. `remaining` now collapses on the same constant. **No picking UI needed to get there:** the last boundary may run to the trip's destination and lands on the 0.1 km grid, so any off-grid window end opens the band. The planned/total pair stays exact (`648.3 / 648.6 km planned`) — that is a measurement, not a countdown, and only the countdown should round to arrival.
    - **Two assertions that could not fail, which is the class this task set out to learn from.** (i) The memo-key test moved BOTH window ends, so it proved only "at least one end is in the key" — dropping `startKm` alone left 802 green, and so did dropping `endKm` alone. That is not academic: `Set start` and `Set finish` (Task 11) each move exactly one end, so each half is a real control's path. Two tests now move one end each. (ii) The stub-escaping test used `<img src=x onerror=alert(1)>`, which inside `title="…"` is never parsed into an element — `querySelector('img')` was null with or without `esc()`. The payload is now `" onmouseover="alert(1)`, which without escaping would END the title attribute and open a live event handler; the test asserts `getAttribute('onmouseover')` is null. **The lesson generalises past this task: a payload that cannot escape its context tests nothing, and a test that moves two variables pins neither.**
    - **`roadContinues`'s rounding gate is now pinned** — it is the predicate this entry headlines (one answer for both the cap and the end's name), and `round1(x) > 0` → `x > 0` had left 802 green. Both sides of the edge are tests now: `startKm: 0.04` draws no cap and keeps `Cuxhaven`; `startKm: 0.05` caps with `road continues 0.1 km to Cuxhaven` and drops to `start`. Honest note: only the **0.04** case catches the mutation. The 0.05 case passes either way and is there to pin the other side of the boundary, not the gate.
    - **`roadPast`'s `totalKm` guard was broader than its arithmetic, and the symmetry was a lie.** Road running back to the road's ORIGIN is just the trip's own `startKm` — the road starts at 0, so that side needs no road length at all. Guarding both branches meant a `totalKm`-less trip starting at km 149.3 suppressed a cap it could measure perfectly well AND then let `endName` call that start "Cuxhaven", which is the exact claim `endName` exists to refuse. The guard now covers only the `totalKm - km` branch; such a trip caps the side it can measure and stays silent about the side it cannot. **Not browser-observable** — `main.js` always passes `totalKm` to `createTrip` — but it is the shape every direct `createStrip` caller can build.
    - **Two pre-existing holes closed while in the files**, both previously green under mutation: `stripLayout`'s bolded negative-width contract (an inverted day now asserts negative width, `x + width === kmToX(endKm)`, and that `hitTestHandle` finds the handle on the day's own END — clamping at source would silently move it to the day's start), and `xToKm`'s pointer clamp, which `kmAtClientX`'s comment leans on and nothing tested. The clamp is pinned in both directions, including that past the left edge is the rider's START — downstream the numerically LARGER km, where a numeric clamp answers with the wrong end.
    - **Vocabulary:** `roadPast`/`endName` take `tripEnd`, not `which`, and the stub's CSS modifier is `--destination` rather than `--end`, so one word means one thing from the model through the markup to the stylesheet. A reader no longer has to hold `--end` and `'destination'` as the same trip end.
    - **Prose corrections, each a specific wrong claim rather than a tidy-up:** the ledger's mutation bullet implied the memo key's two ends were verified individually (they were verified as a pair — corrected in place above, since that was the one claim in this entry a reviewer could falsify); browser bullet (b) quoted the 1300 px harness figure "189 px" among numbers otherwise reconciled at 1392 (now 202.5); `strip-geometry.js`'s tier comment still sized days against "a 650 km route" three corridors ago; the no-absolute-km test called the stub's 149.3 a coincidence when `roadPast` returns `km` itself, so a forward trip's start cap ALWAYS reads its own startKm — and that test's guard, narrowed to blocks and handles, had dropped the remainder, the flag and the glyph titles from coverage, so it now excludes only `.strip__stub`; a "zero width" case in strip-geometry.test.js was exercising a zero-LENGTH window instead, and now tests zero width for both functions.
    - **Eight mutations, run one at a time** (not batched — batching is what made the earlier `Math.abs` gap hard to attribute), each caught by exactly its intended test and nothing else: exact `remaining`; unrounded `roadContinues`; memo key minus `endKm`; memo key minus `startKm`; `esc` removed from the stub title; `roadPast`'s guard restored to both branches; `stripLayout` clamping width at source; `xToKm`'s clamp removed.
    - **Browser re-run** (`band` config added to the scratchpad script, `vite preview` over a fresh build, **zero console errors**): the band now reads `648.3 / 648.6 km planned · 0 km to finish` beside `⚑ km 648.6 · finish reached`, with no remainder and no add button — one story where there were two. The `up` config re-run line-for-line matches the earlier entry, confirming the `--destination` rename still positions the right-hand cap at +2 px past the axis (`leftOfAxis 1394` on a 1392 px axis) rather than collapsing it to `left: auto`.

- **Task 6b done** — the lists run with the ride (pois 15 → **16**, places 63 → **67**, map 25 → **26**, favorites 16 unchanged; suite **829 in 20 files**, zero failures, **+6 mine** — see the count reconciliation at the end of this entry, because two entries here say "817" and mean different snapshots; `npx vite build` clean; browser-verified on real chromium in three configurations). This closes the "List ORDER, not km" flag Task 6 left: Favorites, Food and Sights ran back-to-front on a downstream trip, and under the row/marker caps that meant the wrong SUBSET — the last 40 places the rider would meet instead of the first 40.
  - **The rule, in one sentence:** every km-ordered "on the way" list runs in RIDER KM ASCENDING — 0 at the rider's start, increasing along the trip in both directions — so the first row is the first place they will reach.
  - **It is expressed in two places on purpose, and only one of them needs a trip.** `poisInRange` returns its slice **in the order the span was asked in**; the span itself carries the direction (`endKm < startKm` IS the caller saying they ride downstream), so a function taking two km needs nothing else to know which way they run, and main.js already asks in trip order. Favorites are ordered in `places.js` (`inRideOrder`, through `trip.tripKm`) because that list has no span at all: the starred list is global, spans the whole road, and the store holding it is shared across plans and told about none of them. places.js is the only module holding both the list and the trip. (main.js was outside this task's file scope, but the constraint and the design agree here — main.js hands the same array to `map.setFavoriteMarkers`, which wants no order at all, so ordering there would serve one consumer from a place that serves two.)
  - **The cap needed no change, and that is the finding rather than a shortcut.** Both caps already take a PREFIX (`slice(0, N)`), and over a ride-ordered list a prefix IS "the ones met first". The caps were never wrong about which end of the ARRAY they kept — only about which end of the DAY the array's front happened to be. Ordering at the source fixed the subset and the order together.
  - **Set identity is by shared derivation, not by two matching sorts.** main.js hands `places.render` and `map.setPoiMarkers` the ONE array `poisInRange` returned, and each takes its first 40; they cannot select differently. Browser-confirmed: 74 pins = 40 food rows + 34 sight rows on the offset-forward window, 66 = 40 + 26 downstream, 80 = 40 + 40 whole-road, and hovering pins 0/1/39/40 lit rows food#0/#1/#39 and sight#0 in all three. Favorites are deliberately NOT capped on the map (`setFavoriteMarkers`, user-curated and small), so ordering them in places.js cannot desync anything; with >40 favorites the panel shows 40 while the map pins all — pre-existing, and the direction that matters (every visible row has a pin) holds.
  - **Two assertions that could not fail, both found by mutation, both now real** — the class this feature keeps re-learning.
    - `places.js`'s cap was pinned by ROW COUNT only: `items.slice(-ROW_CAP)`, the cap keeping the LAST 40, **passed all 63 places tests at `913de61`**, with the footer still reading "showing the first 40 of 451" above the last 40 rows. The test now names `Place 0` and `Place 39`.
    - `map.js`'s cap was pinned only against an ASCENDING fixture, so re-sorting by absolute km **passed all 25 map tests** — and that mutation is exactly the set-identity break this task exists to prevent (panel lists the first-met 40, map pins the last-met 40, not one visible row has a pin). A second test hands it the reversed list, where "as given" and "sorted by km" differ.
  - **A silent hole that reordering itself creates, closed:** rows are rendered from one array while clicks resolve through `data-place-index` into `lists`. Every other favorite test in the file renders a SINGLE row, where any alignment passes. Feeding `lists` the unordered array — starring or coffee-ing one place while acting on another — is caught by the new click test and by nothing else in the suite.
  - **Deliberate: favorites sort on the SIGNED rider km**, so one starred behind the rider's start sorts before their trip (a negative km) and one past the destination sorts after it — one monotone axis, the order they would meet these places riding the whole road their way. Under the cap that means a rider with >40 favorites keeps the behind-the-start ones. The alternative (push off-trip favorites to the end) was rejected: it makes the order non-monotone in the very number the row prints, and the row already says "beyond plan".
  - **`favorites.js` keeps its absolute-km sort and its comment stopped lying.** It said "sorted ascending by route distance **for display**"; display order is places.js's answer now. The sort stays as a stable, trip-independent baseline, so the displayed order is a function of the trip and nothing else. No code change, no test change.
  - **Checked and deliberately left alone: Overnight options — symmetric UP TO TIES.** `towns.js`'s `townsNear` ranks by `|town.km − day.endKm| + 1.5 × offsetKm` and keeps the best 8. The measure is symmetric, so the ranking AND the SET its cap keeps mean the same thing in both directions — best-first is the point of that list, and ride order would be a downgrade. Written into places.js's header, so the module's "every list runs in ride order" promise names its own exception. (`townsInRange` is ascending and would need the `poisInRange` treatment, but still has no app caller; towns.js was outside this task's file scope.)
    - **Exact only up to TIES, and an earlier wording here overclaimed it.** `Math.abs` makes the score symmetric, but equal scores are left to `sort`'s stability over a slice held in ascending ABSOLUTE km — which is direction-blind. So two equally-ranked towns on opposite sides of the day's end keep their absolute-km order whichever way the rider is going, and their two rows therefore swap places relative to the ride. The SET kept is still identical in both directions (the tie-break is direction-independent, so it cannot change which 8 survive) and the ranking is genuinely equal, so this is cosmetic and is deliberately not being changed — but "already means the same thing in both directions" should not be read as exact.
  - **One `[0]`-means-the-start still standing, and it is not this task's:** `map.js:408` builds the start pin from `routeFeature.geometry.coordinates[0]` — the ROAD's origin, which on a downstream trip is the rider's DESTINATION. (Cited as `:405` when this entry was written, which was the line before this task's own comment edit moved it three lines down — a line number in a ledger is only true against a stated commit, and this one is `4570315`.) Already assigned to Task 10 by the Task 5 entry; re-flagged because this task swept these files for exactly that pattern and this is the one instance of it.
  - **Three existing expectations changed, all in `pois.test.js`, all order-only.** Recorded because a changed expectation is a red flag worth stopping on: Task 6 wrote those tests to pin that a descending span is not EMPTY (its own entry says so) and over-specified by asserting the ascending order too. Membership is unchanged and still asserted; only the order claims flipped. **No test outside `pois.test.js` had a value edited.**
  - **Whole-road forward trips are untouched**, by construction (from km 0 forward, `tripKm` is the identity, so rider-km order IS absolute order) and by evidence: the 817-test baseline still passes, and the browser's whole-road run reads ascending exactly as before.
  - **Nine mutations, ONE AT A TIME**, each caught by its intended test: `poisInRange`'s reversal dropped (3 tests); reversal on EQUAL ends too (1 — the equal-km tie order, caught by an existing test); `inRideOrder` returning unsorted (4); its comparator inverted (6, two of them **pre-existing forward-trip tests**, which is the no-regression requirement holding independently); `lists` fed the unordered array (1, sole catcher); `section` fed the unordered array (4); `inRideOrder` sorting in place (1, sole catcher); `slice(-ROW_CAP)` (2, after first confirming it survived all 63 at HEAD); map re-sorting by absolute km (1, after first confirming it survived all 25).
  - **Harness correction that every later task needs: `.cache` is NOT excluded from vitest discovery in this project.** The brief and the Task 4/8 entries hold that vitest's default exclude covers `**/.cache/**`. It does not — vitest 4.1.10 against this `vite.config.js` discovers `.cache/mut-*/src/*.test.js` as project test files. Both consequences were observed: `vitest run src/places.test.js` matched the copy too and reported **130 tests for a 67-test file**, and a concurrent agent's `.cache/mut-t9` tree sat in my discovery set while mine sat in theirs — precisely the phantom-failure hazard putting a sweep on `.cache` was meant to avoid. The mutations above are still correctly attributed (each run was scoped with `--root`, so only the copy's own file ran) but every count in this entry was re-measured with `--exclude '**/.cache/**'`, and the copy is deleted. **A later sweep should keep its tree outside the worktree entirely** (the session scratchpad) or pass `--exclude`. The 20-file/817-test baseline this task started from was clean, and 20 files is the true project count: 19 in `src/`, 1 in `scripts/`.
  - **Browser-verified on real chromium** (playwright, `vite preview` over the production build on port **4174** — 4173 was a concurrent agent's), **zero console errors or warnings in all three runs**. Day 2 focused in each, scope `km 80 → 160` in each — the same rider km at opposite ends of the road, which is the whole point. Script `smoke-lists.mjs` in the session scratchpad; unlike `smoke-oriented.mjs` it seeds a FAVORITES blob as well, since the starred list's order is half of this task.
    - **(a) offset forward, 149.3 → 797.6.** Food (87, capped to 40): `Altes Zollhaus` km 85.1 · `SchlossCafé` km 85.1 · `hafenmieze Unterdeck` km 85.1, last kept `Restaurant Claus` km **114.8** — the front of the day, stopping 45 km short of its end, which is the cap keeping the right 40. Sights (34, uncapped): `Aussichtsturm` km 80.7 · `Wachturm BT 9` km 84.1 · `Elbschloss Bleckede` km 85.1. Favorites: `Fav km 100` **km -49.3** beyond plan · `Fav km 200` km 50.7 Day 1 · `Fav km 300` km 150.7 Day 2. **(This favorites line is SUPERSEDED by Task 6c** — a behind-the-start favorite no longer heads the list. Re-measured at `4570315`: `Fav km 200` km 50.7 Day 1 · `Fav km 300` km 150.7 Day 2 · `Fav km 500` km 350.7 beyond plan, with `Fav km 100` km -49.3 now last. Food, sights and the pin counts are unchanged — 6c touched only the favorites list.)
    - **(b) the same window downstream, 797.6 → 149.3.** Food (82, capped to 40): `AMED KEBAP` km 88.7 · `Eventbistro DAS WERK` km 88.7 · `Bäckerei Gäbler - Filiale` km 88.8, last kept `Ricard` km **104.9**. Sights (26): `Barockschloss Martinskirchen` km 80.3 · `Gutshaus Domäne Packisch` km 85.5 · `Brücke des Friedens` km 88.7. Favorites: `Fav km 900` **km -102.4** · `Fav km 700` km 97.6 Day 2 · `Fav km 500` km 297.6 — the exact mirror of (a)'s favorite order. **(Also SUPERSEDED by Task 6c.** Re-measured at `4570315`: `Fav km 700` km 97.6 Day 2 · `Fav km 500` km 297.6 · `Fav km 300` km 497.6, with `Fav km 900` km -102.4 last. Still the exact mirror of (a) — which is what matters here — and still the same 66 pins over the same 40 + 26 rows.) **Entirely different PLACES from (a)** — Torgau's cafés rather than Bleckede's — because day 2 downstream is the other end of the road, and every one of them measured forward from the rider's own last stop.
    - **(c) whole road, 0 → 1026.5 — the identity checkpoint.** Ascending throughout: favorites `km 100` … `km 900` in absolute order, food (**2092** on day 2 — the Hamburg metro) capped to km 85.7 … 98.5, 80 pins = 40 + 40.
    - **Task 6's Day-N tagging is right in all three and was checked against the days rather than assumed:** rider 50.7 → Day 1 and 150.7 → Day 2 on (a); rider 97.6 → Day 2 on (b); rider 100 → Day 2 on (c)'s 0–80/80–160 days; every km outside the two days reads `beyond plan`.
  - **Count reconciliation, because this entry and Task 9's both say "817" and mean different snapshots.** By COMMIT: `913de61` = 811, `d98cff0` (this task) = **817**, `23a15c2` (Task 9) = **829** — 811 + 6 + 12, and those are the only figures comparable between entries. **All three measured, not inferred** (the arithmetic reconciles either way round, so it could not settle which snapshot was which): `git archive <sha> | tar -x -C <dir>` then `npx vitest run --root <dir>`, deleted straight after. That reads a COMMIT's count without checking anything out, without touching the working tree and without a `git stash` — **which is how Task 16 should take its final figure**, since running the suite in place measures whatever the other agents happen to have on disk.
    - **Correction, and it matters before Task 16 acts on this: `<dir>` must be OUTSIDE the project.** This entry first wrote it as `.verify-<sha>` beside `src/`, which defeats the purpose — **any sibling copy inside the worktree lands in vitest's discovery set, whatever it is named.** The hazard was never `.cache` specifically, and `--exclude '**/.cache/**'` does not save you: a `.verify-*` tree here produced **40 files / 1646 tests** (829 at HEAD + 817 from the older tree) with that exclude already applied. Use the session scratchpad, reach `node_modules` by junction, and **unlink that junction before deleting the tree** (`[System.IO.Directory]::Delete(path, false)`; `cmd /c rmdir` tripped over path escaping here) — a recursive delete can otherwise follow it into the shared `node_modules` and destroy it under every concurrent agent. Verified intact here afterwards, by package count and by re-running the suite.
    - **The FILE COUNT is the cheapest detector, and it works AFTER the fact — which means recorded numbers can be audited rather than discarded.** vitest prints it on every run: `20 passed (20)` is this project's clean discovery set, and anything higher means a sibling tree got in. `git status --porcelain | grep '^??'` before a run is the prospective check; the file count is the retrospective one, and it is the only one available for a number already written down. It is how my own three measurements were confirmed rather than re-done — each reported 20 files, not 40, because `--root` scopes discovery — and how the Task 6b reviewer kept their first-pass figures. **Task 16 can use it to audit every count already in this ledger**: any entry citing a file count of 20 was measured against a clean set, whatever was on disk at the time.
    - **The hazard is ONE-DIRECTIONAL, which is the real reason to extract outside the project.** An in-worktree extraction is visible to every *other* agent's full-suite run, so it can manufacture failures and inflated counts that neither party owns and neither can easily attribute — the tree's author sees nothing wrong. A scratchpad extraction cannot do that to anyone. So "outside the project" is not self-protection, it is the courtesy that keeps a shared worktree usable; the `--exclude` flags only ever protect the person who remembers to type them.
    - **One more trap, found the hard way while sweeping Task 6c: build the tree from a COMMIT plus your OWN dirty files, never `cp -r src`.** A straight copy of `src/` picked up the Task 15 agent's in-flight `strip-resize` work mid-edit — 832 tests with one failure — and a mutation run against that tree reports failures that belong to nobody's mutation. `git archive HEAD | tar -x -C <dir>` then copying only the files you have changed gives a tree containing your work and no one else's; the baseline went to a clean 830 and every mutation afterwards was attributable to exactly one line. **A sweep is only as attributable as its baseline is clean**, and in a shared worktree the working tree is not. The other 817 is what this task MEASURED before touching anything, and it is 811 plus 6 of Task 9's then-UNCOMMITTED elevation tests, already sitting in the shared working tree (`git status` showed `M src/elevation.test.js` at the time). **The two coincide by accident.** Read against each other without this note, the two entries say Task 6b's baseline and Task 6b's result were both 817 — that it added nothing — while the same sentence credits it +6. The general lesson, which cost two agents a cross-check to establish: **in a shared worktree a suite count measured off the working tree is not a count of any commit**, so a per-task figure should name which it is.

- **Task 9 done** (`23a15c2`; elevation 28 → **33**, strip-geometry 37 → **38**, strip 121 → **126**, day-panel 68 → **69**; suite **829 in 20 files**, zero failures — +12 mine over the 817 baseline `d98cff0` (Task 6b) left in this shared worktree; `npx vite build` clean; browser-verified on real chromium in seven configurations). **Phase 3 closed: the strip now says how hard a day is, and which way round.**
  - **`ascentBetween` reports the direction it was ASKED in.** Which SAMPLES a stretch covers is direction-free, so the index range is still normalised with `Math.min`/`Math.max`; what gained a direction is the WALK (`step = endKm < startKm ? -1 : 1`, from the sample nearest the start towards the one nearest the end). **The totals are not computed once and swapped**, because hysteresis is not symmetric under reversal: which moves clear the threshold depends on where the walk came from, so `0 → 3 → 8` with a 5 m threshold is 8 m of ascent and — read backwards — 5 m of descent, not 8. One test pins exactly that (`re-walks the stretch rather than swapping the totals`), and it is the ONLY test the lazy swap-the-totals mutant fails, which is its whole reason to exist. `minM`/`maxM` describe the terrain rather than the ride and come back the same either way round, including in the sub-sample branch where `Math.min/Math.max` of the two endpoints is the point rather than an accident (a mutation to `{minM: a, maxM: b}` is caught).
  - **The day panel became direction-correct with NO call-site change, as this ledger predicted — verified first, then pinned.** `main.js:386` already passed `day.startKm, day.endKm`, which a downstream day gives in descending absolute km. The pin lives in day-panel.test.js and goes through the real panel with the real `ascentBetween` over ONE stretch of road ridden both ways (`↑ 1040 m` / `↓ 0 m` becomes `↑ 0 m` / `↓ 1040 m`), because the COMPOSITION is the claim and a hand-written climb fixture would pin none of it. There were no climb tests in day-panel.test.js at all before this.
  - **TIER_FULL_PX = 117, measured, and not the plan's 112.** Real Chromium at 1440, the real page with Archivo loaded from Google Fonts (`document.fonts.check('11px Archivo')` asserted true BEFORE measuring — a silent fallback font would have made every number below worthless), the real `.strip__block`/`.strip__block-label` CSS, and the label shrink-wrapped (`width: max-content`, `overflow: visible`) so the number is what the label NEEDS rather than what the block gave it. Method validated against the existing comment before trusting it: it reproduces `"12"` at 27.1 px and `"12 30.5 km"` at 68.8 px exactly, so this is the same basis (content + the label's 12 px padding + the block's 2 px border). Spec §5's own example (`1 80 km` / `🛏 Hitzacker · ↑ 340 m`) needs **110.9 px**; the worst realistic content (`12 30.5 km` / `🛏 Hitzacker · ↑ 1040 m`) needs **116.1 px** → 117. The 5.2 px between them is the fourth digit of a climb, which this corridor really reaches (km 920 → 1000 is 453 m over 80 km; a 568 km day reads 1616 m). **Measured at a WINDOW's px/km as asked**: text width does not depend on px/km at all, and a narrower window only gives a day MORE px, so the confirmation is that more days reach `full` — the same 80 km day is 108.5 px on the road-scaled axis and 171.8 px on the 648.3 km window.
  - **A new tier, not a new mechanism.** `labelTier` gains `'town'` between `'full'` and `'km'`, and `TIER_TOWN_PX` is the 88 that `TIER_FULL_PX` used to be — still the one judgement in the ladder rather than a measurement (the km tier's first line plus 18 px of room for the town before the ellipsis bites). `'full'` and `'town'` differ only in whether a climb reaches `secondLineMarkup`, which makes spec §5's order ("the climb drops off FIRST, then the town") one line of code instead of a rule to remember. The tier names say which part of the label is the LAST one still on, so `labelTier` still knows nothing about what a tier renders.
  - **The second label line is a flex row, and that is a decision rather than a detail.** `🛏 Hitzacker · ↑ 340 m` as one nowrap line ellipsises from the END, so a longer town name would eat the climb the tier had just promised — and the real overnight list has `Ústí nad Labem`, 138.4 px against the 116.1 px the threshold is measured with. So the town shrinks (`min-width: 0` + ellipsis) and the climb does not (`flex: none`); the town's full name is in the title either way. Measured, then LOOKED at: squeezed into 116 px the town takes 58.8 px and the climb keeps its whole 40.2 px, and a 4× crop of a real 120.2 px block reads `🛏 Ústí nad … · ↑ 275 m`.
  - **The climb is read where the profile already arrives, not passed alongside the days.** `climbFor(state.elevation, day)` in strip-markup, from the same profile `scaleMarkup` already reads for its range — so there is no new render argument, no second data path, and no array parallel to `days` for a future caller to misalign (the hazard this ledger recorded when `breaksIn` faced the same choice). `elevation.js`'s `ascentBetween` is imported on the same terms as `boundaries.js`'s boundary math: a pure function, no store. **No branch on `trip.direction` anywhere** — the day's own km carry it — and `main.js`/`strip.js` are untouched by this task.
  - **`↑ N m ↓ N m` in the title at EVERY tier**, including a 13.6 px block with no label at all. The descent joins it deliberately: a tooltip has the room, and the descent is the figure that SHOWS the direction, since the same stretch trades the two round the other way. The `≈` that qualifies these numbers stays in the day panel, which has room to explain what it means; a bare `≈` in a title string would be cryptic. Climb figures are metres, so none of it goes through `tripKm`; the km either side of it already do.
  - **One guard removed because a mutation proved it was hiding the other one.** `climbFor` began `if (!profile) return null` above its `Number.isFinite(climb.ascentM)` check, and dropping the finite check left all 781 of the mutation tree's tests green: `ascentBetween` already answers nulls for a profile it cannot use, so the early return made the finite check unreachable from any input the app can produce (`main.js` only ever passes `profileForRoute`'s output). With one guard the no-elevation test bites. Kept in the sweep as M5b — the old two-guard shape plus the same mutation — the only mutant that survives, by design, as the record of what the simplification bought.
  - **Twelve mutations, run ONE AT A TIME** on a throwaway `.cache/mut-t9` copy (deleted afterwards; no broken source in the shared worktree, which mattered more than usual here — another agent was committing to `src/places.js` in the same tree while this ran). Eleven caught, each by the test written for it: the normalised walk restored (5 tests, spanning elevation, day-panel and strip); the lazy swap-the-totals (1 — exactly its own test); directional sub-sample extremes (1); `climbFor` reading the day backwards (4); the dropped finite guard (1); the climb off the label (3); the town tier keeping the climb (1 — the degradation-order test); the climb off the title (3); `↑`/`↓` swapped in the title (3); `TIER_FULL_PX` back to 88 (3); `labelTier` never answering `'town'` (3).
    - **Harness note, confirming Task 6b's correction from the other side:** `.cache` is not excluded from vitest discovery here, so `vitest run src/strip.test.js` reported **247 tests for a 126-test file** while both agents' trees existed. Every count in this entry was re-measured with `--exclude '**/.cache/**'`, and the per-file numbers came from the JSON reporter rather than a grep. The sweeps themselves were scoped with `--root .cache/mut-t9`, so only the copy's own files ran. **A later sweep should keep its tree in the session scratchpad instead** — mine sat in the worktree and was therefore in a concurrent agent's discovery set, which is precisely the phantom-failure hazard the discipline exists to avoid.
  - **Browser-verified on real chromium** (playwright, `vite preview` over the production build), **zero console errors or warnings in seven runs**, axis 1392 px. Script `smoke-climb.mjs` (with `measure-tier.mjs` and `zoom-label.mjs`) in the session scratchpad:
    - **(a) whole road, five days of 120/80/60/40/10 km — the whole ladder in one screenshot.** 162.7 px: `1 120 km` / `🛏 Hitzacker · ↑ 20 m`. 108.5 px: `2 80 km` / `🛏 Dömitz` — **the climb dropped and the town kept**. 81.4 px: `3 60 km`. 54.2 px: `4`. 13.6 px: nothing at all — and its title still reads `Day 5 · 10 km · km 300 → 310 · ↑ 27 m ↓ 25 m — Magdeburg`. Then squeezed with Shift+ArrowLeft: 120 → 85 km (115.3 px) drops the climb and keeps the town; 85 → 60 km (81.4 px) drops the town too.
    - **(b) offset forward, 149.3 → 797.6.** `1 80 km` / `🛏 Hitzacker · ↑ 440 m` and `2 80 km` / `🛏 Dömitz · ↑ 155 m`, both 171.8 px, neither half clipped. Day panel `↑ 440 m ↓ 447 m`, agreeing with day 1's title.
    - **(c) the same window downstream, 797.6 → 149.3.** Identical geometry to (b) and DIFFERENT road under each day, so the figures differ honestly: `↑ 301 m` and `↑ 59 m`, day panel `↑ 301 m ↓ 317 m`. Identical numbers would have been the bug here, not the feature.
    - **(d) the same STRETCH both ways, which is the demonstration (c) cannot be.** (b)'s day 1 covers road km 149.3 → 229.3 and reads `↑ 440 m ↓ 447 m`; a downstream window whose LAST day covers 229.3 → 149.3 reads `↑ 444 m ↓ 442 m`. Nearly a transposition and deliberately not exactly one: over the identical 320 samples the walk accepts 88 moves upstream and 90 downstream. Checked against the raw profile in node rather than eyeballed.
    - **(e) km 920 → 1000 and back — the one 80 km stretch on this corridor whose totals transpose EXACTLY:** `↑ 453 m ↓ 398 m` upstream and `↑ 398 m ↓ 453 m` downstream, on the block label, in the block title, and in the day panel. Worth stating plainly: the Elbe is flat enough that most stretches climb and fall by nearly the same amount, so reversing one barely moves the numbers. The spec's "487 m one way and 487 m of descent the other" describes a monotonic climb this corridor does not have; (e) is the clearest real-data statement of the feature the data allows.
    - **(f) `Ústí nad Labem` on a 120.2 px block** — `townClipped: true`, `climbClipped: false`, which is the flex row's whole claim, checked live rather than asserted from the CSS.
    - **One number chased rather than shrugged at:** day 1's title read `↑ 13 m ↓ 15 m` at both 85 km and 60 km, which looks exactly like a stale render. It is not — km 60–85 is marshland at 0–5 m and contributes zero accepted movement (`ascentBetween(profile, 60, 85)` is `{a: 0, d: 0}`), so the two are genuinely the same figure.
  - **Prose fixed while in range** (the stale-after-change class): `glyphLayerMarkup`'s and strip.test.js's "the widest label tier — 88 px" now say "then 88 px", because 88 is the `'town'` threshold now and a reader comparing it against `TIER_FULL_PX` would be misled about which tier the old glyph bug was gated behind.
  - **Residual, and it belongs to no task yet:** the second line is 10 px and now carries two things, so at the taller strip sizes Tasks 14/15 make possible there is room for the DESCENT on the label as well. Spec §6b already lists "the climb figure on more tiers" as the obvious follow-up; this is the same note, now with a concrete shape.
  - **Every count in this entry is now a COMMIT's count**, re-measured with Task 6b's `git archive` method after that entry established that a working-tree figure is nobody's. The four per-file baselines above had been inherited from the Task 6/8 entries' prose rather than measured; all four are exact. At `913de61`: 811 in 20 files, elevation **28**, strip-geometry **37**, strip **121**, day-panel **68**. At `43ad8f9` (this task's last commit): 829 in 20 files, elevation **33**, strip-geometry **38**, strip **126**, day-panel **69**. The `817` above is `d98cff0`'s committed count — see the reconciliation bullet in the Task 6b entry for why that number appears twice in this ledger meaning two different things.
    - **Two traps in that method, for Task 16, which will use it.** (1) The extraction has to sit **outside the project** or it defeats its own purpose: a `.verify-<sha>` beside `src/` is discovered by ordinary suite runs, and one run here reported **40 files / 1646 tests** (829 at HEAD + 817 from the older tree) *with* `--exclude '**/.cache/**'` already applied. The hazard was never `.cache`; it is any sibling copy. (2) Outside the project, `vite` cannot be resolved, so the tree needs a `node_modules` junction — and then **`rm -rf` on that tree can follow the junction into the shared `node_modules` and destroy it under every concurrent agent.** Remove the junction first (`cmd /c rmdir <tree>/node_modules`, which unlinks rather than recurses), verify the real `node_modules` is still there, then delete the tree. Both trees used here were removed that way and the worktree's `node_modules` was checked intact afterwards.

- **Task 6c done** (`4570315`; places 67 → **68**; worktree suite **838 in 20 files**, zero failures, of which +1 is mine and +8 the concurrent Task 15 — the committed figure at `4570315` is **830**; `npx vite build` clean; browser re-verified in three configurations). **Task 6b's own insight, turned back on Task 6b by review, and it was right.**
  - **The defect.** 6b's entry argued the caps "were never wrong about which end of the ARRAY they kept, only about which end of the DAY the array's front happened to be." The signed favorites sort had exactly that flaw one layer in: the front of a signed rider-km list is not the first place the rider reaches, it is the place furthest BEHIND them — one they will never reach at all. So the row cap spent its 40 slots on places off the trip before it reached places on it, under a footer still promising "the first 40". Measured on the test fixture: 46 favorites with 10 behind the start rendered those 10 first and **dropped 6 places that were on the trip**.
  - **Reachable by design, not a corner case.** The starred list is global and plan-independent — which is the whole reason places.js has to order it rather than the store — so favorites left over from a previous plan on the same road are the ordinary case. On the offset-forward browser window a favorite at road km 100 sat 49.3 km behind the rider and headed their list.
  - **The fix: group, do not re-key.** The signed sort key and its monotonicity are kept (review explicitly declined to give them up, and the ledger's argument for one monotone axis still holds). Places at rider km **≥ 0** are grouped ahead of the rest, each group keeping the sorted order internally, so `section`'s prefix cap fills itself with the trip first and spends only the leftover slots on the road behind. Rider km 0 is the start LINE and counts as ahead. Places past the DESTINATION needed nothing — they already sort last and are dropped first.
  - **`section()` is untouched, which is the same shape of answer 6b gave.** The fix is in the ORDER again, so the prefix cap becomes correct on its own. That was the deciding argument for the cheap variant over teaching the cap about a tail: `section` is shared by all four sections, and "every list is a correctly ordered array, every cap is a prefix of one" is the invariant that makes the panel/map set identity provable at all. A tail concept inside `section` would have bought a marginally better behind-the-start policy at the cost of the property the previous task existed to establish.
  - **Nothing changes for a list whose favorites are all ahead of the start** — which is every whole-road forward trip, and every existing test in the file. Demonstrated rather than asserted: swapping the two groups (so behind-the-start comes first again) fails ONLY the new test and leaves the other 829 green, because for an all-ahead fixture the grouping is a genuine no-op.
  - **Known and accepted: within the behind-the-start tail, the cap keeps the places FURTHEST behind.** That follows from one monotone ascending key across both groups, which is what "monotone within each group" and the kept sort key give. Ordering that tail nearest-behind-first would arguably serve a reader better, but it is a second ordering rule inside a group that is entirely off-trip and every row of which already reads `beyond plan`. Recorded as a deliberate choice with a known cost, and it is a one-line change if a later task disagrees.
  - **A visible change for SHORT lists too, and an improvement rather than a regression:** with 40 or fewer favorites nothing is dropped, but a behind-the-start one still moves from the head of the list to the tail. That is the point — the first row is now the first place the rider will actually reach. Worth stating because "nothing changes below the cap" would have been the natural assumption, and it is false for the ORDER even where it holds for the SET.
  - **Three mutations, one at a time**, each caught by exactly the new test and nothing else, against a clean 830-test baseline: the grouping dropped entirely; the two groups swapped; and `>= 0` narrowed to `> 0`, which is the start-LINE boundary (a favorite standing exactly on the rider's start belongs to the trip, not to the road behind it).
  - **Browser re-verified on real chromium** (`smoke-lists.mjs`, `vite preview` over a fresh production build, port 4180), **zero console errors or warnings in all three runs**, and the food/sight/pin figures are line-for-line identical to 6b's — 6c touched only the favorites list, and the runs say so:
    - **offset forward, 149.3 → 797.6:** now `Fav km 200` km 50.7 Day 1 · `Fav km 300` km 150.7 Day 2 · `Fav km 500` km 350.7 beyond plan, with `Fav km 100` km -49.3 moved to LAST. Before 6c the -49.3 headed the list.
    - **the same window downstream, 797.6 → 149.3:** now `Fav km 700` km 97.6 Day 2 · `Fav km 500` km 297.6 · `Fav km 300` km 497.6, with `Fav km 900` km -102.4 last — still the exact mirror of the forward run, which is the property that matters.
    - **whole road, 0 → 1026.5 — the identity checkpoint:** unchanged, `Fav km 100` … `Fav km 900` ascending. On a whole-road forward trip nothing can be behind the start, so the partition cannot fire.
  - Both 6b browser bullets have been annotated in place rather than rewritten, since their favorites lines were true measurements of the code at `d98cff0` and are now superseded — the stale-prose-after-a-change class, caught on this task's own earlier entry.

- **Task 15 done** (`7c78e1d`; suite 842 committed). Wiring the resize handle in, and **the browser overturned Task 14's stated expectation.**
  - `createStripResize` mounts from a `wireStripSize()` declared beside the strip but **called after the first `renderAll`**, because the ordering is load-bearing: `onResize` fires from the *constructor* with the height it loaded, and `strip.js`'s argument-less `render()` throws until a render with arguments has given it a trip. The observer's initial callback is asynchronous and so has never been able to fire first — a guarantee this would rather not depend on, hence the explicit ordering.
  - The axis height travels as `--strip-axis-height` on the container, so `main.js` never reaches into `strip.js`'s DOM and the elevation profile rescales through the `measureHeight` seam that already existed.
  - **`setPointerCapture` retargets `pointerup` AND both compatibility click events to the capture element, so an element that captures can never hear its own `dblclick`.** Measured in Chromium. Task 14 predicted `preventDefault` would be the risk here; it is not — a cancelled `pointerdown` still produces both click events, at the capture target. The reset is now detected from the PRESSES (400 ms, under both Chromium's and Firefox's own interval), which also works on a touch screen where a double-tap may produce no `dblclick` at all. The `dblclick` listener stays as the no-capture path; both are idempotent.
  - **The `ResizeObserver` keys on WIDTH alone, against spec §6b's "must watch both".** It is notified of both, but the strip's box grows in height on every `pointermove` of a resize drag — a path that has already re-rendered — so reacting to height would double the cost of the gesture to redraw an identical axis. The 45% ceiling instead re-applies from a **window** resize listener, the only place that can see it: the body is a 100vh grid whose map row is `minmax(0, 1fr)`, so a shorter window is absorbed by the map and the strip's own box never changes. Spec deviation, deliberate, and the plan's own Task 15 step says the opposite — this entry is the reconciliation.
  - Keys stand down while a pointer is in flight: `startDrag` focuses the handle, so `End` mid-drag would race the next move with nothing on screen saying which won.

- **Task 10 done** (`24dd3bf`; 862 → **867**, 20 files). The map learns to be armed, and the start pin stops being a fact about the road.
  - 11 mutations, 11 caught. The exclusivity IS the feature: an armed click goes to `onPickPoint` **instead of** `onRouteClick`, because a route click already means "add a custom stop" and an armed click that also did that would drop a 📌 on the plan every time a rider chose where to begin.
  - **Browser instrument worth reusing:** the pin's position was recovered as a real lng/lat by unprojecting its rect centre through a tile's own `z/x/y` (two tiles cross-checked, agreeing exactly), because a screen-px comparison could not answer — the camera differs per config. If the pin were still nailed to `coordinates[0]`, all four configs would have read `8.681946, 53.891391`. They read 0.0 / 93.0 / 465.4 / 576.8 km of displacement instead.
  - **Plan error:** its third browser bullet predicted `797.6 → 149.3` would show "Start — Prague". km 797.6 is **Dresden**; the config that actually produces that is the whole road ridden downstream, `1026.5 → 0`. Added.
  - **`#map.map--picking .leaflet-marker-pane { pointer-events: none }` never worked** — found later, by Task 11c. `pointer-events` inherits, but leaflet.css sets `pointer-events: auto` on `.leaflet-marker-icon.leaflet-interactive`, and **an explicit value on the descendant beats an inherited one regardless of ancestor specificity.** A POI dot over the route stayed hit-testable and ate the armed click. Fixed in `4c0f12b` by naming the icons in the selector. Two browser items failed on this before it was found.

- **Task 11 done in four commits** (`d43c4cb` 11a, `8836fb4` 11b, `63954b2` 11b step 9, `4c0f12b` 11c; 867 → **900**, 21 files).
  - **11a — the model.** `proposeEnd` and `fitDaysToLength`, both pure and both unit-tested, because `main.js` has no test file and every guard left in a click handler would have been unverifiable. 22 mutations, all caught. **The plan's own mutation prediction for the signed-length comparison was wrong:** downstream, `795 − 797.6 = −2.6 < 5` still returns `too-short` — the right answer for the wrong reason. What actually kills it is the *good downstream pick* test (`200 − 797.6 = −597.6 < 5` → a perfectly good 597.6 km trip refused), which the plan did not ask for and an earlier agent had added anyway. **Without that test the mutation would have survived** — the good-pick cases are what give the refusal cases their discriminating power, not garnish.
  - **11b — the two controls.** `tripHeadline`, `createPickBanner`, and the scale line's end controls. **The plan's CSS shipped two real defects, both found only in the browser:** the prompt at `left: 10px` sat **on top of Leaflet's zoom control** (overlap 34 × 39.5 px; `elementFromPoint` at the zoom control's centre returned the banner), making `+`/`−` unclickable for as long as a pick was armed — `#map-controls` gets away with that inset only because Leaflet leaves the top-*right* corner empty. And the translucent tint measured **≈1.0:1 contrast** over an OSM land tile. Both fixed and re-measured (10 px gap; 10.19:1).
  - **A test that passed while its listener threw.** Deleting a null guard made the scale-line handler throw, and **jsdom swallows an exception thrown inside an event handler** — `.click()` returned normally, so `expect(onPickEnd).not.toHaveBeenCalled()` still passed and only vitest's "Unhandled Errors" banner went red. Disclosed rather than patched, and closed with a `window.addEventListener('error')` instrument. **Any assertion that a click does *nothing* needs this**, or it cannot tell "correctly ignored" from "threw".
  - **Three more changed expectations than the plan's "three and nothing else" sanctioned** — the scale-line assertions, re-pointed from substring adjacency at `[data-action="set-finish"]`. Strictly stronger (the end is identified by its action rather than by where it happens to sit in a string), and they follow from the plan's own specification that the arrived flag becomes `⚑ reached` *and* a control renders. Accepted by the controller; recorded because the convention says to stop at a fourth.
  - **Step 9 was omitted from the implementer's file list by controller error.** The agent flagged it rather than reaching outside its scope, and it landed separately (`63954b2`). Correct call — and the same discipline appears twice more below.
  - **11c — the wiring, and the payoff.** Three real defects fixed here: Task 10's `pointer-events` rule (above); `refusePick` leaving the control **lit above a disarmed map**, so the next route click quietly drafted a custom stop — the plan disarms unconditionally but only rendered on the success path; and a pick confirmation **surviving a plan switch**, sitting over a plan whose summary read `0 / 1026.5 km planned`. An *armed* prompt deliberately still survives, because the mode belongs to the app rather than to the plan.
  - **A refusal naming both road ends is unreachable.** The plan's comment assumed a whole-road trip "reads right from here"; in fact a proposal with **both** ends on road ends is provably never a reversal — all four cases of move-start/move-destination × 0/`totalKm` come out same-direction, or zero-length and refused as too-short first. At most the *picked* end can be named. Comment replaced with the proof.
  - **Elevation memo verified per end, at the pixel** (`.strip__elevation-line` first→last `y`), never by ascent totals: whole road `45.1 → 13.8`; **start moved only** `29.3 → 13.8` (last identical — both windows finish at Prague); **finish moved only** `45.1 → 45.1` (first identical). This is the standing convention's own example of a broken instrument, done right.

- **Task 12 done** (`b3fe264` + `27b9149`; 900 → **911**, 21 files). The ends get the names of the towns they sit in.
  - **A picked name is DERIVED from the km, never stored.** No field, no schema bump, no migration. A start that sits where a town sits is named by it; move it 3 km and the name goes, because that is the truth.
  - **The agent stopped at its file boundary and left the suite RED rather than make four tests green over a dead app.** `strip.js`'s `render()` rebuilt state field by field, so `endNames` was dropped before the markup saw it — the feature was unobservable in tests *and* dead in the browser. It asked twice, reported NEEDS_CONTEXT with the one-line fix and the evidence, and the controller landed it (`27b9149`). The right call: testing `strip-markup` directly would have bought four green tests and a broken app.
  - **Two of the plan's own assertions could not fail.** Its headline `nearestTown` case asserts `Brambury` at the default 3 km — but that window is `[47, 53]` and the town it is supposed to disagree with is at 54, outside it, so an implementation that just reused `townsNear` answers Brambury too. Rewritten at `withinKm: 10`, where both towns are in the window and the disagreement is real. And the `Number.isFinite(km)` guard the plan asks for is **unreachable**: every comparison against NaN/±Infinity is false, so both bounds walk to the same index and the window is already empty — a branch no test can kill. Omitted, with the three non-finite cases pinned as behaviour instead.
  - **Real dataset km, which the plan's browser bullets had stale:** Hamburg is at **155.8** and Dresden at **797.7**, not 149.3/797.6 — so that window is **641.9 km**, not 648.3. All 887 towns sit on the 0.1 km grid.
  - **A pre-existing gap found and disclosed:** dropping `originName: next.originName ?? state.originName` survived the whole suite, because `render(next = state)` makes `next.originName` the very same object — the test that looks like it pins the fallback pins nothing. The agent had hit the identical defect in its own first draft and fixed it with a second, PARTIAL render. See the Task 16 entry: this thread ends with all five fallbacks deleted.

- **Task 13 done** (`1566167`; 911 → **917**, 21 files). `Finish here` on a day card, routed through `applyPickedEnd` so it inherits every guard for free.
  - **`offerSnap: false`, measured rather than argued** — and against the plan's own snippet, which defaults it to `true`. A map click is a *measurement* (~0.7 km/px at whole-route zoom), so naming the town beside it corrects an error that is really there. A day boundary is not a measurement: it is the km the plan computed from a length the rider typed, dragged or already snapped, and it is the exact thing the button was pressed to keep. With the flag flipped on: day 3 ending at km 240 with **Sumte** as its overnight offered *"Alt Garge is 0.2 km behind your finish"*, one press moved the finish to 239.8, `fitDaysToLength` re-ran and **clamped day 3 from 80 to 79.8**, and the trip ended up named after a town the rider was not sleeping in. The same flip is also the calibration for the absence: with the flag off there is no offer *because of the flag*, not because no town is near.
  - **The plan's five specified tests left the button's title — the only km `Finish here` displays — entirely unpinned**, so an absolute-km title would have shipped. That is the one bug this whole feature exists to guard against. A sixth test kills both title mutants.
  - **One mutation deliberately not killed:** `atFinish = day.endKm === trip.destinationKm` passes all 85. The plan predicts this, and it is a genuinely correct alternative implementation — so the real behaviour was pinned rather than a fixture manufactured to fake a difference.
  - **`Finish here` left an armed pick armed.** The agent measured it and declined to invent behaviour, which was right. Controller ruling: **disarm** — pressing `Finish here` *accomplishes* what the armed pick was for, by another route, so the mode has been satisfied rather than interrupted; leaving it armed reproduces exactly the class of bug 11c had just fixed. Landed in `6d761ac`, which also disarms on the *refusal* path, because the prompt is a single slot and `applyPickedEnd` always speaks into it — by the time `handleFinishHere` returns, the line explaining the mode is gone whatever happened, so there is no way to keep the mode honestly.

- **Task 16.** Final review at `14b6438` (918 tests, 21 files, clean build): **no defect in shipped behaviour.** The reviewer mutated **all 20 `tripKm` display sites to absolute km one at a time and all 20 were caught**, most by two or more tests — the invariant this whole feature rests on holds under adversarial mutation, with exactly two deliberate labelled exceptions (the setup step, which prints "km N *of the road*" and says so, and identity keys that never render). `totalKm` is gone from every `itinerary`/`boundaries`/`strip-geometry` signature.
  - **The five `?? state.x` fallbacks in `strip.js` deleted.** Three findings converged: their comments claim to protect the argument-less width-change render, which is exactly the case they do NOT serve (`next` *is* `state`, so the `??` never takes its right branch — what serves the resize path is the default parameter); no production caller does a partial render at all; and decisively, **the partial-render contract they imply does not exist** — `render({days})` preserves those five fields but resets `focusedIndex` to `null` and `breaks` to `[]`, so a caller doing what the tests exercise would silently lose every break glyph. Four tests existed only to keep the dead code alive. `picking: next.picking ?? null` is different and stays: `null` is meaningful there, and `?? state.picking` would keep a control pressed for ever.
  - **Spec §6a corrected**: *"Hamburg → Dresden · 649 km downstream"* → *"641.9 km upstream"*, both figures wrong, settled against `elevation.json` (Cuxhaven 5 m, Prague 205 m) rather than against the prose. (§4's "487 m one way, 487 m the other" was the other spec error, but it was already corrected back at Task 9 in `584a88c` — an earlier draft of this entry claimed both for Task 16, and the commit that added it claimed a §6a fix it did not actually contain: the edit had been applied to the main checkout's copy of the file instead of the worktree's, so `git add` in the worktree matched nothing. Caught by `git status` in the main checkout during the pre-merge check. **A commit message is not evidence that a commit contains something** — `git show --stat` is.)
  - **Open follow-ups, none blocking:** pin `storage.js`'s single-ruined-end window repair (a stored `{startKm: 149.3, destinationKm: null}` must load as Hamburg→Prague, and nothing says so today); a duplicated four-line comment paragraph in `places.js`; a decision on `breaksInRange`, which has no app caller now that `strip-markup.js` kept its own `breaksIn`; stale future-tense prose in `stubMarkup`; 14 plan-task references in shipped source that name nothing after merge; three small test holes in unreachable branches. **Highest value: lift `nameAtKm` and `endLabel` out of `main.js` into a testable pure module** — `nameAtKm` carries an explicit cross-module invariant (its rounded road-end gate must stay identical to `roadContinues`'s) that nothing enforces, and relaxing `round1(km) <= 0` to `km <= 0` would name a km-0.04 start "Cuxhaven" while the strip drew a *"road continues 0.1 km to Cuxhaven"* cap past that same end and called it "start" — a visible contradiction with a green suite.
  - **The method, in one line: every real bug on this branch was found by mutating code and watching a test fail to notice.** Fifteen assertions that could not fail were found this way, several of them written by the plan itself, and at least four shipped-behaviour bugs (the boundaries stopgap dropping a whole plan on reload, `arrived`'s accidental `Math.abs`, the row cap keeping the LAST 40, the favourites cap spending its slots on places behind the rider) would otherwise have merged green.
