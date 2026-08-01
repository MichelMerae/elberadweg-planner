// ui-util.js is mostly one-line render helpers exercised through the modules that
// use them, which is why it had no test file of its own until now. `tripHeadline` is
// different: it is a SENTENCE about the trip, and the same sentence serves the setup
// step and the confirmation after a pick — so the two cannot describe one trip
// differently, and the thing that could make them lie (the direction word) is not
// observable from either caller's own assertions.
//
// No DOM: every function here returns a string.
import { describe, it, expect } from 'vitest';
import { createTrip } from './trip.js';
import { tripHeadline } from './ui-util.js';

// The real corridor, and the window Michel actually rides: Hamburg-ish km 149.3 to
// Dresden-ish km 797.6 on a 1026.5 km road, then the same window the other way.
const ROAD_KM = 1026.5;
const UP = createTrip({ startKm: 149.3, destinationKm: 797.6, totalKm: ROAD_KM });
const DOWN = createTrip({ startKm: 797.6, destinationKm: 149.3, totalKm: ROAD_KM });

describe('tripHeadline', () => {
  // The two tests below are ONE claim in two halves and have to stay a pair: either
  // alone passes against a hardcoded word, which is the whole failure mode. They are
  // also the only place the app's answer to "which way is +1" is written down as a
  // word — km 0 is Cuxhaven at 5 m and the road's far end is Prague at 205 m, so
  // ascending km climbs towards the source and an ascending trip rides UPSTREAM.
  // Which is the direction most Elberadweg guidebooks do not describe: they run
  // source-to-sea, so Michel's own trip runs against them and the word is doing real
  // work here rather than decorating a number.
  it('names both ends, the distance and the direction, on an ascending trip', () => {
    expect(tripHeadline(UP, { startName: 'Hamburg', destinationName: 'Dresden' })).toBe(
      'Hamburg → Dresden · 648.3 km upstream',
    );
  });

  it('calls the same window downstream when it is ridden the other way', () => {
    expect(tripHeadline(DOWN, { startName: 'Dresden', destinationName: 'Hamburg' })).toBe(
      'Dresden → Hamburg · 648.3 km downstream',
    );
  });

  // main.js resolves the names, and until Task 12 derives them from the picked km
  // there often are none. An end with no name reads as its ROLE — 'undefined' or
  // 'null' in a sentence the rider is meant to check their trip against is worse
  // than saying nothing precise at all.
  it('reads an unnamed end as its role rather than as undefined', () => {
    expect(tripHeadline(UP)).toBe('your start → your finish · 648.3 km upstream');
    expect(tripHeadline(UP, { startName: null, destinationName: undefined })).toBe(
      'your start → your finish · 648.3 km upstream',
    );
  });

  // The names are OSM data (Task 12 takes them from the picked town), and this
  // sentence goes through innerHTML at every call site. Asserted on the STRING, which
  // is what this function produces: the escaped form must be present and the raw
  // payload absent, so dropping either esc() fails here.
  it('escapes both names', () => {
    const line = tripHeadline(UP, {
      startName: '<img src=x onerror="alert(1)">',
      destinationName: 'Ústí & Dresden',
    });

    expect(line).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(line).not.toContain('<img');
    expect(line).toContain('Ústí &amp; Dresden');
  });

  // Rounded like every other km a rider reads. A window's ends are picked off a route
  // line, so its length is off-grid far more often than not.
  it('rounds the distance the way every displayed km is rounded', () => {
    const odd = createTrip({ startKm: 149.3, destinationKm: 797.66, totalKm: ROAD_KM });

    expect(tripHeadline(odd, { startName: 'Hamburg', destinationName: 'Dresden' })).toBe(
      'Hamburg → Dresden · 648.4 km upstream',
    );
  });
});
