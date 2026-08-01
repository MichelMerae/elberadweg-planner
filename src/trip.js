// The trip: an oriented window on the road. A startKm, a destinationKm, and the
// arithmetic that follows from their order.
//
// THE INVARIANT THIS FILE EXISTS TO PROTECT: stored and computed km are absolute
// route km; only DISPLAYED km are relative to the rider's start. tripKm() is the
// one-way conversion, and it belongs to markup-producing code only.
//
// direction is derived once, here, because itinerary, boundaries, strip-geometry,
// elevation and every display site all need it — and six copies of
// `destinationKm >= startKm ? 1 : -1` is six chances to get an equal-km edge wrong.

export function createTrip({ startKm = 0, destinationKm, totalKm } = {}) {
  const start = Number.isFinite(startKm) ? startKm : 0;
  const end = Number.isFinite(destinationKm)
    ? destinationKm
    : Number.isFinite(totalKm)
      ? totalKm
      : 0;

  // An equal-ended window has no direction to derive; forward keeps every
  // consumer's sign arithmetic defined rather than producing 0 and NaN downstream.
  const direction = end >= start ? 1 : -1;
  const lengthKm = Math.abs(end - start);
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);

  return Object.freeze({
    startKm: start,
    destinationKm: end,
    direction,
    lengthKm,

    /** Absolute route km -> km as the rider counts it, from their own start. */
    tripKm: (absoluteKm) => (absoluteKm - start) * direction,

    /** km as the rider counts it -> absolute route km. */
    absoluteKm: (riderKm) => start + riderKm * direction,

    contains: (absoluteKm) => absoluteKm >= lo && absoluteKm <= hi,

    clampKm: (absoluteKm) => Math.min(Math.max(absoluteKm, lo), hi),

    /** Move `distanceKm` further along the trip, never past the destination. */
    advance: (absoluteKm, distanceKm) => {
      const next = absoluteKm + distanceKm * direction;
      return direction === 1 ? Math.min(next, end) : Math.max(next, end);
    },
  });
}

/** Whether swapping to these ends would reverse an existing trip's direction. */
export function wouldReverse(trip, { startKm = trip.startKm, destinationKm = trip.destinationKm }) {
  return createTrip({ startKm, destinationKm }).direction !== trip.direction;
}
