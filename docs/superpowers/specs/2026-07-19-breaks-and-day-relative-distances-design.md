# Committed Breaks + Day-Relative Distances — Design Spec (Sub-project 2 of 3)

**Date:** 2026-07-19
**Status:** Approved by Michel (design conversation, this date)
**Series:** 1) storage v2 + named plans · 2) breaks + day-relative distances ← this spec · 3) favorites
**Depends on:** sub-project 1 (plan-level `breaks` array in schema v2; `hydrate`; plans store).

## Motivation

Michel wants to commit break points (e.g. a lunch stop) as part of the trip, see each day as legs between stops, and read all distances relative to the last overnight stop ("how far will I ride today") rather than absolute route km.

## Decisions (from brainstorming)

- **Break = waypoint on the day.** Day cards show legs ("35 km → ☕ Café X → 45 km → 🛏 Lenzen"); a break has a map pin and is saved with the plan. The day's total distance stays whatever was set — breaks split it for display only.
- **Breaks are plan-level**, stored once, sorted by `routeDistanceKm`; each day *derives* its breaks by km range, so editing day distances re-buckets breaks automatically instead of losing them.
- **Day-relative distances everywhere, absolute secondary**: towns, food/sights, breaks, day cards lead with "X km from [last stop]"; absolute km shown small ("km 158.7").

## 1. Trip model (`src/itinerary.js`)

- New plan-level state: `breaks: []` — records are place snapshots `{ name, kind ('food'|'sight'|'town'), category?, lat, lng, routeDistanceKm, offsetKm }`.
- `breakKey(b)` = `${b.name}@${b.routeDistanceKm}` (module convention).
- API: `addBreak(place)` (validates numeric `routeDistanceKm` ≥ 0 and lat/lng present; inserts sorted; adding an existing key is a no-op), `removeBreak(key)`, `getBreaks()` (defensive copy), `breaksInRange(startKm, endKm)` → breaks with `routeDistanceKm` in `(startKm, endKm]` (breaks list is small — linear filter is fine).
- `hydrate({ days, breaks })` extended to restore breaks (invalid break entries dropped silently); `reset()` clears breaks too.
- Breaks may sit at any km — beyond the last committed day they simply have no day yet (UI shows them under the pending stretch).

## 2. Legs derivation (display only)

For a day `{startKm, endKm}` with derived breaks `b1..bn` (sorted): legs are `b1.km − startKm`, `b2.km − b1.km`, …, `endKm − bn.km`. Rendered on the day card:

```
Day 2 · 80 km · from Boizenburg/Elbe
   35 km → ☕ Café Deichblick (food)
   45 km → 🛏 Lenzen (Elbe)
   km 80 → 160 of 650.2
```

- "from X" = previous day's `townChoice.name`, or **"Hamburg"** for Day 1, or "your last stop" when the previous day has no town chosen.
- Each break line has a small **×** remove control (`onRemoveBreak(key)`).
- A day without breaks keeps the current single-line card (plus the new "from X" lead).
- Breaks beyond the last committed day render as a small list in the pending-day controls section ("Breaks this day: ☕ Café X · 35 km from start ×"), committed with the plan already (they're plan-level — the pending day merely doesn't exist yet).

## 3. Row actions: "☕ break" button

- Every town, food, and sight row gets a **☕** button (`data-action="break"`) that calls `onAddBreak(place)` — main.js snapshots the row's record (adding `kind: 'town'` for towns) into `itinerary.addBreak`, saves, re-renders.
- Row-body click = pan/highlight only (as established in sub-project 1). The ☕ button on a row whose place is already a break shows an active state and removes on click (toggle).
- Towns keep their existing "select as overnight" affordance as the primary row action? **No** — towns row-body click currently selects the town. That stays; towns get the ☕ button alongside (a town can be a lunch stop). Only food/sight row-body clicks are pan-only.

## 4. Day-relative distances (`src/ui.js` display changes)

- **Towns:** `"78.7 km from Boizenburg/Elbe · 1.6 km off route"` + secondary `"km 158.7"`. The reference name/start comes from the pending day (start = last committed endKm; name per §2 rules).
- **Food/sights:** `"45 km from Boizenburg/Elbe (km 125.2) · 0.3 km off route"` — same reference; replaces "into your day" wording.
- **Day cards:** legs as in §2; the `km a → b` line becomes secondary (`km 80 → 160 of 650.2`).
- `renderTowns`/`renderPois` gain `{ dayStartKm, fromName }` inputs; all wording built in ui.js.

## 5. Map (`src/map.js`)

- `setBreakMarkers(breaks)` — persistent, distinct divIcon (☕ glyph in a small amber-bordered white circle, between day-pin and POI-dot in size), always visible like day pins, tooltip = name. Click = pan/highlight only (removal happens on the cards).
- Rendered from `getBreaks()` on every render pass.

## Error handling

- `addBreak` with malformed record → throw (programmer error, same policy as addDay validation); hydrate drops malformed breaks silently (data corruption tolerance).
- Duplicate add via UI (button toggle) handled as remove — no duplicate keys ever stored.

## Testing

- **itinerary.test.js:** addBreak sorted insert/dedupe/validation-throw; removeBreak; breaksInRange boundary semantics `(start, end]`; hydrate with breaks (+ malformed dropped); reset clears; re-bucketing scenario — commit 2 days, break at km 70, edit Day 1 80→60, break now derived into Day 2 (via breaksInRange assertions).
- **Browser (Playwright):** add a break from a food row mid-Day-1 → ☕ pin appears, day card shows two legs summing to the day distance; edit Day 1 shorter → break moves to Day 2's card; remove via ×; towns list shows "km from" wording; reload persists breaks; plan switch isolates breaks per plan.

## Out of scope

Custom break labels ("lunch"/"coffee" naming); reordering breaks (they order by km); break time estimates; favorites (sub-project 3).
