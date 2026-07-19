# Elberadweg Day Planner

A small, personal trip-planning tool for riding the **Elberadweg** (Elbe Cycle
Route) from **Hamburg to Dresden**. Instead of guessing where you'll end up each
evening, you set a daily riding distance and the planner measures that distance
*along the official route* and shows you which towns sit near the day's endpoint
— so you can pick a realistic overnight stop, one day at a time.

- Drag the slider (or type a distance, or click a point on the map) to set the
  next day's target. A pulsing ghost marker shows where you'd end up.
- Pick an overnight town from the nearby list, then commit the day to lock it in.
- **Multiple named plans:** keep an "8 days sporty" and a "10 days relaxed" side
  by side — create, rename, duplicate, switch, or delete plans from the bar at
  the top of the right panel. Each plan carries its own days and breaks; the list
  itself is your history (no separate undo).
- **Breaks as day legs:** hit **☕** on any town, food stop, or sight to commit it
  as a break. Day cards then read as legs — "35 km → ☕ Café · 45 km → 🛏 Lenzen"
  — and editing a day's distance re-buckets its breaks between days automatically.
- **Day-relative distances:** distances read from your last overnight stop
  ("45 km from Boizenburg/Elbe"), with the absolute route km shown alongside — so
  you see how far you'll actually ride that day, not raw kilometre marks.
- **Food on the way & Worth seeing:** the left panel lists cafés, bakeries and
  restaurants (with opening hours where OSM knows them) plus viewpoints, castles
  and notable bridges along the day you're planning.
- **Favorites:** star **⭐** any place to a global save-for-later list, shared
  across every plan. It sits at the top of the left panel, drops a gold pin on
  the map, and tags which planned day (if any) currently covers it.
- Committed days stack up as numbered pins on the map and cards in the panel,
  with a progress bar tracking how far along the ~650 km route you've planned.
- Everything — plans, breaks, and favorites — is saved to `localStorage`, so your
  work is still there next visit.

![Screenshot of the Elberadweg Day Planner — map in the centre, favorites and places along the day on the left, plans and itinerary on the right](docs/screenshot.png)

_Screenshot placeholder — drop a `docs/screenshot.png` here._

## Quick start

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default http://localhost:5173). The route and town
data are committed to the repo, so no data build is needed to run the app.

Other scripts:

```bash
npm run build      # production build to dist/
npm run preview    # serve the production build
npm test           # run the unit tests (Vitest)
```

## How it works

The map (centre) is the hero: OpenStreetMap tiles with the Elberadweg drawn as a
blue line, a green **H** pin at the Hamburg start, red numbered pins for each
committed day, amber dots for candidate towns, ☕ pins for committed breaks, gold
⭐ pins for favorites, and a pulsing blue ghost marker for the pending day's
endpoint. The two side panels are the planning companions: the **right** panel
holds the plans bar, the day controls, overnight options and the itinerary; the
**left** panel holds your favorites and the food stops and sights along the day
you're planning.

The route and towns are **generated from OpenStreetMap**, not hand-drawn:

- The route follows the **right bank** (_rechtselbisch_) of the Elberadweg — the
  OSM superroute is split into consecutive stage relations, and the build script
  stitches the relevant Hamburg→Dresden stages into one ordered line, trims it to
  the Hamburg and Dresden anchors, simplifies, and validates it (length +
  north→south monotonicity). The stitched route measures **~650 km**.
- Towns are OSM `place=city|town|village` nodes within ~5 km of the route, each
  annotated with its distance *along* the route so the app can window them to the
  stretch you're planning.
- Food stops (cafés, bakeries, restaurants, biergartens — within ~2 km) and
  sights (viewpoints, castles, historic sites, named bridges — within ~3 km) are
  pulled the same way and precomputed into `pois.json`.

Distance-along-route maths (snapping a click to the line, finding the point at a
given kilometre, windowing towns) is done with [Turf.js](https://turfjs.org/).

## Rebuilding the data

The generated data lives in `src/data/` (`route.json`, `route.meta.json`,
`towns.json`, `pois.json`) and is already committed. To regenerate it from OpenStreetMap:

```bash
npm run build:data            # uses cached raw OSM if present
npm run build:data -- --refresh   # force a fresh fetch from Overpass
```

`scripts/build-data.mjs` queries the [Overpass API](https://overpass-api.de/)
(with retries, backoff, and mirror fallback, since Overpass is flaky) and caches
the raw response so repeat runs are fast and offline-friendly. The route cache
(`src/data/route.raw.osm.json`) is gitignored; the towns cache lives in your OS
temp directory. Use `--refresh` to bypass both caches and pull current OSM data.

## Tech

- [Vite](https://vitejs.dev/) — dev server and build
- [Leaflet](https://leafletjs.com/) — map rendering (canvas renderer)
- [Turf.js](https://turfjs.org/) — geospatial maths along the route
- [Vitest](https://vitest.dev/) — unit tests
- Vanilla JavaScript, no UI framework

## Data & attribution

- **Route and town data** © [OpenStreetMap](https://www.openstreetmap.org/)
  contributors, available under the
  [Open Database License (ODbL)](https://www.openstreetmap.org/copyright).
- **Map tiles** are served by openstreetmap.org and are used under the
  [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

This is a personal, local-use planning tool. If you deploy or distribute it,
please respect the OSM tile usage policy (it is not for heavy or commercial
traffic) — consider a dedicated tile provider — and keep the attribution above.
