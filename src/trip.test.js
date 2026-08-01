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

  // A zero-length window is the degenerate case every consumer would divide by.
  it('treats an equal-ended window as forward with zero length', () => {
    const nil = createTrip({ startKm: 300, destinationKm: 300 });
    expect(nil.lengthKm).toBe(0);
    expect(nil.direction).toBe(1);
  });

  it('defaults to the whole road when given nothing', () => {
    const whole = createTrip({ totalKm: 1026.5 });
    expect(whole.startKm).toBe(0);
    expect(whole.destinationKm).toBe(1026.5);
    expect(whole.direction).toBe(1);
  });

  it('is frozen, so no consumer can shift the window under another', () => {
    expect(() => { up.startKm = 0; }).toThrow();
  });
});

describe('wouldReverse', () => {
  const up = createTrip({ startKm: 149.3, destinationKm: 797.6 });

  it('is false for a same-direction change', () => {
    expect(wouldReverse(up, { destinationKm: 600 })).toBe(false);
  });

  it('is true for a destination behind the start', () => {
    expect(wouldReverse(up, { destinationKm: 100 })).toBe(true);
  });

  it('is true for a start beyond the destination', () => {
    expect(wouldReverse(up, { startKm: 900 })).toBe(true);
  });
});
