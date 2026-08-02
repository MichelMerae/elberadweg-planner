import { describe, it, expect } from 'vitest';
import { createTrip, wouldReverse, proposeEnd } from './trip.js';

describe('createTrip', () => {
  const up = createTrip({ startKm: 149.3, destinationKm: 797.6 });   // Hamburg -> Dresden
  const down = createTrip({ startKm: 797.6, destinationKm: 149.3 }); // Dresden -> Hamburg

  it('derives direction from the order of the ends', () => {
    expect(up.direction).toBe(1);
    expect(down.direction).toBe(-1);
  });

  it('reports the trip length as a positive distance either way', () => {
    expect(up.lengthKm).toBeCloseTo(648.3, 1);
    expect(down.lengthKm).toBeCloseTo(648.3, 1);
  });

  it('translates absolute km into km from the rider’s start', () => {
    expect(up.tripKm(149.3)).toBeCloseTo(0, 6);
    expect(up.tripKm(229.3)).toBeCloseTo(80, 6);
    expect(down.tripKm(797.6)).toBeCloseTo(0, 6);
    expect(down.tripKm(717.6)).toBeCloseTo(80, 6);
  });

  // A favorite north of the rider's start has to read as negative rather than as
  // zero: clamping here would quietly move it onto the start line. Display code
  // decides how to say "behind you"; this file only translates.
  it('leaves km outside the window unclamped and signed', () => {
    expect(up.tripKm(100)).toBeCloseTo(-49.3, 6);
    expect(up.tripKm(900)).toBeCloseTo(750.7, 6);
    expect(down.tripKm(900)).toBeCloseTo(-102.4, 6);
  });

  it('translates back, so a picked display km can become storage km', () => {
    expect(up.absoluteKm(80)).toBeCloseTo(229.3, 6);
    expect(down.absoluteKm(80)).toBeCloseTo(717.6, 6);
  });

  it('round-trips any km through both translations', () => {
    for (const km of [149.3, 300, 500.5, 797.6]) {
      expect(up.absoluteKm(up.tripKm(km))).toBeCloseTo(km, 6);
      expect(down.absoluteKm(down.tripKm(km))).toBeCloseTo(km, 6);
    }
  });

  it('knows which absolute km lie inside the window, whichever way it runs', () => {
    expect(up.contains(200)).toBe(true);
    expect(up.contains(100)).toBe(false);
    expect(down.contains(200)).toBe(true);
    expect(down.contains(900)).toBe(false);
  });

  it('includes both endpoints', () => {
    expect(up.contains(149.3)).toBe(true);
    expect(up.contains(797.6)).toBe(true);
  });

  it('clamps an absolute km into the window regardless of direction', () => {
    expect(up.clampKm(50)).toBeCloseTo(149.3, 6);
    expect(up.clampKm(900)).toBeCloseTo(797.6, 6);
    expect(down.clampKm(900)).toBeCloseTo(797.6, 6);
    expect(down.clampKm(50)).toBeCloseTo(149.3, 6);
  });

  it('advances a km along the trip by a positive distance', () => {
    expect(up.advance(149.3, 80)).toBeCloseTo(229.3, 6);
    expect(down.advance(797.6, 80)).toBeCloseTo(717.6, 6);
  });

  it('never advances past the destination', () => {
    expect(up.advance(760, 80)).toBeCloseTo(797.6, 6);
    expect(down.advance(180, 80)).toBeCloseTo(149.3, 6);
  });

  // Pinned because advance() is also the clamp consumers reach for: an
  // `if (!distanceKm) return absoluteKm` fast path added later would look
  // harmless and would silently let a km past the destination through.
  it('still pulls a km past the destination back, even advancing no distance', () => {
    expect(up.advance(900, 0)).toBeCloseTo(797.6, 6);
    expect(down.advance(100, 0)).toBeCloseTo(149.3, 6);
  });

  // A zero-length window is the degenerate case every consumer would divide by.
  // It is legal: equal ends are a window the rider chose, not a missing argument.
  it('treats an equal-ended window as forward with zero length', () => {
    const nil = createTrip({ startKm: 300, destinationKm: 300 });
    expect(nil.lengthKm).toBe(0);
    expect(nil.direction).toBe(1);
  });

  it('defaults to the whole road when given only its length', () => {
    const whole = createTrip({ totalKm: 1026.5 });
    expect(whole.startKm).toBe(0);
    expect(whole.destinationKm).toBe(1026.5);
    expect(whole.direction).toBe(1);
  });

  // The realistic half-specified shape: the rider picks where they start and the
  // destination stays the end of the road.
  it('takes the destination from the road length when only the start is picked', () => {
    const fromHome = createTrip({ startKm: 149.3, totalKm: 1026.5 });
    expect(fromHome.destinationKm).toBe(1026.5);
    expect(fromHome.direction).toBe(1);
  });

  // Defaulting the destination to km 0 instead would turn a half-specified trip
  // into a silently REVERSED one — {startKm: 500} becoming a 500 km ride back to
  // Cuxhaven — and every day in it would then collapse against that end.
  it('throws rather than inventing a destination at km 0', () => {
    expect(() => createTrip()).toThrow(/finite destinationKm or totalKm/);
    expect(() => createTrip({ startKm: 500 })).toThrow(/finite destinationKm or totalKm/);
  });

  it('clamps both ends onto the road when it knows the road length', () => {
    const trip = createTrip({ startKm: -5, destinationKm: 99999, totalKm: 1026.5 });
    expect(trip.startKm).toBe(0);
    expect(trip.destinationKm).toBe(1026.5);
    expect(trip.lengthKm).toBe(1026.5);
  });

  it('leaves ends already on the road untouched', () => {
    const trip = createTrip({ startKm: 149.3, destinationKm: 797.6, totalKm: 1026.5 });
    expect(trip.startKm).toBe(149.3);
    expect(trip.destinationKm).toBe(797.6);
  });

  // The clamp runs before direction is derived, so it must not flip a downstream
  // trip into an upstream one on its way onto the road.
  it('keeps a downstream trip downstream while clamping it onto the road', () => {
    const trip = createTrip({ startKm: 900, destinationKm: -5, totalKm: 1026.5 });
    expect(trip.destinationKm).toBe(0);
    expect(trip.direction).toBe(-1);
  });

  // null, not undefined: a trip is persisted, and JSON keeps an explicit null while
  // it drops an undefined — so a stored trip says "road length unknown" out loud.
  it('carries the road length, and null when it was never told one', () => {
    expect(createTrip({ startKm: 0, destinationKm: 100, totalKm: 1026.5 }).totalKm).toBe(1026.5);
    expect(createTrip({ startKm: 0, destinationKm: 100 }).totalKm).toBeNull();
  });

  it('is frozen, so no consumer can shift the window under another', () => {
    expect(() => { up.startKm = 0; }).toThrow();
    expect(up.startKm).toBe(149.3);
  });
});

describe('wouldReverse', () => {
  const up = createTrip({ startKm: 149.3, destinationKm: 797.6 });
  const down = createTrip({ startKm: 797.6, destinationKm: 149.3 });

  it('is false for a same-direction change', () => {
    expect(wouldReverse(up, { destinationKm: 600 })).toBe(false);
  });

  it('is true for a destination behind the start', () => {
    expect(wouldReverse(up, { destinationKm: 100 })).toBe(true);
  });

  it('is true for a start beyond the destination', () => {
    expect(wouldReverse(up, { startKm: 900 })).toBe(true);
  });

  it('reads a flip on a downstream trip too', () => {
    expect(wouldReverse(down, { destinationKm: 900 })).toBe(true);
    expect(wouldReverse(down, { destinationKm: 200 })).toBe(false);
  });

  // Answering `false` for a NaN pick would wave it straight through the caller's
  // refuse-the-flip guard, and on a downstream trip that is exactly the direction
  // this feature exists to support. A pick that is not a number is a bug upstream.
  it('throws on a proposed end that is not a number', () => {
    expect(() => wouldReverse(up, { destinationKm: Number.NaN })).toThrow(/wouldReverse/);
    expect(() => wouldReverse(down, { destinationKm: Number.NaN })).toThrow(/wouldReverse/);
    expect(() => wouldReverse(up, { startKm: Number.NaN })).toThrow(/wouldReverse/);
  });

  it('answers the same for a trip that carries a road length', () => {
    const bounded = createTrip({ startKm: 149.3, destinationKm: 797.6, totalKm: 1026.5 });
    expect(wouldReverse(bounded, { destinationKm: 100 })).toBe(true);
    expect(wouldReverse(bounded, { destinationKm: 600 })).toBe(false);
  });
});

describe('proposeEnd', () => {
  const UP = createTrip({ startKm: 149.3, destinationKm: 797.6, totalKm: 1026.5 });
  const DOWN = createTrip({ startKm: 797.6, destinationKm: 149.3, totalKm: 1026.5 });
  const GUARDS = { dayCount: 3, minLengthKm: 5 };

  it('answers a good pick with the trip it makes', () => {
    const out = proposeEnd(UP, 'start', 200, GUARDS);
    expect(out.ok).toBe(true);
    expect(out.trip.startKm).toBe(200);
    expect(out.trip.destinationKm).toBe(797.6); // the other end untouched
    expect(out.trip.totalKm).toBe(1026.5); // and the road it is measured on
  });

  it('moves the end it was asked for and never the other one', () => {
    const out = proposeEnd(UP, 'destination', 600, GUARDS);
    expect(out.trip.startKm).toBe(149.3);
    expect(out.trip.destinationKm).toBe(600);
  });

  // The refusals below are only worth anything if a good DOWNSTREAM pick is answered
  // too: without this a length compared as a signed subtraction — negative for every
  // downstream window — would refuse the whole direction this feature exists for and
  // still pass all four too-short assertions.
  it('answers a good downstream pick with the trip it makes', () => {
    const out = proposeEnd(DOWN, 'destination', 200, GUARDS);
    expect(out.ok).toBe(true);
    expect(out.trip.startKm).toBe(797.6);
    expect(out.trip.destinationKm).toBe(200);
    expect(out.trip.direction).toBe(-1);
  });

  it('pulls a pick past the end of the road onto it', () => {
    expect(proposeEnd(UP, 'destination', 2000, GUARDS).trip.destinationKm).toBe(1026.5);
  });

  // THE ORDER TEST. A pick landing on the trip's other end makes a ZERO-length window,
  // and createTrip calls an equal-ended window forward — so on a downstream trip
  // wouldReverse asked first answers "reversal" and sends the rider to Reset trip over
  // a window they only need to nudge.
  it('refuses a zero-length pick as too short, not as a reversal, downstream', () => {
    const out = proposeEnd(DOWN, 'destination', 797.6, GUARDS);
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('too-short');
  });

  it('refuses a window under the minimum in both directions', () => {
    expect(proposeEnd(UP, 'destination', 152, GUARDS).reason).toBe('too-short'); // 2.7 km
    expect(proposeEnd(DOWN, 'destination', 795, GUARDS).reason).toBe('too-short'); // 2.6 km
  });

  // The minimum is what a window is allowed to BE, not what it has to exceed: a window
  // exactly MIN_DAY_KM long holds exactly one legal day.
  it('allows a window exactly the minimum length', () => {
    const clean = createTrip({ startKm: 100, destinationKm: 200, totalKm: 1026.5 });
    expect(proposeEnd(clean, 'destination', 105, GUARDS).ok).toBe(true);
  });

  it('refuses a flip once there are days, and reports the window it would have made', () => {
    const out = proposeEnd(UP, 'destination', 100, GUARDS);
    expect(out.reason).toBe('would-reverse');
    expect(out).toMatchObject({ startKm: 149.3, destinationKm: 100 });
  });

  it('refuses a start pushed past the destination too', () => {
    expect(proposeEnd(UP, 'start', 900, GUARDS).reason).toBe('would-reverse');
  });

  // Spec §8: with no days a flip is free — that is trip setup, not a mistake.
  it('allows a flip while the plan has no days', () => {
    const out = proposeEnd(UP, 'destination', 100, { dayCount: 0, minLengthKm: 5 });
    expect(out.ok).toBe(true);
    expect(out.trip.direction).toBe(-1);
  });

  // The ledger's Task 4 hazard one layer up: a `?? 0` on the road length would clamp
  // both ends into [0, 0] and refuse a perfectly good pick as too short. A trip that
  // was never told a road length still has to answer a pick.
  it('proposes on a trip with no road length without inventing one', () => {
    const unbounded = createTrip({ startKm: 149.3, destinationKm: 797.6 });
    const out = proposeEnd(unbounded, 'destination', 600, GUARDS);
    expect(out.ok).toBe(true);
    expect(out.trip.destinationKm).toBe(600);
    expect(out.trip.totalKm).toBeNull();
  });

  it('refuses a pick that is not a number instead of letting wouldReverse throw', () => {
    expect(proposeEnd(UP, 'start', NaN, GUARDS)).toMatchObject({ ok: false, reason: 'not-a-number' });
    expect(() => proposeEnd(UP, 'start', undefined, GUARDS)).not.toThrow();
  });

  it('throws on an end it does not recognise rather than moving the other one', () => {
    expect(() => proposeEnd(UP, 'finish', 600, GUARDS)).toThrow(/start.*destination/);
  });

  it('throws when nobody said how short is too short', () => {
    expect(() => proposeEnd(UP, 'start', 200, { dayCount: 0 })).toThrow(/minLengthKm/);
    expect(() => proposeEnd(UP, 'start', 200)).toThrow(/minLengthKm/);
  });
});
