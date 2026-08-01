import { describe, it, expect } from 'vitest';
import { createTrip, wouldReverse } from './trip.js';

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
