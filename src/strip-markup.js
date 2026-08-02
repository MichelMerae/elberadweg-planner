// The timeline strip's markup. Every export here is a pure function of the
// state, layout and axis width handed to it — no DOM, no listeners, no module
// state — so the whole visual layer can be exercised without mounting anything.
// strip.js keeps the state machine (drag, keyboard, focus restoration) and owns
// the only innerHTML writes.
//
// The three exports are the three regions render() writes: the summary line, the
// axis, and the scale line.
//
// Every km that reaches a user here — a label, a title, an aria value — is counted
// from the RIDER's own start, via `state.trip.tripKm`. The km in `state.days` and
// `state.breaks` are absolute route km and stay that way, and so do the km fed to
// `kmToX`: the axis maps the trip's WINDOW, so kmToX takes an absolute km and answers
// with an x inside that window. A glyph's `left` and a handle's `left` are therefore
// window geometry derived from absolute km — no conversion, and none needed.
//
// Road outside the window has no x at all (kmToX clamps it onto the nearer end), which
// is why the road past a trip end is drawn as a stub BESIDE the axis and why a break
// out there is not drawn at all.

import { esc, round1, glyphFor } from './ui-util.js';
import { boundaryBounds, ARRIVED_EPSILON_KM } from './boundaries.js';
import { kmToX } from './strip-geometry.js';
// Pure, like boundaries.js's boundary math and on the same terms: a block's climb is a
// reading of the profile this module is already handed, not a second source of data.
import { ascentBetween } from './elevation.js';

// Distance ridden from one absolute km to another, counted the rider's way: positive
// along the trip whichever direction it runs. tripKm is linear, so the difference of
// two conversions IS the ride — the same composition itinerary.js makes internally,
// spelled here rather than imported because this module holds no model.
function rideKm(trip, fromKm, toKm) {
  return trip.tripKm(toKm) - trip.tripKm(fromKm);
}

/**
 * A block's CSS box from its geometry, the only place px land in the DOM.
 *
 * Two hazards, both owned here rather than in the pure geometry:
 *
 * 1. `width` is deliberately NEGATIVE for an inverted day (endKm before
 *    startKm, which the model can transiently hold on pathological stored
 *    data) so that `x + width` keeps equalling `kmToX(endKm)` and handle
 *    positions stay truthful. CSS `width: -80px` is invalid, gets dropped, and
 *    an absolutely positioned div then falls back to `auto` — visible garbage.
 * 2. Rounding `x` and `width` independently scatters seams: 0.1 km is ~0.2 px,
 *    adjacent edges already agree to ~1e-13, and one edge can round up while
 *    its neighbour rounds down. So round the two EDGES and derive the width
 *    from them — block i's right edge is then the same number as block i+1's
 *    left edge, by construction, at any axis width.
 */
function span(x, width) {
  const left = round1(x);
  const right = round1(x + width);
  return { left, width: Math.max(0, right - left) };
}

// The trailing unplanned stretch as it will be drawn: the part of the rider's own
// window their days have not filled yet.
//
// Both the axis (does the remainder get a box at all?) and the scale line (has the trip
// arrived?) turn on the same rounded width, so it is derived once — and now they mean
// the same thing by it. They briefly did not: while stripLayout still measured the
// remainder against the ROAD, a completed 648 km trip on a 1026 km road drew 290 px of
// "+ add a day" here beside a summary that already read "0 km to Prague".
function tailBox(layout) {
  return span(layout.remainder.x, layout.remainder.width);
}

/**
 * The breaks a day's block names, bucketed the way `itinerary.dayOwnsKm` buckets
 * them: half-open `(start, end]` in RIDER km, with day 1 also owning a break sitting
 * exactly on the rider's start line (the one boundary with no previous day to hand
 * the shared km to).
 *
 * Rider km is what keeps the rule pointing the same way downstream — in absolute km
 * `> startKm && <= endKm` is never true when the day descends, so every downstream
 * block named none of its breaks. And the exception is INDEX-0, not km-0: keyed on
 * the road's origin it fired on no day at all once the trip started at km 149.3.
 *
 * Spelled here rather than asked of the model because this module is pure markup with
 * no itinerary to ask, and because a block's names label the glyph cluster inside its
 * own box — a span, not a day index. It mirrors `spanOwnsRiderKm`, normalised end for
 * end the same way, so an inverted day still buckets rather than silently emptying.
 */
function breaksIn(breaks, trip, day, isFirstDay) {
  const from = trip.tripKm(day.startKm);
  const to = trip.tripKm(day.endKm);
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return breaks.filter((b) => {
    const at = trip.tripKm(b.routeDistanceKm);
    return (isFirstDay ? at >= lo : at > lo) && at <= hi;
  });
}

/**
 * One glyph layer for the whole axis, each break at its absolute route km.
 *
 * Filtered to the WINDOW, not to the road. kmToX clamps, so a break out on road the
 * rider is not riding would pile up on the nearer end of the axis and read as a stop
 * standing on their own start line. `trip.contains` is inclusive of both ends, which is
 * right here: a stop exactly on the start or the finish is on the trip.
 *
 * These used to be children of the day they fell in, which cost three things: a
 * block's `overflow: hidden` clipped them, every offset needed the block's own
 * rendered left edge subtracted (a whole class of off-by-a-block bug), and they
 * were gated behind the widest label tier of the day — then 88 px, about 39 km at
 * desktop width on a road-scaled axis — so a 20 km day with a café silently showed
 * nothing. At axis level they work at every tier. They are pointer-events: none, so
 * clicks still reach the block underneath.
 */
function glyphLayerMarkup(breaks, axis) {
  return breaks
    .filter((b) => Number.isFinite(b.routeDistanceKm) && axis.trip.contains(b.routeDistanceKm))
    .map((b) => {
      const x = kmToX(b.routeDistanceKm, axis);
      return `<span class="strip__glyph" style="left:${round1(x)}px" title="${esc(b.name)}">${glyphFor(b)}</span>`;
    })
    .join('');
}

/**
 * The elevation profile as one filled area plus a stroked top line.
 *
 * Sits ABOVE the day blocks, not behind them: blocks carry an opaque background, so
 * a profile behind them would only show in the gaps. It is `pointer-events: none`
 * (see the CSS) exactly like the glyph layer, because the axis underneath is a drag
 * surface for the boundary handles.
 *
 * No viewBox, deliberately. SVG user units then equal CSS pixels, so the 2px stroke
 * cannot be distorted by a non-uniform scale — which is what `preserveAspectRatio="none"`
 * over a stale viewBox would do the moment the window was resized.
 *
 * aria-hidden: the profile is decorative here. The numbers a screen reader needs are
 * the ascent figures in the day panel and the range in the scale line, both text.
 *
 * @param {Array<[number, number]>} points - from elevation.js's profilePoints.
 */
function elevationMarkup(points, { width, height } = {}) {
  if (!Array.isArray(points) || points.length < 2 || !width || !height) return '';
  const line = points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round1(x)},${round1(y)}`)
    .join('');
  const area = `${line}L${round1(width)},${round1(height)}L0,${round1(height)}Z`;
  return `
      <svg class="strip__elevation" aria-hidden="true" focusable="false">
        <path class="strip__elevation-fill" d="${area}" />
        <path class="strip__elevation-line" d="${line}" />
      </svg>`;
}

/**
 * A day's climb, or null when the app has no elevation data to read one from.
 *
 * The day's own km, in the order the itinerary chains them — which is TRIP order, so a
 * downstream day hands `ascentBetween` a descending span and gets the descent-heavy
 * answer back. That is the whole of the direction-awareness here: no branch on
 * `trip.direction`, because the day already carries it.
 *
 * Read here rather than passed in alongside the days: an array parallel to `days` would
 * add an index-alignment invariant for every future caller to maintain, and a forgotten
 * one would silently label days with each other's climb. The profile is already in
 * `state.elevation` (the scale line reads its range), so this adds no data path at all.
 */
function climbFor(profile, day) {
  // One guard, not two: `ascentBetween` already answers nulls for a profile it cannot
  // use, so asking it first collapses "no elevation build" and "half-written profile"
  // into the same answer — and leaves nothing here that a test cannot reach. (An earlier
  // `if (!profile) return null` above this made the finite check unreachable from any
  // input the app can produce, which a mutation duly survived.)
  const climb = ascentBetween(profile, day.startKm, day.endKm);
  return Number.isFinite(climb.ascentM) ? climb : null;
}

/** The climb as the block's label says it: metres of ascent, or nothing. */
function climbText(climb) {
  return climb ? `↑ ${Math.round(climb.ascentM)} m` : '';
}

/**
 * The climb as the block's TITLE says it, at every tier — so a day too narrow for a label
 * still reports it on hover.
 *
 * With the descent beside the ascent, which the label has no room for: a tooltip does, and
 * the descent is the figure that shows the direction, since the same stretch trades the two
 * round the other way. Metres, so none of it goes through the trip; the km either side of
 * it already do. The ≈ that qualifies these numbers stays in the day panel, which has the
 * room to explain what it means.
 */
function climbTitle(climb) {
  return climb ? ` · ${climbText(climb)} ↓ ${Math.round(climb.descentM)} m` : '';
}

/**
 * The block's second label line: where the rider sleeps, and how much the day climbs.
 *
 * ```
 * 1  80 km
 * 🛏 Hitzacker · ↑ 340 m
 * ```
 *
 * A flex row rather than one nowrap line, so the ellipsis bites the TOWN and not the
 * climb: "Ústí nad Labem" is half again as wide as the "Hitzacker" TIER_FULL_PX is
 * measured against, and a tier that promised the climb and then clipped it off the end
 * would be worse than one that never offered it. The town's full name is in the title.
 *
 * Either half can be absent — a day with no town chosen still reports its climb — so the
 * separator belongs to the climb, which is the half that can have something before it.
 */
function secondLineMarkup(day, climb) {
  const town = day.townChoice ? `<span class="strip__block-town">🛏 ${esc(day.townChoice.name)}</span>` : '';
  const text = climbText(climb);
  const up = text ? `<span class="strip__block-climb">${town ? '· ' : ''}${text}</span>` : '';
  if (!town && !up) return '';
  return `<span class="strip__block-second">${town}${up}</span>`;
}

/**
 * A block's label, as much of it as the block's width can carry.
 *
 * The ladder degrades from the bottom of the label upwards: the climb goes first, then
 * the town with it, then the day's own km, leaving just its number (spec §5). Which is
 * why 'full' and 'town' differ only in whether a climb reaches `secondLineMarkup`.
 */
function blockLabelMarkup(block, day, trip, climb) {
  // A day's length is a distance RIDDEN, so it is positive whichever way the trip
  // runs. `endKm - startKm` is the same number forwards and its negation downstream,
  // which put "-80 km" on every block of a Dresden -> Hamburg plan.
  const km = `${round1(rideKm(trip, day.startKm, day.endKm))} km`;
  const number = `<b>${block.index + 1}</b>`;
  const first = `${number} <span class="strip__block-km">${km}</span>`;
  if (block.tier === 'full') {
    return `<span class="strip__block-label">${first}${secondLineMarkup(day, climb)}</span>`;
  }
  if (block.tier === 'town') {
    return `<span class="strip__block-label">${first}${secondLineMarkup(day, null)}</span>`;
  }
  if (block.tier === 'km') {
    return `<span class="strip__block-label">${first}</span>`;
  }
  if (block.tier === 'number') {
    return `<span class="strip__block-label">${number}</span>`;
  }
  return '';
}

/**
 * One boundary handle: a role="slider" button at the day's end km.
 *
 * `activeIndex` is the boundary currently being dragged, or null. The dragging
 * class is re-derived on every render rather than set on the node, because the
 * node this class belongs to is destroyed by the drag's first preview.
 *
 * `trip` is the window the boundary math is measured in, built once per render by
 * axisMarkup rather than per handle.
 */
function handleMarkup(days, index, axis, activeIndex, trip) {
  const day = days[index];
  // Announced in RIDER km, which is also what makes the range coherent without a
  // sort: boundaryBounds answers in TRIP order — downstream its `min` is the
  // numerically LARGER absolute km — and rider km puts trip order and numeric order
  // back together, so valuemin <= valuemax holds by construction. (A sort here would
  // hide a real inversion rather than prevent one; boundaries.js floors `max` at
  // `min` in rider km so an inverted window cannot reach us.)
  const bounds = boundaryBounds(days, index, { trip });
  const value = trip.tripKm(day.endKm);
  const lo = trip.tripKm(bounds.min);
  const hi = trip.tripKm(bounds.max);
  // A slider's value has to lie inside the range it reports, and on squeezed
  // stored data it did not: hand-edited days of 10 and 2 km put boundary 0 at
  // km 10 with a legal window of [5, 7]. Widening the reported range to contain
  // the value keeps the announcement coherent (an out-of-range valuenow is
  // undefined behaviour for a screen reader), and it is a no-op for every
  // well-formed plan — MIN_DAY_KM on both neighbours puts endKm inside [min, max]
  // by construction. The model still refuses the moves it always refused.
  const min = Math.min(lo, value);
  const max = Math.max(hi, value);
  // The day's ABSOLUTE end km, deliberately: kmToX maps it into the window, so this is
  // geometry rather than a number anyone reads. The number read is `value`, above.
  const x = kmToX(day.endKm, axis);
  const town = day.townChoice ? ` (${day.townChoice.name})` : '';
  const label = `Day ${index + 1} end, km ${round1(value)}${town}, arrow keys adjust`;
  const active = activeIndex === index ? ' strip__handle--dragging' : '';
  return `
      <button type="button" class="strip__handle${active}" data-boundary-index="${index}"
              style="left:${round1(x)}px" role="slider" tabindex="0"
              aria-valuenow="${round1(value)}" aria-valuemin="${round1(min)}" aria-valuemax="${round1(max)}"
              aria-label="${esc(label)}" title="${esc(label)}"></button>`;
}

// Neutral stand-ins for the endpoint names. The corridor is data — it grew from
// Hamburg → Dresden to Cuxhaven → Prague and will change again — so no place name
// belongs in this module. These are what it says when mounted without names, which
// the tests do and which must not read as "undefined"; they are also what a trip end
// the rider chose reads as when no town sits near enough to name it.
const ORIGIN_FALLBACK = 'start';
const DESTINATION_FALLBACK = 'finish';

/**
 * What lies past one end of the trip: how much ROAD is left, and the name of the road
 * end that road runs to. `tripEnd` is 'start' or 'destination'.
 *
 * Which road end that is follows the DIRECTION, not the trip end's own role: a
 * downstream trip starts at the road's destination, so the road behind its start runs
 * to Prague and the road past its finish runs to Cuxhaven. Getting this backwards would
 * label the caps with each other's names and read as perfectly plausible.
 *
 * `remainingKm` is a plain distance, positive whichever way the trip runs. The two sides
 * are NOT symmetric in what they need to know: road running back to the road's ORIGIN is
 * just `km`, since the road starts at 0 — so that side is always measurable. Road running
 * on to the road's far end needs `totalKm`, and a trip that was never told one reports 0
 * there, which is what the strip drew before windows existed: as far as it knows, the
 * trip ends where the road does.
 *
 * Guarding both sides on `totalKm` looked tidier and told a lie: a totalKm-less trip
 * starting at km 149.3 suppressed the cap for road it could measure perfectly well, AND
 * then let `endName` call that start "Cuxhaven" — the exact claim endName exists to
 * refuse.
 */
function roadPast({ trip, originName, destinationName }, tripEnd) {
  const towardsOrigin = tripEnd === 'start' ? trip.direction === 1 : trip.direction === -1;
  const km = tripEnd === 'start' ? trip.startKm : trip.destinationKm;
  const remainingKm = towardsOrigin
    ? km
    : Number.isFinite(trip.totalKm)
      ? trip.totalKm - km
      : 0;
  return {
    name: towardsOrigin ? originName ?? ORIGIN_FALLBACK : destinationName ?? DESTINATION_FALLBACK,
    remainingKm,
  };
}

/**
 * Whether the road really continues past a trip end.
 *
 * The one predicate the edge stub (draw a cap?) and the end's own name (is this end
 * already named by the road?) both read, so the two cannot disagree about whether a
 * trip end is a road end. Rounded, because a cap whose title would read "road continues
 * 0 km" is not a cap.
 */
function roadContinues(past) {
  return round1(past.remainingKm) > 0;
}

/**
 * What to call one end of the trip.
 *
 * Three answers, in this order:
 *
 * 1. `state.endNames[tripEnd]` — the name main.js resolved for this end, which is a town
 *    the rider's end sits in, or the road's own name when the end is a road end. It wins
 *    because it is the answer to exactly this question, computed where the town data
 *    lives; nothing in this module can look a town up, and a name derived from the km
 *    is never stored, so this arrives fresh on every render (see main.js's `nameAtKm`).
 * 2. An end sitting on an end of the ROAD keeps that road end's name.
 * 3. Anything else reads as the neutral word for its role — "Cuxhaven" on a start 149 km
 *    past Cuxhaven would be a plain lie.
 *
 * Additive: with no `endNames` at all (which is how most of strip.test.js renders) every
 * case behaves exactly as it did before, including the pinned `startKm: 0.04` pair.
 *
 * Branch 1 sitting ABOVE branch 2 costs nothing in the app, because the two never
 * disagree there: main.js's `nameAtKm` answers the road's own name for a km on a road
 * end, on the SAME rounded comparison `roadContinues` uses, and its comment says so.
 * That shared gate — not the ordering here — is what stops a town 40 m from Cuxhaven
 * renaming the road's origin.
 */
function endName(state, tripEnd) {
  const named = state.endNames?.[tripEnd];
  if (named) return named;
  const past = roadPast(state, tripEnd);
  if (!roadContinues(past)) return past.name;
  return tripEnd === 'start' ? ORIGIN_FALLBACK : DESTINATION_FALLBACK;
}

/**
 * One end of the trip, as a control that arms a pick for it (spec §6).
 *
 * The visible text is the label the scale line always showed — editing a value where it
 * is displayed needs no new vocabulary, and it is why every existing scale-line
 * assertion still passes. What pressing it does lives in `title`, and `aria-pressed`
 * makes it what it is: a toggle, because a second press cancels.
 *
 * **The accessible name is also where the remaining road becomes TEXT.** The edge stub
 * past this end is `aria-hidden` and its figure was available to a pointer only — the
 * debt Task 8 recorded and assigned here. It belongs on this control: the road past an
 * end is exactly what pressing it can claim. The stub keeps the pointer half, so the
 * two halves say the same sentence to two kinds of reader rather than one of them
 * saying nothing.
 *
 * `name` arrives UNESCAPED and is escaped here, once — twice would put `&amp;` on
 * screen, and the aria-label would carry the entity too.
 *
 * The `--start`/`--destination` modifier is the trip's own ends, as everywhere else in
 * this file, and is what lets the scale line keep its far end flush with the axis's
 * right edge now that the arrived flag can follow it.
 */
function endControlMarkup(state, tripEnd, kmLabel, name) {
  const past = roadPast(state, tripEnd);
  const more = roadContinues(past)
    ? ` ${round1(past.remainingKm)} km of road continues to ${past.name}.`
    : '';
  const role = tripEnd === 'start' ? 'start' : 'finish';
  const armed = state.picking === tripEnd;
  const label = `Trip ${role}: km ${kmLabel}, ${name}.${more} Press to set it on the map.`;
  return `<button type="button" class="strip__end strip__end--${tripEnd}" data-action="set-${role}"
                  aria-pressed="${armed}" aria-label="${esc(label)}"
                  title="Set where your trip ${role === 'start' ? 'starts' : 'finishes'}">km ${kmLabel} · ${esc(name)}</button>`;
}

/**
 * A dimmed cap where the ROAD continues past an end of the trip (spec §3).
 *
 * Drawn OUTSIDE the axis proper, in #strip's side padding, because the axis maps the
 * window and there is no x inside it for road nobody is riding. Without them a trip
 * that finishes at Dresden looks like a road that finishes at Dresden.
 *
 * Not a button and not draggable: extending the trip is what the scale line's `Set
 * start` / `Set finish` will do (plan Task 11), and a draggable cap would be a second,
 * silent way to do the same thing. aria-hidden because an empty span's title is
 * announced by nothing anyway and there is no action here to offer — Tasks 11/12 put
 * the trip's ends into real controls, which is where this belongs as text.
 *
 * The distance is display text, so it is rounded like every other km on the strip.
 *
 * `tripEnd` is the same 'start'|'destination' the rest of this file uses, and it becomes
 * the CSS modifier: the axis runs in trip order, so the trip's start is always the left
 * cap and its destination always the right one, whichever way along the road that is.
 */
function stubMarkup(tripEnd, past) {
  if (!roadContinues(past)) return '';
  const title = `road continues ${round1(past.remainingKm)} km to ${past.name}`;
  return `
          <span class="strip__stub strip__stub--${tripEnd}" aria-hidden="true" title="${esc(title)}"></span>`;
}

/**
 * The line above the axis: how far the plan reaches, and the average day.
 *
 * Every figure is a distance RIDDEN, measured against the trip's own length rather
 * than the road's. The last day's absolute endKm is not "how far you have planned":
 * on a trip starting at km 149.3 it overstated the plan by 149.3 km, and against a
 * 1026 km road a 648 km trip could never read as finished.
 *
 * The place counted down to is the RIDER's destination, named by endName — "468 km to
 * Prague" on a trip that stops 229 km short of Prague is the same lie the km used to be.
 *
 * `remaining` collapses on the SAME tolerance stripLayout collapses its remainder on,
 * which is what keeps this line and the axis beside it telling one story. Computed
 * exactly, it read `0.3 km to finish` next to a scale line already saying "reached" and
 * an axis with no remainder and no way to add a day — the same self-contradiction the
 * window rescale closed, inverted, in the 0.1–0.5 km band. A rider reaches that band by
 * dragging the last boundary near an off-grid finish; it needs no picking UI.
 *
 * **The `planned / lengthKm` pair stays EXACT, deliberately, and must not be rounded to
 * agree with the countdown.** Inside the band the line reads `648.3 / 648.6 km planned ·
 * 0 km to finish`, and a reader who notices the pair does not subtract to the countdown is
 * looking at the feature: the pair is two MEASUREMENTS of how far the plan and the trip
 * each reach, while only the arrival CLAIM rounds. The visible 0.3 km is the off-grid slack
 * the epsilon exists to forgive, and this pair is the one place a curious rider can still
 * see it. Rounding the pair to protect the claim would falsify the plan's actual extent.
 */
export function summaryMarkup(state) {
  const { days, trip } = state;
  const planned = days.length ? trip.tripKm(days[days.length - 1].endKm) : 0;
  const left = trip.lengthKm - planned;
  // This `Math.abs` is symmetry with `stripLayout`'s in strip-geometry.js rather than a
  // guard — the `Math.max` beside it makes the two forms equivalent for every input, so no
  // test pins it and none can. That one IS load-bearing: dropping it fails three tests,
  // two written for it and one that only breaks downstream of a false `arrived`. Do not
  // generalise from this expression to that one; they are not the same claim.
  const remaining = Math.abs(left) <= ARRIVED_EPSILON_KM ? 0 : Math.max(0, left);
  const avg = days.length ? round1(planned / days.length) : 0;
  const right = days.length
    ? `${days.length} ${days.length === 1 ? 'day' : 'days'} · ⌀ ${avg} km/day`
    : 'no days yet';
  const destination = esc(endName(state, 'destination'));
  return `
      <span><b>${round1(planned)} / ${round1(trip.lengthKm)} km planned</b> · ${round1(remaining)} km to ${destination}</span>
      <span>${right}</span>`;
}

/**
 * The axis: one block per day, each followed by its own boundary handle, then
 * the trailing remainder and the break glyphs.
 *
 * Day then its own boundary, left to right along the trip. Handles are
 * absolutely positioned and lifted by z-index, so source order costs nothing
 * visually and buys the tab order: all blocks and then all handles made a
 * keyboard user cross the whole route twice to reach day 2's end.
 *
 * @param {{days: Array<object>, focusedIndex: number|null, breaks: Array<object>}} state
 * @param {ReturnType<import('./strip-geometry.js').stripLayout>} layout
 * @param {{startKm: number, endKm: number, width: number, height: number, trip: object}} axis
 *   - the window the axis maps, plus the `createTrip()` object it was built from: the
 *     one window every km below is announced in and every x is positioned in.
 * @param {number|null} activeIndex - the boundary being dragged, or null.
 */
export function axisMarkup(state, layout, axis, activeIndex = null) {
  const elevation = elevationMarkup(axis.elevationPoints, {
    width: axis.width,
    height: axis.height,
  });
  // From the axis, not from the state: the geometry below and the km read off it are
  // then the same window by construction rather than by two callers agreeing.
  const trip = axis.trip;
  const blocks = layout.blocks
    .map((block) => {
      const day = state.days[block.index];
      const box = span(block.x, block.width);
      const focused = block.index === state.focusedIndex ? ' strip__block--focused' : '';
      const town = day.townChoice ? ` — ${day.townChoice.name}` : '';
      // Name the breaks: on a narrow day their glyphs overlap into one
      // illegible cluster, and a 5 km day is ~11 px wide.
      const marks = breaksIn(state.breaks, trip, day, block.index === 0);
      const marked = marks.length ? ` · ${marks.map((b) => `${glyphFor(b)} ${b.name}`).join(', ')}` : '';
      // Read once per block and used twice: the label carries the ascent when the block is
      // wide enough, the title carries both figures whatever the width.
      const climb = climbFor(state.elevation, day);
      const title = `Day ${block.index + 1} · ${round1(rideKm(trip, day.startKm, day.endKm))} km · km ${round1(trip.tripKm(day.startKm))} → ${round1(trip.tripKm(day.endKm))}${climbTitle(climb)}${town}${marked}`;
      return `
          <div class="strip__block${focused}" data-day-index="${block.index}" role="button" tabindex="0"
               style="left:${box.left}px;width:${box.width}px" title="${esc(title)}">
            ${blockLabelMarkup(block, day, trip, climb)}
          </div>${handleMarkup(state.days, block.index, axis, activeIndex, trip)}`;
    })
    .join('');

  const box = tailBox(layout);
  const tail =
    box.width > 0
      ? `<div class="strip__remainder" style="left:${box.left}px;width:${box.width}px">
             <button type="button" class="strip__add" data-action="add-day">+ add a day</button>
             <span class="strip__flag">⚑ ${esc(endName(state, 'destination'))}</span>
           </div>`
      : '';

  const stubs =
    stubMarkup('start', roadPast(state, 'start')) +
    stubMarkup('destination', roadPast(state, 'destination'));

  // Elevation first in source order: it and the glyph layer share z-index 1, so the
  // later one paints on top and a café pin must not disappear under the terrain fill.
  // The stubs sit outside the axis's own width, so their order costs nothing.
  return elevation + blocks + tail + glyphLayerMarkup(state.breaks, axis) + stubs;
}

/**
 * The scale line under the axis: where the TRIP starts and where it ends — and, since
 * Task 11b, the two controls that move those ends (spec §6).
 *
 * Both ends are the rider's own, named by endName — on a whole-road trip ridden
 * downstream that means the two road names swap places, because the rider starts at
 * Prague. `arrived` is arrival at the trip's destination, which is what the remainder's
 * width has meant since stripLayout started measuring the window.
 *
 * The finish marker lives here rather than on the axis: at right: 0 over a
 * collapsed remainder it sat on top of the last block and underneath the last
 * handle. It says `⚑ reached` and nothing more, because the end it is about is named
 * by the control it stands beside: turning that flag into the button would put a
 * control inside a status, and repeating `km 648.3 · Dresden` beside itself would be
 * the same fact twice on a 10px line.
 */
export function scaleMarkup(state, layout) {
  const arrived = state.days.length > 0 && tailBox(layout).width <= 0;
  // Deliberately NOT escaped here any more: endControlMarkup escapes the name itself,
  // once, into two places (its own text and its aria-label). Escaping first would
  // render `&amp;amp;`.
  const origin = endName(state, 'start');
  const destination = endName(state, 'destination');
  // The vertical range, whenever a profile is drawn. Not decoration: this corridor
  // falls from sea level to 184 m over 1026 km, so the profile is exaggerated
  // roughly 500:1, and an unlabelled exaggerated profile invites reading a 30 m
  // river terrace as a climb.
  //
  // It is the whole ROAD's range even though the axis now draws one window, because
  // that range is the vertical SCALE — fixing it is what keeps two windows, and two
  // days, comparable. The title says so, since the number no longer describes the
  // stretch on screen.
  const profile = state.elevation;
  const range =
    profile && Number.isFinite(profile.minM) && Number.isFinite(profile.maxM)
      ? `<span class="strip__range" title="Elevation range along the whole route — the profile's vertical scale, fixed so that days and trips stay comparable. It is exaggerated to make this relief visible.">↕ ${Math.round(profile.minM)}–${Math.round(profile.maxM)} m</span>`
      : '';
  // km 0 needs no conversion: the left end of the scale IS the rider's start, which is
  // rider km 0 whatever absolute km it sits at. The right end is how far they ride —
  // the trip's length, not the road's.
  //
  // The finish control renders either way, arrived or not: a finished trip still has an
  // end its rider may want to move, and a control that vanished on arrival would be one
  // more state in which the app can only be argued with.
  return (
    endControlMarkup(state, 'start', 0, origin) +
    range +
    endControlMarkup(state, 'destination', round1(state.trip.lengthKm), destination) +
    (arrived ? `<span class="strip__finish">⚑ reached</span>` : '')
  );
}
