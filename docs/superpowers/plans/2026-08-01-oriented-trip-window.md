# Oriented Trip Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/trip.test.js`
Expected: FAIL — `Failed to resolve import "./trip.js"`.

- [ ] **Step 3: Implement**

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

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/trip.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Test `wouldReverse` too**

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

- [ ] **Step 6: Commit**

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

- [ ] **Step 1: Read every existing test before changing anything**

`src/itinerary.test.js` has `const TOTAL_KM = 380` at the top and ~120 cases built on an ascending km-0 origin. **Read them.** The change you are making is exactly the kind that makes tests pass for the wrong reason: if a test asserts `days[0].startKm === 0` and the new default trip starts at 0, it passes while testing nothing about direction.

Add a `trip` helper to the file and convert the existing suite to build its itinerary through it, keeping every assertion's *intent*:

```js
import { createTrip } from './trip.js';

const TOTAL_KM = 380;
const WHOLE = createTrip({ startKm: 0, destinationKm: TOTAL_KM });
```

- [ ] **Step 2: Write the failing NEW tests — direction is what needs proving**

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

- [ ] **Step 3: Run to verify the new tests fail**

Run: `npx vitest run src/itinerary.test.js`
Expected: FAIL on the oriented cases.

- [ ] **Step 4: Implement**

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

- [ ] **Step 5: Run the whole file**

Run: `npx vitest run src/itinerary.test.js`
Expected: PASS. If an old test needed its numbers changed rather than its construction, stop and check you have not changed its intent.

- [ ] **Step 6: Commit**

```bash
git add src/itinerary.js src/itinerary.test.js
git commit -m "feat(itinerary): chain days along an oriented trip"
```

---

### Task 3: `boundaries.js` becomes signed

**Files:**
- Modify: `src/boundaries.js`
- Test: `src/boundaries.test.js`

- [ ] **Step 1: Read `boundaries.test.js` in full first**

~130 cases, all ascending from km 0. Same hazard as Task 2, worse: this file owns `MIN_DAY_KM` enforcement, and a sign error here lets a day become negative-length without any test noticing.

- [ ] **Step 2: Write the failing tests**

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

- [ ] **Step 3: Run to verify they fail**, then implement.

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

- [ ] **Step 4: Run, then commit**

```bash
git add src/boundaries.js src/boundaries.test.js
git commit -m "feat(boundaries): do boundary maths in rider km, both directions"
```

---

### Task 4: Storage v4

**Files:**
- Modify: `src/storage.js`
- Test: `src/storage.test.js`

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Implement**

`SCHEMA_VERSION = 4`, `PREVIOUS_SCHEMA_VERSION` accepts 3 **and** 2. `createPlanStore` takes `totalKm` so it can default the window. `normalizePlan` gains:

```js
    // Absolute route km. A plan that predates the window spans the whole road,
    // which is exactly what it did before the field existed.
    startKm: Number.isFinite(plan.startKm) ? plan.startKm : 0,
    destinationKm: Number.isFinite(plan.destinationKm) ? plan.destinationKm : totalKm ?? 0,
```

`emptyPlan`, `duplicatePlan` and `saveActivePlan` all carry the two fields.

**Do not touch the `routeId` archive logic.** A window change is not a corridor change, and v3 → v4 must not archive anything.

- [ ] **Step 3: Run, then commit**

```bash
git add src/storage.js src/storage.test.js
git commit -m "feat(storage): schema v4 carries each plan's trip window"
```

---

## Phase 2 — display translation

### Task 5: Wire the trip through `main.js`

**Files:** `src/main.js`

- [ ] **Step 1: Build the trip from the active plan**

```js
  // The trip is derived from the active plan, so switching plans switches windows.
  let trip = createTrip({
    startKm: bootPlan.startKm,
    destinationKm: bootPlan.destinationKm,
    totalKm: meta.totalKm,
  });
```

`createItinerary({ trip })`, and every `boundaryWindow`/`clampBoundaryKm` call passes `{ trip }` instead of `{ totalKm }`. `hydrateActivePlan` rebuilds `trip` from the plan it loads. `saveActivePlan` persists `trip.startKm` / `trip.destinationKm`.

- [ ] **Step 2: Run the app, confirm nothing changed**

Run: `npm run dev`, open it, add days.
Expected: identical to `997c525` — the window is the whole road, so every number matches. **This is the checkpoint for phase 1.** If anything differs, phase 1 has a bug and phase 2 will bury it.

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat: derive the trip from the active plan"
```

---

### Task 6: `tripKm` at every display site

**Files:** `src/ui-util.js`, `src/strip-markup.js`, `src/day-panel.js`, `src/places.js`, `src/map.js`, plus their tests.

- [ ] **Step 1: Enumerate the sites before editing any**

```bash
git grep -n "startKm\|endKm\|routeDistanceKm\|totalKm" -- src/*.js | grep -v test | grep -vE "^src/(trip|boundaries|itinerary|storage|elevation|strip-geometry)\.js"
```

Every hit inside a template literal or a `textContent` assignment is a display site. Write the list into this plan's ledger before touching code — the failure mode is a *missed* site, and a list you wrote down is checkable where memory is not.

- [ ] **Step 2: Test-drive each module's translation**

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

- [ ] **Step 3: Implement**

Each of those modules takes `trip` in its render arguments and calls `trip.tripKm(...)` wherever a km reaches markup. `ui-util.js` gains nothing — `trip.js` already owns the conversion, and a second copy in `ui-util` is how the two drift apart.

- [ ] **Step 4: Sweep**

Re-run the grep from step 1. Every remaining raw `startKm`/`endKm` in markup-producing code must be either converted or deliberately absolute with a comment saying why.

- [ ] **Step 5: Commit**

```bash
git add src/ && git commit -m "feat: show distances from the rider's own start"
```

---

## Phase 3 — the strip

### Task 7: `strip-geometry.js` maps the window

**Files:** `src/strip-geometry.js`, `src/strip-geometry.test.js`

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Implement**

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

- [ ] **Step 3: Run, commit.**

### Task 8: The strip renders a window, with stubs

**Files:** `src/strip.js`, `src/strip-markup.js`, `src/style.css`, tests

- [ ] Tests: the summary counts down to the destination using trip length; the scale line names the trip's own ends; a stub appears at an end only when the road continues past it, with the remaining distance in its title; no stub when an end is the road's end.
- [ ] Implement: `axisOpts()` returns `{ startKm, endKm, width, height, elevationPoints }`; `elevationPointsFor` passes the window (and its memo key gains both ends); `scaleMarkup` uses the trip's ends; a `stubMarkup(side, km, name)` renders the caps.
- [ ] `elevation.js`: relax `profilePoints`'s `endKm <= startKm` guard to allow a descending window, with a test proving a downstream profile is the mirror of the upstream one.
- [ ] Commit.

### Task 9: Per-day climb on the block, direction-aware

**Files:** `src/elevation.js`, `src/strip-geometry.js`, `src/strip-markup.js`, tests

- [ ] Tests: `ascentBetween` swaps ascent and descent when the span is given in descending order (the same stretch is 487 m up one way and 487 m down the other); the `full` tier renders `↑ 340 m` on the second line; the climb is in the block `title` at every tier; a block below the new `full` threshold drops the climb before it drops the town.
- [ ] Implement: `ascentBetween(profile, fromKm, toKm)` stops normalising with `min/max` and instead reports relative to the direction it was asked in. `TIER_FULL_PX` 88 → **112**, measured in Chromium at the real 11px Archivo with `1 80 km` / `🛏 Hitzacker · ↑ 340 m` — do the measurement, do not trust the number.
- [ ] Commit.

---

## Phase 4 — picking

### Task 10: Picking mode on the map

- [ ] `createMap` gains `setPickingMode('start'|'destination'|null)` and an `onPickPoint` callback; a `.map--picking` class sets the crosshair cursor; a route click while armed fires `onPickPoint` **instead of** `onRouteClick`, so a custom stop is never created by a picking click. Test both paths.

### Task 11: Trip setup and the two controls

- [ ] The scale-line endpoints become buttons (`Set start`, `Set finish`). Empty-plan panel becomes the setup step from spec §6a, naming the direction in words. Both ends default to the road's ends so the step is skippable.

### Task 12: Town snapping and refused flips

- [ ] After a pick, if a town lies within 3 km, offer it by name and km; one press snaps. A pick that would flip direction with days present is refused with the message from spec §6 — test the message names the direction.
- [ ] **Guard order:** the `MIN_DAY_KM` length guard (spec §8) runs **before** `wouldReverse`. A pick at or on top of the other end is refused as *too short*, never as a reversal — `wouldReverse` conflates a zero-length window with a flip on downstream trips, so it must never see one. Also validate the pick is a finite km before either guard; `wouldReverse` throws on non-finite ends by design (Task 1 quality review).

### Task 13: `Finish here` on a day card

- [ ] Sets `destinationKm` to that day's end; drops later days, reporting how many.

---

## Phase 5 — the resizable strip

### Task 14: `strip-resize.js`

**Files:** Create `src/strip-resize.js`, `src/strip-resize.test.js`

- [ ] Tests: a drag on the handle changes the height; the height clamps at 46 px and at 45% of the viewport; the value persists to `localStorage` under `elberadweg-strip-height`; a double-click resets to 46; a stored height outside the bounds is repaired on load; `pointercancel` mid-drag leaves a sane height.
- [ ] Implement as its own module taking `{ el, storage, onResize, measureViewport }`, mirroring `strip.js`'s pointer-capture discipline — capture on a stable element, not the handle, for the same reason documented there.

### Task 15: Wire it up

- [ ] `main.js` mounts it, and its `onResize` re-renders the strip. The `ResizeObserver` currently watching width must watch height too, or a resize will move the handle without redrawing the profile.
- [ ] Verify in the browser at 46 px, mid-range and maximum: the profile rescales, the day labels stay put, the map shrinks, and a reload restores the height.
- [ ] Commit.

---

## Task 16: Review, verify, merge

- [ ] `npm test` — run from inside the worktree; expect >650 tests passing (592 baseline + this feature's new tests; the plan's original ">1150" figure was based on a polluted count).
- [ ] `npm run build`.
- [ ] Grep sweep: no raw absolute km in display code; no `totalKm` left in `itinerary`/`boundaries`/`strip-geometry` signatures.
- [ ] Browser: Hamburg → Dresden, then Dresden → Hamburg, and confirm the climb figures swap.
- [ ] Two-stage review — spec conformance, then quality.
- [ ] Merge to `master` with `--no-ff`, push.
- [ ] Append the outcome to the spec.

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

- **Task 6b done** — the lists run with the ride (pois 15 → **16**, places 63 → **67**, map 25 → **26**, favorites 16 unchanged; suite **829 in 20 files**, zero failures, of which +6 are mine and the rest a concurrent Task 9 over this task's 817 baseline; `npx vite build` clean; browser-verified on real chromium in three configurations). This closes the "List ORDER, not km" flag Task 6 left: Favorites, Food and Sights ran back-to-front on a downstream trip, and under the row/marker caps that meant the wrong SUBSET — the last 40 places the rider would meet instead of the first 40.
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
  - **Checked and deliberately left alone: Overnight options.** `towns.js`'s `townsNear` ranks by `|town.km − day.endKm| + 1.5 × offsetKm` and keeps the best 8. The measure is symmetric, so the ranking AND its cap already mean the same thing in both directions — best-first is the point of that list, and ride order would be a downgrade. Written into places.js's header, so the module's "every list runs in ride order" promise names its own exception. (`townsInRange` is ascending and would need the `poisInRange` treatment, but still has no app caller; towns.js was outside this task's file scope.)
  - **One `[0]`-means-the-start still standing, and it is not this task's:** `map.js:405` builds the start pin from `routeFeature.geometry.coordinates[0]` — the ROAD's origin, which on a downstream trip is the rider's DESTINATION. Already assigned to Task 10 by the Task 5 entry; re-flagged because this task swept these files for exactly that pattern and this is the one instance of it.
  - **Three existing expectations changed, all in `pois.test.js`, all order-only.** Recorded because a changed expectation is a red flag worth stopping on: Task 6 wrote those tests to pin that a descending span is not EMPTY (its own entry says so) and over-specified by asserting the ascending order too. Membership is unchanged and still asserted; only the order claims flipped. **No test outside `pois.test.js` had a value edited.**
  - **Whole-road forward trips are untouched**, by construction (from km 0 forward, `tripKm` is the identity, so rider-km order IS absolute order) and by evidence: the 817-test baseline still passes, and the browser's whole-road run reads ascending exactly as before.
  - **Nine mutations, ONE AT A TIME**, each caught by its intended test: `poisInRange`'s reversal dropped (3 tests); reversal on EQUAL ends too (1 — the equal-km tie order, caught by an existing test); `inRideOrder` returning unsorted (4); its comparator inverted (6, two of them **pre-existing forward-trip tests**, which is the no-regression requirement holding independently); `lists` fed the unordered array (1, sole catcher); `section` fed the unordered array (4); `inRideOrder` sorting in place (1, sole catcher); `slice(-ROW_CAP)` (2, after first confirming it survived all 63 at HEAD); map re-sorting by absolute km (1, after first confirming it survived all 25).
  - **Harness correction that every later task needs: `.cache` is NOT excluded from vitest discovery in this project.** The brief and the Task 4/8 entries hold that vitest's default exclude covers `**/.cache/**`. It does not — vitest 4.1.10 against this `vite.config.js` discovers `.cache/mut-*/src/*.test.js` as project test files. Both consequences were observed: `vitest run src/places.test.js` matched the copy too and reported **130 tests for a 67-test file**, and a concurrent agent's `.cache/mut-t9` tree sat in my discovery set while mine sat in theirs — precisely the phantom-failure hazard putting a sweep on `.cache` was meant to avoid. The mutations above are still correctly attributed (each run was scoped with `--root`, so only the copy's own file ran) but every count in this entry was re-measured with `--exclude '**/.cache/**'`, and the copy is deleted. **A later sweep should keep its tree outside the worktree entirely** (the session scratchpad) or pass `--exclude`. The 20-file/817-test baseline this task started from was clean, and 20 files is the true project count: 19 in `src/`, 1 in `scripts/`.
  - **Browser-verified on real chromium** (playwright, `vite preview` over the production build on port **4174** — 4173 was a concurrent agent's), **zero console errors or warnings in all three runs**. Day 2 focused in each, scope `km 80 → 160` in each — the same rider km at opposite ends of the road, which is the whole point. Script `smoke-lists.mjs` in the session scratchpad; unlike `smoke-oriented.mjs` it seeds a FAVORITES blob as well, since the starred list's order is half of this task.
    - **(a) offset forward, 149.3 → 797.6.** Food (87, capped to 40): `Altes Zollhaus` km 85.1 · `SchlossCafé` km 85.1 · `hafenmieze Unterdeck` km 85.1, last kept `Restaurant Claus` km **114.8** — the front of the day, stopping 45 km short of its end, which is the cap keeping the right 40. Sights (34, uncapped): `Aussichtsturm` km 80.7 · `Wachturm BT 9` km 84.1 · `Elbschloss Bleckede` km 85.1. Favorites: `Fav km 100` **km -49.3** beyond plan · `Fav km 200` km 50.7 Day 1 · `Fav km 300` km 150.7 Day 2.
    - **(b) the same window downstream, 797.6 → 149.3.** Food (82, capped to 40): `AMED KEBAP` km 88.7 · `Eventbistro DAS WERK` km 88.7 · `Bäckerei Gäbler - Filiale` km 88.8, last kept `Ricard` km **104.9**. Sights (26): `Barockschloss Martinskirchen` km 80.3 · `Gutshaus Domäne Packisch` km 85.5 · `Brücke des Friedens` km 88.7. Favorites: `Fav km 900` **km -102.4** · `Fav km 700` km 97.6 Day 2 · `Fav km 500` km 297.6 — the exact mirror of (a)'s favorite order. **Entirely different PLACES from (a)** — Torgau's cafés rather than Bleckede's — because day 2 downstream is the other end of the road, and every one of them measured forward from the rider's own last stop.
    - **(c) whole road, 0 → 1026.5 — the identity checkpoint.** Ascending throughout: favorites `km 100` … `km 900` in absolute order, food (**2092** on day 2 — the Hamburg metro) capped to km 85.7 … 98.5, 80 pins = 40 + 40.
    - **Task 6's Day-N tagging is right in all three and was checked against the days rather than assumed:** rider 50.7 → Day 1 and 150.7 → Day 2 on (a); rider 97.6 → Day 2 on (b); rider 100 → Day 2 on (c)'s 0–80/80–160 days; every km outside the two days reads `beyond plan`.
