# Elberadweg Day Planner

A trip-planning tool for riding the **Elberadweg** (Elbe Cycle Route) over several
days. The road runs **Cuxhaven to Prague**, ~1027 km, and your trip is however much
of it you plan. The whole thing is one timeline strip along the bottom of the
window, drawn to scale in kilometres: each day is a block, and the line between two
blocks is where you sleep. You shape the trip by dragging those lines, and the
planner measures every distance *along the official route*, so it can tell you
which towns sit near the end of a day.

- **Add a day, then drag its boundary.** `+ add a day` appends another day as long
  as your last one — 80 km only when there is no last one to copy — and clicking
  the dashed remainder appends a day ending exactly where you clicked. Dragging the
  handle at a day's end, or its numbered pin on the map, moves where that day
  finishes. The strip always shows the whole route, so the trip can never scroll
  out of sight.
- **Editing one day resizes its neighbour, never the whole trip.** Give day 3 an
  extra 10 km and day 4 gives up 10; days 1–2 and everything past day 4 stay
  exactly where they were, along with the towns you already chose for them. Days
  stop 5 km short of each other, so a boundary can't swallow its neighbour.
- **Overnight towns snap the boundary.** Pick a town from the left panel and the
  day ends *at that town's kilometre* — the neighbour absorbs the difference. If
  the town is too close to the next day's end to reach exactly, the panel says so
  rather than quietly disagreeing with itself.
- **Split and delete.** Split a day in two at its midpoint, or delete one and it
  merges into the day after it — again without moving the rest of the trip.
- **The focused day gets its own panel.** Click a block (or step with `‹ ›`) and
  the right panel shows that one day: its length as a number you can type into,
  its overnight town, and its legs. One day at a time, so the panel can never
  outgrow the window the way a scrolling itinerary did.
- **Keyboard throughout.** Tab to any boundary handle — they are real sliders — and
  `→`/`←` nudge it 1 km, `Shift` 5 km. Every control in the day panel keeps its
  focus across the re-render it triggers.
- **The map follows the focused day**, drawing that stretch thick over the rest of
  the route, with the numbered day pins draggable. Pan or zoom yourself and the
  map stays where you put it; `⤢ this day` and `⤢ whole route` take it back.
- **Multiple named plans:** keep an "8 days sporty" and a "10 days relaxed" side
  by side — create, rename, duplicate, reset or delete plans from the bar in the
  app header. **Reset trip** empties the plan you are in; **Delete plan** removes
  the plan itself. Each plan carries its own days and breaks; the list itself is
  your history (no separate undo).
- **Breaks as day legs:** hit **☕** on any town, food stop, or sight to commit it
  as a break, or click the route on the map to add a custom stop with your own
  label. The focused day then reads as legs — "35 km → ☕ Café · 45 km → 🛏 Lenzen"
  — and moving a boundary re-buckets breaks between days automatically.
- **Day-relative distances:** distances read from your last overnight stop
  ("45 km from Boizenburg/Elbe"), with the absolute route km shown alongside — so
  you see how far you'll actually ride that day, not raw kilometre marks.
- **Food on the way & Worth seeing:** the left panel lists cafés, bakeries and
  restaurants (with opening hours where OSM knows them) plus viewpoints, castles
  and notable bridges along the day you're focused on. Hovering a row lights up
  its dot on the map, and hovering a dot lights up its row.
- **Favorites:** star **⭐** any place to a global save-for-later list, shared
  across every plan. It sits at the top of the left panel, drops a gold pin on
  the map, and tags which planned day (if any) currently covers it.
- Everything — plans, breaks, and favorites — is saved to `localStorage`, so your
  work is still there next visit. A boundary drag writes once, on release.

![Screenshot of the Elberadweg Day Planner — the timeline strip along the bottom, the map in the centre, places along the focused day on the left, and that day's panel on the right](docs/screenshot.png)

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

Four regions, and each answers one question:

- The **strip** along the bottom is the trip: every day to scale, the unplanned
  remainder dashed out to the destination, and a handle at every boundary. It is the only
  view of the whole route, and it is always visible.
- The **map** (centre) is where the trip actually is: OpenStreetMap tiles with the
  whole Elberadweg as a thin dashed line in light blue, and the focused day's
  stretch drawn over it heavy and in a deeper blue — so the day you are working on
  reads as the day at any zoom. Plus a green start pin at km 0, red numbered pins at
  each day's end (drag them), ☕ and 📌 pins for breaks, and gold ⭐ for favorites.
- The **right panel** is the focused day: its distance, its overnight town, its
  legs, and Split / Delete. The plans bar sits above it in the app header.
- The **left panel** is what you can choose from along that day: your favorites,
  the overnight candidates, the food stops and the sights.

Everything is keyed on which day is focused — there are no modes. A click on the
route adds a stop to the focused day; the left panel windows itself to that day's
stretch; the map frames it. Clicking a different block moves all of that at once.

The route and towns are **generated**, not hand-drawn:

- The route is assembled from **three sources**, because none of them spans the
  corridor. Both German banks come from **elberadweg.de's official GPX** — the 15
  lettered sections A–O, published once per side: the **left bank** (_links_) runs
  Cuxhaven → the Czech border in 827 km, the **right bank** (_rechts_) Brunsbüttel →
  the border in 799 km. Past the border there are no official bank variants, so
  **EuroVelo 7**'s Czech part comes from OSM and carries the Elbe and the Vltava in
  one relation, leaving no junction to invent at Mělník.

  The canonical line — the km axis every stored distance refers to — is the left bank
  down to the Hamburg hand-over, the right bank onward to the border, then the Czech
  line to Prague. It takes the LEFT bank out of Cuxhaven because the official right
  bank simply does not run there.

  Each source is stitched, trimmed, simplified and rounded, then the three are joined
  across two **declared joins**: the Hamburg bank change at the Landungsbrücken
  (15 m — both official banks share that promenade, so this seam is a shared path
  rather than water) and Schmilka–Hřensko (3.26 km, real water). Naming them means an
  unexpected distance fails the build instead of hiding among warnings. The trim
  points are *derived* from where the lines actually come closest, not from guessed
  coordinates — but the Hamburg one is derived inside a declared neighbourhood,
  because two banks running 800 km in parallel touch in 33 places and an
  unconstrained search picks whichever one it likes.

  The build validates length, nine strictly-increasing monotonicity checkpoints,
  anchor snap offsets, join lengths, the straight-line bridging that survives inside
  segments, and how much of the route doubles back on itself. It measures
  **1000.4 km** — Hamburg at km 138.7, Dresden at km 772.4, Prague at the end. That
  is 26 km shorter than the OSM composite it replaced, most of it doubling-back that
  the official routing does not have: 1.2 km of the route retraces itself, against
  11.8 km before.
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
