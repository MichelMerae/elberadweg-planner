import { describe, expect, test } from 'vitest';
import { loadTowns, townLabel, townsNear } from './towns.js';

// Sorted ascending by routeDistanceKm, as the real towns.json will be.
const TOWNS = [
  { name: 'Start', place: 'city', lat: 53.55, lng: 10.0, routeDistanceKm: 0, offsetKm: 0 },
  { name: 'Riverton', place: 'village', lat: 53.5, lng: 10.1, routeDistanceKm: 12, offsetKm: 3 },
  { name: 'Oakdale', place: 'town', lat: 53.45, lng: 10.2, routeDistanceKm: 28, offsetKm: 1 },
  { name: 'Pinewell', place: 'village', lat: 53.42, lng: 10.25, routeDistanceKm: 39, offsetKm: 0.5 }, // just below window
  { name: 'Millbrook', place: 'village', lat: 53.4, lng: 10.3, routeDistanceKm: 40, offsetKm: 0.5 }, // == lower bound
  { name: 'Ashford', place: 'town', lat: 53.35, lng: 10.4, routeDistanceKm: 44, offsetKm: 6 },
  { name: 'Brambury', place: 'village', lat: 53.3, lng: 10.5, routeDistanceKm: 51, offsetKm: 4 }, // nearer-along, far-offset
  { name: 'Craghill', place: 'town', lat: 53.25, lng: 10.6, routeDistanceKm: 54, offsetKm: 1 }, // farther-along, close-offset
  { name: 'Dunmoor', place: 'city', lat: 53.2, lng: 10.7, routeDistanceKm: 60, offsetKm: 2 }, // == upper bound
  { name: 'Elmswick', place: 'village', lat: 53.15, lng: 10.8, routeDistanceKm: 61, offsetKm: 0 }, // just above window
  { name: 'Foxholt', place: 'town', lat: 53.1, lng: 10.9, routeDistanceKm: 75, offsetKm: 0 },
  { name: 'Greymere', place: 'village', lat: 53.05, lng: 11.0, routeDistanceKm: 90, offsetKm: 8 },
  { name: 'Harrow', place: 'city', lat: 53.0, lng: 11.1, routeDistanceKm: 120, offsetKm: 0 },
];

describe('townsNear', () => {
  test('includes towns exactly at the window boundary and excludes towns just outside it', () => {
    const names = townsNear(TOWNS, 50, { windowKm: 10 }).map((t) => t.name);
    expect(names).toContain('Millbrook'); // routeDistanceKm 40 == 50 - 10
    expect(names).toContain('Dunmoor'); // routeDistanceKm 60 == 50 + 10
    expect(names).not.toContain('Pinewell'); // routeDistanceKm 39, just below
    expect(names).not.toContain('Elmswick'); // routeDistanceKm 61, just above
  });

  test('ranks a farther-along but much-closer-offset town ahead of a nearer-along but far-offset one', () => {
    // Brambury: diff 1, offset 4 -> score 1 + 6   = 7
    // Craghill: diff 4, offset 1 -> score 4 + 1.5 = 5.5 (should rank first)
    const names = townsNear(TOWNS, 50, { windowKm: 10 }).map((t) => t.name);
    const craghillIndex = names.indexOf('Craghill');
    const bramburyIndex = names.indexOf('Brambury');
    expect(craghillIndex).toBeGreaterThanOrEqual(0);
    expect(bramburyIndex).toBeGreaterThanOrEqual(0);
    expect(craghillIndex).toBeLessThan(bramburyIndex);
  });

  test('returns the full window in ascending score order', () => {
    const names = townsNear(TOWNS, 50, { windowKm: 10 }).map((t) => t.name);
    expect(names).toEqual(['Craghill', 'Brambury', 'Millbrook', 'Dunmoor', 'Ashford']);
  });

  test('respects the max cap', () => {
    const names = townsNear(TOWNS, 50, { windowKm: 10, max: 3 }).map((t) => t.name);
    expect(names).toEqual(['Craghill', 'Brambury', 'Millbrook']);
  });

  test('applies default windowKm and max when options are omitted', () => {
    const names = townsNear(TOWNS, 50).map((t) => t.name);
    // default windowKm = 12 -> range [38, 62], pulling in Pinewell and Elmswick too
    expect(names).toEqual(
      expect.arrayContaining(['Pinewell', 'Millbrook', 'Ashford', 'Brambury', 'Craghill', 'Dunmoor', 'Elmswick'])
    );
    expect(names).toHaveLength(7);
  });

  test('returns an empty array when nothing falls within the window', () => {
    expect(townsNear(TOWNS, 1000, { windowKm: 5 })).toEqual([]);
  });

  test('does not mutate the input array or its town objects', () => {
    const snapshot = JSON.stringify(TOWNS);
    const result = townsNear(TOWNS, 50, { windowKm: 10 });
    expect(JSON.stringify(TOWNS)).toBe(snapshot);
    // returned entries are the same objects, not copies
    const dunmoor = TOWNS.find((t) => t.name === 'Dunmoor');
    expect(result.find((t) => t.name === 'Dunmoor')).toBe(dunmoor);
  });

  describe('binary search at array edges', () => {
    const short = [
      { name: 'A', place: 'town', lat: 0, lng: 0, routeDistanceKm: 10, offsetKm: 1 },
      { name: 'B', place: 'town', lat: 0, lng: 0, routeDistanceKm: 20, offsetKm: 1 },
      { name: 'C', place: 'town', lat: 0, lng: 0, routeDistanceKm: 30, offsetKm: 1 },
    ];

    test('endpoint before the first town returns empty', () => {
      expect(townsNear(short, -100, { windowKm: 5 })).toEqual([]);
    });

    test('endpoint after the last town returns empty', () => {
      expect(townsNear(short, 1000, { windowKm: 5 })).toEqual([]);
    });

    test('endpoint at the first town is included', () => {
      const names = townsNear(short, 10, { windowKm: 2 }).map((t) => t.name);
      expect(names).toEqual(['A']);
    });

    test('endpoint at the last town is included', () => {
      const names = townsNear(short, 30, { windowKm: 2 }).map((t) => t.name);
      expect(names).toEqual(['C']);
    });

    test('empty towns array returns empty', () => {
      expect(townsNear([], 10)).toEqual([]);
    });
  });
});

describe('townLabel', () => {
  test('formats name, distance along, and offset', () => {
    expect(townLabel({ name: 'Foo', routeDistanceKm: 12.3, offsetKm: 1.2 })).toBe(
      'Foo — 12.3 km along, 1.2 km off route'
    );
  });
});

describe('loadTowns', () => {
  test('is exported as an async loader (not invoked here; data file is generated separately)', () => {
    expect(typeof loadTowns).toBe('function');
  });
});
