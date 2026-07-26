import { describe, it, expect } from 'vitest';
import {
  totalLength,
  pointAtDistance,
  snap,
  createRouteIndex,
  pointAtKm,
  stretchCoords,
} from './route.js';

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

// The index exists because pointAtDistance re-measures the whole line on every
// call, so anything that samples a stretch per pointermove has to stop calling
// it. Its answers must therefore match pointAtDistance's, or the map and the
// plan would disagree about where a km is.
describe('createRouteIndex', () => {
  it('measures the same total length as totalLength', () => {
    const index = createRouteIndex(meridianLine);
    expect(index.totalKm).toBeCloseTo(totalLength(meridianLine), 6);
  });

  it('puts every vertex at its own cumulative distance, ascending from 0', () => {
    const { coords, cumKm } = createRouteIndex(meridianLine);
    expect(coords).toHaveLength(5);
    expect(cumKm[0]).toBe(0);
    for (let i = 1; i < cumKm.length; i += 1) expect(cumKm[i]).toBeGreaterThan(cumKm[i - 1]);
    // The fixture's vertices are evenly spaced, so vertex 2 sits at half the line.
    expect(cumKm[2]).toBeCloseTo(totalLength(meridianLine) / 2, 6);
  });

  it('accepts a bare geometry as well as a Feature', () => {
    expect(createRouteIndex(meridianLine.geometry).totalKm).toBeCloseTo(
      createRouteIndex(meridianLine).totalKm,
      6,
    );
  });
});

describe('pointAtKm', () => {
  it('agrees with pointAtDistance all along the line', () => {
    const index = createRouteIndex(meridianLine);
    for (const km of [0, 5, 27.8, 55.595, 90, 111]) {
      const [lng, lat] = pointAtKm(index, km);
      const [expLng, expLat] = pointAtDistance(meridianLine, km);
      expect(lng).toBeCloseTo(expLng, 4);
      expect(lat).toBeCloseTo(expLat, 4);
    }
  });

  it('clamps a km outside the line to its ends', () => {
    const index = createRouteIndex(meridianLine);
    expect(pointAtKm(index, -50)[1]).toBeCloseTo(51.0, 6);
    expect(pointAtKm(index, index.totalKm + 100)[1]).toBeCloseTo(50.0, 6);
  });

  it('returns the only vertex of a degenerate line', () => {
    const index = createRouteIndex({ type: 'LineString', coordinates: [[0, 51]] });
    expect(pointAtKm(index, 10)).toEqual([0, 51]);
  });
});

describe('stretchCoords', () => {
  it('starts and ends exactly at the requested km', () => {
    const index = createRouteIndex(meridianLine);
    const coords = stretchCoords(index, 30, 80);
    expect(coords[0][1]).toBeCloseTo(pointAtKm(index, 30)[1], 9);
    expect(coords[coords.length - 1][1]).toBeCloseTo(pointAtKm(index, 80)[1], 9);
  });

  it('keeps the route vertices that fall inside the range, in order', () => {
    const index = createRouteIndex(meridianLine);
    // Vertices sit at ~0 / 27.8 / 55.6 / 83.4 / 111.2 km, so 30..80 contains one.
    const coords = stretchCoords(index, 30, 80);
    expect(coords).toHaveLength(3);
    expect(coords[1]).toEqual([0, 50.5]);
    const lats = coords.map(([, lat]) => lat);
    expect([...lats].sort((a, b) => b - a)).toEqual(lats); // heading south
  });

  it('does not repeat a vertex that coincides with an endpoint', () => {
    const index = createRouteIndex(meridianLine);
    const at = index.cumKm[2]; // exactly on a vertex
    const coords = stretchCoords(index, at, index.cumKm[3]);
    expect(coords).toHaveLength(2);
    expect(coords[0][1]).toBeCloseTo(50.5, 9);
    expect(coords[1][1]).toBeCloseTo(50.25, 9);
  });

  it('clamps a range that runs past either end of the line', () => {
    const index = createRouteIndex(meridianLine);
    const coords = stretchCoords(index, -20, index.totalKm + 20);
    expect(coords[0][1]).toBeCloseTo(51.0, 6);
    expect(coords[coords.length - 1][1]).toBeCloseTo(50.0, 6);
    expect(coords).toHaveLength(5);
  });

  it('returns nothing for an empty or inverted range', () => {
    const index = createRouteIndex(meridianLine);
    expect(stretchCoords(index, 40, 40)).toEqual([]);
    expect(stretchCoords(index, 80, 30)).toEqual([]);
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
