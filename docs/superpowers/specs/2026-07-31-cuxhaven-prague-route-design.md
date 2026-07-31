# Cuxhaven → Prague: the whole road as one dataset

**Date:** 2026-07-31
**Status:** approved in brainstorming, not yet planned
**First of three specs.** This one replaces the route data. Then: *selectable start and destination* (the trip becomes a window on the road, storage v3). Then: *elevation profile in the strip*.

## Product context

The app's goal is to be **the best planner for anyone riding the Elberadweg over several days** — not a planner for one particular Hamburg → Dresden trip. Every decision below is weighed that way: arbitrary start and finish, honest distances, and a road longer than any single trip. The plan currently in local storage is throwaway test data and is not a constraint.

## Problem

`route.json` is Hamburg → Dresden, 650.24 km, right bank only. Two things follow from that:

- **The road stops short at both ends.** Users aiming past Dresden — Bad Schandau, Děčín, Prague — have no data at all, and nothing exists north of Hamburg either, so a start point can never be anywhere but km 0.
- **Both endpoints are hardcoded as strings.** `index.html:27`, `map.js:397`, `main.js:284`, `strip-markup.js:129`/`172`/`191`/`192` and `itinerary.js:66` all name Hamburg or Dresden directly. Any change of endpoint is a change in six files.

The follow-up feature — picking where the trip starts and ends — needs a road that is longer than the trip. This spec builds that road.

## Decisions taken during brainstorming

| Decision | Choice |
| --- | --- |
| Corridor | **Cuxhaven → Prague**, roughly 1050–1100 km |
| Northern end | Cuxhaven, which is on the **left** bank — so the route uses two banks |
| Hamburg junction | The **Finkenwerder ↔ Landungsbrücken ferry**, an expected ~1.3 km of water |
| Czech source | **One relation** — EV7 Czech (`2775754`), Elbe *and* Vltava in one line |
| Route assembly | **Three separately trimmed segments** joined by declared bridges |
| Towns / POIs | **Corridor query** (`around:` on a subsampled route), not one giant bbox |
| Southern end | **Prague**, via the Vltava spur — not the Elbe's own course to the source |
| Stored plans | **Archived and reset**, not migrated — the saved plan is test data |
| Endpoint names | Read from `route.meta.json`, never literals |
| Km inflation | Measured 2026-07-31: **not a problem** (1.3%). Diagnostic kept as a build guard |

### Why Prague and not the source

The Elberadweg's own southern terminus is Špindlerův Mlýn, reached along the Labe from Mělník through Hradec Králové. Prague leaves the Elbe at Mělník and runs up the Vltava. Prague wins here because it is where multi-day riders actually aim — rail links home are far better — and because EV7 delivers it as one continuous relation.

The honest product answer is **both**: the Elbe course as the main line with Prague as a named spur. That needs `route.json` to hold more than one LineString and route km to stop being a single scalar, which is the same machinery left-bank/right-bank variants need. One route-variants spec should cover both; neither is attempted here.

### Why plans are reset rather than migrated

Every stored number is an absolute route km: day `endKm`, break `routeDistanceKm`, the `name@km` and `kind:name@km` keys. Adding Cuxhaven → Hamburg moves Hamburg from km 0 to roughly km 185, so the existing 7-day plan (boundaries at 114 / 194 / 274 / 354 / 466 / 650) would become a plan from Cuxhaven to near Magdeburg, with Hitzacker replaced by Stade.

Adding the offset to every stored km would fix that, except `itinerary.js` guarantees `days[0]` starts at km 0 — a plan cannot begin at km 185 until the *next* spec makes the start selectable. Reset now, re-enter by hand, and the migration never has to be written.

## Design

### 1. Sources

| Segment | Relations | Bank / network |
| --- | --- | --- |
| Cuxhaven → Finkenwerder | `2599008`, `2599035` | Elberadweg **left** (linkselbisch, D10) |
| Landungsbrücken → Schöna | `2599011`, `2599013`, `2599015`, `2599016`, `2599018`, `2599020`, `2599024`, `2599025`, `2599026`, `7758087`, `2599030`, `2599032`, `2599033` | Elberadweg **right** (rechtselbisch, D10) |
| Hřensko → Prague | `2775754` | **EuroVelo 7**, Czech part |

Two additions to the current right-bank list: `2599033` (Heidenau → Schöna) closes Dresden to the border. `2599011` stays in the fetch because it carries the Hamburg passage, but its Wedel → Landungsbrücken half is trimmed away — the left bank covers that stretch on the other side of the river.

All three sources are flat way lists using the `forward` / `backward` / no-role conventions `stitch()` already handles; `181093` (Labská stezka) also carries `guidepost` nodes, but it is not used. Right-bank stages `2599007` and `2599009` (Brunsbüttel → Wedel) are deliberately **not** used: Brunsbüttel is a different northern terminus and mixing it in would fork the route.

The alternative Czech routing — stitch `181093` to Mělník and hand it off to a Vltava relation — needs two sources and an invented junction. EV7 is a designed through-route and needs neither.

### 2. Assembly: three segments, two declared bridges

Each segment is stitched and trimmed **independently**, then the three are concatenated:

```
stitch(left)   → trim [CUXHAVEN → FINKENWERDER]  ─┐
                                                  ├─ bridge "Finkenwerder–Landungsbrücken ferry"
stitch(right)  → trim [HAMBURG → SCHOENA]        ─┤
                                                  ├─ bridge "Schöna–Hřensko ferry"
stitch(ev7)    → trim [SCHOENA → PRAGUE]         ─┘
```

Feeding all sixteen relations to one `stitch()` call would be less code, but the Hamburg ferry then surfaces as a generic `‼ HARD GAP` warning indistinguishable from real corruption, and the first-way orientation heuristic has to guess across a bank change. Declaring the joins makes them checkable instead.

**Each bridge is named, expected, measured and bounded:**

| Bridge | Expected | Build fails above |
| --- | --- | --- |
| Finkenwerder–Landungsbrücken ferry | ~1.3 km | 3 km |
| Schöna–Hřensko ferry | ~0.2 km | 1 km |

A genuine break therefore cannot hide inside an expected gap. The bridge km are recorded in meta so later features can label them (a ferry is not a stretch you ride).

The EV7 segment's start is `nearestPointOnLine(ev7Line, SCHOENA)` rather than a Hřensko coordinate, so whichever bank EV7 crosses on, the trim lands at the border.

### 3. Anchors

Approximate `[lng, lat]`; the script snaps each with `nearestPointOnLine`.

| Constant | Coordinate | Place |
| --- | --- | --- |
| `CUXHAVEN` | `[8.7166, 53.8917]` | Kugelbake, the Elbe mouth marker |
| `FINKENWERDER` | `[9.8760, 53.5372]` | Finkenwerder ferry pier |
| `HAMBURG` | `[9.9686, 53.5457]` | Landungsbrücken — **unchanged** |
| `SCHOENA` | `[14.2372, 50.8703]` | Schöna ferry, at the border |
| `PRAGUE` | `[14.4114, 50.0865]` | Charles Bridge |

**New check:** every anchor's snap offset is reported, and an offset above 2 km fails the build. Today a wrong anchor silently trims somewhere else entirely.

### 4. Towns and POIs: corridor query

The corridor's bounding box spans roughly 5.5° × 6.5° and contains Berlin, Hannover, Leipzig and Nuremberg's latitude band. The existing single-bbox POI query will very likely time out, and what it returned would be discarded by the `offsetKm` filter anyway.

Instead: subsample the finished route to one point every **2 km** (~520 points) and issue each clause as `around:3000,<lat,lon,…>`. Response size then scales with the corridor rather than the rectangle. Corridor half-widths are unchanged — food 2 km, sights 3 km, towns 5 km — and `around:3000` is a prefilter, with the exact `offsetKm` test still deciding.

Fallback if `around` proves too slow on a 520-point list: six latitude-banded bboxes fetched in sequence and concatenated. Everything downstream (classify, name, dedupe, sort) is untouched either way.

Expected sizes: `route.json` ~76 KB → ~120 KB, `towns.json` ~76 KB → ~120 KB, `pois.json` ~1.1 MB → ~1.7 MB, and the gitignored raw cache several MB.

### 5. Validation

Monotonicity checkpoints, extended and asserted strictly increasing, with each snap offset reported:

Freiburg (Elbe) `[9.2833, 53.8250]` → Stade `[9.4757, 53.5928]` → Hamburg `[9.9686, 53.5457]` → Lauenburg `[10.5586, 53.3739]` → Wittenberge `[11.75, 52.995]` → Magdeburg `[11.629, 52.126]` → Meißen `[13.472, 51.162]` → Ústí nad Labem `[14.0400, 50.6607]` → Mělník `[14.4740, 50.3510]`.

Mělník precedes Prague because the Vltava leg runs upstream — the two are 50 km apart on the route and 45 km apart in a straight line, so the ordering is a real assertion, not an accident.

Length bounds re-based: hard **850–1350 km**, nominal **1000–1150 km**. The nominal range is set from an OSM-measured estimate, not the signposted figures — see below for why those differ.

**Doubling-back guard (new).** The report gains: total km of the line whose vertices lie within **30 m** of a non-adjacent part of the same line (non-adjacent meaning more than **1 km** apart measured along the route), plus the five largest such clusters with their route positions. Implemented with a ~0.0005° lat/lng grid so it stays linear. **The build fails above 5%.**

This exists because a stage's `alternative` members once produced a spurious 8.6 km jump, and out-and-back spurs would silently inflate every distance the app quotes a user. It is a regression guard, not an investigation: the current route was measured on 2026-07-31 and is clean — **8.4 km of 650.2 km, 1.3%**, in ten clusters, the largest a 2 km loop at km 43–45. Milestone distances from Hamburg also run slightly *short* against signposted values (Bleckede −8%, Havelberg −7%, Magdeburg −2%, Torgau +1%, Meißen +1%), so the 650 km figure is sound. The 5% threshold is set to catch a new stitching fault, and the three added sources are what could introduce one.

### 6. `route.meta.json`

```json
{
  "routeId": "cuxhaven-prague-ev7-v1",
  "totalKm": 1067.4,
  "origin":      { "name": "Cuxhaven", "km": 0 },
  "destination": { "name": "Prague", "km": 1067.4 },
  "segments": [
    { "source": "elberadweg-left",  "from": "Cuxhaven",        "to": "Finkenwerder", "relations": [2599008, 2599035],      "startKm": 0,     "endKm": 183.2 },
    { "source": "elberadweg-right", "from": "Landungsbrücken", "to": "Schöna",       "relations": [2599011, 2599013, 2599033], "startKm": 184.5, "endKm": 892.1 },
    { "source": "eurovelo-7-cz",    "from": "Hřensko",         "to": "Prague",       "relations": [2775754],               "startKm": 892.3, "endKm": 1067.4 }
  ],
  "bridges": [
    { "name": "Finkenwerder–Landungsbrücken ferry", "km": 183.2, "lengthKm": 1.3 },
    { "name": "Schöna–Hřensko ferry",               "km": 892.1, "lengthKm": 0.2 }
  ],
  "builtAt": "…", "simplifyTolerance": 0.00008, "pointCount": 5600
}
```

Km values above are placeholders and the right-bank `relations` list is abbreviated to three of its thirteen ids; the build writes the measured values and the full list. `bank` is dropped — nothing reads it, and the route is no longer one bank. `osmRelations` is dropped too, being derivable from `segments`.

### 7. App changes

Endpoint names come from meta, everywhere:

| File | Change |
| --- | --- |
| `strip-markup.js` | `summaryMarkup` / `scaleMarkup` read `state.originName` and `state.destinationName` instead of the literals at lines 129, 172, 191, 192 |
| `strip.js` | State gains `originName` / `destinationName`, defaulting to `'start'` / `'finish'` so the module stays independently mountable |
| `main.js` | Fills both from meta; `fromNameFor(0)` returns `meta.origin.name` instead of `'Hamburg'` (line 284) |
| `map.js` | Start-pin title takes the origin name as an option instead of `'Start — Hamburg'` (line 397) |
| `index.html` | Header span becomes a placeholder that `main.js` fills |
| `itinerary.js` | Contract comment at line 66 stops naming Hamburg and Dresden |
| `README.md` | Lines 4, 90, 105–106 |

No behaviour changes anywhere else. `boundaries.js` makes no assumptions about route length, and `map.js` already derives its camera from `routeLayer.getBounds()`.

### 8. Stored data: archive and reset

`storage.js` records the `routeId` a plan blob was built against and bumps its schema version to **3**. The current routeId is **injected by `main.js`**, not imported from meta inside `storage.js` — the same trade `totalKm` already makes, so the storage tests stay free of the data files.

On load, a blob whose `routeId` is missing or different is **archived, not read**:

- `elberadweg-plans` → `elberadweg-plans-backup-<oldRouteId>`
- `elberadweg-favorites` → `elberadweg-favorites-backup-<oldRouteId>`

where `<oldRouteId>` is the blob's own routeId, or `v2` when it has none. **If that key is already occupied, a `-2`, `-3`, … counter is appended** — a second rebuild against the same old routeId must never overwrite the first backup.

The app then starts with one fresh empty plan. This mirrors the v1 → v2 migration, which also kept the legacy key as a backup. No notice UI: the only plan that exists is test data, and a banner explaining a wipe nobody will notice is not worth its code.

**This is a pre-users answer, and it expires.** Once real people have plans, a route-data change has to *migrate* — shift every stored km by the origin's delta — rather than reset. That is only expressible once `days[0]` can start somewhere other than km 0, which is exactly what the next spec adds. The `routeId` written here is what that future migration branches on, so recording it now is the part that lasts.

### 9. Testing

The genuinely new logic is extracted into pure, exported functions and tested for real — `scripts/*.test.mjs` is already inside vitest's default include pattern:

| Function | What its tests pin |
| --- | --- |
| `joinSegments(segments, bridges)` | Concatenation order, measured gap per bridge, throwing above the ceiling, and that a bridge's recorded km equals the preceding segment's end |
| `anchorSnap(line, anchor, {maxOffsetKm})` | Returns the snap, throws past the ceiling |
| `doublingBackReport(coords, {radiusM, minAlongKm})` | A clean line reports zero; a synthetic out-and-back spur reports its length; a normal hairpin closer than `minAlongKm` along the route does **not** count |
| `corridorPoints(line, spacingKm)` | Spacing, endpoint inclusion, and that a short line yields at least two points |

In `src`: `strip.test.js` and any other test asserting `"330 km to Dresden"`, `"km 650 · Dresden"` or the arrival wording move to injected names; `storage.test.js` gains cases for a matching `routeId` (read normally), a mismatched one and an absent one (both archive and reset), and for the archive key not overwriting an existing backup.

The build's own validation report stays the acceptance gate for the data itself — length, monotonicity, anchor offsets, bridge lengths, gap counts, POI counts, doubling-back.

## Out of scope

Selectable start and destination; Hamburg and Dresden as strip milestones; the elevation profile; the Brunsbüttel arm; left-bank stages south of Finkenwerder; GPX export.

**Route variants** are the largest deferral: left bank versus right, and the Elbe's own course to the source versus the Prague spur. Both need `route.json` to hold multiple lines and route km to stop being one scalar. That is a spec of its own, and it is the biggest gap between this app and "the best Elberadweg planner" — a rider who wants the left bank cannot be served at all until it lands.

Two more product gaps this spec does not touch, recorded so they aren't forgotten: **mobile layout**, since people plan trips on phones, and **lazy-loading the POI data** rather than bundling it.

## Open risks

- **EV7 completeness through Prague.** The urban Vltava routing is the least predictable part of the corridor. The build reports every gap; a hard gap inside the Czech segment means falling back to `181093` plus a Vltava relation.
- **`around:` with ~520 coordinates may be slow or rejected.** Banded bboxes are the fallback; the decision point is the first successful town fetch.
- **`pois.json` at ~1.7 MB** is bundled, not lazy-loaded — it is shipped to every user on first load, which is the cost that grows worst as the corridor grows.
