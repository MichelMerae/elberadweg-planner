# Committed-Day Secondary Stops — Design

**Date:** 2026-07-20
**Status:** Approved by Michel (design discussion in session)

## 1. Problem

Days are the primary stops (where to sleep). Secondary stops — lunch, a café,
a bridge, a viewpoint, "2 hours at the top eating" — belong *inside* a day,
between its start and end. Today they can only be added while a day is still
pending: the ☕ toggles live on the "On the way" lists, and those lists only
ever render the uncommitted stretch. Once a day is committed its km range is
never browsable again, so stops can no longer be added to it. Breaks also
carry no free-text label.

The model layer already supports everything positionally: breaks are
plan-level `{name, kind, routeDistanceKm, lat, lng}` records, sorted by km and
bucketed into days by `(startKm, endKm]` (`breaksInRange`), re-bucketing
automatically when day distances change. The gap is UI reach and the label.

## 2. Approved UX decisions

1. **Day selection mode** (chosen over an inline day-card form): an
   **+ Add stops** button on each committed day card re-points the existing
   left panel and map POI markers at that day's km range. Same rows, same
   ☕/⭐ actions as pending planning. **Done** exits back to pending planning.
2. **Custom text-only stops via map click** (chosen over typed-km or
   positionless notes): while a day is selected, clicking the route inside the
   day's range opens a small label prompt and adds a 📌 stop at the snapped
   km.

## 3. Data model

- A break entry gains one **optional field `note: string`** (free text, e.g.
  "15 min coffee", "2h at the top eating"). Absent on old data — no schema
  bump: `normalizePlan` already passes break objects through untouched,
  `addBreak`/`hydrate` spread unknown fields, `isValidBreak` is unchanged.
- **Custom stops are ordinary breaks** with `kind: 'custom'`; their `name` IS
  the user's label (required, non-empty after trim). Key stays `name@km`
  (`breakKey`), so identity/dedup/removal work unchanged.
- New itinerary API: `updateBreak(key, {name?, note?})` — applies the patch,
  validates (name non-empty if given), and returns the updated break's
  (possibly new) key, or null for an unknown key. No re-sort is needed:
  `routeDistanceKm` is never patched, so order cannot change. A patch that
  would collide with an existing key is a no-op returning null.

## 4. Day selection mode (main.js / ui.js)

- New main.js state: `selectedDayIndex: number | null` (null = current
  pending-planning behavior; not persisted, resets on plan switch/reload).
- Each committed day card gets an **+ Add stops** footer button
  (`data-action="add-stops"`). Clicking it selects that day; clicking another
  day's button switches; **Done** or Esc deselects. `removeLastDay`/`reset`
  deselect if the selected day disappears.
- While selected:
  - The controls block swaps its pending-day content (distance input, commit
    button, pending-breaks list) for a day-mode header: *"Adding stops to
    Day N (km X → Y)"* + **Done** button.
  - The left panel renders food, sights, **and towns** whose
    `routeDistanceKm` falls in `[startKm, endKm]` inclusive — the same
    inclusive browse window pending mode already uses for POIs. (Break
    *bucketing* onto day legs keeps its `(start, end]` rule with the km-0
    widening; a place exactly at a day boundary shows in the list but
    buckets to the previous day, identical to pending-mode behavior today.)
  - The map shows that stretch's POI markers; the ghost marker is hidden;
    day pins, break markers, favorite markers stay.
  - Day-target editing on any card stays live and re-buckets legs as today.
    If the selected day's range changes, day mode re-renders for the new
    range.
- Selecting a day changes nothing in the model — it only re-points rendering.

## 5. Custom stops (map click in day mode)

- In day mode, a route click inside the selected day's range opens an inline
  prompt in the controls block: *"New stop at km K"* + text input + Add /
  Cancel. Add creates `{kind: 'custom', name: label, routeDistanceKm, lat,
  lng}` (no `note`) via `addBreak` and persists. Empty label ⇒ disabled Add.
  While the prompt is open, Esc cancels the prompt only; a second Esc exits
  day mode.
- Route clicks outside the day's range are ignored. In normal (pending) mode
  route clicks keep their current meaning: set pending distance.
- Custom stops render as legs with a 📌 glyph (`BREAK_GLYPH.custom`) and get
  📌 map markers alongside existing break markers. They are **not**
  favoritable (no ⭐; they're personal text, not a place).

## 6. Notes on legs

- Every day-card leg (and pending-break row) gets a ✎ button opening an
  inline one-line text input (Enter/blur saves, Esc cancels):
  - place-kind breaks (town/food/sight): edits `note`; rendered after the
    name as `🍴 Café Elbe · 15 min` when present. Empty input clears the
    note.
  - custom breaks: edits the label (`name`) itself. Emptying is rejected
    (keep old value).
- Saving goes through `updateBreak` + `persistPlan` + `renderAll`.

## 7. Edge cases

- Re-bucketing: shrinking a day so a stop falls past its end moves the stop
  to the following day (existing behavior, unchanged and desired).
- A custom stop beyond the last committed day can't be created (map clicks
  only work in day mode, inside a committed range) — pending-stretch stops
  keep working through the ☕ lists as today.
- Duplicate custom labels at different km are fine (`name@km` differs); an
  exact key collision in `addBreak` stays a silent no-op.
- Favorites cross-marking (☕ filled on favorite rows that are breaks) is
  key-based and unaffected by `note`.

## 8. Out of scope

- Structured durations (the free-text label covers "2h", "15 min").
- Drag-reordering stops (order = km position).
- Persisting day-mode selection across reloads.
- Accommodation/booking integration (v2 candidate, unchanged).

## 9. Testing

- itinerary.test.js: `note` survives addBreak/getBreaks/hydrate round-trips;
  `updateBreak` (note set/clear, custom rename incl. key change, unknown key
  → null, collision → null/no-op, note-only patch keeps key and order);
  `kind: 'custom'` passes validation.
- storage.test.js: notes and custom kinds survive saveActivePlan → load.
- ui/main wiring (day mode, map-click prompt, ✎ editing) is verified by
  running the app — repo convention: main.js/ui.js have no unit tests.
- All existing tests (150) stay green; the `name@km` key convention is locked
  by existing tests and must not change.
