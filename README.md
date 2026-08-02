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
- The **other bank** is `route.alt.json`: the left bank from the first crossing to
  the last, with its own km axis. It exists only where crossings bound it — nothing
  north of Hamburg (see below) and nothing in Czechia.
- **Crossings** are derived, not hand-kept: OSM bridges that admit bicycles, plus
  ferries, keeping only those with one end within 250 m of one bank and the other
  end within 250 m of the other. **33** survive, 14 ferries and 19 bridges. The
  geometric test is the whole filter and it has to be strict — the banks touch in 33
  places, and where they do, a 6 m ditch bridge technically "connects" them, so a
  crossing must also span at least 80 m of water.
- Towns are OSM `place=city|town|village` nodes within ~5 km of the route, each
  annotated with its distance *along* the route so the app can window them to the
  stretch you're planning. Every place is located against **both** lines and tagged
  with the bank it is on (`left`, `right`, `both`, or `null` in Czechia); a place
  reachable only from the far bank keys its canonical km through the crossing table,
  so day assignment still runs on the one stored axis.
- Food stops (cafés, bakeries, restaurants, biergartens — within ~2 km) and
  sights (viewpoints, castles, historic sites, named bridges — within ~3 km) are
  pulled the same way and precomputed into `pois.json`.

### Riding the other bank

Crossing the river is a **day-planning action**, peer to ending the day: open a day
and its panel lists the crossings that day passes, each with a **⇄ Cross** button.
Press one and it becomes a leg of the day — "18.2 km → ⇄ Cross to the other bank ·
Sternbrücke" — and the rest of the day continues on the far side. ✕ takes it back.
The map's ⇄ markers are a shortcut for the same thing, and the strip's ribbon shows
which bank each stretch rides.

Distances stay honest: the two banks are not the same length, so the km you read are
the km on the bank you actually ride, the crossing itself included. Choosing the
Magdeburg Sternbrücke on a Hamburg → Dresden trip shortens it from 633 to 617.7 km,
and the days after it re-flow to match.

Only the crossings you chose are stored (as ids). Where the alt bank ends, the path
rejoins the canonical bank on its own — the rider never chose that, so it is drawn
and ridden but never saved as a decision.

**Not covered:** the stretch north of Hamburg. There *is* a second bank there — the
right bank from Brunsbüttel, with real crossings like the Glückstadt–Wischhafen
ferry — but north of Hamburg the canonical line already *is* the left bank, and one
alt file tagged `left` cannot also be the right bank. The empty northern stretch is
a consequence of the one-alt-line model, not a derivation bug.

Distance-along-route maths (snapping a click to the line, finding the point at a
given kilometre, windowing towns) is done with [Turf.js](https://turfjs.org/).

## Rebuilding the data

The generated data lives in `src/data/` and is already committed:

| File | What it holds |
| --- | --- |
| `route.json` | the canonical line — the km axis every stored distance refers to |
| `route.alt.json` | the other bank, between the outermost crossings, with its own km axis |
| `crossings.json` | the 33 derived crossings, each with its km on **both** axes |
| `route.meta.json` | route id, length, the segments and their banks, the declared joins |
| `towns.json`, `pois.json` | places along either bank, each tagged with its bank |
| `elevation.json` | the canonical profile, keyed by route id |

To regenerate:

```bash
npm run build:data            # uses cached raw sources if present
npm run build:data -- --refresh   # force a fresh fetch
npm run build:elevation       # after any change to the line itself
```

`scripts/build-data.mjs` downloads the 30 official GPX files and queries the
[Overpass API](https://overpass-api.de/) (with retries, backoff, and mirror
fallback, since Overpass is flaky), caching both so repeat runs are fast and
offline-friendly. The GPX cache (`src/data/gpx.raw/`) and the route cache
(`src/data/route.raw.osm.json`) are gitignored; Overpass responses live in your OS
temp directory, keyed by bounding box. `--refresh` bypasses all of them.

Changing the line changes the km axis, so `route.meta.json`'s `routeId` is part of
the data's identity: when it changes, saved plans are archived and reset rather than
being silently reinterpreted against a different road. `elevation.json` carries the
same id and is rejected if it does not match — rebuild it whenever the line moves.

## Tech

- [Vite](https://vitejs.dev/) — dev server and build
- [Leaflet](https://leafletjs.com/) — map rendering (canvas renderer)
- [Turf.js](https://turfjs.org/) — geospatial maths along the route
- [Vitest](https://vitest.dev/) — unit tests
- Vanilla JavaScript, no UI framework

## Data & attribution

- **Both German bank routes** come from the official
  [elberadweg.de GPX downloads](https://www.elberadweg.de/planen-buchen/interaktive-karte-gps/).
  The site states no licence terms on that page, so treat the derived route data as
  theirs and ask before redistributing it — if that becomes a problem, the same
  banks can be rebuilt from OSM, which is where every other layer already comes from.
- **Czech route, town, crossing and POI data** © [OpenStreetMap](https://www.openstreetmap.org/)
  contributors, available under the
  [Open Database License (ODbL)](https://www.openstreetmap.org/copyright).
- **Map tiles** are served by openstreetmap.org and are used under the
  [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

This is a personal, local-use planning tool. If you deploy or distribute it,
please respect the OSM tile usage policy (it is not for heavy or commercial
traffic) — consider a dedicated tile provider — and keep the attribution above.
