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
