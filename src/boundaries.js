// Pure boundary math, shared by the itinerary model and the timeline strip's
// live drag preview. A plan's days are stored as lengths (targetKm); a
// *boundary* is where a day ends — the cumulative sum of lengths up to it.
//
// Editing is local: moving boundary i changes days i and i+1 only, so the rest
// of the trip (and every overnight town past it) stays put.

/** Shortest day we allow, in km. A boundary can never squeeze past this. */
export const MIN_DAY_KM = 5;

/**
 * The km window boundary `index` may be moved to.
 *
 * The lower bound keeps day `index` at least `minDayKm` long. The upper bound
 * keeps the NEXT day at least `minDayKm` long — except for the last boundary,
 * which has no next day and may run to the end of the route (moving it extends
 * or shrinks the plan itself).
 *
 * @param {Array<{startKm: number, endKm: number}>} days
 * @param {number} index - 0-based day index
 * @param {{totalKm: number, minDayKm?: number}} opts
 * @returns {{min: number, max: number}} - max is never below min, so a squeezed
 *   day yields a single legal position rather than an inverted window.
 */
export function boundaryBounds(days, index, { totalKm, minDayKm = MIN_DAY_KM } = {}) {
  // Fail on first use, not just on the last boundary: a forgotten totalKm
  // would otherwise return correct windows everywhere except the final day,
  // and the NaN it produced there gets persisted rather than thrown. Infinity
  // is legitimate — an itinerary without a route length is unclamped above.
  if (typeof totalKm !== 'number' || Number.isNaN(totalKm)) {
    throw new Error(`boundaryBounds needs a numeric totalKm, got: ${totalKm}`);
  }
  const prevEnd = index === 0 ? 0 : days[index - 1].endKm;
  const isLast = index === days.length - 1;
  const min = prevEnd + minDayKm;
  const max = isLast ? totalKm : days[index + 1].endKm - minDayKm;
  return { min, max: Math.max(min, max) };
}

/** `km` clamped into boundaryBounds(days, index, opts). */
export function clampBoundaryKm(days, index, km, opts) {
  const { min, max } = boundaryBounds(days, index, opts);
  return Math.min(Math.max(km, min), max);
}
