# Two banks, and the crossings between them

**Date:** 2026-08-02
**Status:** approved in brainstorming, not yet planned

## Product context

The Elberadweg runs on **both banks** of the Elbe through Germany, and the official route
treats them as equals: every stage is published in a `linkselbisch` (left) and
`rechtselbisch` (right) variant. The app so far serves exactly one composite line, so a
rider who wants the left bank — or wants to ride 50 km on the right, cross at Magdeburg,
and finish the day on the left — cannot be served at all. The previous route spec called
this deferral "the biggest gap between this app and 'the best Elberadweg planner'". This
spec closes it.

The defining scenario, from brainstorming: *planning a day, the rider wants "cross to the
other side" as an option of the same rank as "end the day here" — ride ~50 km, cross at
Magdeburg, keep planning the same day on the left bank.*

## Problem

`route.json` is one LineString and every stored thing — trip ends, day lengths, breaks,
favorites, towns, POIs — hangs off one scalar km axis along it. Two banks break both
assumptions at once: there are two lines, and a km on one bank is not a km on the other
(the banks genuinely differ in length between crossings). The design has to add the
second bank **without** re-addressing the world the app already stores.

## Decisions taken during brainstorming

| Decision | Choice |
| --- | --- |
| Scope | Both banks for the **German** Elbe; Czech stays the single EV7 line (no official second bank exists there) |
| Second-bank source | **Official elberadweg.de GPX**, sections A–O, both variants — for BOTH German banks, so the two lines share conventions |
| Czech source | OSM EV7 relation `2775754`, unchanged |
| Crossings | **Every physical crossing**, derived from OSM (bridges + ferries), validated — not a hand-kept list |
| Switching UX | A **day-planning action**: "Crossings you pass today" list in the day panel; a chosen crossing becomes a removable day leg |
| Map / strip roles | Map = secondary shortcut (clickable crossing markers) and result display; strip = read-only bank ribbon + crossing milestones |
| Position model | **Bank overlay on the canonical axis**: stored km stay absolute canonical km; the plan gains a list of chosen crossing ids |
| Brunsbüttel arm | **Deferred.** North of Hamburg the "other bank" is a dead-end arm to a different terminus, not a crossing-bounded bank |
| Stored plans | Archived and reset via the existing routeId machinery — the axis is rebuilt from a new source |

## Design

### 1. The two lines

**Canonical line** — the km axis, one Feature<LineString> in `route.json`, same shape as
today: left bank Cuxhaven → Hamburg (the only bank there), right bank Hamburg → the
border, EV7 to Prague. The German parts are rebuilt from official GPX; EV7 stays OSM.

**Alternative line** — `route.alt.json`, one Feature<LineString>: the German **left bank**
from its first Hamburg-area crossing to its last crossing near the border. It has its own
km axis (`kmAlt`). It exists only where crossings bound it — no alt coverage north of the
first crossing (that is the deferred Brunsbüttel arm's territory) and none in Czechia.

Each bank is stitched from its 15 official section files with the machinery and guards
the build already has: gap detection with declared expected bridges, monotonicity
checkpoints (both banks get their own checkpoint lists), length bounds, doubling-back
report, anchor-snap ceilings. A hard gap between section files fails the build.

The official GPX is fetched by a new build step, cached raw and gitignored exactly like
the Overpass responses. Download URLs are pinned in the build script.

### 2. Crossings: derived, then validated

A **crossing** is a place a rider can change banks. Candidates come from OSM in the
corridor between the two lines:

- **Bridges:** ways tagged as bridges with bicycle access (or cycleway/path/footway with
  `bicycle != no`) whose two ends project onto the two bank lines within **250 m** each.
- **Ferries:** `route=ferry` ways/relations whose terminals project the same way.

Each surviving candidate becomes
`{ id, name, kind: 'bridge' | 'ferry', kmCanonical, kmAlt, lengthKm, coord }`, sorted by
`kmCanonical`, written to `crossings.json`. `lengthKm` is the measured ride/float across.
`id` is a stable slug of the name plus rounded km (`magdeburg-sternbruecke-479`), so a
data rebuild that moves a crossing by metres does not orphan saved plans.

Validation, so OSM noise cannot become UI:

| Check | Bound |
| --- | --- |
| Endpoint projection onto each line | ≤ 250 m, else the candidate is dropped |
| Name | resolved from the way/relation, else nearest town + kind; never empty |
| Crossing length | ≤ 3 km, else dropped with a report line |
| Duplicates | two candidates within 150 m on **both** axes merge; the named/shorter one survives |
| Total count | hard 15–60, nominal 25–45; outside hard bounds the build **fails** |

The two existing declared bridges (Hamburg ferry, border link) remain declared joins of
the canonical line — unrelated to this table, which only describes bank changes.

### 3. Data files and meta

| File | Change |
| --- | --- |
| `route.json` | unchanged shape; German geometry now official-GPX |
| `route.alt.json` | **new** — the left-bank line, Hamburg-area → border |
| `crossings.json` | **new** — the validated crossing table |
| `towns.json`, `pois.json` | every entry gains `bank: 'right' \| 'left' \| 'both'`; `routeDistanceKm` stays **canonical** km (alt-bank entries get theirs via the crossing-table mapping in §4) |
| `elevation.json` | becomes `{ canonical: [...], alt: [...] }`; the loader adapts |
| `route.meta.json` | gains `alt: { lengthKm, fromCrossing, toCrossing }`, `crossingCount`; routeId becomes **`cuxhaven-prague-official-v2`** |

Bank words in `towns.json`/`pois.json` and in every UI string are the rider's words —
`left` / `right` as the Elberadweg itself uses them (facing downstream). `canonical` /
`alt` name the two **lines** in file and code names only, and never appear in the UI.
The canonical line's own geographic bank varies by segment (left north of Hamburg, right
south of it — the meta `segments` record which), which is why the two vocabularies must
not be conflated.

### 4. The path model: `path.js`

The one new module, pure and exported, owning every piece of new arithmetic.

```
createPath({ trip, chosenCrossingIds, canonicalIndex, altIndex, crossings })
```

returns a trip-shaped object the display layer consumes **instead of** `trip`:

| Member | Contract |
| --- | --- |
| `bankAt(km)` | the rider-word bank (`'left'`/`'right'`) at a canonical km: the canonical line's own bank there (from meta segments), flipped when the parity of chosen crossings passed before it — counted along the trip's direction — is odd |
| `riddenKm(km)` / `canonicalKmAt(riddenKm)` | the piecewise mapping between canonical km and km actually ridden; inverse of each other on the window |
| `advance(km, riddenDistance)` | the composed-path twin of `trip.advance` — walks ridden km, returns canonical km; **this is what itinerary's day-length walking calls** |
| `legs()` | ordered `[{ bank, fromKm, toKm, riddenLengthKm, crossing? }]` for map, strip ribbon and elevation |
| `crossingsBetween(a, b)` | crossings in a canonical-km span, ordered the trip's way — the day panel's list |
| `coords(fromKm, toKm)` | the composed polyline for rendering, spliced from both indexes plus straight crossing links |
| passthroughs | `startKm`, `destinationKm`, `direction`, `tripKm`, `contains`, `clampKm` delegate to the trip; `lengthKm` is **ridden** length |

Mapping rules, stated so there is exactly one reading:

- Within an alt-ridden stretch between crossings at canonical `k1 < k2` with alt span
  `a1 < a2`: ridden distance scales linearly, factor `(a2−a1)/(k2−k1)`.
- A crossing's `lengthKm` is ridden distance spent at a single canonical km — a vertical
  step in the mapping, like the ferries the meta already records are not stretches you ride.
- A chosen crossing whose km lies outside the trip window is **kept in storage, ignored
  in composition** — shrinking and re-growing the window does not forget choices.
- Trips start on the canonical line's bank. Starting on the other bank = choosing a
  crossing at/near the start; there is no stored start-bank flag.
- Everything works for both trip directions; parity and ordering follow `trip.direction`.
- Crossing on a day boundary: owned by the day `dayOwnsKm` says, same as breaks.

`main.js` builds the path once per plan change and hands it where it hands `trip` today.
When `chosenCrossingIds` is empty the path degenerates to the trip — same numbers, same
legs, one bank — which is also the compatibility argument: nothing changes until the
first crossing is chosen.

### 5. The day panel: where crossing happens

Below the day's legs, a **"Crossings you pass today"** group: `crossingsBetween(dayStart,
dayEnd)` minus already-chosen ones, each row `kind-glyph · km (rider-relative) · name` with
a **⇄ Cross** button. Ferry rows carry a "check operating times" hint.

Pressing Cross appends the id to the plan's `crossings` list (kept sorted by canonical
km). The crossing then renders as a **day leg** at its km — `⇄ Cross to the left bank ·
Magdeburg, Sternbrücke` — with a ✕ to remove it, like a custom stop. Legs after it show
the new bank's badge; the list group re-offers the remaining crossings as "Cross back".
Day lengths are stored lengths (`targetKm`), so adding or removing a crossing re-flows
every later day along the changed path automatically — no stored day moves.

### 6. Map and strip

**Map:** the composed path (`path.coords`) is the solid route line; the unridden bank's
stretches render faint and dashed; crossing markers appear **within the trip window** and
clicking one performs exactly the day panel's action against the day that owns that km.

**Strip:** a read-only bank ribbon under the scale — two shades, split at each chosen
crossing's trip-km — plus ⇄ ticks for chosen crossings. The elevation profile follows
`path.legs()`, reading each leg's samples from its bank's array.

### 7. Towns and POIs on two banks

The corridor query runs once per bank line; each town/POI is tagged with the bank whose
line it sits nearest (within the existing half-widths), `both` when it is within corridor
of both lines — Magdeburg and Dresden span the river. Alt-bank entries get their
canonical `routeDistanceKm` through the §4 mapping, so day bucketing, break keys
(`name@km`) and favorites keys are untouched.

Display: other-side items stay visible but badged ("other side"), and the overnight-town
chooser prefers the bank the rider ends the day on. No reachability logic — a badge, not
a filter.

### 8. Storage: schema v4

The plan blob gains `crossings: [id, ...]` and the schema version becomes **4**. The
routeId changes to `cuxhaven-prague-official-v2`, so every existing blob is archived and
reset by the machinery of the previous spec — no v3→v4 migration code is ever written.

Hydration of a v4 blob validates each crossing id against `crossings.json`: an unknown id
is **dropped with a console warning, keeping the plan** — a crossing is one choice, not
the plan's identity. Order is not trusted from storage; ids re-sort by their table km.

### 9. Testing

| Surface | What its tests pin |
| --- | --- |
| `path.js` | bankAt parity (add, remove, cross back, both directions); riddenKm/canonicalKmAt round-trip on the window; advance walking across a crossing lands the next day where the ridden km say; legs() splice order; degenerate no-crossings path equals the trip's numbers; out-of-window chosen crossing ignored |
| build: bank assembly | per-bank stitch guards fire on a synthetic gapped GPX pair; both-banks-from-one-source lengths within bounds |
| build: crossing derivation | synthetic parallel lines + bridge/ferry ways: projection bound drops far candidates, dedupe merges doubles, names resolve, count bounds fail the build |
| day panel | crossings group renders from `crossingsBetween`; Cross appends and re-renders the leg; ✕ removes; ferry hint present; bank badges flip after the crossing |
| storage | v4 round-trip with crossings; unknown id dropped with plan kept; routeId mismatch archives (existing tests extended) |
| strip / map | ribbon splits at chosen crossings' trip-km; composed-path coords swap banks at the crossing |

The build's validation report remains the acceptance gate for the data itself: both banks'
lengths, gaps, monotonicity, anchor snaps, crossing table stats, POI/town counts per bank.

## Out of scope

- **The Brunsbüttel arm** north of Hamburg — a second terminus, not a bank pair; needs a
  spur concept the overlay model deliberately avoids. Recorded for later.
  **What this costs, recorded honestly (measured during implementation):** it is not that
  the northern stretch has no other bank or no crossings. The official right bank starts at
  Brunsbüttel and runs parallel to the left bank from roughly left km 35 to the Hamburg
  hand-over, and that stretch carries real Elbe crossings — the Glückstadt–Wischhafen ferry
  most obviously. They are undroppable-by-geography but undrivable-by-model: the canonical
  line *is* the left bank north of Hamburg and the left bank again as `route.alt.json`
  south of it, and one alt file tagged `bank: 'left'` cannot also be the right bank. So the
  empty northern stretch is a deliberate consequence of the one-alt-line model, **not** a
  derivation bug — do not "fix" it by widening the derivation corridor.
- Czech bank variants — no official second bank exists; the single line is the road there.
- The Elbe-source routing (Špindlerův Mlýn) as an alternative to the Prague spur.
- Recommending a bank ("the left is nicer here") — the app offers the choice, not opinions.
- Ferry timetables — a ferry crossing carries a static "check operating times" hint only.
- GPX export of the composed path.

## Open risks

- **GPX license.** elberadweg.de states no terms on the download page, and derived data
  lands in the repo. Worth a short permission email before shipping publicly; the fallback
  is building the left bank from the OSM linkselbisch relations instead — same machinery,
  and the crossing derivation would then want its projection bound loosened toward 300 m
  for the mixed-source case.
- **Official GPX quality.** 30 section files must stitch into two clean lines; the
  existing guards decide, and the first build's report is the decision point.
- **Crossing count in the wild.** The 25–45 nominal range is an estimate; the first
  derivation run calibrates it. Magdeburg alone contributes several legitimate crossings.
- **`pois.json` growth.** Two corridors roughly double POI volume toward ~3 MB bundled;
  lazy-loading remains recorded product debt from the previous spec, made heavier here.
