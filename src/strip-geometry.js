// Pure geometry for the bottom timeline strip: no DOM, no Leaflet, no data
// modules. The strip maps the WHOLE route onto the axis width, so every km has
// exactly one x and 650 km always fits — the strip can never overflow.

import { ARRIVED_EPSILON_KM } from './boundaries.js';

const TIER_FULL_PX = 64;   // number + km + break glyphs
const TIER_KM_PX = 30;     // number + km
const TIER_NUMBER_PX = 14; // number only
const HANDLE_TOLERANCE_PX = 12;

function positive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Route km -> x on the axis, clamped to the axis. */
export function kmToX(km, { totalKm, width } = {}) {
  if (!positive(totalKm) || !positive(width) || !Number.isFinite(km)) return 0;
  const clamped = Math.min(Math.max(km, 0), totalKm);
  return (clamped / totalKm) * width;
}

/** x on the axis -> route km, clamped to the route. */
export function xToKm(x, { totalKm, width } = {}) {
  if (!positive(totalKm) || !positive(width) || !Number.isFinite(x)) return 0;
  const clamped = Math.min(Math.max(x, 0), width);
  return (clamped / width) * totalKm;
}

/**
 * How much label a block of `width` px can carry. A 5 km day is ~11 px wide on
 * a 1400 px axis, so labels must degrade rather than overflow.
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
 * A block's `width` can be NEGATIVE for an inverted day (endKm before startKm),
 * which the model can transiently hold on pathological stored data. That is
 * deliberate: `x + width` must keep equalling `kmToX(endKm)` so handle positions
 * stay truthful. **Renderers clamp width at zero; hit-testing relies on the sum.**
 *
 * @param {Array<{startKm: number, endKm: number}>} days
 * @param {{totalKm: number, width: number}} opts
 * @returns {{blocks: Array<{index: number, x: number, width: number, startKm: number, endKm: number, tier: string}>,
 *            remainder: {x: number, width: number, startKm: number, endKm: number}}}
 */
export function stripLayout(days, { totalKm, width } = {}) {
  const list = Array.isArray(days) ? days : [];
  const blocks = list.map((day, index) => {
    const x = kmToX(day.startKm, { totalKm, width });
    const w = kmToX(day.endKm, { totalKm, width }) - x;
    return { index, x, width: w, startKm: day.startKm, endKm: day.endKm, tier: labelTier(w) };
  });
  const plannedKm = list.length ? list[list.length - 1].endKm : 0;
  const x = kmToX(plannedKm, { totalKm, width });
  const axisWidth = positive(width) ? width : 0;
  // Within the arrival tolerance the plan counts as finished, so the remainder
  // collapses rather than leaving a permanent one-pixel dashed sliver with an
  // "+ add a day" button inside it (see ARRIVED_EPSILON_KM).
  const arrived = totalKm - plannedKm <= ARRIVED_EPSILON_KM;
  const remainderWidth = arrived ? 0 : Math.max(0, axisWidth - x);
  return {
    blocks,
    remainder: { x, width: remainderWidth, startKm: plannedKm, endKm: totalKm },
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
