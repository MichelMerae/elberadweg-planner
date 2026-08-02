import { describe, it, expect } from 'vitest';
import { altKmAt, canonicalKmFromAlt } from './path.js';

// Three anchors: canonical 100→200→300 maps to alt 0→110→190.
const T = [
  { id: 'a', kmCanonical: 100, kmAlt: 0 },
  { id: 'b', kmCanonical: 200, kmAlt: 110 },
  { id: 'c', kmCanonical: 300, kmAlt: 190 },
];

describe('altKmAt', () => {
  it('maps anchors exactly', () => {
    expect(altKmAt(T, 100)).toBe(0);
    expect(altKmAt(T, 200)).toBe(110);
    expect(altKmAt(T, 300)).toBe(190);
  });
  it('interpolates linearly between anchors', () => {
    expect(altKmAt(T, 150)).toBeCloseTo(55);   // first span stretches ×1.1
    expect(altKmAt(T, 250)).toBeCloseTo(150);  // second span shrinks ×0.8
  });
  it('returns null outside alt coverage', () => {
    expect(altKmAt(T, 99.9)).toBeNull();
    expect(altKmAt(T, 300.1)).toBeNull();
  });
});

describe('canonicalKmFromAlt', () => {
  it('is the inverse of altKmAt on the covered range', () => {
    for (const km of [100, 137, 200, 261.5, 300]) {
      expect(canonicalKmFromAlt(T, altKmAt(T, km))).toBeCloseTo(km);
    }
  });
  it('returns null outside coverage', () => {
    expect(canonicalKmFromAlt(T, -1)).toBeNull();
    expect(canonicalKmFromAlt(T, 191)).toBeNull();
  });
});
