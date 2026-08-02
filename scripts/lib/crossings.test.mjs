import { describe, it, expect } from 'vitest';
import { slugifyCrossingId, deriveCrossings, dedupeCrossings } from './crossings.mjs';

// Two parallel lines 200 m apart along lat, 10 km long along lng at lat 53.
const N = 41;
const lineA = Array.from({ length: N }, (_, i) => [i * 0.005, 53.0]);
const lineB = Array.from({ length: N }, (_, i) => [i * 0.005, 53.0018]); // ~200 m north

const bridgeWay = (lngIdx, name) => ({
  type: 'way', id: lngIdx, tags: { bridge: 'yes', highway: 'cycleway', name },
  geometry: [ { lon: lngIdx * 0.005, lat: 53.0 }, { lon: lngIdx * 0.005, lat: 53.0018 } ],
});
const ferryWay = (lngIdx, name) => ({
  type: 'way', id: 1000 + lngIdx, tags: { route: 'ferry', name },
  geometry: [ { lon: lngIdx * 0.005, lat: 53.0 }, { lon: lngIdx * 0.005, lat: 53.0018 } ],
});

describe('slugifyCrossingId', () => {
  it('lowercases, transliterates umlauts, keeps the rounded km', () => {
    expect(slugifyCrossingId('Magdeburg, Sternbrücke', 478.61)).toBe('magdeburg-sternbruecke-479');
  });

  it('keeps a compound id when the name slugifies to nothing', () => {
    // A name with no ASCII-mappable characters would otherwise leave the km
    // as the whole id, so two such crossings at one km would collide.
    expect(slugifyCrossingId('???', 12.3)).toBe('crossing-12');
  });
});

describe('deriveCrossings', () => {
  it('emits a crossing per qualifying way, with km on both lines and a length', () => {
    const out = deriveCrossings([bridgeWay(10, 'Test Bridge'), ferryWay(30, 'Test Ferry')], lineA, lineB, { maxSnapM: 250 });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: 'bridge', name: 'Test Bridge' });
    expect(out[1].kind).toBe('ferry');
    expect(out[0].kmCanonical).toBeLessThan(out[1].kmCanonical);
    expect(out[0].lengthKm).toBeGreaterThan(0.15);
    expect(out[0].lengthKm).toBeLessThan(0.3);
  });
  it('drops a way whose ends are too far from either line', () => {
    const far = { ...bridgeWay(10, 'Far'), geometry: [{ lon: 0.05, lat: 53.02 }, { lon: 0.05, lat: 53.03 }] };
    expect(deriveCrossings([far], lineA, lineB, { maxSnapM: 250 })).toHaveLength(0);
  });
  it('names an unnamed way from the nearest town + kind', () => {
    const anon = { ...bridgeWay(20, undefined) };
    delete anon.tags.name;
    const towns = [{ name: 'Teststadt', routeDistanceKm: 3.4 }];
    const out = deriveCrossings([anon], lineA, lineB, { maxSnapM: 250, towns });
    expect(out[0].name).toBe('Teststadt bridge');
  });
});

describe('dedupeCrossings', () => {
  it('merges two crossings within 150 m on both axes, keeping the shorter', () => {
    const a = { id: 'x-1', name: 'X', kind: 'bridge', kmCanonical: 5.0, kmAlt: 5.1, lengthKm: 0.3, coord: [0, 0] };
    const b = { id: 'y-1', name: 'Y', kind: 'bridge', kmCanonical: 5.1, kmAlt: 5.2, lengthKm: 0.2, coord: [0, 0] };
    const out = dedupeCrossings([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].lengthKm).toBe(0.2);
  });
  it('keeps genuinely distinct neighbours (Magdeburg has several)', () => {
    const a = { id: 'x-1', name: 'X', kind: 'bridge', kmCanonical: 5.0, kmAlt: 5.0, lengthKm: 0.3, coord: [0, 0] };
    const b = { id: 'y-1', name: 'Y', kind: 'bridge', kmCanonical: 6.2, kmAlt: 6.3, lengthKm: 0.2, coord: [0, 0] };
    expect(dedupeCrossings([a, b])).toHaveLength(2);
  });
});
