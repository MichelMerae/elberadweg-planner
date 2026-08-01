// Pure geometry for the bottom timeline strip: no DOM, no Leaflet, no data
// modules. The strip maps the TRIP's window onto the axis width — the rider's own
// start at x 0 and their destination at the full width — so every km of the ride has
// exactly one x and the whole ride always fits. The strip can never overflow.
//
// The window is an ORIENTED pair, `{startKm, endKm}` in trip order, and one expression
// serves both directions: a descending window (endKm < startKm, riding downstream)
// makes the denominator negative and the mapping still runs left to right in trip
// order. Nothing in this file re-derives a direction, and nothing needs to.
//
// The km crossing this file's edge are ABSOLUTE route km, as everywhere else; the
// window is the pair of absolute km the axis happens to span. Road OUTSIDE the window
// has no x at all — it is clamped onto the nearer end — which is why strip-markup draws
// the road past a trip end as a stub beside the axis rather than as part of it.

import { ARRIVED_EPSILON_KM } from './boundaries.js';

// Measured in Chromium at the real 11px Archivo, worst case a two-digit day
// number, and including the label's 12px padding and the block's 2px border:
// "12" needs 27.1px and "12 30.5 km" needs 68.8px. (A three-digit day number
// needs 75.1px, so it clips at the km tier's lower edge — that takes a plan of
// 100+ days, which on a 650 km route means every day near the 5 km minimum.)
// The 'full' threshold is the one judgement rather than a measurement: its first
// line is the km tier's, and the 18px above it are so the second line has room
// to say something about the town before the ellipsis bites.
const TIER_FULL_PX = 88;   // number + km, plus the town line and break glyphs
const TIER_KM_PX = 70;     // number + km
const TIER_NUMBER_PX = 28; // number only
const HANDLE_TOLERANCE_PX = 12;

function positive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Whether an oriented window is usable: two finite ends and a real width. */
function drawable({ startKm, endKm, width }) {
  return positive(width) && Number.isFinite(startKm) && Number.isFinite(endKm);
}

/** Absolute route km -> x on the axis, clamped to the trip window. */
export function kmToX(km, { startKm = 0, endKm, width } = {}) {
  if (!drawable({ startKm, endKm, width }) || !Number.isFinite(km)) return 0;
  const span = endKm - startKm;
  // A zero-length window has one x for every km, and dividing by its span would
  // put NaN into a CSS length.
  if (span === 0) return 0;
  const lo = Math.min(startKm, endKm);
  const hi = Math.max(startKm, endKm);
  const clamped = Math.min(Math.max(km, lo), hi);
  const x = ((clamped - startKm) / span) * width;
  // A descending window divides by a negative span, so its own start comes out as -0.
  // Harmless in a CSS length, but -0 is not 0 under Object.is and a caller asking
  // whether an x is the axis's left edge deserves a straight answer.
  return x === 0 ? 0 : x;
}

/** x on the axis -> absolute route km, clamped to the trip window. */
export function xToKm(x, { startKm = 0, endKm, width } = {}) {
  if (!drawable({ startKm, endKm, width }) || !Number.isFinite(x)) return 0;
  const clamped = Math.min(Math.max(x, 0), width);
  // No zero-span special case needed: every x of a zero-length window really is its
  // one km, which is what this already returns.
  return startKm + (clamped / width) * (endKm - startKm);
}

/**
 * How much label a block of `width` px can carry. A 5 km day is ~11 px wide on a
 * 1400 px axis spanning the whole road, so labels must degrade rather than overflow.
 * A narrower window is only ever kinder — the axis maps the trip, so every day of a
 * 200 km trip gets five times the px it had when the axis mapped 1000 km of road.
 * @returns {'full'|'km'|'number'|'none'}
 */
export function labelTier(width) {
  if (width >= TIER_FULL_PX) return 'full';
  if (width >= TIER_KM_PX) return 'km';
  if (width >= TIER_NUMBER_PX) return 'number';
  return 'none';
}

/**
 * Pixel layout for the strip: one block per day plus the trailing unplanned
 * remainder. Blocks are to scale, and contiguous as long as the caller passes
 * a properly chained day list (which the itinerary model guarantees).
 *
 * Everything here is measured against the WINDOW, not the road: the remainder runs
 * from the last day's end to the trip's own destination, and `arrived` compares
 * distances so a downstream plan finishes at the same tolerance a forward one does.
 * Measured against the road instead, a 648 km trip on a 1026 km road could never
 * finish — the axis kept drawing a remainder with "+ add a day" in it while the
 * summary above already read "0 km to Prague".
 *
 * A block's `width` can be NEGATIVE for an inverted day (a day whose end lies BEHIND
 * its start along the trip), which the model can transiently hold on pathological
 * stored data. That is deliberate: `x + width` must keep equalling `kmToX(endKm)` so
 * handle positions stay truthful. **Renderers clamp width at zero; hit-testing relies
 * on the sum.** A properly chained downstream day is not inverted — its absolute km
 * descend, and so does the window it is measured in.
 *
 * @param {Array<{startKm: number, endKm: number}>} days - absolute km, in trip order
 * @param {{startKm: number, endKm: number, width: number}} opts - the trip's window
 * @returns {{blocks: Array<{index: number, x: number, width: number, startKm: number, endKm: number, tier: string}>,
 *            remainder: {x: number, width: number, startKm: number, endKm: number}}}
 */
export function stripLayout(days, { startKm = 0, endKm, width } = {}) {
  const window = { startKm, endKm, width };
  const list = Array.isArray(days) ? days : [];
  const blocks = list.map((day, index) => {
    const x = kmToX(day.startKm, window);
    const w = kmToX(day.endKm, window) - x;
    return { index, x, width: w, startKm: day.startKm, endKm: day.endKm, tier: labelTier(w) };
  });
  // An empty plan has reached the rider's own start, not the road's origin.
  const plannedKm = list.length ? list[list.length - 1].endKm : startKm;
  const x = kmToX(plannedKm, window);
  const axisWidth = positive(width) ? width : 0;
  // Within the arrival tolerance the plan counts as finished, so the remainder
  // collapses rather than leaving a permanent one-pixel dashed sliver with an
  // "+ add a day" button inside it (see ARRIVED_EPSILON_KM). A distance, not a signed
  // difference: downstream the subtraction runs the other way.
  const arrived = drawable(window) && Math.abs(endKm - plannedKm) <= ARRIVED_EPSILON_KM;
  const remainderWidth = arrived ? 0 : Math.max(0, axisWidth - x);
  return {
    blocks,
    remainder: { x, width: remainderWidth, startKm: plannedKm, endKm },
  };
}

/**
 * Index of the boundary handle within `tolerance` px of `x`, or null. Handles
 * sit at each block's right edge; when two are crowded together the nearer one
 * wins.
 */
export function hitTestHandle(x, layout, { tolerance = HANDLE_TOLERANCE_PX } = {}) {
  let best = null;
  for (const block of layout.blocks || []) {
    const dist = Math.abs(x - (block.x + block.width));
    if (dist <= tolerance && (best === null || dist < best.dist)) best = { index: block.index, dist };
  }
  return best ? best.index : null;
}
