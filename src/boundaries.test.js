import { describe, it, expect } from 'vitest';
import { MIN_DAY_KM, boundaryBounds, boundaryWindow, clampBoundaryKm } from './boundaries.js';

const TOTAL_KM = 650;

// Days as the itinerary exposes them: startKm/endKm already chained.
function days(...ends) {
  let prev = 0;
  return ends.map((endKm) => {
    const day = { startKm: prev, endKm };
    prev = endKm;
    return day;
  });
}

describe('MIN_DAY_KM', () => {
  it('is 5 km', () => {
    expect(MIN_DAY_KM).toBe(5);
  });
});

describe('boundaryBounds', () => {
  it('keeps the edited day and its neighbour at least MIN_DAY_KM long', () => {
    const list = days(80, 160, 240, 320);
    expect(boundaryBounds(list, 1, { totalKm: TOTAL_KM })).toEqual({ min: 85, max: 235 });
  });

  it('measures the first boundary from km 0', () => {
    const list = days(80, 160);
    expect(boundaryBounds(list, 0, { totalKm: TOTAL_KM })).toEqual({ min: 5, max: 155 });
  });

  it('lets the last boundary run to the end of the route', () => {
    const list = days(80, 160);
    expect(boundaryBounds(list, 1, { totalKm: TOTAL_KM })).toEqual({ min: 85, max: TOTAL_KM });
  });

  it('throws when opts is omitted entirely', () => {
    expect(() => boundaryBounds(days(80, 160), 0)).toThrow(/totalKm/);
  });

  it('throws on a NaN totalKm', () => {
    expect(() => boundaryBounds(days(80, 160), 0, { totalKm: NaN })).toThrow(/totalKm/);
  });

  it('accepts Infinity, leaving the last boundary unclamped above', () => {
    const bounds = boundaryBounds(days(80, 160), 1, { totalKm: Infinity });
    expect(bounds).toEqual({ min: 85, max: Infinity });
  });

  it('never returns a max below its min for a squeezed day', () => {
    // Days 0 and 1 together span only 8 km — less than 2 × MIN_DAY_KM — so the
    // raw window would be inverted (min 5, max 3).
    const list = days(4, 8, 300);
    const bounds = boundaryBounds(list, 0, { totalKm: TOTAL_KM });
    expect(bounds.min).toBe(5);
    expect(bounds.max).toBe(bounds.min);
  });
});

// The one definition of "this boundary has nowhere legal to go", which strip.js
// asks before proposing a move and the itinerary refuses on for the same reason.
describe('boundaryWindow', () => {
  it('returns the unfloored window when the boundary can move', () => {
    expect(boundaryWindow(days(80, 160, 240), 1, { totalKm: TOTAL_KM })).toEqual({
      min: 85,
      max: 235,
    });
  });

  it('returns null when the pair is too squeezed to hold a boundary', () => {
    // Days 0 and 1 span 8 km together — under 2 × MIN_DAY_KM, so neither half can
    // be 5 km long wherever the boundary goes.
    expect(boundaryWindow(days(4, 8, 300), 0, { totalKm: TOTAL_KM })).toBeNull();
  });

  // The distinction that makes this a separate function: boundaryBounds reports
  // min === max here, and reading "nowhere to go" off `min >= max` would refuse a
  // move the model accepts — the midpoint leaves both days exactly MIN_DAY_KM.
  it('allows the single position of a pair spanning exactly 2 x MIN_DAY_KM', () => {
    const list = days(3, 2 * MIN_DAY_KM, 300);
    expect(boundaryBounds(list, 0, { totalKm: TOTAL_KM })).toEqual({ min: 5, max: 5 });
    expect(boundaryWindow(list, 0, { totalKm: TOTAL_KM })).toEqual({ min: 5, max: 5 });
  });

  it('lets the last boundary run to the end of the route', () => {
    expect(boundaryWindow(days(80, 160), 1, { totalKm: TOTAL_KM })).toEqual({
      min: 85,
      max: TOTAL_KM,
    });
  });

  // The last boundary has no neighbour, but it does have the end of the route: a
  // plan already within MIN_DAY_KM of Dresden cannot make its final day any
  // longer, so that boundary is stuck too.
  it('refuses the last boundary when the route end is closer than MIN_DAY_KM', () => {
    expect(boundaryWindow(days(646, 648), 1, { totalKm: TOTAL_KM })).toBeNull();
  });
});

describe('clampBoundaryKm', () => {
  it('passes a value inside the window through', () => {
    expect(clampBoundaryKm(days(80, 160, 240), 1, 200, { totalKm: TOTAL_KM })).toBe(200);
  });

  it('clamps to the upper bound', () => {
    expect(clampBoundaryKm(days(80, 160, 240), 1, 500, { totalKm: TOTAL_KM })).toBe(235);
  });

  it('clamps to the lower bound', () => {
    expect(clampBoundaryKm(days(80, 160, 240), 1, 10, { totalKm: TOTAL_KM })).toBe(85);
  });
});
