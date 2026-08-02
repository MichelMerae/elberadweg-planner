# The trip becomes an oriented window on the road

**Date:** 2026-08-01
**Status:** SHIPPED 2026-08-02 — merged to master as `304e586` and pushed. See "Outcome" at the end.
**Depends on:** `2026-07-31-cuxhaven-prague-route-design.md` (the road must be longer than the trip), `2026-08-01-elevation-profile-design.md` (per-day climb)

## Problem

The road runs Cuxhaven → Prague, 1026.5 km. Nobody rides that. `itinerary.js` guarantees `days[0]` starts at km 0, so every plan begins at Cuxhaven whether or not that is where the rider is.

For Michel specifically, extending the road north made his own case **worse**: before, km 0 was Hamburg, exactly where he starts. Now there are 149 km in front of him that he has to plan and then ignore. The northern extension only pays off once the trip can begin somewhere other than the road's start.

And the road has a direction the app does not: the Elbe descends the whole way, so Dresden → Hamburg is a different ride from Hamburg → Dresden. Guidebooks describe the route source-to-sea. The app can only express one of those.

## What a trip is, after this

A trip is **an oriented window on the road**: a `startKm`, a `destinationKm`, and nothing else. Direction is implied by their order — `destinationKm < startKm` means riding downstream. Days chain from `startKm` toward `destinationKm`, in whichever direction that is.

## Decisions taken

| Decision | Choice |
| --- | --- |
| Picking a start / finish | **Armed map click** — a control arms the next route click |
| Precision help | After the click, offer to **snap to the nearest town** |
| Direction | **Implied by start/destination order**, not a separate flag |
| Direction changes | **Fixed once days exist.** Both ends are set at trip setup; a flip afterwards is refused |
| Strip scope | **The trip only**, rescaled, with a stub at each end where the road continues |
| Displayed km | **Relative to the start** — Hamburg reads km 0 |
| Stored km | **Absolute route km, unchanged** |
| Per-day climb | On the strip block's **second label line**, beside the overnight town |
| Strip height | **User-resizable**, dragged from its top edge, persisted |
| Existing plans | Default to the whole road, so nothing changes for them |

### Why direction is fixed rather than reversible

Michel's framing, and it removes a whole branch: *"there is no such a case — from the day start it should go just in the direction to the destination, the user should set the start and the destination from the beginning."*

So both ends are chosen at trip setup, before there are days. Days then only ever run start → destination. Changing an end **in the same direction** afterwards is allowed and reflows the days. Changing one so the direction would *flip* is **refused**, with a message pointing at Reset trip. No day-reordering arithmetic, no overnight towns migrating between reversed boundaries, and nothing that can silently discard a plan.

That makes the empty-plan state a real trip-setup step, which it is not today — it currently says "click the strip to pick where day 1 ends", quietly presuming the road's own start.

### Why an armed click rather than a plain one

A route click already means "add a custom stop to the focused day". Overloading it would make the two indistinguishable. So `Set start` / `Set finish` arm a one-shot picking mode, the cursor changes, and the next route click resolves it. Escape or a second press cancels.

They live in the **scale line**, on the endpoint labels the strip already shows (`km 0 · Cuxhaven`). Editing a value where it is displayed needs no new vocabulary.

### Why snapping to a town matters

At whole-route zoom one pixel is ~0.7 km, so a click is worth ±2 km. "Closest to my home" deserves better than that. After a click the app names the nearest town and offers to snap — one tap gets Hamburg's exact km rather than somewhere near it.

### Why stored km stay absolute

Because it costs nothing and buys everything: breaks (`name@km`), favorites (`kind:name@km`), POI and town `routeDistanceKm` all keep meaning when the start moves. **Changing your start does not invalidate a single favorite.** Only the display shifts.

## Design

### 1. Model

`itinerary.js` — `createItinerary({ startKm, destinationKm })` replaces `{ totalKm }`.

```js
const direction = destinationKm >= startKm ? 1 : -1;   // +1 upstream, -1 downstream
const tripKm = Math.abs(destinationKm - startKm);
// day chaining
day.startKm = prevEnd ?? startKm;
day.endKm = day.startKm + direction * day.targetKm;    // clamped to destinationKm
```

Its contract comment changes from "days[0] always starts at km 0" to "days[0] starts at the trip's startKm, and each day chains toward the destination in the trip's direction".

`boundaries.js` — every comparison becomes signed. `MIN_DAY_KM` guards `Math.abs(endKm - startKm)`. `boundaryWindow` clamps to the trip's span rather than `[0, totalKm]`. `ARRIVED_EPSILON_KM` compares `Math.abs` distances.

**This is the risk concentration in the whole feature.** `boundaries.js` and `itinerary.js` carry ~250 tests between them, all written against an ascending km 0 origin. Every one needs re-reading, not just re-running.

### 2. Display translation

One helper in `ui-util.js`, used everywhere a km reaches a user:

```js
/** Absolute route km -> km as the rider counts it, from their own start. */
export function tripKm(absoluteKm, { startKm, direction }) {
  return round1((absoluteKm - startKm) * direction);
}
```

Call sites: the strip's block labels, scale line and summary; the day panel's `km x → y` and its legs; the places rows' `km 641`; break and favorite row distances; the map's day-pin tooltips.

**The failure mode to watch for is a missed call site** — a single absolute km among trip-relative ones is worse than all-absolute, because nothing marks it as different. The plan's last task is a sweep for `routeDistanceKm` and `startKm`/`endKm` reaching markup without passing through `tripKm`.

### 3. Strip rescale

`strip-geometry.js` — `kmToX(km, { startKm, endKm, width })` replaces the `totalKm` form:

```js
x = ((km - startKm) / (endKm - startKm)) * width;
```

The same expression serves both directions: a descending window makes the denominator negative and the mapping still runs left-to-right in trip order. Clamping uses `Math.min/Math.max` of the two ends rather than `[0, totalKm]`.

**Edge stubs.** Where the road continues past an end, a 10 px dimmed cap sits outside the axis proper with a tooltip (`road continues 149 km to Cuxhaven`). It is not draggable — extending the trip is what the `Set start` control is for. Without the stubs a trip that ends at Dresden looks like a road that ends at Dresden.

### 4. Direction and the elevation profile

`profilePoints` already computes `km = startKm + (endKm - startKm) * t`, which is direction-correct; its `endKm <= startKm` guard has to be relaxed to allow a descending window.

`ascentBetween` currently normalises with `Math.min/Math.max`, so it always reports the upstream figure. It gains a direction: riding downstream, the ascent and descent totals swap. That is the whole point of the feature — km 920 → 1000 reads 453 m of climbing and 398 m of descent ridden upstream, and 398 / 453 ridden back.

(Illustration corrected during Task 9; the requirement above is unchanged. An earlier draft said *"the same stretch is 487 m of climbing one way and 487 m of descent the other"*, which assumes a monotonic climb this corridor does not contain: **the Elbe is nearly symmetric in elevation** — across 95 sampled 80 km stretches the weaker side is a median 0.947 of the stronger, and not one is below 20% — so reversing a stretch trades two similar numbers rather than turning a climb into a descent. Direction-awareness still matters, and for the reason the swap illustrates rather than the magnitude.)

### 5. Per-day climb on the strip

The `full` tier already renders two lines. The second gains the climb:

```
1  80 km
🛏 Hitzacker · ↑ 340 m
```

`TIER_FULL_PX` grows from 88 to **112 px** — measured, not guessed, and the measurement is a task step. Below that the climb drops off first, then the town, matching how the tiers already degrade. The climb also joins the block's `title` at every tier, so a narrow day still reports it on hover.

### 6. Picking flow

1. `Set start` pressed → picking mode, map cursor crosshair, banner *"Click the route where your trip starts"*.
2. Route click → snap to nearest route point → `startKm`.
3. If a town lies within 3 km, offer *"Start at Hamburg (km 149.3) instead?"* — one press snaps to it.
4. Days reflow from the new start. Days that no longer fit the window are dropped, with the count reported.
5. Escape, or pressing `Set start` again, cancels without changing anything.

Setting a destination is the same flow. Additionally, a day card gets **`Finish here`**, which sets `destinationKm` to that day's end — the "after planning some days, select this stop as destination" from the original brainstorm.

**A refused flip reads plainly.** Picking a destination behind the start (or a start beyond the destination) while days exist shows *"That would reverse the trip. Reset the trip to ride Dresden → Hamburg instead."* — the direction named, not just refused.

### 6a. Trip setup, for an empty plan

A plan with no days shows a setup step rather than "click the strip":

> **Where are you riding?**
> Start — *not set* · `Set start`
> Finish — *not set* · `Set finish`

Both default to the road's ends (Cuxhaven → Prague), so the step can be skipped entirely by anyone happy with the whole road. Once both are set the panel switches to the normal "add your first day" state and reports the trip's length and direction: *"Hamburg → Dresden · 641.9 km upstream"*.

Direction is named in words because the sign of a subtraction is not something a user should have to infer.

(Example corrected during Task 16; the requirement above is unchanged. An earlier draft read *"649 km downstream"* and **both figures were wrong**. Settled against the data rather than the prose: `src/data/elevation.json` puts km 0 (Cuxhaven) at **5 m** and the road's far end (Prague) at **205 m**, so ascending km climbs *toward the source*. Cuxhaven is the mouth, and Hamburg → Dresden is therefore **upstream** — which is also what §1's model comment says and what the implementation does. The distance is 641.9 km: in the built corridor Hamburg sits at km 155.8 and Dresden at km 797.7.

Worth keeping in view as a product fact, because it is why this sentence earns its place: the Elberadweg's own literature describes the route source-to-sea, so a rider heading for Dresden is going *against* the direction the guidebooks are written in. "Upstream" is a word most users will not have been prepared for by anything else they have read about this route. Naming the direction in words is doing real work here, not decoration.)

### 6b. A vertically resizable strip

At 46 px the profile is cramped — 1 px is ~6 m of elevation, so a 30 m river terrace is five pixels. The strip gets a drag handle on its **top edge**; dragging up grows the axis and shrinks the map.

- Only the **axis** grows. The summary and scale lines are text and keep their heights.
- Bounds: 46 px (today's height) to 45% of the viewport. Below the minimum the handles stop being grabbable; above ~45% the map stops being useful.
- Persisted in `localStorage` under `elberadweg-strip-height` — a UI preference, not plan data, so it is not per-plan and it is not archived with a corridor change.
- Double-clicking the handle returns it to 46 px.
- The profile rescales for free: `strip.js` already reads the axis height through an injectable `measureHeight` seam, and `profilePoints` already takes a height. The `ResizeObserver` in `main.js` currently watches width only and must watch both.
- At taller sizes the axis has room the labels do not currently use. Out of scope here, noted as the obvious follow-up: gridlines at round elevations, and the climb figure on more tiers.

### 7. Storage

Schema **v4**. Each plan gains `startKm` and `destinationKm`. A v3 plan loads with `startKm: 0` and `destinationKm: totalKm`, which is exactly today's behaviour — **no reset, no data loss, nothing archived.** The `routeId` check from v3 is untouched.

### 8. Guards

- `Math.abs(destinationKm - startKm) >= MIN_DAY_KM`, or the pick is refused with a reason.
- Both ends clamped to `[0, meta.totalKm]`.
- A window that shrinks below the planned distance clamps the last day and drops days that no longer fit, reporting how many.
- **A pick that would flip the direction of a plan with days is refused**, naming the direction it would have produced. With no days, a flip is free — that is trip setup.

## Testing

New: `tripKm` translation including a descending trip; `itinerary` chaining downstream; `boundaries` refusing a sub-`MIN_DAY_KM` window in both directions; `kmToX` monotonic left-to-right for both orderings; `ascentBetween` swapping totals with direction; storage v3 → v4 defaulting; the picking flow's town-snap offer, its cancel path and its refused-flip message; the strip's resize bounds, persistence and double-click reset.

Re-read, not just re-run: every existing `boundaries.test.js` and `itinerary.test.js` case, because they encode an ascending km-0 origin as an assumption rather than as a parameter. A test that passes because both sides moved the same way has told us nothing.

## Out of scope

Route variants (left/right bank, the Prague spur) — still the largest gap. Accommodation. A second trip on one road. Round trips (`start == destination`). Per-day gradient colouring. Reversing a plan in place, which the fixed-direction decision removes. Elevation gridlines at the taller strip sizes.

## Sequencing note

This is larger than either feature built on 2026-07-31, and `boundaries.js`/`itinerary.js` are the app's arithmetic core. **One plan, five phases, merged once:**

1. **Oriented model + storage v4** — no UI change; every plan still spans the whole road.
2. **Display translation** — `tripKm` and its call sites.
3. **Strip rescale + stubs + per-day climb label.**
4. **The picking UI** — trip setup, armed click, town snap, `Finish here`, refused flips.
5. **The resizable strip** — drag handle, bounds, persistence.

Phases 1–3 are invisible to a user on their own, which argues for finishing all five before merging and against merging any of them half-done. Phase 5 is independent of 1–4 and could be pulled forward if the profile needs to be readable sooner.

---

## Outcome

**Shipped 2026-08-02**, merged to master as `304e586` and pushed. 16 tasks over ~60 commits; **918 tests in 21 files** (from 592 at branch point), zero failures, clean build. Every task was implemented and then reviewed twice — against this spec, then for quality — with a final review across the whole branch.

### Everything in this spec was built

§1 model, §2 translation, §3 rescale + stubs, §4 direction-aware elevation, §5 climb label, §6/§6a/§6b picking + setup + resize, §7 storage v4, §8 guards. Nothing was dropped.

### Where the implementation departed from this document

- **§2's helper lives on the trip, not in `ui-util.js`.** `trip.tripKm()` is a method on the frozen value object `createTrip` returns, and it does not round — call sites do. Direction is then derived once, in one place, instead of being passed alongside every conversion.
- **§1's `createItinerary({startKm, destinationKm})` became `createItinerary({trip})`.** Two loose numbers that must agree became one value object that cannot disagree.
- **§5's `TIER_FULL_PX` is 117, not 112** — measured against the worst realistic label rather than estimated.
- **§6b's "the `ResizeObserver` must watch both" is width-only, deliberately.** The strip's box grows in height on every `pointermove` of a resize drag, a path that has already re-rendered, so reacting to height would double the cost of the gesture to redraw an identical axis. The 45% ceiling instead re-applies from a *window* resize listener — the only place that can see it, because the body is a 100vh grid whose map row absorbs a shorter window and the strip's own box never changes.
- **§6a's two-state setup is one state.** "Start — *not set*" never appears: both ends always have a value, because they default to the road's ends.
- **§8's guard list became one function, `proposeEnd`.** The ORDER is the point — a pick landing on the trip's other end makes a zero-length window, and an equal-ended window counts as forward, so asking "would this reverse?" first would send a downstream rider to Reset trip over a window they only need to nudge. Length is judged first, and each refusal gets its own reason.
- **A scope addition this spec never mentions: Food, Sights and Favourites now run in ride order.** The rescale broke them — their 40-row caps were keeping the *last* 40 places a downstream rider would meet. Scope the feature created, not scope invented.

### Two errors in this document, both corrected in place

Both are annotated where they occur (§4 and §6a), and both were settled against measured data rather than against the prose. §4's *"487 m of climbing one way and 487 m of descent the other"* described a monotonic climb the Elbe corridor does not contain — across 95 sampled 80 km stretches the weaker side is a median **0.947** of the stronger. §6a's *"Hamburg → Dresden · 649 km downstream"* had both figures wrong: it is **641.9 km upstream**.

The §4 error did real damage before it was caught. A browser check written to verify the elevation profile re-samples when one window end moves compared **ascent totals** — on a corridor where two different stretches report near-identical climb, so a stale memo would have reported "fine". The check was replaced with a pixel-level one. **A spec's illustrative numbers get copied into tests, and a wrong illustration makes an unfalsifiable test.**

### What this branch is actually worth remembering for

**Every real bug here was found by mutating the code and watching a test fail to notice.** Fifteen assertions that could not fail were found that way — several written by the plan itself, two of them among the assertions it specified verbatim. At least four bugs in shipped behaviour would otherwise have merged green:

- the boundaries stopgap wrote `targetKm <= 0` on any offset or downstream trip, and `hydrate` then **dropped the entire plan on reload**;
- `arrived`'s `Math.abs` was pinned only by accident, and the signed form made an 80 km plan on a 648 km downstream window read as finished on day 1 — removing any way to add day 2;
- the row cap kept the **last** 40 places rather than the first, passing all 63 places tests;
- the favourites cap spent its slots on places *behind* the rider, dropping 6 places that were actually on the trip.

Three more were found only in a real browser, where no unit test could have reached them: a picking prompt sitting **on top of Leaflet's zoom control**, making `+`/`−` unclickable while armed, at ≈1.0:1 contrast over map tiles; a `pointer-events: none` rule that never worked because leaflet.css sets an explicit `auto` on the marker icons and **an explicit value beats an inherited one at any ancestor specificity**; and `setPointerCapture` retargeting `dblclick` to the capture element, so an element that captures **can never hear its own double-click**.

And two habits that paid for themselves repeatedly: **jsdom swallows exceptions thrown inside event handlers**, so any assertion that a click does *nothing* needs an `error` listener or it cannot tell "correctly ignored" from "threw". And a `render(next = state)` argument-less re-render **cannot pin a `next.x ?? state.x` fallback**, because `next.x` *is* `state.x` — five such fallbacks looked defended by tests, turned out to be dead entirely, and were deleted.

### Known follow-ups, none blocking

Pin `storage.js`'s single-ruined-end window repair (a stored `{startKm: 149.3, destinationKm: null}` must load as Hamburg→Prague, and nothing says so today). Decide the fate of `breaksInRange`, which has no app caller now that `strip-markup.js` kept its own `breaksIn`. Sweep 14 plan-task references out of shipped source. **Highest value: lift `nameAtKm` and `endLabel` out of `main.js`** — `main.js` has no test file, and `nameAtKm` carries a cross-module invariant nothing enforces: relaxing its rounded road-end gate would name a km-0.04 start "Cuxhaven" while the strip drew a *"road continues 0.1 km to Cuxhaven"* cap past that same end and called it "start", a visible contradiction with a green suite.

Still out of scope, unchanged: route variants (left/right bank, the Prague spur) — still the largest gap in the product. Accommodation. A second trip on one road. Round trips. Per-day gradient colouring. Elevation gridlines at the taller strip sizes.
