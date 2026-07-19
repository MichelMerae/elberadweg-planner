# Breaks + Day-Relative Distances Implementation Plan (Sub-project 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Read the spec first:** `docs/superpowers/specs/2026-07-19-breaks-and-day-relative-distances-design.md` (authority on requirements). Requires sub-project 1 (storage v2) to be merged.

**Goal:** Committed break waypoints (plan-level, day cards render legs), ☕ row buttons, break map pins, and day-relative distance wording everywhere.

**Architecture:** `itinerary.js` gains plan-level `breaks` (add/remove/range-query, hydrated with days); day cards derive legs from breaks in `[startKm, endKm]`; `ui.js` re-words all distance meta to "X km from [name]" with absolute km secondary; `map.js` gains persistent break markers.

**Sequencing:** Task 1 (model) first; Task 2 (integration/UI) after.

---

### Task 1: Breaks in `src/itinerary.js` + tests

**Files:** Modify `src/itinerary.js`, `src/itinerary.test.js` only.

- [ ] **Step 1: TDD tests first** (new describe blocks): `addBreak` inserts sorted by routeDistanceKm regardless of add order; validation — missing/negative routeDistanceKm or missing lat/lng throws; adding an existing key (`name@routeDistanceKm`) is a no-op (no duplicate); `removeBreak(key)` removes, unknown key no-op; `getBreaks()` defensive copy; `breaksInRange(start, end)` uses `(start, end]` semantics (break exactly at `start` excluded, exactly at `end` included); `hydrate({days, breaks})` object form restores both, drops malformed break entries silently, and plain-array form still hydrates days only (back-compat with sub-project 1 call sites until Task 2 updates them); `reset()` clears breaks; re-bucketing scenario: days 80+80, break at km 70 → in range of day 0; `editDay(0, 60)` → break now in `(60, 140]` = day 1's range.

- [ ] **Step 2: Implement.**

```js
function breakKey(b) { return `${b.name}@${b.routeDistanceKm}`; }

let breaks = []; // plan-level, sorted asc by routeDistanceKm

function assertValidBreak(place) {
  if (!place || typeof place.routeDistanceKm !== 'number' || !Number.isFinite(place.routeDistanceKm)
      || place.routeDistanceKm < 0 || typeof place.lat !== 'number' || typeof place.lng !== 'number') {
    throw new Error('break needs numeric routeDistanceKm >= 0 and lat/lng');
  }
}

function addBreak(place) {
  assertValidBreak(place);
  const key = breakKey(place);
  if (breaks.some((b) => breakKey(b) === key)) return; // no duplicates
  breaks.push({ ...place });
  breaks.sort((a, b) => a.routeDistanceKm - b.routeDistanceKm);
}

function removeBreak(key) { breaks = breaks.filter((b) => breakKey(b) !== key); }
function getBreaks() { return breaks.map((b) => ({ ...b })); }
function breaksInRange(startKm, endKm) {
  return getBreaks().filter((b) => b.routeDistanceKm > startKm && b.routeDistanceKm <= endKm);
}
```
`hydrate(input)`: accept array (days only, as before) OR `{days, breaks}`; break entries validated with the same predicate but silently dropped when invalid. `reset()` also `breaks = []`. Export `addBreak, removeBreak, getBreaks, breaksInRange` and a `breakKey` helper export (ui/main need the same convention — export it from itinerary and import in main; ui gets keys passed in, mirroring how pinnedKeys worked).

- [ ] **Step 3:** `npx vitest run src/itinerary.test.js` → green.

### Task 2: Integration — legs, ☕ buttons, break pins, day-relative wording

**Files:** Modify `src/main.js`, `src/ui.js`, `src/map.js`, `src/style.css`.

- [ ] **Step 1: map.js** — `setBreakMarkers(breaks)`: persistent layerGroup (like day pins), divIcon class `break-marker` (☕ glyph in a small white circle with amber border, ~18px — between day pin 26px and poi dot 10px), tooltip name, click → existing highlight/pan callback path. Export in API; JSDoc.

- [ ] **Step 2: ui.js** —
  - `renderPois`/`renderTowns` signatures gain `{ dayStartKm, fromName, breakKeys }`. Meta wording: towns `"${round1(routeDistanceKm - dayStartKm)} km from ${fromName} · ${offsetKm} km off route"` + secondary `<span class="meta__abs">km ${routeDistanceKm}</span>`; POIs `"${round1(routeDistanceKm - dayStartKm)} km from ${fromName} (km ${routeDistanceKm}) · ${offsetKm} km off route"` (spec §4 wording).
  - Every town/food/sight row gets `<button class="row-action row-action--break" data-action="break" title="Add as break">☕</button>`; active state class when its key ∈ `breakKeys`; click (delegated, `e.stopPropagation()` relative to row-body semantics) fires `onToggleBreak(place)`. Food/sight row-body click stays `onSelectPoi` (pan/highlight); town row-body click stays select-overnight.
  - Day cards: legs list per spec §2 — derive via new render input `breaksForDay(day)` passed from main (array per day). Card shows `from ${fromName}` lead (`fromName` rules: prev day's townChoice.name, "Hamburg" for day 0, else "your last stop"), leg lines `${legKm} km → ${glyph} ${esc(name)}` each with `<button data-action="remove-break" data-break-key="...">×</button>`, final leg to `🛏 ${townChoice?.name ?? 'day end'}`, secondary line `km ${startKm} → ${endKm} of ${totalKm}`. `onRemoveBreak(key)` callback.
  - Pending-stretch breaks (beyond last committed endKm): small list in the controls section with the same × control (render input `pendingBreaks`).

- [ ] **Step 3: main.js** — pass everything through: `fromName` computed once per render (prev committed day's town etc.); `breakKeys` = `new Set(itinerary.getBreaks().map(breakKey))`; `handleToggleBreak(place)` → if key exists `removeBreak` else `addBreak({...place, kind: place.kind ?? 'town'})`; then `persistPlan()` (now `breaks: itinerary.getBreaks()`) + renderAll; `handleRemoveBreak(key)` same path. `itinerary.hydrate({days: plan.days, breaks: plan.breaks})` (object form) at boot/plan-switch. `map.setBreakMarkers(itinerary.getBreaks())` in the render pass. `breaksForDay(day)` = `itinerary.breaksInRange(day.startKm, day.endKm)`; pendingBreaks = `breaksInRange(lastCommittedEndKm, Infinity)`.

- [ ] **Step 4: style.css** — row-action button styling (small, right-aligned in row grid, active state amber), break marker, day-card leg list (indented, route-spine-friendly), `.meta__abs` (faint, small).

- [ ] **Step 5: Verify.** `npx vitest run` + `npm run build` green. Playwright: Day 1 pending → click ☕ on a food row ~km 45 → break pin on map + pending-breaks list entry; commit day 80 → card shows `45 km → ☕ ... , 35 km → 🛏 ...` legs summing to 80; towns list reads "X km from Hamburg"; commit Day 2, edit Day 1 to 60 → break re-buckets into Day 2's card; × removes; reload persists; second plan has independent breaks; zero console errors; clear localStorage; stop server.

### Final: coordinator commits and pushes.

## Self-review notes (done)
- Spec coverage: §1→Task 1; §2/§3/§4/§5→Task 2. Error handling: throw-on-add + silent-drop-on-hydrate in Task 1.
- Consistency: `breakKey` exported from itinerary and used by main; `(start, end]` semantics identical in tests and impl; hydrate object-form matches SP1 array-form back-compat.
- No placeholders: model code fully shown; UI steps name exact wording, classes, callbacks, and data attrs.
