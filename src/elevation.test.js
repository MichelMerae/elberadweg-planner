import { describe, it, expect } from 'vitest';
import { elevationAtKm, profilePoints, ascentBetween, profileForRoute } from './elevation.js';

// 11 samples 100 m apart: a 1 km profile climbing 0 -> 100 m in even 10 m steps.
const ramp = {
  routeId: 'test-route-v1',
  spacingM: 100,
  count: 11,
  minM: 0,
  maxM: 100,
  elevationsM: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
};

describe('elevationAtKm', () => {
  it('reads a sample exactly on a sample point', () => {
    expect(elevationAtKm(ramp, 0)).toBe(0);
    expect(elevationAtKm(ramp, 0.5)).toBe(50);
    expect(elevationAtKm(ramp, 1)).toBe(100);
  });

  it('interpolates between samples', () => {
    expect(elevationAtKm(ramp, 0.05)).toBeCloseTo(5, 6);
    expect(elevationAtKm(ramp, 0.25)).toBeCloseTo(25, 6);
  });

  it('clamps before the start and past the end rather than returning undefined', () => {
    expect(elevationAtKm(ramp, -10)).toBe(0);
    expect(elevationAtKm(ramp, 999)).toBe(100);
  });

  it('returns null for a missing profile, so callers can degrade', () => {
    expect(elevationAtKm(null, 0.5)).toBeNull();
    expect(elevationAtKm({ elevationsM: [] }, 0.5)).toBeNull();
  });

  it('returns null for a non-finite km rather than NaN', () => {
    expect(elevationAtKm(ramp, NaN)).toBeNull();
  });
});

describe('profilePoints', () => {
  it('maps the elevation range onto the height, inverted for SVG', () => {
    // 2 columns over the whole ramp, 100 px tall. SVG y grows downward, so the
    // HIGH end of the profile must produce the SMALL y.
    const pts = profilePoints(ramp, { startKm: 0, endKm: 1, width: 100, height: 100, columns: 2 });
    expect(pts).toHaveLength(2);
    expect(pts[0][1]).toBeGreaterThan(pts[1][1]);
  });

  it('spans the full width, first column at x=0 and last at x=width', () => {
    const pts = profilePoints(ramp, { startKm: 0, endKm: 1, width: 300, height: 50, columns: 4 });
    expect(pts[0][0]).toBe(0);
    expect(pts[pts.length - 1][0]).toBe(300);
  });

  it('puts the minimum on the baseline and the maximum at the top', () => {
    const pts = profilePoints(ramp, { startKm: 0, endKm: 1, width: 100, height: 80, columns: 11 });
    expect(pts[0][1]).toBeCloseTo(80, 6); // 0 m -> baseline
    expect(pts[10][1]).toBeCloseTo(0, 6); // 100 m -> top
  });

  it('scales against an explicit range when one is given, so days share one scale', () => {
    // Same ramp, but told the route spans 0..200 m: 100 m must land mid-height.
    const pts = profilePoints(ramp, {
      startKm: 0,
      endKm: 1,
      width: 100,
      height: 100,
      columns: 11,
      minM: 0,
      maxM: 200,
    });
    expect(pts[10][1]).toBeCloseTo(50, 6);
  });

  it('does not divide by zero on a perfectly flat profile', () => {
    const flat = { ...ramp, elevationsM: [7, 7, 7], count: 3, minM: 7, maxM: 7 };
    const pts = profilePoints(flat, { startKm: 0, endKm: 0.2, width: 10, height: 40, columns: 3 });
    for (const [, y] of pts) expect(Number.isFinite(y)).toBe(true);
    // A flat profile sits on the baseline rather than at an arbitrary height.
    for (const [, y] of pts) expect(y).toBeCloseTo(40, 6);
  });

  it('returns an empty array for a missing profile', () => {
    expect(profilePoints(null, { startKm: 0, endKm: 1, width: 10, height: 10 })).toEqual([]);
  });

  it('returns an empty array for a zero or negative width', () => {
    expect(profilePoints(ramp, { startKm: 0, endKm: 1, width: 0, height: 10 })).toEqual([]);
  });

  // The strip's axis runs in TRIP order, so a downstream ride hands this a window whose
  // end is BELOW its start. `km = startKm + (endKm - startKm) * t` was already
  // direction-correct; only the guard refused to let it run.
  it('mirrors a descending window, so a downstream ride reads left to right', () => {
    const shared = { width: 100, height: 80, columns: 11, minM: 0, maxM: 100 };
    const up = profilePoints(ramp, { startKm: 0, endKm: 1, ...shared });
    const down = profilePoints(ramp, { startKm: 1, endKm: 0, ...shared });

    expect(down).toHaveLength(11);
    // The point-mirror of the upstream profile: same x, the y from the far column.
    down.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(up[i][0], 6);
      expect(y).toBeCloseTo(up[up.length - 1 - i][1], 6);
    });
    // Which for this ramp means: ridden downstream it starts at the top and descends
    // to the baseline, rather than being drawn identically to the climb.
    expect(down[0][1]).toBeCloseTo(0, 6);
    expect(down[10][1]).toBeCloseTo(80, 6);
  });

  it('mirrors a descending sub-stretch too, not only a whole-profile one', () => {
    const shared = { width: 100, height: 100, columns: 2, minM: 0, maxM: 100 };
    const down = profilePoints(ramp, { startKm: 1, endKm: 0.5, ...shared });
    // 100 m at the top, 50 m halfway up — the sub-stretch test below, ridden the other
    // way round.
    expect(down[0][1]).toBeCloseTo(0, 6);
    expect(down[1][1]).toBeCloseTo(50, 6);
  });

  // Still refused: a zero-length window has no stretch to draw, and every column
  // would sample the same km — a flat line that reads as terrain.
  it('returns an empty array for a zero-length window', () => {
    expect(profilePoints(ramp, { startKm: 0.5, endKm: 0.5, width: 100, height: 80 })).toEqual([]);
  });

  it('covers a sub-stretch of the route, not always the whole thing', () => {
    const pts = profilePoints(ramp, {
      startKm: 0.5,
      endKm: 1,
      width: 100,
      height: 100,
      columns: 2,
      minM: 0,
      maxM: 100,
    });
    // 50 m -> halfway up; 100 m -> the top.
    expect(pts[0][1]).toBeCloseTo(50, 6);
    expect(pts[1][1]).toBeCloseTo(0, 6);
  });
});

describe('ascentBetween', () => {
  it('totals a steady climb', () => {
    const out = ascentBetween(ramp, 0, 1, { thresholdM: 5 });
    expect(out.ascentM).toBeCloseTo(100, 6);
    expect(out.descentM).toBeCloseTo(0, 6);
  });

  it('reports the min and max over the stretch', () => {
    const out = ascentBetween(ramp, 0.2, 0.6);
    expect(out.minM).toBe(20);
    expect(out.maxM).toBe(60);
  });

  // The whole reason the threshold exists. A DEM is accurate to a few metres, so
  // sampling a flat road every 100 m produces a sawtooth that would otherwise be
  // reported as hundreds of metres of climbing.
  it('ignores a sawtooth smaller than the threshold', () => {
    const noisy = {
      ...ramp,
      count: 21,
      elevationsM: Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 10 : 13)),
    };
    const out = ascentBetween(noisy, 0, 2, { thresholdM: 5 });
    expect(out.ascentM).toBe(0);
    expect(out.descentM).toBe(0);
  });

  it('counts a sawtooth larger than the threshold', () => {
    const swings = {
      ...ramp,
      count: 5,
      elevationsM: [0, 30, 0, 30, 0],
    };
    const out = ascentBetween(swings, 0, 0.4, { thresholdM: 5 });
    expect(out.ascentM).toBeCloseTo(60, 6);
    expect(out.descentM).toBeCloseTo(60, 6);
  });

  it('separates ascent from descent on a climb then a drop', () => {
    const hill = { ...ramp, count: 5, elevationsM: [0, 50, 100, 60, 20] };
    const out = ascentBetween(hill, 0, 0.4, { thresholdM: 5 });
    expect(out.ascentM).toBeCloseTo(100, 6);
    expect(out.descentM).toBeCloseTo(80, 6);
  });

  it('returns nulls for a missing profile so the panel can hide the line', () => {
    expect(ascentBetween(null, 0, 1)).toEqual({
      ascentM: null,
      descentM: null,
      minM: null,
      maxM: null,
    });
  });

  it('handles a stretch shorter than one sample without inventing climb', () => {
    const out = ascentBetween(ramp, 0.31, 0.33, { thresholdM: 5 });
    expect(out.ascentM).toBe(0);
    expect(out.descentM).toBe(0);
  });

  it('accumulates a long climb in threshold-sized steps, not once at the end', () => {
    // 1 m steps up to 100 m with a 5 m threshold still totals ~100, not 0 and not 20.
    const fine = {
      ...ramp,
      spacingM: 100,
      count: 101,
      elevationsM: Array.from({ length: 101 }, (_, i) => i),
    };
    const out = ascentBetween(fine, 0, 10, { thresholdM: 5 });
    expect(out.ascentM).toBeGreaterThan(90);
    expect(out.ascentM).toBeLessThanOrEqual(100);
  });
});

// The span's ORDER is the question asked, not a pair of bounds to normalise. This is
// the point of the oriented window: the same stretch is 487 m of climbing one way and
// 487 m of descent the other, and the figures the day panel and the strip block show
// are direction-correct because the day's own km arrive in trip order.
describe('ascentBetween - direction', () => {
  it('swaps ascent and descent when the same stretch is asked in the other order', () => {
    const up = ascentBetween(ramp, 0, 1, { thresholdM: 5 });
    const down = ascentBetween(ramp, 1, 0, { thresholdM: 5 });

    expect(up.ascentM).toBeCloseTo(100, 6);
    expect(up.descentM).toBeCloseTo(0, 6);
    expect(down.ascentM).toBeCloseTo(0, 6);
    expect(down.descentM).toBeCloseTo(100, 6);
    // The terrain is the same terrain, so the extremes do not move with the direction.
    expect(down.minM).toBe(up.minM);
    expect(down.maxM).toBe(up.maxM);
  });

  it('re-walks the stretch rather than swapping the totals', () => {
    // Hysteresis is not symmetric under reversal, so the two directions are not each
    // other's mirror. 0 → 3 → 8 clears the 5 m threshold once going up, and the accepted
    // move is measured from the last reference: 8 m of ascent. Ridden the other way the
    // same three samples give 5 m of descent (8 → 3), and the last 3 m never clears.
    // A version that computed the upstream pair and swapped it would say 8 m down.
    const step = { ...ramp, count: 3, elevationsM: [0, 3, 8] };

    expect(ascentBetween(step, 0, 0.2, { thresholdM: 5 })).toMatchObject({ ascentM: 8, descentM: 0 });
    expect(ascentBetween(step, 0.2, 0, { thresholdM: 5 })).toMatchObject({ ascentM: 0, descentM: 5 });
  });

  it('keeps the hysteresis threshold in both directions', () => {
    // A 3 m ripple, then a 30 m climb. The ripple is the DEM's error bar and must not
    // be counted whichever way the stretch is ridden: without the threshold this would
    // read 33 m up / 3 m down upstream and 3 m up / 33 m down going back.
    const ripple = { ...ramp, count: 4, elevationsM: [0, 3, 0, 30] };

    expect(ascentBetween(ripple, 0, 0.3, { thresholdM: 5 })).toMatchObject({
      ascentM: 30,
      descentM: 0,
    });
    expect(ascentBetween(ripple, 0.3, 0, { thresholdM: 5 })).toMatchObject({
      ascentM: 0,
      descentM: 30,
    });
  });

  it('reports no climb and unordered-proof extremes for a sub-sample stretch either way', () => {
    // Too short to hold a whole sample, so there is nothing to accumulate — but the
    // endpoints are still read, and min/max are the LOWER and HIGHER of them rather
    // than the first and the second.
    const shared = { ascentM: 0, descentM: 0, minM: 31, maxM: 33 };
    expect(ascentBetween(ramp, 0.31, 0.33, { thresholdM: 5 })).toEqual(shared);
    expect(ascentBetween(ramp, 0.33, 0.31, { thresholdM: 5 })).toEqual(shared);
  });

  it('reports zero for a zero-length span, which has no direction to have', () => {
    expect(ascentBetween(ramp, 0.5, 0.5, { thresholdM: 5 })).toEqual({
      ascentM: 0,
      descentM: 0,
      minM: 50,
      maxM: 50,
    });
  });
});

describe('profileForRoute', () => {
  it('accepts a profile whose routeId matches', () => {
    expect(profileForRoute(ramp, 'test-route-v1')).toBe(ramp);
  });

  // Elevation sampled along a different corridor describes a different road. Drawing
  // it would be worse than drawing nothing.
  it('rejects a profile built for another corridor', () => {
    expect(profileForRoute(ramp, 'some-other-route-v2')).toBeNull();
  });

  it('rejects a null or malformed profile', () => {
    expect(profileForRoute(null, 'test-route-v1')).toBeNull();
    expect(profileForRoute({ routeId: 'test-route-v1' }, 'test-route-v1')).toBeNull();
    expect(profileForRoute({ routeId: 'test-route-v1', elevationsM: [] }, 'test-route-v1')).toBeNull();
  });

  it('accepts any profile when no routeId is demanded, keeping the module testable', () => {
    expect(profileForRoute(ramp, undefined)).toBe(ramp);
  });
});
