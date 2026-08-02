import { describe, it, expect } from 'vitest';
import { altKmAt, canonicalKmFromAlt, createPath } from './path.js';
import { createTrip } from './trip.js';
import { createRouteIndex } from './route.js';

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

// Synthetic geometry: canonical = straight line 0..400 km (along lng), alt line
// covers canonical 100..300 with the T table above (alt total 190 km).
// 1 degree lng at lat 0 ≈ 111.32 km; build indexes from evenly spaced vertices.
function straightLine(totalKm, points = 81) {
  const coords = [];
  for (let i = 0; i < points; i += 1) coords.push([(totalKm / 111.32) * (i / (points - 1)), 0]);
  return createRouteIndex({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
}
const canonicalIndex = straightLine(400);
const altIndex = straightLine(190);
const TABLE = [
  { id: 'a', name: 'A bridge', kind: 'bridge', kmCanonical: 100, kmAlt: 0, lengthKm: 0.5 },
  { id: 'b', name: 'B ferry', kind: 'ferry', kmCanonical: 200, kmAlt: 110, lengthKm: 0.3 },
  { id: 'c', name: 'C bridge', kind: 'bridge', kmCanonical: 300, kmAlt: 190, lengthKm: 0.4 },
];
const SEGMENTS = [{ startKm: 0, endKm: 400, bank: 'right' }];

function path(tripOpts, chosen = []) {
  return createPath({
    trip: createTrip({ totalKm: 400, ...tripOpts }),
    chosenCrossingIds: chosen,
    crossings: TABLE,
    canonicalIndex,
    altIndex,
    segments: SEGMENTS,
  });
}

describe('createPath with no crossings', () => {
  it('is the trip: same window, ridden == canonical', () => {
    const p = path({ startKm: 50, destinationKm: 350 });
    expect(p.lengthKm).toBeCloseTo(300);
    expect(p.tripKm(150)).toBeCloseTo(100);
    expect(p.absoluteKm(100)).toBeCloseTo(150);
    expect(p.advance(50, 60)).toBeCloseTo(110);
    expect(p.bankAt(200)).toBe('right');
  });
});

describe('createPath with one crossing chosen', () => {
  // Cross at a (km 100): ride canonical 50→100 (50 km), cross 0.5 km,
  // then alt from altKm 0. Alt span 100..200 canonical = 110 km ridden.
  const p = path({ startKm: 50, destinationKm: 250 }, ['a']);

  it('flips the bank after the crossing', () => {
    expect(p.bankAt(99)).toBe('right');
    expect(p.bankAt(101)).toBe('left');
  });
  it('tripKm counts ridden km including the crossing itself', () => {
    expect(p.tripKm(100)).toBeCloseTo(50);          // at the crossing
    expect(p.tripKm(200)).toBeCloseTo(50 + 0.5 + 110); // canonical + cross + alt span
  });
  it('absoluteKm inverts tripKm through the alt stretch', () => {
    for (const km of [60, 100, 150, 199, 250]) {
      expect(p.absoluteKm(p.tripKm(km))).toBeCloseTo(km);
    }
  });
  it('advance walks ridden km: a 55 km day starting at km 50 ends INSIDE the crossing step', () => {
    // 50 ridden reaches the crossing; the next 0.5 is the ferry; 55 lands 4.5 km into the alt
    const end = p.advance(50, 55);
    expect(p.tripKm(end)).toBeCloseTo(55);
    expect(end).toBeGreaterThan(100);
  });
  it('lengthKm is the ridden total, not the canonical window', () => {
    // canonical 50→100 (50) + cross (0.5) + alt 100→250 (alt 0→150·(110/100)... use mapping)
    expect(p.lengthKm).toBeCloseTo(50 + 0.5 + (altKmAt(TABLE, 250) - 0));
  });
});

describe('cross and cross back', () => {
  const p = path({ startKm: 50, destinationKm: 350 }, ['a', 'b']);
  it('returns to canonical after the second crossing', () => {
    expect(p.bankAt(150)).toBe('left');
    expect(p.bankAt(250)).toBe('right');
  });
  it('total = 50 + 0.5 + 110 + 0.3 + 150', () => {
    expect(p.lengthKm).toBeCloseTo(50 + 0.5 + 110 + 0.3 + 150);
  });
});

describe('downstream trips (destination < start)', () => {
  const p = path({ startKm: 350, destinationKm: 50 }, ['b']);
  it('parity counts along the trip direction', () => {
    expect(p.bankAt(250)).toBe('right'); // before crossing b (riding 350→50)
    expect(p.bankAt(150)).toBe('left');  // after it
  });
  it('tripKm still reads positive along the ride', () => {
    // THE BOUNDARY CONVENTION: a km AT a crossing reads as the NEAR side — you have
    // ridden 150 km when you arrive at ferry b, and its 0.3 km is paid as you ride
    // across, so only km on the far side carry it. Same rule both directions: the
    // upstream case above reads tripKm(100) === 50, not 50.5.
    expect(p.tripKm(200)).toBeCloseTo(150);
    expect(p.tripKm(199)).toBeCloseTo(150 + 0.3 + altKmAt(TABLE, 200) - altKmAt(TABLE, 199));
  });
});

describe('crossingsBetween', () => {
  const p = path({ startKm: 50, destinationKm: 350 }, ['a']);
  it('annotates chosen state and canCross, ordered the trip way', () => {
    const rows = p.crossingsBetween(50, 350);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rows[0].chosen).toBe(true);
    expect(rows[1].canCross).toBe(true);   // crossing back is always allowed
    expect(rows[2].chosen).toBe(false);
  });
  it('the outermost crossing cannot START an alt leg (deviation 5)', () => {
    const q = path({ startKm: 50, destinationKm: 350 }, []);
    const rows = q.crossingsBetween(50, 350);
    expect(rows.find((r) => r.id === 'c').canCross).toBe(false); // no anchor beyond c
    expect(rows.find((r) => r.id === 'a').canCross).toBe(true);
  });
});

describe('edge rules', () => {
  it('a chosen crossing outside the window is ignored, not dropped', () => {
    const p = path({ startKm: 150, destinationKm: 250 }, ['c']);
    expect(p.bankAt(200)).toBe('right');
    expect(p.lengthKm).toBeCloseTo(100);
  });
  it('out-of-window tripKm extrapolates at canonical rate (deviation 4)', () => {
    const p = path({ startKm: 100, destinationKm: 300 }, ['a']);
    expect(p.tripKm(90)).toBeCloseTo(-10);
  });
  it('legs() names the banks and carries ridden lengths', () => {
    const p = path({ startKm: 50, destinationKm: 250 }, ['a']);
    const legs = p.legs();
    expect(legs.map((l) => l.bank)).toEqual(['right', 'left']);
    expect(legs[0]).toMatchObject({ fromKm: 50, toKm: 100 });
    expect(legs[0].riddenLengthKm).toBeCloseTo(50);
    expect(legs[1].riddenLengthKm).toBeCloseTo(altKmAt(TABLE, 250));
    expect(legs[1].crossingIn.id).toBe('a');
  });
  it('coords() hops lines at the crossing', () => {
    const p = path({ startKm: 50, destinationKm: 250 }, ['a']);
    const coords = p.coords(50, 250);
    expect(coords.length).toBeGreaterThan(4);
    // last coordinate sits on the alt line (lat 0 both here — check via km instead):
    expect(p.bankAt(250)).toBe('left');
  });
});
