import { describe, expect, test } from 'vitest';
import { poisInRange } from './pois.js';

// Sorted ascending by routeDistanceKm, mixed food/sight kinds, as the real
// pois.json will be.
const POIS = [
  { name: 'Riverside Cafe', kind: 'food', category: 'cafe', lat: 53.5, lng: 10.1, routeDistanceKm: 10, offsetKm: 0.2 },
  { name: 'Old Watchtower', kind: 'sight', category: 'tower', lat: 53.49, lng: 10.11, routeDistanceKm: 10, offsetKm: 1.5 }, // duplicate km, different kind
  { name: 'Village Bakery', kind: 'food', category: 'bakery', lat: 53.48, lng: 10.12, routeDistanceKm: 20, offsetKm: 0.5 },
  { name: 'Hilltop Viewpoint', kind: 'sight', category: 'viewpoint', lat: 53.47, lng: 10.13, routeDistanceKm: 30, offsetKm: 2.1 },
  { name: 'Quiet Ice Cream', kind: 'food', category: 'ice_cream', lat: 53.46, lng: 10.14, routeDistanceKm: 40, offsetKm: 1.0 },
  { name: 'Ruined Castle', kind: 'sight', category: 'castle', lat: 53.45, lng: 10.15, routeDistanceKm: 50, offsetKm: 2.9 },
  { name: 'Bridge of Sighs', kind: 'sight', category: 'bridge', lat: 53.44, lng: 10.16, routeDistanceKm: 50, offsetKm: 0.1 }, // duplicate km, same kind
  { name: 'Roadside Snack Bar', kind: 'food', category: 'fast_food', lat: 53.43, lng: 10.17, routeDistanceKm: 60, offsetKm: 1.8 },
  { name: 'Waterfall Lookout', kind: 'sight', category: 'waterfall', lat: 53.42, lng: 10.18, routeDistanceKm: 70, offsetKm: 2.4 },
  { name: 'Farmhouse Restaurant', kind: 'food', category: 'restaurant', lat: 53.41, lng: 10.19, routeDistanceKm: 80, offsetKm: 0.9 },
  { name: 'Old Lighthouse', kind: 'sight', category: 'lighthouse', lat: 53.4, lng: 10.2, routeDistanceKm: 90, offsetKm: 1.2 },
  { name: 'Beer Garden', kind: 'food', category: 'biergarten', lat: 53.39, lng: 10.21, routeDistanceKm: 100, offsetKm: 0.3 },
];

describe('poisInRange', () => {
  test('includes POIs exactly at both inclusive bounds', () => {
    const names = poisInRange(POIS, 20, 50).map((p) => p.name);
    expect(names).toContain('Village Bakery'); // routeDistanceKm 20 == startKm
    expect(names).toContain('Ruined Castle'); // routeDistanceKm 50 == endKm
    expect(names).toContain('Bridge of Sighs'); // also 50 == endKm
  });

  test('excludes POIs just outside the range', () => {
    const names = poisInRange(POIS, 20, 50).map((p) => p.name);
    expect(names).not.toContain('Riverside Cafe'); // 10, just below
    expect(names).not.toContain('Old Watchtower'); // 10, just below
    expect(names).not.toContain('Roadside Snack Bar'); // 60, just above
    expect(names).not.toContain('Waterfall Lookout'); // 70, just above
  });

  test('returns entries in stored ascending-km order', () => {
    const kms = poisInRange(POIS, 0, 1000).map((p) => p.routeDistanceKm);
    const sorted = [...kms].sort((a, b) => a - b);
    expect(kms).toEqual(sorted);
  });

  test('filters by kind', () => {
    const foodNames = poisInRange(POIS, 0, 1000, { kind: 'food' }).map((p) => p.name);
    expect(foodNames).toEqual([
      'Riverside Cafe',
      'Village Bakery',
      'Quiet Ice Cream',
      'Roadside Snack Bar',
      'Farmhouse Restaurant',
      'Beer Garden',
    ]);

    const sightNames = poisInRange(POIS, 0, 1000, { kind: 'sight' }).map((p) => p.name);
    expect(sightNames).toEqual([
      'Old Watchtower',
      'Hilltop Viewpoint',
      'Ruined Castle',
      'Bridge of Sighs',
      'Waterfall Lookout',
      'Old Lighthouse',
    ]);
  });

  test('kind filter respects the range bounds, not just the whole array', () => {
    const names = poisInRange(POIS, 20, 50, { kind: 'food' }).map((p) => p.name);
    expect(names).toEqual(['Village Bakery', 'Quiet Ice Cream']);
  });

  test('returns all kinds when kind is omitted', () => {
    const result = poisInRange(POIS, 50, 50);
    expect(result.map((p) => p.name)).toEqual(['Ruined Castle', 'Bridge of Sighs']);
  });

  test('returns an empty array when the range excludes everything', () => {
    expect(poisInRange(POIS, 45, 45)).toEqual([]);
  });

  test('returns an empty array when startKm is after the last POI', () => {
    expect(poisInRange(POIS, 1000, 2000)).toEqual([]);
  });

  test('returns an empty array when endKm is before the first POI', () => {
    expect(poisInRange(POIS, -2000, -1000)).toEqual([]);
  });

  test('returns the whole array when the range covers it entirely', () => {
    expect(poisInRange(POIS, 0, 1000)).toHaveLength(POIS.length);
  });

  test('returns an empty array for an empty POI list', () => {
    expect(poisInRange([], 0, 100)).toEqual([]);
  });

  test('does not mutate the input array or its POI objects', () => {
    const snapshot = JSON.stringify(POIS);
    const result = poisInRange(POIS, 20, 50, { kind: 'food' });
    expect(JSON.stringify(POIS)).toBe(snapshot);
    // returned entries are the same objects, not copies
    const bakery = POIS.find((p) => p.name === 'Village Bakery');
    expect(result.find((p) => p.name === 'Village Bakery')).toBe(bakery);
  });
});

describe('loadPois', () => {
  test('is exported as an async loader (not invoked here; data file may not exist yet)', async () => {
    const { loadPois } = await import('./pois.js');
    expect(typeof loadPois).toBe('function');
  });
});
