// The timeline strip's markup. Every export here is a pure function of the
// state, layout and axis width handed to it — no DOM, no listeners, no module
// state — so the whole visual layer can be exercised without mounting anything.
// strip.js keeps the state machine (drag, keyboard, focus restoration) and owns
// the only innerHTML writes.
//
// The three exports are the three regions render() writes: the summary line, the
// axis, and the scale line.

import { esc, round1, glyphFor } from './ui-util.js';
import { boundaryBounds } from './boundaries.js';
import { kmToX } from './strip-geometry.js';

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

// The trailing unplanned stretch as it will be drawn. Both the axis (does the
// remainder get a box at all?) and the scale line (has the trip arrived?) turn
// on the same rounded width, so it is derived once.
function tailBox(layout) {
  return span(layout.remainder.x, layout.remainder.width);
}

// Breaks inside (startKm, endKm]. Day 1 starts at km 0 and owns a break sitting
// exactly there, which is why the lower edge opens up for it.
function breaksIn(breaks, startKm, endKm) {
  return breaks.filter(
    (b) => b.routeDistanceKm > (startKm === 0 ? -1 : startKm) && b.routeDistanceKm <= endKm,
  );
}

/**
 * One glyph layer for the whole axis, each break at its absolute route km.
 *
 * These used to be children of the day they fell in, which cost three things: a
 * block's `overflow: hidden` clipped them, every offset needed the block's own
 * rendered left edge subtracted (a whole class of off-by-a-block bug), and they
 * were gated behind the widest label tier — 88 px, about 39 km at desktop
 * width — so a 20 km day with a café silently showed nothing. At axis level
 * they work at every tier. They are pointer-events: none, so clicks still reach
 * the block underneath.
 */
function glyphLayerMarkup(breaks, axis) {
  return breaks
    .filter(
      (b) =>
        Number.isFinite(b.routeDistanceKm) && b.routeDistanceKm >= 0 && b.routeDistanceKm <= axis.totalKm,
    )
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

function blockLabelMarkup(block, day) {
  const km = `${round1(day.endKm - day.startKm)} km`;
  const town = day.townChoice ? `<span class="strip__block-town">🛏 ${esc(day.townChoice.name)}</span>` : '';
  if (block.tier === 'full') {
    return `<span class="strip__block-label"><b>${block.index + 1}</b> <span class="strip__block-km">${km}</span>${town}</span>`;
  }
  if (block.tier === 'km') {
    return `<span class="strip__block-label"><b>${block.index + 1}</b> <span class="strip__block-km">${km}</span></span>`;
  }
  if (block.tier === 'number') {
    return `<span class="strip__block-label"><b>${block.index + 1}</b></span>`;
  }
  return '';
}

/**
 * One boundary handle: a role="slider" button at the day's end km.
 *
 * `activeIndex` is the boundary currently being dragged, or null. The dragging
 * class is re-derived on every render rather than set on the node, because the
 * node this class belongs to is destroyed by the drag's first preview.
 */
function handleMarkup(days, index, axis, activeIndex) {
  const day = days[index];
  const bounds = boundaryBounds(days, index, { totalKm: axis.totalKm });
  // A slider's value has to lie inside the range it reports, and on squeezed
  // stored data it did not: hand-edited days of 10 and 2 km put boundary 0 at
  // km 10 with a legal window of [5, 7]. Widening the reported range to contain
  // the value keeps the announcement coherent (an out-of-range valuenow is
  // undefined behaviour for a screen reader), and it is a no-op for every
  // well-formed plan — MIN_DAY_KM on both neighbours puts endKm inside [min, max]
  // by construction. The model still refuses the moves it always refused.
  const min = Math.min(bounds.min, day.endKm);
  const max = Math.max(bounds.max, day.endKm);
  const x = kmToX(day.endKm, axis);
  const town = day.townChoice ? ` (${day.townChoice.name})` : '';
  const label = `Day ${index + 1} end, km ${round1(day.endKm)}${town}, arrow keys adjust`;
  const active = activeIndex === index ? ' strip__handle--dragging' : '';
  return `
      <button type="button" class="strip__handle${active}" data-boundary-index="${index}"
              style="left:${round1(x)}px" role="slider" tabindex="0"
              aria-valuenow="${round1(day.endKm)}" aria-valuemin="${round1(min)}" aria-valuemax="${round1(max)}"
              aria-label="${esc(label)}" title="${esc(label)}"></button>`;
}

// Neutral stand-ins for the endpoint names. The corridor is data — it grew from
// Hamburg → Dresden to Cuxhaven → Prague and will change again — so no place name
// belongs in this module. These are what it says when mounted without names, which
// the tests do and which must not read as "undefined".
const ORIGIN_FALLBACK = 'start';
const DESTINATION_FALLBACK = 'finish';

/** The line above the axis: how far the plan reaches, and the average day. */
export function summaryMarkup({ days, totalKm, destinationName }) {
  const planned = days.length ? days[days.length - 1].endKm : 0;
  const remaining = Math.max(0, totalKm - planned);
  const avg = days.length ? round1(planned / days.length) : 0;
  const right = days.length
    ? `${days.length} ${days.length === 1 ? 'day' : 'days'} · ⌀ ${avg} km/day`
    : 'no days yet';
  const destination = esc(destinationName ?? DESTINATION_FALLBACK);
  return `
      <span><b>${round1(planned)} / ${round1(totalKm)} km planned</b> · ${round1(remaining)} km to ${destination}</span>
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
 * @param {{days: Array<object>, totalKm: number, focusedIndex: number|null, breaks: Array<object>}} state
 * @param {ReturnType<import('./strip-geometry.js').stripLayout>} layout
 * @param {{totalKm: number, width: number}} axis
 * @param {number|null} activeIndex - the boundary being dragged, or null.
 */
export function axisMarkup(state, layout, axis, activeIndex = null) {
  const elevation = elevationMarkup(axis.elevationPoints, {
    width: axis.width,
    height: axis.height,
  });
  const blocks = layout.blocks
    .map((block) => {
      const day = state.days[block.index];
      const box = span(block.x, block.width);
      const focused = block.index === state.focusedIndex ? ' strip__block--focused' : '';
      const town = day.townChoice ? ` — ${day.townChoice.name}` : '';
      // Name the breaks: on a narrow day their glyphs overlap into one
      // illegible cluster, and a 5 km day is ~11 px wide.
      const marks = breaksIn(state.breaks, day.startKm, day.endKm);
      const marked = marks.length ? ` · ${marks.map((b) => `${glyphFor(b)} ${b.name}`).join(', ')}` : '';
      const title = `Day ${block.index + 1} · ${round1(day.endKm - day.startKm)} km · km ${round1(day.startKm)} → ${round1(day.endKm)}${town}${marked}`;
      return `
          <div class="strip__block${focused}" data-day-index="${block.index}" role="button" tabindex="0"
               style="left:${box.left}px;width:${box.width}px" title="${esc(title)}">
            ${blockLabelMarkup(block, day)}
          </div>${handleMarkup(state.days, block.index, axis, activeIndex)}`;
    })
    .join('');

  const box = tailBox(layout);
  const tail =
    box.width > 0
      ? `<div class="strip__remainder" style="left:${box.left}px;width:${box.width}px">
             <button type="button" class="strip__add" data-action="add-day">+ add a day</button>
             <span class="strip__flag">⚑ ${esc(state.destinationName ?? DESTINATION_FALLBACK)}</span>
           </div>`
      : '';

  // Elevation first in source order: it and the glyph layer share z-index 1, so the
  // later one paints on top and a café pin must not disappear under the terrain fill.
  return elevation + blocks + tail + glyphLayerMarkup(state.breaks, axis);
}

/**
 * The scale line under the axis: where the route starts and where it ends.
 *
 * The finish marker lives here rather than on the axis: at right: 0 over a
 * collapsed remainder it sat on top of the last block and underneath the last
 * handle. The scale line already names the destination, so it says "reached"
 * instead.
 */
export function scaleMarkup(state, layout) {
  const arrived = state.days.length > 0 && tailBox(layout).width <= 0;
  const origin = esc(state.originName ?? ORIGIN_FALLBACK);
  const destination = esc(state.destinationName ?? DESTINATION_FALLBACK);
  // The vertical range, whenever a profile is drawn. Not decoration: this corridor
  // falls from sea level to 184 m over 1026 km, so the profile is exaggerated
  // roughly 500:1, and an unlabelled exaggerated profile invites reading a 30 m
  // river terrace as a climb.
  const profile = state.elevation;
  const range =
    profile && Number.isFinite(profile.minM) && Number.isFinite(profile.maxM)
      ? `<span class="strip__range" title="Elevation range along the whole route. The profile's vertical scale is exaggerated to make this relief visible.">↕ ${Math.round(profile.minM)}–${Math.round(profile.maxM)} m</span>`
      : '';
  return (
    `<span>km 0 · ${origin}</span>` +
    range +
    (arrived
      ? `<span class="strip__finish">⚑ km ${round1(state.totalKm)} · ${destination} reached</span>`
      : `<span>km ${round1(state.totalKm)} · ${destination}</span>`)
  );
}
