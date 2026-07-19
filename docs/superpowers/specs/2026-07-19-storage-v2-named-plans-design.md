# Storage v2 + Named Plans — Design Spec (Sub-project 1 of 3)

**Date:** 2026-07-19
**Status:** Approved by Michel (design conversation, this date)
**Series:** 1) storage v2 + named plans ← this spec · 2) breaks + day-relative distances · 3) favorites

## Motivation

Michel wants to save multiple named plans ("8 days sporty", "10 days relaxed"), see the list, open/edit/duplicate/delete them. This requires lifting persistence out of `itinerary.js` into a dedicated storage layer with a multi-plan schema — which also lays the foundation the breaks (plan-level waypoints) and favorites (global store) sub-projects need.

## Decisions (from brainstorming)

- **Named plans you switch between.** The plans list IS the history. No automatic snapshots, no undo (out of scope).
- **Unified model (Approach A):** the existing per-day `poiPins` concept is retired. During migration, pins become **favorites** (a global store consumed by sub-project 3).
- Favorites data is written by migration now; its UI arrives in sub-project 3. Between the two, pin chips disappear from day cards — accepted.

## 1. New module: `src/storage.js`

`createPlanStore({ storage, routeVersion })` — `storage` injected like itinerary's used to be (localStorage in the browser, fake in tests). All reads/writes guarded try/catch; a corrupted v2 blob → start fresh with one empty plan (do not throw).

**Persisted shape** under key `elberadweg-plans`:
```json
{
  "schemaVersion": 2,
  "activePlanId": "<id>",
  "plans": [{
    "id": "<uuid>", "name": "My plan",
    "createdAt": "<ISO>", "updatedAt": "<ISO>",
    "routeVersion": "<meta.builtAt at save time>",
    "days": [{ "targetKm": 80, "townChoice": null }],
    "breaks": []
  }]
}
```
`days` stores only `targetKm` + `townChoice` (startKm/endKm derived, as today). `breaks` exists in the schema now (always `[]` until sub-project 2). IDs via `crypto.randomUUID()` (fallback: `Date.now()+random` string).

**API** (all persist immediately):
- `load()` → hydrates from storage (running migration if needed); returns `{ plans: [{id,name,createdAt,updatedAt}], activePlanId }`.
- `getActivePlan()` → full active plan record (or null before load).
- `setActivePlan(id)`, `renamePlan(id, name)`, `deletePlan(id)`, `createPlan(name?)` → new empty plan (auto-named "Plan N"), `duplicatePlan(id, name?)` → deep copy, name defaults to "<original> (copy)". `createPlan`/`duplicatePlan` activate the new plan and return it.
- `saveActivePlan({ days, breaks })` → updates the active plan's payload + `updatedAt` + `routeVersion` (current).
- `deletePlan` on the active plan → activate the most-recently-updated remaining plan; deleting the last plan → create a fresh empty "My plan". Deleting requires nothing else (UI confirms).

**Migration v1 → v2** (runs inside `load()` when the v2 key is absent and legacy key `elberadweg-itinerary` holds a valid schemaVersion-1 payload):
- Wrap its days (targetKm/townChoice only) as one plan named **"My plan"**; `routeVersion` carried over; `breaks: []`.
- Collect every day's `poiPins`, dedupe by `${kind}:${name}@${routeDistanceKm}`, and write them to key `elberadweg-favorites` as `{ schemaVersion: 1, favorites: [...] }` (only if that key is empty/absent).
- The v1 key is left in place untouched (backup); it is ignored once the v2 key exists.

## 2. `src/itinerary.js` slims down to pure trip math

- Remove: `save`, `load`, `storage`/`routeVersion` options, `togglePoiPin`, `poiPins` on day records, `poiPinKey`.
- Add: `hydrate(dayEntries)` — replaces current days by replaying `[{targetKm, townChoice}]` through the existing chain/clamp logic (same replay path `load()` used); invalid entries → hydrate to empty (no throw).
- Everything else (addDay/editDay/setTownChoice/removeLastDay/reset/totalPlannedKm/getDays) unchanged.
- Tests updated accordingly: persistence tests move to `storage.test.js`; pin tests removed; hydrate tests added (replay, clamp vs current totalKm, malformed → empty).

## 3. `src/main.js` wiring

- Boot: `createPlanStore({storage: localStorage, routeVersion: meta.builtAt})`, `store.load()`, `itinerary.hydrate(activePlan.days)`.
- `routeChanged` banner: shown when `activePlan.routeVersion !== meta.builtAt` (per plan, on load and on plan switch).
- After every itinerary mutation (commit/edit/remove/reset/town choice): `store.saveActivePlan({ days: itinerary.getDays().map(d => ({targetKm: d.targetKm, townChoice: d.townChoice})), breaks: activeBreaks })` (activeBreaks = `[]` until sub-project 2).
- Plan switching: `setActivePlan` → re-hydrate itinerary → reset pending state (target 80, no town) → full re-render.
- Pin UI removal: `pendingPoiPins`, `handleTogglePoi`'s pin semantics, and day-card pin chips go away. POI row click reverts to highlight/pan only (its break/star buttons arrive in sub-projects 2/3). POI marker click: pan/highlight only.

## 4. Plans bar UI (`src/ui.js` + `index.html` + `style.css`)

New `#plans` container in the right panel between the header and `#banner`:
- A `<select>` listing plans by name (active selected) — change fires `onSelectPlan(id)`.
- A text input with the active plan's name — change fires `onRenamePlan(name)` (empty input → revert, no callback).
- Buttons: **New**, **Duplicate**, **Delete** (Delete wrapped in `confirm()`; label the dialog with the plan name).
- `renderPlans({ plans: [{id, name}], activePlanId })` re-renders the bar; same event-delegation and design language as existing sections.

## Error handling

- Storage quota/denied: `saveActivePlan` best-effort (try/catch swallow) — same policy as today.
- Corrupted plans blob or wrong schemaVersion: start fresh (one empty plan), no crash.
- `setActivePlan`/`renamePlan`/`deletePlan`/`duplicatePlan` with unknown id: no-op returning null (UI can't normally produce this).

## Testing

- **storage.test.js (new):** v1→v2 migration (days carried, pins→favorites written once, v1 key untouched, no double-migration), plans CRUD, duplicate deep-copies (mutating copy doesn't affect original), delete-active switches to most-recently-updated, delete-last creates fresh plan, corrupted JSON → fresh store, quota-throwing storage doesn't crash saves, activePlanId persisted across load().
- **itinerary.test.js:** hydrate replay/clamp/malformed; removed save/load/pin tests.
- **Browser (Playwright):** commit 2 days → create second plan → both plans in dropdown, switching swaps itinerary; duplicate + edit copy leaves original intact; delete active plan falls back gracefully; reload restores active plan; legacy-v1 seeded localStorage migrates to "My plan".

## Out of scope

Automatic snapshots/undo; plan export/import; breaks behavior (sub-project 2); favorites UI (sub-project 3).
