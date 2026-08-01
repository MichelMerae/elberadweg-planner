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
//
// Non-finite km are the constructor's problem, not the methods'. createTrip repairs
// what it can (a missing start is km 0), rejects what it cannot (a trip with no end
// at all) and pulls both ends onto the road; the returned methods then assume finite
// km and leave callers to guard their own input — the same split strip-geometry
// makes by checking at ITS entry points rather than inside every formula.

export function createTrip({ startKm = 0, destinationKm, totalKm } = {}) {
  // A trip has to go somewhere. Defaulting the destination to km 0 would turn a
  // half-specified trip into a silently REVERSED one — `{startKm: 500}` becoming a
  // 500 km ride back to Cuxhaven — and every day in it would then collapse against
  // that invented end. Equal ends remain legal: a zero-length window is a choice,
  // a missing end is a bug.
  if (!Number.isFinite(destinationKm) && !Number.isFinite(totalKm)) {
    throw new Error('createTrip needs a finite destinationKm or totalKm');
  }

  // null rather than undefined for an unknown road length: a trip is persisted, and
  // JSON keeps an explicit null while it drops an undefined key entirely.
  const total = Number.isFinite(totalKm) ? totalKm : null;
  const onRoad = (km) => (total === null ? km : Math.min(Math.max(km, 0), total));

  // Both ends clamped into [0, totalKm] when the road length is known, and clamped
  // BEFORE direction and length are derived so that all of them describe the window
  // the trip actually has rather than the one that was asked for. With no totalKm
  // there is nothing to clamp against — the road's length is simply unknown here.
  const start = onRoad(Number.isFinite(startKm) ? startKm : 0);
  const end = onRoad(Number.isFinite(destinationKm) ? destinationKm : total);

  // An equal-ended window has no direction to derive; forward keeps every
  // consumer's sign arithmetic defined rather than producing 0 and NaN downstream.
  const direction = end >= start ? 1 : -1;
  const lengthKm = Math.abs(end - start);
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);

  return Object.freeze({
    startKm: start,
    destinationKm: end,
    /** The road's length, or **null** when this trip was never told one. */
    totalKm: total,
    direction,
    lengthKm,

    /**
     * Absolute route km -> km as the rider counts it, from their own start.
     *
     * Unclamped and signed: a place behind the start reads negative and a place
     * past the destination reads beyond lengthKm. Clamping here would quietly move
     * an off-trip favorite onto the start line; saying "12 km behind you" is the
     * display layer's job, not this one's.
     */
    tripKm: (absoluteKm) => (absoluteKm - start) * direction,

    /** km as the rider counts it -> absolute route km. */
    absoluteKm: (riderKm) => start + riderKm * direction,

    /**
     * Whether an absolute km lies in the window, INCLUSIVE of both endpoints.
     *
     * Deliberately not itinerary's half-open `(startKm, endKm]` day-bucketing rule.
     * That convention exists so two adjacent days cannot both claim the km they
     * share; a window has no neighbour to share an end with, and both of the
     * rider's own endpoints are on their trip. A window is not a day.
     */
    contains: (absoluteKm) => absoluteKm >= lo && absoluteKm <= hi,

    /**
     * `absoluteKm` pulled into the window — inclusive of both endpoints too, so
     * every clamped km satisfies contains().
     */
    clampKm: (absoluteKm) => Math.min(Math.max(absoluteKm, lo), hi),

    /**
     * Move `distanceKm` further along the trip, never past the destination.
     *
     * `distanceKm` is a positive distance ridden, counted the rider's way: the
     * heading is the trip's, so the same call works in both directions. Callers
     * validate their own distances (see itinerary's `assertValidTargetKm`) — a
     * negative one here simply rides backwards, which nothing asks for.
     */
    advance: (absoluteKm, distanceKm) => {
      const next = absoluteKm + distanceKm * direction;
      return direction === 1 ? Math.min(next, end) : Math.max(next, end);
    },
  });
}

/**
 * Whether swapping to these ends would reverse an existing trip's direction.
 *
 * Throws on a non-finite end rather than answering. Answering `false` would wave a
 * NaN pick straight through the caller's refuse-the-flip guard, and it fails open on
 * a DOWNSTREAM trip in particular — the very direction this feature exists for. A
 * pick that is not a number is a bug upstream, not a choice a rider made.
 *
 * The proposed ends are compared as given, unclamped: only their order matters here,
 * and createTrip pulls them onto the road when the trip is actually built.
 */
export function wouldReverse(trip, { startKm = trip.startKm, destinationKm = trip.destinationKm }) {
  if (!Number.isFinite(startKm) || !Number.isFinite(destinationKm)) {
    throw new Error(`wouldReverse needs finite ends, got: ${startKm} -> ${destinationKm}`);
  }
  return createTrip({ startKm, destinationKm }).direction !== trip.direction;
}

/**
 * A proposed new end for a trip, answered: the trip it would make, or the reason it is
 * refused. Spec §8's three guards, in the ONE order that gives each refusal its own
 * reason — which is why this is a function and not three lines in a click handler.
 *
 * 1. **Finite.** `wouldReverse` throws on a non-finite end by design (it used to fail
 *    OPEN downstream, waving a NaN pick through the very guard that exists to refuse
 *    it), so a pick that is not a number must never reach it.
 * 2. **Long enough.** A pick landing on the trip's other end makes a zero-length
 *    window, and an equal-ended window is FORWARD here — so downstream `wouldReverse`
 *    would call that a reversal and point the rider at Reset trip. Length first, and
 *    the refusal says what is actually wrong: too short.
 * 3. **Not a flip, once there are days.** With no days a flip is trip setup.
 *
 * @param {object} trip - the trip being changed, from createTrip().
 * @param {'start'|'destination'} tripEnd - which end the pick moves. Exactly one, ever:
 *   each control owns one end, which is also what keeps the strip's elevation memo key
 *   honest — both of its ends are pinned by a test that moves one at a time.
 * @param {number} km - the picked ABSOLUTE route km.
 * @param {{dayCount?: number, minLengthKm: number}} opts - `minLengthKm` is required and
 *   validated: MIN_DAY_KM belongs to boundaries.js, which this module deliberately does
 *   not import, and a defaulted guard is a guard a caller can forget.
 * @returns {{ok: true, trip: object}
 *   | {ok: false, reason: 'not-a-number', km: number}
 *   | {ok: false, reason: 'too-short', lengthKm: number, minLengthKm: number}
 *   | {ok: false, reason: 'would-reverse', startKm: number, destinationKm: number}}
 */
export function proposeEnd(trip, tripEnd, km, { dayCount = 0, minLengthKm } = {}) {
  if (tripEnd !== 'start' && tripEnd !== 'destination') {
    throw new Error(`proposeEnd needs tripEnd 'start' or 'destination', got: ${tripEnd}`);
  }
  if (!Number.isFinite(minLengthKm)) {
    throw new Error(`proposeEnd needs a finite minLengthKm, got: ${minLengthKm}`);
  }
  if (!Number.isFinite(km)) return { ok: false, reason: 'not-a-number', km };

  const ends =
    tripEnd === 'start'
      ? { startKm: km, destinationKm: trip.destinationKm }
      : { startKm: trip.startKm, destinationKm: km };
  // Built before the length is judged, so the length judged is the one the trip would
  // really have: createTrip pulls both ends onto the road.
  const next = createTrip({ ...ends, totalKm: trip.totalKm });
  if (next.lengthKm < minLengthKm) {
    return { ok: false, reason: 'too-short', lengthKm: next.lengthKm, minLengthKm };
  }
  if (dayCount > 0 && wouldReverse(trip, ends)) {
    return { ok: false, reason: 'would-reverse', ...ends };
  }
  return { ok: true, trip: next };
}
