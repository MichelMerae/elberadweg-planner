# Favorites Implementation Plan (Sub-project 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Read the spec first:** `docs/superpowers/specs/2026-07-19-favorites-design.md` (authority on requirements). Requires sub-projects 1+2 merged (migration already writes the favorites key; row-action button pattern exists).

**Goal:** Global ⭐ favorites: star any town/food/sight, a Favorites section in the left panel with day tags, gold star map markers, shared across plans.

**Architecture:** New `src/favorites.js` store (own key, injected storage); `ui.js` adds ⭐ row buttons + the Favorites `<details>` section; `map.js` adds always-visible favorite markers; `main.js` wires toggle/render.

**Sequencing:** Task 1 (store) first; Task 2 (integration) after.

---

### Task 1: `src/favorites.js` + tests

**Files:** Create `src/favorites.js`, `src/favorites.test.js` only.

- [ ] **Step 1: TDD tests first** with a fake storage: toggle adds then removes (round-trip through a second instance on the same storage — persist verified); `favKey` kind-prefixing distinguishes `{kind:'town', name:'X', routeDistanceKm:50}` from `{kind:'food', name:'X', routeDistanceKm:50}`; `list()` sorted ascending by routeDistanceKm + defensive copy; `has(key)`; corrupted JSON → empty list no throw; wrong schemaVersion → empty; missing storage → in-memory no-crash; loads a blob in exactly the migration-written shape (`{schemaVersion:1, favorites:[{kind:'food', name:'Café X', routeDistanceKm:42, offsetKm:0.2, lat:53, lng:10}]}`); setItem throwing → toggle still updates memory.

- [ ] **Step 2: Implement:**

```js
const FAVORITES_KEY = 'elberadweg-favorites';
const SCHEMA_VERSION = 1;

export function favKey(place) {
  return place ? `${place.kind}:${place.name}@${place.routeDistanceKm}` : null;
}

export function createFavorites({ storage } = {}) {
  let favorites = load();
  function load() { /* guarded parse of FAVORITES_KEY; wrong schema/corrupt/missing/no storage -> [] ; drop entries without kind/name/numeric routeDistanceKm/lat/lng */ }
  function persist() { /* try { storage?.setItem(FAVORITES_KEY, JSON.stringify({schemaVersion: SCHEMA_VERSION, favorites})) } catch {} */ }
  function list() { return favorites.map((f) => ({ ...f })).sort((a, b) => a.routeDistanceKm - b.routeDistanceKm); }
  function has(key) { return favorites.some((f) => favKey(f) === key); }
  function toggle(place) {
    const key = favKey(place);
    if (has(key)) favorites = favorites.filter((f) => favKey(f) !== key);
    else favorites.push({ ...place });
    persist();
    return has(key);
  }
  return { list, has, toggle };
}
```

- [ ] **Step 3:** `npx vitest run src/favorites.test.js` → green.

### Task 2: Integration — stars, Favorites section, gold markers, README

**Files:** Modify `src/main.js`, `src/ui.js`, `src/map.js`, `src/style.css`, `README.md`.

- [ ] **Step 1: ui.js** —
  - Every town/food/sight row gains `<button class="row-action row-action--fav" data-action="fav" title="Favorite">⭐</button>` next to ☕ (same delegated pattern; active/filled class when key ∈ passed `favoriteKeys` Set). New callback `onToggleFavorite(place)`.
  - New `renderFavorites({ favorites, days })` into a `<div id="favorites">` container placed at the TOP of the left panel (index.html: inside `#panel-left`, right after `#panel-left-header`): `<details open>` titled `⭐ Favorites (N)`; rows show kind glyph (🛏/🍴/📷), esc(name), category chip (underscores → spaces), `km ${routeDistanceKm}`, day tag `Day N` (first committed day where `startKm < km <= endKm`) or `beyond plan`; row-body click → `onSelectFavorite(place)`; each row keeps ☕ (`onToggleBreak`) and filled ⭐ (`onToggleFavorite` = unfavorite). Empty state per spec.
  - Escape ALL interpolated place data (existing `esc()`).
- [ ] **Step 2: map.js** — `setFavoriteMarkers(favorites)`: own layerGroup, divIcon class `fav-marker` (gold ⭐, ~14px, subtle white halo), tooltip name, click → highlight/pan callback, always visible (no cap, whole route). Export in API.
- [ ] **Step 3: main.js** — `const favorites = createFavorites({storage: window.localStorage})`; pass `favoriteKeys` (Set of favKey) into towns/pois/favorites renders; `handleToggleFavorite(place)` → snapshot (`{...place, kind: place.kind ?? 'town'}`) → `favorites.toggle` → re-render lists + `map.setFavoriteMarkers(favorites.list())`; `onSelectFavorite` → pan/highlight. Render favorites section + markers at boot and after plan switches (day tags depend on active plan's days; the LIST never changes with plans).
- [ ] **Step 4: style.css** — fav row-action active state (gold), fav marker, favorites section (matches pois sections), day-tag chip.
- [ ] **Step 5: README** — document the full series in one pass: plans bar (save/duplicate/switch named plans), breaks as day legs, day-relative distances, favorites. Update the features bullet list and How-it-works accordingly.
- [ ] **Step 6: Verify.** `npx vitest run` + `npm run build` green. Playwright: star a town + a sight → Favorites section rows with correct day tags, gold stars on map; unstar from section removes everywhere; stars persist across reload AND across plan switch (day tags update, list identical); ☕ on a favorite row commits a break; origin rows show filled star; migration-seeded favorites (from SP1's key) appear on first load; zero console errors; clear localStorage; stop server.

### Final: coordinator commits and pushes. Update project memory (breaks/plans/favorites shipped).

## Self-review notes (done)
- Spec coverage: §1→Task 1; §2–§5→Task 2 steps 1–3; post-series cleanup→step 5. Error handling embedded in Task 1.
- Consistency: `favKey` kind-prefixed everywhere; favorites section id `#favorites` used in both index.html placement and renderFavorites; day-tag boundary `(startKm, endKm]` matches breaks convention.
- No placeholders: store fully shown; UI steps name exact classes/attrs/callbacks and reuse the SP2 row-action pattern.
