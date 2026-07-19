# Elberadweg Day Planner

A small, personal trip-planning tool for riding the **Elberadweg** (Elbe Cycle
Route) from **Hamburg to Dresden**. Instead of guessing where you'll end up each
evening, you set a daily riding distance and the planner measures that distance
*along the official route* and shows you which towns sit near the day's endpoint
— so you can pick a realistic overnight stop, one day at a time.

- Drag the slider (or type a distance, or click a point on the map) to set the
  next day's target. A pulsing ghost marker shows where you'd end up.
- Pick an overnight town from the nearby list; commit the day to lock it in.
- Committed days stack up as numbered pins on the map and cards in the panel,
  with a progress bar tracking how far along the ~650 km route you've planned.
- Everything is saved to `localStorage`, so your plan is still there next visit.

![Screenshot of the Elberadweg Day Planner — map on the left, planning panel on the right](docs/screenshot.png)

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

The map (left) is the hero: OpenStreetMap tiles with the Elberadweg drawn as a
blue line, a green **H** pin at the Hamburg start, red numbered pins for each
committed day, amber dots for candidate towns, and a pulsing blue ghost marker
for the pending day's endpoint. The panel (right) is the planning companion.

The route and towns are **generated from OpenStreetMap**, not hand-drawn:

- The route follows the **right bank** (_rechtselbisch_) of the Elberadweg — the
  OSM superroute is split into consecutive stage relations, and the build script
  stitches the relevant Hamburg→Dresden stages into one ordered line, trims it to
  the Hamburg and Dresden anchors, simplifies, and validates it (length +
  north→south monotonicity). The stitched route measures **~650 km**.
- Towns are OSM `place=city|town|village` nodes within ~5 km of the route, each
  annotated with its distance *along* the route so the app can window them to the
  stretch you're planning.

Distance-along-route maths (snapping a click to the line, finding the point at a
given kilometre, windowing towns) is done with [Turf.js](https://turfjs.org/).

## Rebuilding the data

The generated data lives in `src/data/` (`route.json`, `route.meta.json`,
`towns.json`) and is already committed. To regenerate it from OpenStreetMap:

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
