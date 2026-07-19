# Food Stops & Sights — Design Spec

**Date:** 2026-07-19
**Status:** Approved by Michel (design conversation, this date)
**Feature:** Show food breaks (cafés/bakeries/restaurants) and sights (viewpoints, castles/historic, bridges/landmarks) along the day currently being planned, with optional pinning to a day.

## Motivation

While planning each riding day, Michel wants to see where he could stop for breakfast/lunch/coffee, and which beautiful or historic places lie on (or slightly off) that day's stretch — so day lengths can be tuned around a good lunch town or a castle worth visiting. Purely informational: breaks and sights never change the distance math.

## Decisions made during brainstorming

1. **Break model:** food stops are *shown* along the current day's stretch and can be *optionally* pinned to the day. No structural breaks in the day model; distances stay start→end.
2. **Sight categories:** viewpoints & nature, castles & historic, bridges & landmarks. **Excluded:** museums/general attractions (noise), `historic=memorial` (plaque noise).
3. **Display:** current pending day only (start → ghost), like the towns list. No whole-route layers in this iteration.
4. **Approach:** extend the existing build-time Overpass pipeline (Approach A). No runtime OSM queries.

## 1. Data pipeline (`scripts/build-data.mjs`)

Add a third corridor dataset, generated alongside route/towns using the existing bbox, retry/backoff/mirror, and cache machinery (raw response cached, gitignored; refreshed via `--refresh`).

**Query:** nodes AND ways, with `out center` (ways contribute their centroid — cafés are often building outlines; bridges are always ways):

- **Food** (`kind: "food"`, corridor `offsetKm <= 2`):
  - `amenity` ∈ cafe, restaurant, fast_food, ice_cream, biergarten
  - `shop` = bakery
  - Unnamed entries are kept with a category-based fallback label (e.g. "Café").
- **Sights** (`kind: "sight"`, corridor `offsetKm <= 3`):
  - `tourism` = viewpoint (kept even when unnamed — labeled "Viewpoint")
  - `natural` = waterfall
  - `historic` ∈ castle, monument, ruins, fort, city_gate, tower
  - `man_made` = lighthouse; `man_made` = tower with `tower:type=observation`
  - `man_made` = bridge — **named bridges only**

**Per-POI record:** `{ name, kind, category, lat, lng, routeDistanceKm (1dp), offsetKm (2dp), openingHours? }`.
`openingHours` = raw OSM `opening_hours` string when present (displayed verbatim, never parsed). `category` is the specific type (bakery, cafe, restaurant, viewpoint, castle, bridge, tower, …) used for chips and fallback labels.

**Processing:** snap each POI with `turf.nearestPointOnLine` (same as towns) → keep those inside the per-kind corridor → **dedupe** near-duplicates (same normalized name within ~100 m, e.g. node + building way) keeping the closest-to-route → sort ascending by `routeDistanceKm` → write `src/data/pois.json`.

**Validation additions:** print per-category counts; fail if the total POI count is 0 (indicates a broken query); route/towns validation unchanged.

Expected volume ~500–1000 POIs, ~100–250 KB JSON.

## 2. Runtime logic

### `src/sorted-range.js` (new, shared)
`lowerBound(arr, km)` / `upperBound(arr, km)` — the binary-search helpers currently private in `towns.js`, extracted verbatim so both modules share them. They operate on arrays sorted by `routeDistanceKm`.

### `src/towns.js` (refactor only)
Imports the helpers from `sorted-range.js`. Behavior and public API unchanged; existing tests must pass unmodified.

### `src/pois.js` (new)
- `poisInRange(pois, startKm, endKm, { kind })` → all POIs of that kind with `routeDistanceKm` ∈ [startKm, endKm] (inclusive), in stored (ascending km) order. Binary search for the range bounds; no mutation of the input.
- `async loadPois()` → dynamic import of `./data/pois.json` (same pattern as `loadTowns`; sole reference to the file).

Note the semantic difference from towns: towns use a *window around the endpoint*; POIs use the *full day range* [start, ghost].

## 3. Itinerary model (`src/itinerary.js`)

- Day records gain `poiPins: []` — an array of pinned POI objects (stored as given by the caller, like `townChoice`).
- New method `togglePoiPin(dayIndex, poi)` — adds the POI to the day's pins, or removes it if already pinned. Pin identity = `name + '@' + routeDistanceKm` (same convention as `townKey`).
- **Persistence:** saved day entries become `{ targetKm, townChoice, poiPins }`. Schema version stays **1** (additive change, tolerant reader): `load()` defaults missing `poiPins` to `[]`, so existing saved plans load unchanged.
- The existing payload-shape contract test is updated to expect the third key; a new test covers pins surviving a save/load round-trip and an old-format payload (no `poiPins`) loading cleanly.
- `getDays()` copies must include pins defensively (mutating the returned array must not affect internal state).

**Pending-day pins:** like the town choice, pins chosen while planning live in `main.js` state (`pendingPoiPins`) and are applied at commit (`addDay` then `togglePoiPin` per pin). Committed day cards *display* pins; editing pins on already-committed days is out of scope for this iteration (workaround: remove last day and recommit).

## 4. UI

### Panel (`src/ui.js`)
Two new sections between the towns list and the itinerary, each collapsible (`<details>` or equivalent):
- **"Food on the way"** — food POIs in the pending stretch.
- **"Worth seeing"** — sight POIs in the pending stretch.

Each row: name (escaped), category chip, `"{kmIntoDay} km into your day (km {routeDistanceKm}) · {offsetKm} km off route"`, `openingHours` line when present, and a pin toggle. Rows are buttons (same event-delegation pattern as towns); clicking toggles the pin and highlights/pans the map to the POI. Pinned rows show a filled pin marker. Lists render fully and scroll; each section header shows its count.

Day cards render pinned POIs as small chips under the town line (icon by kind + name).

### Map (`src/map.js`)
- `setPoiMarkers(pois)` — small dot `divIcon` markers along the pending stretch only, colors distinct from existing markers: **warm orange = food, teal = sights** (existing markers: day pins red, selected-town highlight amber, start/finish green — pick food/sight shades that don't collide with these). Hover tooltip = name; click fires `onPoiClick(poi)` (same toggle path as list rows).
- Refreshed with the ghost (inside the existing debounced render); marker churn is acceptable at expected counts.
- **Density cap:** if a stretch contains more than 40 POIs of a kind, the map renders the 40 nearest-to-route; the panel list always stays complete.

### Wiring (`src/main.js`)
`renderPending()` additionally slices `poisInRange(pois, pendingStartKm, ghostKm, {kind})` for both kinds and drives the two panel sections + `setPoiMarkers`. Commit applies pending pins; all mutations still funnel through the single render path + `save()`.

## Error handling

- Missing/empty `pois.json` → app still boots; POI sections show "No data — run npm run build:data" (loadPois failure caught in main.js boot alongside existing data loading).
- POIs with malformed fields are dropped at build time, not runtime.

## Testing

- **Unit (vitest):** `sorted-range.js` bounds; `pois.js` range inclusivity/edges/kind filter/no-mutation; `itinerary.js` pin toggle (add/remove), persistence round-trip with pins, old-payload compatibility, updated contract test. Existing 48 tests must stay green (towns refactor is behavior-neutral).
- **Pipeline:** `npm run build:data` prints per-category counts; spot-check known POIs (e.g. a Dresden Elbe bridge, a viewpoint in the Sächsische Weinstraße area near Meißen).
- **Browser (Playwright):** at Day 1 / 80 km from Hamburg: both sections populate; pin a food POI + a sight, commit, chips appear on the day card; reload → pins persist; slider move refreshes markers; no console errors.

## Out of scope (explicitly)

Whole-route sight browsing/layer toggles; time-of-day break planning; opening-hours parsing; pin editing on committed days; museums/attractions category; elevation, GPX export (unrelated).
