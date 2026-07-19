# Favorites — Design Spec (Sub-project 3 of 3)

**Date:** 2026-07-19
**Status:** Approved by Michel (design conversation, this date)
**Series:** 1) storage v2 + named plans · 2) breaks + day-relative distances · 3) favorites ← this spec
**Depends on:** sub-project 1 (migration already writes pins→`elberadweg-favorites`); sub-project 2 (row-action button pattern).

## Motivation

Michel wants to star places to a save-for-later list — separate from committing. The plan holds places he committed to (overnight towns, breaks); favorites hold places he just wants to keep in view.

## Decisions (from brainstorming)

- **Star any place** — towns, food stops, sights all get a ⭐ toggle.
- **One global list shared across plans** (a nice castle is nice in every plan), persisted independently of plans.
- Favorites never enter a plan by themselves — committing (overnight/break) stays explicit.

## 1. New module: `src/favorites.js`

`createFavorites({ storage })` — injected storage, guarded try/catch like the plans store.

- Persisted under key `elberadweg-favorites`: `{ schemaVersion: 1, favorites: [place...] }` — the exact key/shape sub-project 1's migration already writes (pins from the old schema appear here automatically).
- Place record: `{ kind: 'town'|'food'|'sight', name, category?, lat, lng, routeDistanceKm, offsetKm, openingHours? }` — a snapshot of the row's data (favorites survive data rebuilds; they don't re-resolve against pois.json).
- `favKey(place)` = `${kind}:${name}@${routeDistanceKm}` (kind-prefixed — a town and a café can share name+km).
- API: `list()` → sorted ascending by `routeDistanceKm`, defensive copy; `has(key)`; `toggle(place)` → adds or removes, persists immediately, returns new state (boolean).
- Corrupted/missing blob → empty list, no throw; saves best-effort.

## 2. Row stars (`src/ui.js`)

- Every town/food/sight row gets a **⭐** button (`data-action="fav"`) next to the ☕ break button — filled/active when `favKey(place)` is in the passed `favoriteKeys` set; fires `onToggleFavorite(place)` (main.js snapshots kind for towns, same as breaks).
- `renderTowns`/`renderPois` accept `favoriteKeys` (Set) to mark active stars.

## 3. Favorites section (left panel)

- New collapsible `<details open>` **"⭐ Favorites (N)"** at the TOP of the left panel (above "Food on the way") — it's short and user-curated.
- `renderFavorites({ favorites, days })`: each row shows kind glyph (🛏 towns / 🍴 food / 📷 sights), name, category chip, absolute `km X`, and a **day tag**: "Day N" when a committed day's `[startKm, endKm]` covers its km, else "beyond plan".
- Row-body click → `onSelectFavorite(place)` → map pan + highlight. Each row also has the ☕ break button (commit it as a break from here) and a filled ⭐ (click = unfavorite, removing it from the list).
- Empty state: "Nothing starred yet — hit ⭐ on any place."

## 4. Map (`src/map.js`)

- `setFavoriteMarkers(favorites)` — small gold-star divIcon for EVERY favorite, always visible across the whole route (favorites are few and user-curated; no density cap), tooltip = name, click → pan/highlight. Distinct from day pins / break pins / POI dots.
- Rendered on boot and after every favorites change.

## 5. Wiring (`src/main.js`)

- Boot: `createFavorites({storage: localStorage})`; render favorites section + markers.
- `onToggleFavorite` → `favorites.toggle(place)` → re-render favorites section, stars in all lists, and markers.
- Favorites are global: plan switches re-render day tags in the favorites section but never change the list.

## Error handling

Same policies as the other stores: never throw on load, best-effort save, malformed entries dropped on read.

## Testing

- **favorites.test.js:** toggle add/remove round-trip; kind-prefixed key distinguishes town vs café with same name+km; sorted list; defensive copy; corrupted blob → empty; persists via fake storage; migration-written blob (from sub-project 1's shape) loads as-is.
- **Browser (Playwright):** star a town + a sight → both in Favorites section with correct day tags + gold stars on map; unstar from the section; star survives reload AND plan switch; ☕ from a favorite row commits a break; stars show filled state in the origin lists.

## Out of scope

Hover-linking favorites rows to markers (existing POI hover covers the stretch lists); notes/comments on favorites; import/export.

## Post-series cleanup (part of this sub-project)

- README: document plans bar, breaks/legs, day-relative distances, favorites.
- Update the day-card screenshot reference if present.
