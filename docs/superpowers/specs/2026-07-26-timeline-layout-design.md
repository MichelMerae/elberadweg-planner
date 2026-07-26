# Timeline layout: the trip as a to-scale strip, one focused day at a time

**Date:** 2026-07-26
**Status:** design approved, ready for planning
**Supersedes UX behaviour from:** `2026-07-20-committed-day-stops-design.md` (day mode becomes the universal interaction), `2026-07-19-breaks-and-day-relative-distances-design.md` (leg rendering moves, semantics kept)

## Problem

Measured in the running app at 1512 x 900 with four days committed:

- The right panel holds 2010 px of content in a 900 px window, and `#itinerary` starts at 989 px. **The trip — the thing you return to on every visit — is entirely below the fold**, behind a slider you touch once per day and 589 px of overnight candidates you skim once.
- `map.js` fits the whole 650 km route once at boot and never zooms again; row clicks `panTo` without changing zoom. The 80 km day you are deciding about is ~12% of the drawn line, and placing a custom stop means clicking a ~1 cm segment.
- Editing a middle day ripples: every later boundary shifts, so a chosen overnight town no longer matches its day.
- A day exists in two different shapes — a *pending* day (slider, ghost marker, candidates, Commit) and a *committed* day (km field, plus a separate "day mode" behind "+ Add stops") — with two code paths and two mental models.

A vertical scrolling list is the wrong shape for a trip. A trip is one linear thing measured in kilometres, so it belongs on a horizontal axis where 650 km always fits the width and position on the strip equals position on the map.

## Decisions taken during brainstorming

| Decision | Choice |
| --- | --- |
| Layout | Bottom timeline strip **is** the trip; right panel holds only the focused day |
| Strip placement | Bottom (header keeps identity; a bottom strip reads as ground) |
| Boundary edit semantics | **Local** — the neighbour absorbs the delta; nothing beyond it moves |
| Pending/commit staging | **Collapsed** — no slider, no Commit, no ghost, no separate day mode |
| Overnight town | **Snaps the boundary** to the town's route position |
| Day operations | move boundary, split day, delete day (split and delete are inverses) |
| Place-list stopgap | Cap each section at 40 rows with a "showing 40 nearest of N" footer |

## Design

### 1. Layout zones

```
┌──────────────────────────────────────────────────────────────────┐
│ header: title · Hamburg → Dresden            plans ▾ New Dup Del │  38 px
├────────────┬──────────────────────────────────┬──────────────────┤
│ left 340   │ map (flex)                       │ right 380        │
│ scoped to  │ framed on the focused day        │ the focused day, │
│ the focused│ rest of route dashed             │ and only that day│
│ day        │ ⤢ this day / ⤢ whole route       │                  │
├────────────┴──────────────────────────────────┴──────────────────┤
│ strip: 320/650 km planned · 330 km to Dresden · 4 days · ⌀ 80 km  │
│ [ 1 ][ 2 ][   3 focused  ][4]┈┈┈┈┈┈ + add a day ┈┈┈┈┈┈ ⚑ Dresden │ ~170 px
│ km 0                     km 265                            km 650│
└──────────────────────────────────────────────────────────────────┘
```

**Invariant: exactly one day is focused whenever the plan has at least one day.** Default focus is the last day. Focus is not persisted — a plan switch or reload focuses the last day. Focus drives the left panel's stretch, the map's camera, and the right panel's contents simultaneously.

With zero days, the right panel shows an empty state ("No days yet — click the strip to add your first day"), the left panel shows favorites only, and the map fits the whole route.

### 2. The strip

Full-width, ~170 px, at the bottom. Three rows:

1. **Summary line** — `320 / 650 km planned · 330 km to Dresden` left, `4 days · ⌀ 80 km/day` right. This replaces the progress bar inside the itinerary.
2. **Axis** — one block per day, `width = (day.endKm - day.startKm) / totalKm` of the inner width, so blocks are honestly to scale. Each block shows its number, its km, its overnight town, and its breaks' glyphs positioned at their real km within the block. The focused block is outlined in river blue. Trailing unplanned distance is a dashed remainder ending in a Dresden flag.
3. **Scale line** — `km 0 · Hamburg` … `km 650`, with the focused boundary's km called out.

**Label tiers** (a 5 km day is ~11 px wide at 1400 px, so labels must degrade): ≥64 px shows number + km + glyphs; ≥30 px number + km; ≥14 px number only; below that no label, `title` tooltip only.

**Gestures**

- **Click a block** → focus that day.
- **Drag a block's right edge** (the handle) → move that boundary. Live: the dragged day and its neighbour both show their new km; the map highlight follows; the camera pans only if the moving end would leave the viewport, and refits on release. **Persist once on release, never during the drag.**
- **Click the dashed remainder** → add a day ending at the clicked km.
- **`+ add a day` button on the remainder** → append a day of the previous day's length (80 km if it's the first), clamped to `totalKm`.
- **Keyboard**: each handle is a focusable `role="slider"` with `aria-valuenow/min/max` and `aria-label` like *"Day 3 end, km 265, arrow keys adjust"*. `←/→` move 1 km, `Shift+←/→` move 5 km, respecting the same clamps. This is the accessible replacement for the removed slider.
- **Touch**: pointer events with `setPointerCapture` and `touch-action: none`; handle hit area 10 px visual / 24 px effective.

### 3. Boundary semantics (local)

Days are stored as lengths (`targetKm`); boundaries are their cumulative sums. `MIN_DAY_KM = 5`.

Index convention: API arguments are **0-based day indices** matching the existing `day.index`; prose and UI labels ("Day 3") are 1-based. `boundary(i)` means `days[i].endKm`, and `boundary(-1)` is km 0.

`moveBoundary(i, endKm)`:

- Clamp `endKm` to `[boundary(i-1) + MIN_DAY_KM, upper]` where `upper = (i is last) ? totalKm : boundary(i+1) - MIN_DAY_KM`.
- Apply `delta = clamped - boundary(i)` as `days[i].targetKm += delta`, and when `i` is not the last, `days[i+1].targetKm -= delta`.
- When `i` **is** the last day there is no neighbour, so the move extends or shrinks the plan itself. This is the append/trim gesture.

Worked example (the one validated in brainstorming): four 80 km days, boundaries 80/160/240/320. Dragging boundary 3 from km 240 to 265 gives day 3 = 105 km and day 4 = 55 km. Days 1–2 untouched, day 5 still starts at km 320, every break and favorite keeps the day it was on.

`splitDay(i)` inserts a boundary at the day's midpoint, producing two days that sum to the original. The **second** half keeps the original `townChoice` — its end is where the original day ended, so that is still where you sleep — and the new first half starts with none. Disabled (button disabled, `title` explains) when the day is shorter than `2 * MIN_DAY_KM`.

`deleteDay(i)` removes the boundary at the **end** of day `i`, merging it into day `i+1`, which keeps its own end — so nothing downstream moves. On the last day it truncates the plan (today's `removeLastDay`). Deleting the only day leaves an empty plan.

`splitDay` and `deleteDay` are inverses. There is no separate "insert day" — inserting a boundary *is* splitting.

`editDay(i, km)` keeps its name and its role as the typed-distance path, but **changes from ripple to local**: it is `moveBoundary(i, boundary(i-1) + km)`. Existing ripple assertions in `itinerary.test.js` are rewritten deliberately as part of this work; the change is the point, not a regression.

### 4. Town snapping

`setTownChoice(i, town)` records the town **and** moves the boundary to `town.routeDistanceKm` through `moveBoundary`, so the neighbour absorbs the difference. A day's km then means the distance you actually ride.

- The town's off-route detour (`offsetKm`) is displayed separately (`+0.33 km off route`) and never folded into the day's km.
- If the snap target is outside the clamp window (a town within `MIN_DAY_KM` of the next boundary), the boundary clamps and the day panel shows a note. Worked example: day 3 ends at km 240, day 4 ends at km 268, and you choose a town at km 265. The upper clamp is `268 - 5 = 263`, so the boundary stops at km 263 and the note reads *"Rosenhof sits at km 265; day 4 can't be shorter than 5 km, so the boundary stopped at km 263."* The town choice is still recorded.
- Clearing a town choice leaves the boundary where it is.

### 5. Focused day panel (right)

Bounded content by construction — one day — so the fold problem cannot return.

- Header: `Day 3`, `from Lenzen (Elbe) · km 160 → 265`, and `3 of 4 · ‹ ›` to step focus between days.
- `Distance` — a number field showing the day's km. Typing commits on Enter/blur through `editDay`. Dragging is fast, typing is exact; both exist.
- `Overnight` — the chosen town (or "none chosen"), picked from the left panel's candidates or by dragging the boundary pin on the map.
- `Legs` — unchanged semantics from the breaks design: km since the previous stop → glyph + name, with `✎` (note for place breaks, label for custom stops) and `×`. A break at km 0 renders as "at the start" instead of a `0 km` leg.
- Actions: `Split day`, `Delete day`.
- A hint line, *"click the route on the map to add a stop"*, replaces the `+ Add stops` button. Since route clicks now always add a stop to the focused day (§7), a button to arm that behaviour would be arming something already on. The map carries the same hint. The label prompt for naming a new stop is unchanged, and moves into this panel.

### 6. Left panel

Same lists, now explicitly scoped to the focused day (`On the way · Day 3 · km 160 → 265`) and with **overnight candidates moved here** from the right panel, above food and sights. Selecting a candidate calls `setTownChoice` on the focused day.

Stopgap for volume: each section renders at most **40** rows, ordered as today, with a footer `showing 40 nearest of 451 · show all`. An expanded section stays expanded until the focused day changes, then collapses back to 40. Purely presentational; real list-taming (grouping, opening-hours filtering, corridor tightening) stays a separate project.

### 7. Map

- `focusRange(startKm, endKm)` fits the focused stretch with padding; the focused stretch draws thicker in `--river-deep`, the rest of the route dashed and muted.
- Numbered boundary pins are **draggable**, mirroring the strip handles through the same `moveBoundary` path and the same clamps.
- **Route click means one thing now**: add a stop to the focused day (today's day-mode behaviour, made universal). Setting a day's end is dragging its pin or its handle. The current mode-dependent double meaning is gone.
- Camera policy: refit on focus change; during a drag pan only when the moving end would leave a 12% viewport inset, then refit on release; a manual pan or zoom suspends auto-fit until the next focus change. `⤢ this day` and `⤢ whole route` are always available. `prefers-reduced-motion` disables animated fitting.
- The ghost marker is removed with the pending day.

### 8. Plans bar

Moves into the full-width header — it is trip-level and the right panel is now day-level. Contents unchanged (select, name field, New / Duplicate / Delete) to keep this project's scope on layout; the redundant select-plus-name-field pairing is noted as a separate cleanup.

### 9. What is removed

The distance slider and its debounce, the `Commit day` button, the pending-day block, the pulsing ghost marker, the `+ Add stops` button and the separate day mode behind it, the "Breaks this day" pending list, and `main.js`'s `pendingTarget` / `pendingTown` / `selectedDayIndex` / `customStopDraft` — replaced by a single `focusedDayIndex`.

Breaks beyond the last day keep their place in the model and render as glyphs on the dashed remainder; they are absorbed into a day as soon as the plan grows past them. The km-0 widening rule for day 1 is unchanged.

## Data model and storage

**No schema change.** Plans stay v2: `days: [{ targetKm, townChoice }]`, `breaks: [...]`. Boundaries are derived cumulative sums, and all boundary operations maintain the `targetKm` array. Consequences:

- No migration, so no migration risk (this repo has been bitten by one before) and `storage.test.js` needs no rewriting.
- `targetKm` values become fractional after snapping (76.2, 83.8). Everything already rounds through `round1` for display.
- Persistence points: pointer release on a drag, Enter/blur on the distance field, and every discrete operation (split, delete, add, town choice, break edit). Never mid-drag.

## Module structure

`ui.js` is 855 lines and most of it is changing, so it becomes a thin facade — `main.js` keeps calling `ui.renderX` — over:

| Module | Owns |
| --- | --- |
| `strip.js` | timeline render, label tiers, drag/keyboard interaction, emits `onFocusDay` / `onMoveBoundary` / `onAddDay` |
| `strip-geometry.js` | pure km↔px mapping, block widths, handle hit-testing, drag clamping (no DOM, directly unit-testable) |
| `day-panel.js` | focused-day editor: distance, overnight, legs with `✎`/`×`, add stops / split / delete |
| `places.js` | left panel: favorites, overnight candidates, food, sights; row actions, hover↔marker wiring, the 40-row cap |
| `plans-bar.js` | header plans control |
| `ui-util.js` | shared `esc`, `round1`, `townKey`/`poiKey`, glyph maps |

`itinerary.js` gains `moveBoundary`, `splitDay`, `deleteDay`, redefines `editDay`, and extends `setTownChoice` with snapping. `map.js` gains `focusRange`, `setRouteHighlight`, draggable boundary pins, and loses `setGhost`.

Naming conventions that existing tests lock stay as they are: `name@km` for ui rows/breaks/markers, kind-prefixed `kind:name@km` for favorites only.

## Testing

TDD throughout, per the usual flow.

- `strip-geometry.test.js` — km↔px round-trips, to-scale widths summing to the axis, handle hit-testing, clamp behaviour at both ends and on the last day.
- `itinerary.test.js` — local `moveBoundary` (neighbour absorbs; days beyond untouched; both clamps; last-day extend/shrink; single-day plan); `splitDay` (sums preserved, no town on the new day, disabled below `2 * MIN_DAY_KM`); `deleteDay` (merge forward, downstream untouched, last-day truncate, delete-only-day); town snapping including the clamped case; break re-bucketing across move/split/delete; km-0 rule. Existing ripple assertions rewritten.
- `storage.test.js` — round-trip of fractional `targetKm`, and an assertion that the schema version is still 2.
- `places.test.js` / `day-panel.test.js` — jsdom render assertions in the style of the current ui tests, including the 40-row cap and its footer.
- Manual verification pass in the browser at 1512x900 with a 4-day plan: itinerary visible without scrolling, drag → local resize, split, delete, town snap, keyboard handle adjustment.

## Explicitly out of scope

- **Taming the place lists** properly (ranking, grouping, opening-hours filter, corridor tightening) — only the 40-row cap ships here.
- **Dates** (trip start date → weekday per day, arrival date, rest days). The day panel's header leaves room for the date line.
- **Phone layout.** The strip is a step towards it, but no responsive work in this project.
- Plans-bar cleanup (select + name field redundancy), map legend, accommodation data, elevation, GPX export.

## Risks

- The left panel gets busier before the list work happens; the 40-row cap is the mitigation.
- Drag interaction is the only genuinely new interaction code here. Extracting the geometry as pure functions is what keeps it testable; touch and keyboard paths are specified above rather than left to implementation.
- ~170 px comes off the map's height. At 900 px the map still gets ~690 px, taller than it is wide in the middle column.
