// Pure boundary math, shared by the itinerary model and the timeline strip's
// live drag preview. A plan's days are stored as lengths (targetKm); a
// *boundary* is where a day ends — the cumulative sum of lengths up to it.
//
// Editing is local: moving boundary i changes days i and i+1 only, so the rest
// of the trip (and every overnight town past it) stays put.
//
// Every km crossing this file's edge — in the days, in a proposed position, in the
// bounds returned — is ABSOLUTE route km. The arithmetic in between happens in RIDER
// km (0 at the trip's start, always ascending towards the destination), so the
// ordering logic below is the same whichever way the trip runs and the direction
// lives in the two conversions only. Sprinkling `* trip.direction` through the
// comparisons instead is what makes sign bugs.

/** Shortest day we allow, in km. A boundary can never squeeze past this. */
export const MIN_DAY_KM = 5;

/**
 * How close to the end of the route counts as having arrived, in km.
 *
 * Boundary edits quantize to the 0.1 km grid while the real route is a fractional
 * length (1026.5 km today), so a finished plan stops a few tens of metres short of
 * the destination rather than exactly on it. Every part of the
 * screen must agree on that: the strip collapsing its remainder while the day
 * panel still offers "142 m left to ride" is one plan contradicting itself.
 */
export const ARRIVED_EPSILON_KM = 0.5;

/**
 * The km window boundary `index` may be moved to, in ABSOLUTE route km.
 *
 * The lower bound keeps day `index` at least `minDayKm` long. The upper bound
 * keeps the NEXT day at least `minDayKm` long — except for the last boundary,
 * which has no next day and may run to the trip's destination (moving it extends
 * or shrinks the plan itself).
 *
 * **The bounds come back in TRIP order, not numeric order:** `min` is the closest
 * legal position to the rider's start and `max` the farthest along the trip, so on a
 * DOWNSTREAM trip `min` is the numerically LARGER absolute km. A caller that needs
 * them numerically ordered sorts them itself — `strip-markup.js` does, because
 * `aria-valuemin > aria-valuemax` is undefined behaviour for a screen reader.
 * Ordering them here instead would put the answer in road order and lose which end
 * is the rider's own floor, which is the thing every caller actually asks about.
 *
 * @param {Array<{startKm: number, endKm: number}>} days - absolute km
 * @param {number} index - 0-based day index
 * @param {{trip: object, minDayKm?: number}} opts - trip from createTrip()
 * @returns {{min: number, max: number}} - max is never *behind* min along the trip,
 *   so a squeezed day yields a single reported position rather than an inverted
 *   window. That position may be unreachable; see boundaryWindow.
 */
export function boundaryBounds(days, index, { trip, minDayKm = MIN_DAY_KM } = {}) {
  const { min, max } = riderBounds(days, index, { trip, minDayKm });
  return { min: trip.absoluteKm(min), max: trip.absoluteKm(max) };
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
 * Absolute km, TRIP-ordered, exactly as `boundaryBounds` returns them.
 *
 * @returns {{min: number, max: number}|null}
 */
export function boundaryWindow(days, index, { trip, minDayKm = MIN_DAY_KM } = {}) {
  const { min, max } = rawRiderBounds(days, index, { trip, minDayKm });
  return min > max ? null : { min: trip.absoluteKm(min), max: trip.absoluteKm(max) };
}

/**
 * `km` clamped into boundaryBounds(days, index, opts) — absolute km in, absolute
 * km out.
 *
 * The clamp happens in rider km like everything else here, which is what keeps it
 * right downstream: `Math.min/Math.max` on the trip-ordered absolute bounds would
 * pull a km towards the road's origin rather than towards the rider's.
 */
export function clampBoundaryKm(days, index, km, { trip, minDayKm = MIN_DAY_KM } = {}) {
  const { min, max } = riderBounds(days, index, { trip, minDayKm });
  return trip.absoluteKm(Math.min(Math.max(trip.tripKm(km), min), max));
}

// The days as the rider counts them, and the guard every export runs first — pairing
// the two is what makes it impossible for one of them to skip it.
//
// The trip is duck-typed the way itinerary.js duck-types its own, and all three
// members are checked because all three are load-bearing: tripKm converts in,
// absoluteKm converts out, and lengthKm IS the last boundary's upper bound. Fail on
// first use rather than on the last boundary only: an incomplete trip would otherwise
// return correct windows everywhere except the final day, and the NaN it produced
// there gets persisted rather than thrown.
//
// A finite lengthKm is part of that check, which retires the old `{ totalKm: Infinity }`
// tolerance — a trip built by createTrip always knows how long it is, so an infinite
// length can only be a stub, and it NaNs precisely the boundary this guard protects.
function riderDays(days, trip) {
  if (
    !trip ||
    typeof trip.tripKm !== 'function' ||
    typeof trip.absoluteKm !== 'function' ||
    !Number.isFinite(trip.lengthKm)
  ) {
    throw new Error(`boundaries need a trip with tripKm/absoluteKm/lengthKm, got: ${trip}`);
  }
  return days.map((day) => ({ startKm: trip.tripKm(day.startKm), endKm: trip.tripKm(day.endKm) }));
}

// Absolute days in, unfloored RIDER-km window out: the one composition all three
// exports go through, so none of them can spell the conversion differently.
function rawRiderBounds(days, index, { trip, minDayKm }) {
  return rawBounds(riderDays(days, trip), index, { lengthKm: trip.lengthKm, minDayKm });
}

// The floored window in RIDER km: max never behind min. The flooring stays in rider
// km — `Math.max` on absolute km would pick the larger NUMBER, which downstream is
// the inverted window's illegal end.
function riderBounds(days, index, opts) {
  const { min, max } = rawRiderBounds(days, index, opts);
  return { min, max: Math.max(min, max) };
}

// The window before the floor, in RIDER km, where min > max still means "no legal
// position". The rider's own start is km 0 here, which is why the hardcoded 0 origin
// below is exactly right — and why handing this absolute km from an offset or
// downstream trip used to put the floor behind the rider.
function rawBounds(days, index, { lengthKm, minDayKm }) {
  const prevEnd = index === 0 ? 0 : days[index - 1].endKm;
  const isLast = index === days.length - 1;
  return {
    min: prevEnd + minDayKm,
    // The last boundary has no next day to squeeze, so it may run to the end of
    // the trip: moving it extends or shrinks the plan itself.
    max: isLast ? lengthKm : days[index + 1].endKm - minDayKm,
  };
}
