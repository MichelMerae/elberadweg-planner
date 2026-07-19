import { describe, expect, test } from 'vitest';
import { lowerBound, upperBound } from './sorted-range.js';

// Sorted ascending by routeDistanceKm, with a duplicate km value (30) to
// exercise tie-breaking behavior at an exact match.
const ARR = [
  { name: 'A', routeDistanceKm: 10 },
  { name: 'B', routeDistanceKm: 20 },
  { name: 'C', routeDistanceKm: 30 },
  { name: 'D', routeDistanceKm: 30 },
  { name: 'E', routeDistanceKm: 40 },
];

describe('lowerBound', () => {
  test('returns 0 for an empty array', () => {
    expect(lowerBound([], 10)).toBe(0);
  });

  test('target before the first element returns 0', () => {
    expect(lowerBound(ARR, -100)).toBe(0);
  });

  test('target after the last element returns arr.length', () => {
    expect(lowerBound(ARR, 1000)).toBe(ARR.length);
  });

  test('exact match returns the index of the first matching element', () => {
    expect(lowerBound(ARR, 30)).toBe(2);
  });

  test('target between two elements returns the index of the next element', () => {
    expect(lowerBound(ARR, 25)).toBe(2);
  });

  test('target exactly at the first element returns 0', () => {
    expect(lowerBound(ARR, 10)).toBe(0);
  });

  test('target exactly at the last element returns its index', () => {
    expect(lowerBound(ARR, 40)).toBe(4);
  });
});

describe('upperBound', () => {
  test('returns 0 for an empty array', () => {
    expect(upperBound([], 10)).toBe(0);
  });

  test('target before the first element returns 0', () => {
    expect(upperBound(ARR, -100)).toBe(0);
  });

  test('target after the last element returns arr.length', () => {
    expect(upperBound(ARR, 1000)).toBe(ARR.length);
  });

  test('exact match returns the index just past all matching (duplicate) elements', () => {
    expect(upperBound(ARR, 30)).toBe(4);
  });

  test('target between two elements returns the index of the next element', () => {
    expect(upperBound(ARR, 25)).toBe(2);
  });

  test('target exactly at the first element returns the index just past it', () => {
    expect(upperBound(ARR, 10)).toBe(1);
  });

  test('target exactly at the last element returns arr.length', () => {
    expect(upperBound(ARR, 40)).toBe(5);
  });
});
