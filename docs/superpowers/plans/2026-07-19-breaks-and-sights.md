# Food Stops & Sights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show food stops (cafés/bakeries/restaurants) and sights (viewpoints/castles/bridges) along the day currently being planned, with optional pinning to a day — per the approved spec at `docs/superpowers/specs/2026-07-19-breaks-and-sights-design.md`.

**Architecture:** Extend the existing build-time Overpass pipeline with a third dataset (`src/data/pois.json`, precomputed `routeDistanceKm`/`offsetKm`, sorted). New `src/pois.js` answers "which POIs fall inside [startKm, endKm]" via binary search helpers extracted to a shared `src/sorted-range.js`. Days gain an additive `poiPins` array (schema stays v1). UI adds two collapsible panel sections and orange/teal dot markers along the pending stretch only.

**Tech Stack:** Existing only — Vite, vanilla JS, Leaflet 1.9, @turf/turf 7, Vitest. No new dependencies.

**Parallelization:** Tasks 1–3 touch disjoint files and run in parallel. Task 4 (integration) requires all of them.

---

### Task 1: `sorted-range.js` extraction + `towns.js` refactor + `pois.js`

**Files:**
- Create: `src/sorted-range.js`, `src/sorted-range.test.js`
- Create: `src/pois.js`, `src/pois.test.js`
- Modify: `src/towns.js` (refactor only — behavior identical)
- Must NOT touch: `src/towns.test.js` (proves the refactor is behavior-neutral)

- [ ] **Step 1: Create `src/sorted-range.js`** by moving `lowerBound`/`upperBound` out of `towns.js` verbatim, generalized to take a key accessor is NOT needed — all arrays use `routeDistanceKm`. Keep the exact algorithm:

```js
// Binary-search bounds over arrays sorted ascending by routeDistanceKm.

// First index i such that arr[i].routeDistanceKm >= target.
export function lowerBound(arr, target) {
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (arr[mid].routeDistanceKm < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

// First index i such that arr[i].routeDistanceKm > target.
export function upperBound(arr, target) {
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (arr[mid].routeDistanceKm <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}
```

- [ ] **Step 2: Write `src/sorted-range.test.js`** (failing first is impossible here since code is moved with the file — instead run it to prove green): cover empty array, target before first / after last, exact-match boundaries, duplicate km values.

- [ ] **Step 3: Refactor `src/towns.js`** to `import { lowerBound, upperBound } from './sorted-range.js';` and delete its private copies. No other change.

- [ ] **Step 4: Run `npx vitest run src/towns.test.js src/sorted-range.test.js`** — towns tests must pass UNMODIFIED.

- [ ] **Step 5: TDD `src/pois.js`** — write `src/pois.test.js` first with a synthetic sorted fixture (~12 POIs, mixed `kind: 'food'|'sight'`), covering: inclusive bounds at both ends; kind filtering; empty range; range covering whole array; startKm > all / endKm < all; input not mutated; stored ascending order preserved. Then implement:

```js
import { lowerBound, upperBound } from './sorted-range.js';

// pois must be sorted ascending by routeDistanceKm.
// Returns POIs of `kind` with routeDistanceKm in [startKm, endKm] (inclusive),
// in stored (ascending km) order.
export function poisInRange(pois, startKm, endKm, { kind } = {}) {
  const start = lowerBound(pois, startKm);
  const end = upperBound(pois, endKm);
  const slice = pois.slice(start, end);
  return kind ? slice.filter((p) => p.kind === kind) : slice;
}

export async function loadPois() {
  const mod = await import('./data/pois.json');
  return mod.default;
}
```

- [ ] **Step 6: Run `npx vitest run src/pois.test.js`** — all green. Do NOT call `loadPois()` in tests (data file may not exist yet).

- [ ] **Step 7: Full suite `npx vitest run`** — everything green. (Coordinator commits.)

### Task 2: `itinerary.js` poiPins

**Files:**
- Modify: `src/itinerary.js`, `src/itinerary.test.js`

- [ ] **Step 1: TDD — add failing tests** to `src/itinerary.test.js`:
  - `togglePoiPin(i, poi)` adds a pin; toggling the same identity (`name + '@' + routeDistanceKm`) removes it; different POIs coexist; throws on out-of-range index (match `setTownChoice`'s validation style).
  - `getDays()` exposes `poiPins` as a defensive copy (mutating the returned array doesn't leak).
  - save() payload contract test UPDATED: day entries have exactly the keys `['poiPins','targetKm','townChoice']` (sorted).
  - Round-trip: pins survive save() → fresh instance load().
  - Backward compat: an old payload whose days lack `poiPins` loads cleanly with `poiPins: []`.

- [ ] **Step 2: Implement.** Day records gain `poiPins: []` (in `addDay`, in `load()` replay via `entry.poiPins ?? []`, in `toPublicDay` as a copied array `[...day.poiPins]`). New method mirroring `setTownChoice`'s index validation:

```js
function poiPinKey(poi) {
  return `${poi.name}@${poi.routeDistanceKm}`;
}

function togglePoiPin(index, poi) {
  assertValidIndex(index); // same guard style used by setTownChoice
  const pins = days[index].poiPins;
  const key = poiPinKey(poi);
  const existing = pins.findIndex((p) => poiPinKey(p) === key);
  if (existing >= 0) pins.splice(existing, 1);
  else pins.push(poi);
}
```

save() persists `poiPins` alongside `targetKm`/`townChoice`. `SCHEMA_VERSION` stays 1.

- [ ] **Step 3: Run `npx vitest run src/itinerary.test.js`** — all green (old tests + new).

### Task 3: pipeline — POI dataset generation

**Files:**
- Modify: `scripts/build-data.mjs`
- Generate: `src/data/pois.json` (committed) — raw Overpass response cached like towns (NOT committed)

- [ ] **Step 1: Add the POI Overpass query** over the same padded route bbox, **nodes AND ways with `out center`** (ways contribute `element.center` as their coordinate):

```
[out:json][timeout:180];
(
  nwr["amenity"~"^(cafe|restaurant|fast_food|ice_cream|biergarten)$"](S,W,N,E);
  nwr["shop"="bakery"](S,W,N,E);
  nwr["tourism"="viewpoint"](S,W,N,E);
  nwr["natural"="waterfall"](S,W,N,E);
  nwr["historic"~"^(castle|monument|ruins|fort|city_gate|tower)$"](S,W,N,E);
  nwr["man_made"="lighthouse"](S,W,N,E);
  nwr["man_made"="tower"]["tower:type"="observation"](S,W,N,E);
  nwr["man_made"="bridge"]["name"](S,W,N,E);
);
out center;
```

Reuse `fetchCached` with a new cache path (os.tmpdir like towns) honoring `--refresh`. Note `out center` yields `lat`/`lon` directly on nodes and `center.lat`/`center.lon` on ways/relations — normalize both.

- [ ] **Step 2: Classify** each element into `{kind, category}`: `shop=bakery`→food/bakery; `amenity=X`→food/X; `tourism=viewpoint`→sight/viewpoint; `natural=waterfall`→sight/waterfall; `historic=X`→sight/X; `man_made=lighthouse|bridge`→sight/lighthouse|bridge; observation tower→sight/tower. Fallback labels for unnamed: food → capitalized category ("Café", "Bakery", "Restaurant", …); sights → only unnamed viewpoints kept (label "Viewpoint"); all other unnamed sights and named-less bridges dropped (bridge query already requires name).

- [ ] **Step 3: Snap + filter + dedupe + sort**, mirroring the towns flow: `turf.nearestPointOnLine` per POI → keep food with `offsetKm <= 2`, sights with `offsetKm <= 3` → dedupe entries with the same normalized (lowercased, trimmed) name within 100 m of each other keeping the lower `offsetKm` → records `{ name, kind, category, lat, lng, routeDistanceKm (1dp), offsetKm (2dp), openingHours }` where `openingHours` is the raw `opening_hours` tag if present (omit the key otherwise) → sort ascending by `routeDistanceKm` → write `src/data/pois.json`.

- [ ] **Step 4: Validation additions:** print counts per kind and per category; **fail (exit non-zero) if total POIs === 0**; existing route/towns validation untouched.

- [ ] **Step 5: Run `node scripts/build-data.mjs`** (route+towns load from cache, only POIs fetch). Confirm: counts printed, pois.json written, spot-check that a known Dresden Elbe bridge (e.g. "Blaues Wunder"/"Loschwitzer Brücke") and at least one viewpoint near Meißen–Dresden appear with plausible km (~620–650).

### Task 4: integration — map markers, panel sections, pins (depends on Tasks 1–3)

**Files:**
- Modify: `src/map.js`, `src/ui.js`, `src/main.js`, `src/style.css`

- [ ] **Step 1: `src/map.js` — `setPoiMarkers(pois)` + `onPoiClick` callback.** Follow the existing divIcon pattern (like `setDayPins`): a `L.layerGroup` cleared and refilled; each POI a small dot divIcon — class `poi-marker poi-marker--food` (warm orange) or `poi-marker--sight` (teal); `bindTooltip(name)`; click → `onPoiClick(poi)`. Density cap: if `pois.length > 40` for a kind, keep the 40 with smallest `offsetKm` (cap applies per kind, map only).

- [ ] **Step 2: `src/ui.js` — two collapsible sections + pin rendering.** New render function `renderPois({ food, sights, pinnedKeys, dayStartKm })` targeting a new `#pois` container (add `<div id="pois"></div>` between `#towns` and `#itinerary` in `index.html`). Each section a `<details open>` with `<summary>Food on the way (N)</summary>` / `Worth seeing (N)`. Rows are buttons (event delegation on the container, `data-poi-index` + `data-poi-kind`), content: name (use the existing `esc()`), category chip, `${round1(p.routeDistanceKm - dayStartKm)} km into your day (km ${p.routeDistanceKm}) · ${p.offsetKm} km off route`, optional opening-hours line (escaped), pin toggle state via `poi--pinned` class when its key ∈ `pinnedKeys`. Key = `name@routeDistanceKm` (export a `poiKey(poi)` from ui.js mirroring `townKey`). Day cards: render pinned chips under the town line — `day-card__pins` with one chip per pin (icon by kind: 🍴/📷 or CSS dot, name escaped). Callback: `onTogglePoi(poi)`.

- [ ] **Step 3: `src/main.js` wiring.** Boot: `loadPois()` in the existing `Promise.all`; on failure, show "No POI data — run npm run build:data" in `#pois` and continue. State: `pendingPoiPins = []`. In `renderPending()`: `const food = poisInRange(pois, startKm, ghostKm, {kind:'food'}); const sights = poisInRange(pois, startKm, ghostKm, {kind:'sight'});` → `ui.renderPois(...)` + `map.setPoiMarkers([...food, ...sights])`. `handleTogglePoi(poi)`: toggle in `pendingPoiPins` (by `poiKey`), `renderPending()`, `map.panTo([poi.lng, poi.lat])`. Commit: after `addDay`, apply each pending pin via `itinerary.togglePoiPin(newDayIndex, pin)`, clear `pendingPoiPins`, `save()`. Reset/remove flows clear `pendingPoiPins` too.

- [ ] **Step 4: `src/style.css`** — styles for `details/summary` sections, POI rows (reuse `.town` row patterns), pin toggle state, `poi-marker--food` (#e07b39-ish orange) / `poi-marker--sight` (#2a9d8f-ish teal) dots sized ~10px, `day-card__pins` chips. Match the existing dark-panel design language.

- [ ] **Step 5: Verify.** `npx vitest run` (all green) → `npm run build` (success) → `npm run dev` + Playwright: Day 1 at 80 km → both sections populate with plausible entries; pin one food + one sight → rows highlight; commit → chips on Day 1 card; reload → pins persist; move slider → markers/lists refresh; zero console errors; clear localStorage; stop server.

### Final: cleanup + push

- [ ] Full suite + build green; commit remaining work; push to `origin master` (github.com/MichelMerae/elberadweg-planner).

## Self-review notes (done)
- Spec coverage: §1→Task 3, §2→Task 1, §3→Task 2, §4→Task 4, error handling→Task 4 step 3, testing→each task + Task 4 step 5. No gaps.
- Type consistency: `poiKey`/`poiPinKey` both `name@routeDistanceKm`; `poisInRange(pois, startKm, endKm, {kind})` signature identical in Tasks 1 and 4; record fields match spec (`openingHours` in JSON, raw string).
- No placeholders: every code step shows code or names the exact existing pattern file to mirror.
