import { describe, it, expect } from 'vitest';
import { MIN_DAY_KM, boundaryBounds, boundaryWindow, clampBoundaryKm } from './boundaries.js';
import { createTrip } from './trip.js';

const TOTAL_KM = 650;

// The whole road, ridden forwards from km 0 — the only trip these functions could
// describe before a plan could have a window at all. Every conversion inside
// boundaries.js is an IDENTITY on it, which is exactly why the cases below keep the
// numbers they had under the old `{ totalKm }` contract.
//
// It is also why they cannot prove orientation: on this trip a bound of km 5 could
// come from the trip's own start or from a hardcoded zero, and a passing test says
// nothing about which. Orientation is proved separately, in 'oriented trips'.
const WHOLE = createTrip({ startKm: 0, destinationKm: TOTAL_KM });

// Days as the itinerary exposes them: startKm/endKm already chained. Ascending from
// km 0, so these days belong to WHOLE; the oriented cases spell their days out.
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
    expect(boundaryBounds(list, 1, { trip: WHOLE })).toEqual({ min: 85, max: 235 });
  });

  it('measures the first boundary from the trip start', () => {
    const list = days(80, 160);
    expect(boundaryBounds(list, 0, { trip: WHOLE })).toEqual({ min: 5, max: 155 });
  });

  it('lets the last boundary run to the end of the trip', () => {
    const list = days(80, 160);
    expect(boundaryBounds(list, 1, { trip: WHOLE })).toEqual({ min: 85, max: TOTAL_KM });
  });

  it('throws when opts is omitted entirely', () => {
    expect(() => boundaryBounds(days(80, 160), 0)).toThrow(/trip/);
  });

  // Every export converts for itself — boundaryWindow does not route through
  // boundaryBounds — so every export owns the guard rather than inheriting it.
  it('throws from the other exports too, not only from boundaryBounds', () => {
    const list = days(80, 160);
    expect(() => boundaryWindow(list, 0)).toThrow(/trip/);
    expect(() => clampBoundaryKm(list, 0, 100)).toThrow(/trip/);
  });

  // Fail on first use, not just on the last boundary: an incomplete trip would
  // otherwise return correct windows everywhere except the final day, whose NaN gets
  // persisted rather than thrown. All three members are load-bearing — tripKm on the
  // way in, absoluteKm on the way out, and lengthKm IS the last boundary's own upper
  // bound — so a stub missing any of them is refused.
  it('throws on a trip-shaped object missing the arithmetic it uses', () => {
    const id = (km) => km;
    expect(() => boundaryBounds(days(80, 160), 0, { trip: { absoluteKm: id, lengthKm: TOTAL_KM } })).toThrow(/trip/);
    expect(() => boundaryBounds(days(80, 160), 0, { trip: { tripKm: id, lengthKm: TOTAL_KM } })).toThrow(/trip/);
    expect(() => boundaryBounds(days(80, 160), 0, { trip: { tripKm: id, absoluteKm: id } })).toThrow(/trip/);
  });

  // The old contract accepted `{ totalKm: Infinity }` and left the last boundary
  // unclamped above, for an itinerary that had not been told its route length. A trip
  // always knows how long it is — createTrip needs two finite ends — so that
  // tolerance has nowhere left to come from, and an infinite length now means what a
  // missing one means: a trip that would NaN the last boundary and only the last one.
  it('refuses a trip whose length is not finite', () => {
    const id = (km) => km;
    const endless = { tripKm: id, absoluteKm: id, lengthKm: Infinity };
    expect(() => boundaryBounds(days(80, 160), 1, { trip: endless })).toThrow(/trip/);
  });

  it('never returns a max below its min for a squeezed day', () => {
    // Days 0 and 1 together span only 8 km — less than 2 × MIN_DAY_KM — so the
    // raw window would be inverted (min 5, max 3).
    const list = days(4, 8, 300);
    const bounds = boundaryBounds(list, 0, { trip: WHOLE });
    expect(bounds.min).toBe(5);
    expect(bounds.max).toBe(bounds.min);
  });
});

// The one definition of "this boundary has nowhere legal to go", which strip.js
// asks before proposing a move and the itinerary refuses on for the same reason.
describe('boundaryWindow', () => {
  it('returns the unfloored window when the boundary can move', () => {
    expect(boundaryWindow(days(80, 160, 240), 1, { trip: WHOLE })).toEqual({
      min: 85,
      max: 235,
    });
  });

  it('returns null when the pair is too squeezed to hold a boundary', () => {
    // Days 0 and 1 span 8 km together — under 2 × MIN_DAY_KM, so neither half can
    // be 5 km long wherever the boundary goes.
    expect(boundaryWindow(days(4, 8, 300), 0, { trip: WHOLE })).toBeNull();
  });

  // The distinction that makes this a separate function: boundaryBounds reports
  // min === max here, and reading "nowhere to go" off `min >= max` would refuse a
  // move the model accepts — the midpoint leaves both days exactly MIN_DAY_KM.
  it('allows the single position of a pair spanning exactly 2 x MIN_DAY_KM', () => {
    const list = days(3, 2 * MIN_DAY_KM, 300);
    expect(boundaryBounds(list, 0, { trip: WHOLE })).toEqual({ min: 5, max: 5 });
    expect(boundaryWindow(list, 0, { trip: WHOLE })).toEqual({ min: 5, max: 5 });
  });

  it('lets the last boundary run to the end of the trip', () => {
    expect(boundaryWindow(days(80, 160), 1, { trip: WHOLE })).toEqual({
      min: 85,
      max: TOTAL_KM,
    });
  });

  // The last boundary has no neighbour, but it does have the end of the trip: a
  // plan already within MIN_DAY_KM of Dresden cannot make its final day any
  // longer, so that boundary is stuck too.
  it('refuses the last boundary when the trip end is closer than MIN_DAY_KM', () => {
    expect(boundaryWindow(days(646, 648), 1, { trip: WHOLE })).toBeNull();
  });
});

describe('clampBoundaryKm', () => {
  it('passes a value inside the window through', () => {
    expect(clampBoundaryKm(days(80, 160, 240), 1, 200, { trip: WHOLE })).toBe(200);
  });

  it('clamps to the upper bound', () => {
    expect(clampBoundaryKm(days(80, 160, 240), 1, 500, { trip: WHOLE })).toBe(235);
  });

  it('clamps to the lower bound', () => {
    expect(clampBoundaryKm(days(80, 160, 240), 1, 10, { trip: WHOLE })).toBe(85);
  });
});

// Trips that do not begin at km 0, which is what the internal rider-km conversion
// exists for. Every km crossing this file's edge is ABSOLUTE route km; the MIN_DAY_KM
// arithmetic in between happens in rider km, so nothing here depends on the days'
// absolute km ascending.
//
// The returned bounds are in TRIP order: `min` is the closest legal position to the
// trip's start, which downstream is the numerically LARGER absolute km. That is the
// contract these cases pin.
describe('boundaries - oriented trips', () => {
  const DOWN = createTrip({ startKm: 300, destinationKm: 100 }); // 200 km downstream
  const UP = createTrip({ startKm: 149.3, destinationKm: 797.6 }); // offset forward

  // (300, 220], (220, 100] — 80 km then 120 km, ridden towards km 100.
  const downDays = () => [
    { startKm: 300, endKm: 220, targetKm: 80 },
    { startKm: 220, endKm: 100, targetKm: 120 },
  ];

  // (149.3, 229.3], (229.3, 309.3] — two 80 km days on a 648.3 km trip.
  const upDays = () => [
    { startKm: 149.3, endKm: 229.3, targetKm: 80 },
    { startKm: 229.3, endKm: 309.3, targetKm: 80 },
  ];

  it('is the identity on a whole-road forward trip', () => {
    // The same plan and the same numbers as the ascending cases above: on a trip
    // from km 0 to the road's end both conversions are identities, which is what
    // leaves every existing caller's arithmetic untouched by the move to rider km.
    const list = days(80, 160, 240);
    expect(boundaryWindow(list, 1, { trip: WHOLE })).toEqual({ min: 85, max: 235 });
    expect(clampBoundaryKm(list, 1, 500, { trip: WHOLE })).toBe(235);
  });

  it('keeps MIN_DAY_KM as a distance, not a signed difference', () => {
    const w = boundaryWindow(downDays(), 0, { trip: DOWN });
    // Boundary 0 may sit between 5 km past the start and 5 km short of day 2's end.
    // Trip-ordered: min is the closest legal km to the start (km 295, 5 km ridden)
    // and max the farthest (km 105, 195 km ridden), so min is the larger number.
    expect(w.min).toBeCloseTo(295, 6);
    expect(w.max).toBeCloseTo(105, 6);
  });

  it('refuses a window with no legal position, downstream', () => {
    const squeezed = [
      { startKm: 300, endKm: 297, targetKm: 3 },
      { startKm: 297, endKm: 295, targetKm: 2 },
    ];
    expect(boundaryWindow(squeezed, 0, { trip: DOWN })).toBeNull();
  });

  // The floor is applied in rider km too. Applied to absolute km, `Math.max` would
  // pick the larger NUMBER — km 297 over km 295 — which downstream is the inverted
  // window's own illegal end, leaving day 0 the 3 km the floor exists to refuse.
  it('floors a squeezed window at its own min, downstream', () => {
    const squeezed = [
      { startKm: 300, endKm: 296, targetKm: 4 },
      { startKm: 296, endKm: 292, targetKm: 4 },
    ];
    const bounds = boundaryBounds(squeezed, 0, { trip: DOWN });
    expect(bounds.min).toBeCloseTo(295, 6);
    expect(bounds.max).toBe(bounds.min);
  });

  it('lets the last boundary run to the destination, downstream', () => {
    const w = boundaryWindow(downDays(), 1, { trip: DOWN });
    expect(w.min).toBeCloseTo(215, 6); // day 1 keeps its MIN_DAY_KM
    expect(w.max).toBeCloseTo(100, 6); // the trip's own end, not the road's
  });

  it('clamps a proposed boundary into the window, downstream', () => {
    // km 50 is past the destination, so the clamp lands on the far bound.
    expect(clampBoundaryKm(downDays(), 0, 50, { trip: DOWN })).toBeCloseTo(105, 6);
  });

  it('clamps a boundary asked for behind the trip start, downstream', () => {
    // km 400 is 100 km behind a rider heading for km 100.
    expect(clampBoundaryKm(downDays(), 0, 400, { trip: DOWN })).toBeCloseTo(295, 6);
  });

  it('measures the first boundary from an offset trip start, not from km 0', () => {
    const w = boundaryWindow(upDays(), 0, { trip: UP });
    expect(w.min).toBeCloseTo(154.3, 6); // 149.3 + MIN_DAY_KM, not 5
    expect(w.max).toBeCloseTo(304.3, 6);
  });

  it('lets the last boundary run to the trip destination, not the road end', () => {
    const w = boundaryWindow(upDays(), 1, { trip: UP });
    expect(w.min).toBeCloseTo(234.3, 6);
    expect(w.max).toBeCloseTo(797.6, 6);
  });

  it('clamps a boundary asked for behind an offset trip start', () => {
    // km 100 is 49.3 km behind the rider's start. Under the old km-0 origin this
    // sailed through as a legal position and the day derived from it was negative.
    expect(clampBoundaryKm(upDays(), 0, 100, { trip: UP })).toBeCloseTo(154.3, 6);
  });

  it('clamps a boundary asked for past an offset trip destination', () => {
    expect(clampBoundaryKm(upDays(), 1, 900, { trip: UP })).toBeCloseTo(797.6, 6);
  });
});
