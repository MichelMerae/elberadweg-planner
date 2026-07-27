// Pure boundary math, shared by the itinerary model and the timeline strip's
// live drag preview. A plan's days are stored as lengths (targetKm); a
// *boundary* is where a day ends — the cumulative sum of lengths up to it.
//
// Editing is local: moving boundary i changes days i and i+1 only, so the rest
// of the trip (and every overnight town past it) stays put.

/** Shortest day we allow, in km. A boundary can never squeeze past this. */
export const MIN_DAY_KM = 5;

/**
 * How close to the end of the route counts as having arrived, in km.
 *
 * Boundary edits quantize to the 0.1 km grid while the real route is 650.24 km
 * long, so a finished plan stops ~0.04 km short of Dresden. Every part of the
 * screen must agree on that: the strip collapsing its remainder while the day
 * panel still offers "142 m left to ride" is one plan contradicting itself.
 */
export const ARRIVED_EPSILON_KM = 0.5;

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
 *   day yields a single reported position rather than an inverted window. That
 *   position may be unreachable; see boundaryWindow.
 */
export function boundaryBounds(days, index, opts = {}) {
  const { min, max } = rawBounds(days, index, opts);
  return { min, max: Math.max(min, max) };
}

// The window before the floor, where min > max still means "no legal position".
// Both public views are derived from this one computation so they cannot drift.
function rawBounds(days, index, { totalKm, minDayKm = MIN_DAY_KM } = {}) {
  // Fail on first use, not just on the last boundary: a forgotten totalKm
  // would otherwise return correct windows everywhere except the final day,
  // and the NaN it produced there gets persisted rather than thrown. Infinity
  // is legitimate — an itinerary without a route length is unclamped above.
  if (typeof totalKm !== 'number' || Number.isNaN(totalKm)) {
    throw new Error(`boundaryBounds needs a numeric totalKm, got: ${totalKm}`);
  }
  const prevEnd = index === 0 ? 0 : days[index - 1].endKm;
  const isLast = index === days.length - 1;
  return {
    min: prevEnd + minDayKm,
    // The last boundary has no next day to squeeze, so it may run to the end of
    // the route: moving it extends or shrinks the plan itself.
    max: isLast ? totalKm : days[index + 1].endKm - minDayKm,
  };
}

/**
 * The window boundary `index` may be moved within, or **null** when it has
 * nowhere legal to go — the one definition of that condition.
 *
 * A pair of days spanning less than 2 x minDayKm cannot hold a boundary between
 * them at all: both halves would have to be at least minDayKm long and there is
 * not that much route between the neighbours. `boundaryBounds` still reports a
 * window there, because a `role="slider"` has to describe itself with
 * aria-valuemin <= aria-valuemax whatever the plan looks like — but that single
 * floored position is itself a move the model refuses.
 *
 * So: a caller deciding whether to ASK for a move wants this function, and a
 * caller describing the window wants `boundaryBounds`. Reading "nowhere to go"
 * off the floored window (`min >= max`) is the subtly wrong version — it also
 * refuses a pair spanning exactly 2 x minDayKm, whose midpoint is legal.
 *
 * @returns {{min: number, max: number}|null}
 */
export function boundaryWindow(days, index, opts = {}) {
  const { min, max } = rawBounds(days, index, opts);
  return min > max ? null : { min, max };
}

/** `km` clamped into boundaryBounds(days, index, opts). */
export function clampBoundaryKm(days, index, km, opts) {
  const { min, max } = boundaryBounds(days, index, opts);
  return Math.min(Math.max(km, min), max);
}
