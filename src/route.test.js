import { describe, it, expect } from 'vitest';
import { totalLength, pointAtDistance, snap } from './route.js';

// Synthetic fixture: a line running due south along the Greenwich meridian
// (lng fixed at 0), from 51.0N down to 50.0N, split into a few vertices.
// 1 degree of latitude ~= 111.19 km, so this line is ~111.19 km long.
const meridianLine = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'LineString',
    coordinates: [
      [0, 51.0],
      [0, 50.75],
      [0, 50.5],
      [0, 50.25],
      [0, 50.0],
    ],
  },
};

const EXPECTED_TOTAL_KM = 111.19; // 1 degree latitude, approx
const TOLERANCE_KM = 1;

describe('totalLength', () => {
  it('matches the expected great-circle length within tolerance', () => {
    const length = totalLength(meridianLine);
    expect(length).toBeCloseTo(EXPECTED_TOTAL_KM, 0);
    expect(Math.abs(length - EXPECTED_TOTAL_KM)).toBeLessThan(TOLERANCE_KM);
  });
});

describe('pointAtDistance', () => {
  it('returns the first vertex at km 0', () => {
    const [lng, lat] = pointAtDistance(meridianLine, 0);
    expect(lng).toBeCloseTo(0, 6);
    expect(lat).toBeCloseTo(51.0, 6);
  });

  it('clamps negative km to the start', () => {
    const [lng, lat] = pointAtDistance(meridianLine, -50);
    expect(lng).toBeCloseTo(0, 6);
    expect(lat).toBeCloseTo(51.0, 6);
  });

  it('clamps km past the end to the last vertex', () => {
    const total = totalLength(meridianLine);
    const [lng, lat] = pointAtDistance(meridianLine, total + 100);
    expect(lng).toBeCloseTo(0, 3);
    expect(lat).toBeCloseTo(50.0, 3);
  });

  it('returns a coordinate on the line for a midpoint distance', () => {
    const total = totalLength(meridianLine);
    const [lng, lat] = pointAtDistance(meridianLine, total / 2);
    expect(lng).toBeCloseTo(0, 3);
    expect(lat).toBeGreaterThan(50.0);
    expect(lat).toBeLessThan(51.0);
  });
});

describe('snap', () => {
  it('snaps a point slightly off the line to a sane distance and coord', () => {
    // Slightly east of the line, roughly at the midpoint latitude.
    const { distanceKm, coord } = snap(meridianLine, [0.01, 50.5]);
    const total = totalLength(meridianLine);

    expect(distanceKm).toBeGreaterThanOrEqual(0);
    expect(distanceKm).toBeLessThanOrEqual(total);
    expect(distanceKm).toBeCloseTo(total / 2, 0);

    // Snapped coord should land back on the line (lng ~ 0).
    expect(coord[0]).toBeCloseTo(0, 2);
    expect(coord[1]).toBeCloseTo(50.5, 1);
  });

  it('snaps the start point to distance 0', () => {
    const { distanceKm } = snap(meridianLine, [0, 51.0]);
    expect(distanceKm).toBeCloseTo(0, 3);
  });
});
