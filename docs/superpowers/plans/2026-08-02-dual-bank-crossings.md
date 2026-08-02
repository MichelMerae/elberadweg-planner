# Two Banks & Crossings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the second Elbe bank (official elberadweg.de GPX, both German banks) and let the rider switch banks at derived physical crossings — as a day-planning action — with every displayed distance measured on the bank actually ridden.

**Architecture:** The canonical line keeps the one scalar km axis; the left bank becomes `route.alt.json` plus a derived `crossings.json` table. One new pure module `src/path.js` decorates a trip with the piecewise canonical⇄ridden mapping and is handed to `createItinerary`, the day panel and the strip **as the trip** — so day lengths, breaks and boundaries become bank-honest without any of those modules changing their contracts. Storage v5 adds `crossings: [id]` to the plan. Build-side, two new pure libs (`gpx.mjs`, `crossings.mjs`) feed an extended `build-data.mjs`.

**Tech Stack:** Node 18+ ESM, `@turf/turf` 7, Overpass QL (crossings + CZ), official GPX over HTTPS, vitest 4 (jsdom pragma per UI test file), Vite 8, vanilla JS + Leaflet 1.9.

**Spec:** `docs/superpowers/specs/2026-08-02-dual-bank-crossings-design.md`

---

## Deviations from the spec, decided while planning

Recorded here rather than silently applied.

1. **Schema version is 5, not 4.** The spec said "the schema version becomes 4"; `src/storage.js:6` is *already* at 4 (the trip-window feature took it). This feature ships **SCHEMA_VERSION 5**, readable set `{5, 4, 3, 2}`. The routeId change archives old blobs anyway, so the v4→v5 read path is just `crossings: []` defaulting in `normalizePlan`.
2. **`tripKm`/`absoluteKm` do NOT delegate — they ARE the ridden mapping.** Spec §4 listed `tripKm` as a passthrough and `riddenKm`/`canonicalKmAt` as separate members. That would leave `day-panel.js`'s `rideKm()` and `itinerary.js`'s converters printing canonical spans — dishonest exactly where honesty was the point. Instead `path.tripKm(absKm)` returns **signed ridden km** and `path.absoluteKm(riderKm)` is its inverse; the separate members disappear. Every consumer of a trip keeps working because the mapping is strictly monotonic.
3. **Elevation stays on the canonical profile.** `elevation.json` is a flat `{routeId, spacingM, elevationsM[]}` (not the spec's `{canonical, alt}` — the spec misremembered its shape), and both banks share a river valley floor: opposite-bank height differences are metres, under one strip pixel at 2 px/column. `elevation.json` is simply **rebuilt** for the new line and routeId. An `elevation.alt.json` is deferred until a real profile difference is demonstrated.
4. **Out-of-window km read at canonical rate.** `tripKm` of a km behind the start / past the destination (used only for "12 km behind you" favorite labels) extrapolates 1:1 instead of extending the piecewise mapping beyond the window. Recorded, not hidden: the label is approximate off-trip by the bank-length skew, which is under 4% between anchors.
5. **Outermost crossings are "cross back only".** The alt line ends *at* the first and last crossing, so toggling onto the alt bank is only offered when a further anchor exists in trip direction (`canCross` flag). Without this, the last crossing before the border would offer a bank that ends immediately.
6. **Route clicks snap to both lines.** A rider on the left bank clicking their line must not get a custom stop snapped across the river. `main.js` snaps against both features and converts an alt-line hit to canonical km through the crossing table. Small, and prevents a genuinely wrong interaction.
7. **A feature branch, not a worktree** — same reasoning as the previous plan: the data build needs this checkout's `node_modules`. Branch: `feature/two-banks`.
8. **Task 0 is a throwaway spike.** The two unknowns that could invalidate everything: do the official GPX files download & stitch into two clean banks, and does crossing derivation land in the sane 15–60 range? Answered in one scratchpad script before any tested code.
9. **GPX raw cache ignore pattern.** `.gitignore` gains `src/data/gpx.raw/` — the 30 official files are cached as downloaded, one file each, refreshable with `--refresh` like the Overpass caches.
10. **Meta segments gain a `bank` field** (`'left' | 'right' | null`). `bankAt` needs the canonical line's own geographic bank per segment (left north of the Hamburg junction, right south of it, `null` in CZ where the single line is both banks); reading it from meta keeps `path.js` free of geography constants.

---

## File Structure

**Create:**
- `scripts/lib/gpx.mjs` — pure GPX→coords parser (no deps, no I/O). `parseGpxTracks(xml)`.
- `scripts/lib/gpx.test.mjs` — unit tests.
- `scripts/lib/crossings.mjs` — pure crossing derivation: `slugifyCrossingId`, `projectOntoLine`, `deriveCrossings`, `dedupeCrossings`. Fed prepared inputs; no fetching.
- `scripts/lib/crossings.test.mjs` — unit tests.
- `src/path.js` — the path model: `altKmAt`, `canonicalKmFromAlt`, `createPath`. Pure; imports only `./route.js` helpers.
- `src/path.test.js` — unit tests (node env).
- `src/data/route.alt.json`, `src/data/crossings.json` — generated, committed.

**Modify:**
- `scripts/build-data.mjs` — GPX fetch + two-bank assembly, crossings derivation, bank tags on towns/POIs, new meta.
- `src/storage.js` + `src/storage.test.js` — schema 5, `crossings` on the plan record.
- `src/route.js` — `loadAltRoute()`, `loadCrossings()` loaders.
- `src/main.js` — path wiring, crossing handlers, dual-line snapping, path-aware pins/highlight.
- `src/day-panel.js` + test — crossing legs + "Crossings you pass today" group + two callbacks.
- `src/map.js` + test — alt route layer, crossing markers, `onCrossingClick`.
- `src/strip.js`, `src/strip-markup.js` + tests — bank ribbon row.
- `src/style.css` — ribbon + crossing marker styles.
- `.gitignore`, `README.md`.
- `src/data/route.json`, `route.meta.json`, `towns.json`, `pois.json`, `elevation.json` — regenerated.

**Why this split:** every genuinely new algorithm (GPX parsing, crossing derivation, the ridden mapping) sits behind a pure, unit-tested interface; `build-data.mjs` stays the untested orchestrator it already is, verified by its own validation report; UI modules keep their `createX({el, callbacks})`/`render(state)` contracts and are tested in jsdom as today.

---

## Task 0: Spike — official GPX + crossing count (throwaway, never committed)

**Files:** Create (scratchpad only): `<scratchpad>/spike-banks.mjs`

- [ ] **Step 1: Write and run the spike**

```js
// <scratchpad>/spike-banks.mjs — run: node spike-banks.mjs (cwd: planner-app, uses its node_modules)
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import * as turf from '@turf/turf';

const DIR = process.env.SPIKE_DIR ?? '.';
mkdirSync(`${DIR}/gpx`, { recursive: true });
const SECTIONS = 'ABCDEFGHIJKLMNO'.split('');
const gpxUrl = (sec, side) =>
  'https://www.elberadweg.de/gps/' +
  encodeURIComponent(`Elberadweg - Labská stezka [Abschnitt ${sec} ${side}].gpx`);

async function fetchGpx(sec, side) {
  const file = `${DIR}/gpx/${sec}-${side}.gpx`;
  if (existsSync(file)) return readFileSync(file, 'utf8');
  const res = await fetch(gpxUrl(sec, side), { headers: { 'User-Agent': 'elberadweg-planner/spike' } });
  if (!res.ok) throw new Error(`${sec} ${side}: HTTP ${res.status} for ${gpxUrl(sec, side)}`);
  const text = await res.text();
  writeFileSync(file, text);
  return text;
}

// crude trkpt scrape — the spike only needs coordinates
function coordsOf(xml) {
  const pts = [];
  const re = /<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g;
  for (let m; (m = re.exec(xml)); ) pts.push([Number(m[2]), Number(m[1])]);
  return pts;
}

for (const side of ['links', 'rechts']) {
  let line = [];
  for (const sec of SECTIONS) {
    const pts = coordsOf(await fetchGpx(sec, side));
    if (!pts.length) { console.log(`  !! ${sec} ${side}: 0 points`); continue; }
    if (line.length) {
      const gapM = turf.distance(line[line.length - 1], pts[0], { units: 'meters' });
      const gapRevM = turf.distance(line[line.length - 1], pts[pts.length - 1], { units: 'meters' });
      console.log(`  join ${sec} ${side}: gap ${Math.round(gapM)} m (reversed: ${Math.round(gapRevM)} m), ${pts.length} pts`);
      if (gapRevM < gapM) pts.reverse();
    }
    line = line.concat(pts);
  }
  const km = turf.length(turf.lineString(line), { units: 'kilometers' });
  console.log(`${side}: ${line.length} pts, ${km.toFixed(1)} km`);
}
```

- [ ] **Step 2: Extend the spike with a crossing-count probe**

Append (uses the two lines from step 1 kept in memory; refactor the loop to store `lines.links` / `lines.rechts`):

```js
const q = `[out:json][timeout:180];
( way["bridge"]["highway"~"^(cycleway|path|footway|track|residential|unclassified|tertiary|secondary|primary)$"]["bicycle"!="no"](53.0,8.5,53.9,10.2);
  way["route"="ferry"](53.0,8.5,53.9,10.2);
  relation["route"="ferry"](53.0,8.5,53.9,10.2); );
out body; >; out skel qt;`;
// probe ONE bbox band (Hamburg area) just to sanity-check tag yield; full corridor comes later
const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'data=' + encodeURIComponent(q),
});
const osm = await res.json();
console.log('bridge/ferry candidate elements in Hamburg band:', osm.elements.filter((e) => e.type === 'way' || e.type === 'relation').length);
```

- [ ] **Step 3: Record findings at the top of this plan**

Decide from output: (a) URL pattern works or needs correcting from the site's HTML, (b) per-section join gaps (expect < 100 m; sections share endpoints), (c) each bank's total length (expect 840–900 km — the official banks are longer than the OSM composite), (d) candidate yield is nonzero. If (a) fails, fix the URL constant in Task 4 before proceeding — everything else is source-independent.

---

## Task 1: `scripts/lib/gpx.mjs` — GPX parser

**Files:**
- Create: `scripts/lib/gpx.mjs`
- Test: `scripts/lib/gpx.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lib/gpx.test.mjs
import { describe, it, expect } from 'vitest';
import { parseGpxTracks } from './gpx.mjs';

const GPX = `<?xml version="1.0"?>
<gpx version="1.1"><trk><name>A links</name>
<trkseg>
<trkpt lat="53.8600" lon="8.6900"><ele>3</ele></trkpt>
<trkpt lon="8.7000" lat="53.8550"/>
</trkseg>
<trkseg>
<trkpt lat="53.8500" lon="8.7100"/>
</trkseg>
</trk></gpx>`;

describe('parseGpxTracks', () => {
  it('returns one coords array per trkseg, as [lng, lat]', () => {
    expect(parseGpxTracks(GPX)).toEqual([
      [[8.69, 53.86], [8.7, 53.855]],
      [[8.71, 53.85]],
    ]);
  });

  it('accepts either attribute order and self-closed trkpt', () => {
    const segs = parseGpxTracks(GPX);
    expect(segs[0][1]).toEqual([8.7, 53.855]);
  });

  it('throws on a document with no trkpt at all', () => {
    expect(() => parseGpxTracks('<gpx><trk></trk></gpx>')).toThrow(/no trkpt/i);
  });

  it('ignores waypoints and route points — only trkseg counts', () => {
    const withWpt = GPX.replace('</gpx>', '<wpt lat="0" lon="0"/></gpx>');
    expect(parseGpxTracks(withWpt).flat()).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run scripts/lib/gpx.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// scripts/lib/gpx.mjs — minimal GPX track reader. Regex, not XML: GPX track points
// are flat, attribute-only elements, and the official files carry nothing exotic.
// Segments are kept separate so the caller can decide how to join them.

/**
 * @param {string} xml
 * @returns {Array<Array<[number, number]>>} one [lng,lat] array per <trkseg>
 */
export function parseGpxTracks(xml) {
  const segments = [];
  const segRe = /<trkseg[^>]*>([\s\S]*?)<\/trkseg>/g;
  const ptRe = /<trkpt\b([^>]*)>/g;
  const attr = (s, name) => {
    const m = new RegExp(`${name}="([-\\d.]+)"`).exec(s);
    return m ? Number(m[1]) : NaN;
  };
  for (let seg; (seg = segRe.exec(xml)); ) {
    const coords = [];
    for (let pt; (pt = ptRe.exec(seg[1])); ) {
      const lat = attr(pt[1], 'lat');
      const lon = attr(pt[1], 'lon');
      if (Number.isFinite(lat) && Number.isFinite(lon)) coords.push([lon, lat]);
    }
    if (coords.length) segments.push(coords);
  }
  if (!segments.length) throw new Error('parseGpxTracks: no trkpt found in document');
  return segments;
}
```

- [ ] **Step 4: Run tests** — `npx vitest run scripts/lib/gpx.test.mjs` → 4 PASS.
- [ ] **Step 5: Commit** — `git add scripts/lib/gpx.mjs scripts/lib/gpx.test.mjs && git commit -m "feat(build): GPX track parser for the official bank files"`

---

## Task 2: `src/path.js` part 1 — the axis mapping

**Files:**
- Create: `src/path.js`
- Test: `src/path.test.js`

The crossing table is the set of correspondence anchors between the two axes. Between adjacent anchors the map is linear. This task builds only the pure mapping; `createPath` follows in Task 3.

- [ ] **Step 1: Write the failing tests**

```js
// src/path.test.js
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
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/path.test.js` → FAIL.
- [ ] **Step 3: Implement**

```js
// src/path.js — the composed path: two bank lines, one km axis.
//
// THE INVARIANT, inherited from trip.js and preserved here: stored and computed
// km are absolute CANONICAL km; only displayed km are ridden km, and tripKm()
// is the one-way conversion. What this module adds is that "ridden" is now
// measured on the bank the rider chose, through the crossing table.

/**
 * The crossing table is the piecewise-linear correspondence between the
 * canonical axis and the alt axis. Anchors are ALL crossings, chosen or not.
 * Outside [first.kmCanonical, last.kmCanonical] there is no alt line: null.
 * @param {Array<{kmCanonical: number, kmAlt: number}>} table sorted by kmCanonical
 * @param {number} km canonical km
 * @returns {number|null} alt km
 */
export function altKmAt(table, km) {
  if (!table.length || km < table[0].kmCanonical || km > table[table.length - 1].kmCanonical) return null;
  let lo = 0;
  let hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table[mid].kmCanonical <= km) lo = mid;
    else hi = mid - 1;
  }
  if (lo === table.length - 1) return table[lo].kmAlt;
  const a = table[lo];
  const b = table[lo + 1];
  const span = b.kmCanonical - a.kmCanonical;
  const t = span > 0 ? (km - a.kmCanonical) / span : 0;
  return a.kmAlt + t * (b.kmAlt - a.kmAlt);
}

/** Inverse of altKmAt on the covered range; null outside it. */
export function canonicalKmFromAlt(table, altKm) {
  if (!table.length || altKm < table[0].kmAlt || altKm > table[table.length - 1].kmAlt) return null;
  let lo = 0;
  let hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table[mid].kmAlt <= altKm) lo = mid;
    else hi = mid - 1;
  }
  if (lo === table.length - 1) return table[lo].kmCanonical;
  const a = table[lo];
  const b = table[lo + 1];
  const span = b.kmAlt - a.kmAlt;
  const t = span > 0 ? (altKm - a.kmAlt) / span : 0;
  return a.kmCanonical + t * (b.kmCanonical - a.kmCanonical);
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/path.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(path): canonical <-> alt axis mapping over the crossing table"`

---

## Task 3: `src/path.js` part 2 — `createPath`

**Files:**
- Modify: `src/path.js`
- Test: `src/path.test.js`

- [ ] **Step 1: Write the failing tests** (append to `src/path.test.js`)

```js
import { createTrip } from './trip.js';
import { createRouteIndex } from './route.js';
import { createPath } from './path.js';

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
    expect(p.tripKm(200)).toBeCloseTo(150 + 0.3);
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
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/path.test.js` → new describes FAIL (`createPath` not exported).

- [ ] **Step 3: Implement `createPath`** (append to `src/path.js`)

```js
import { pointAtKm, stretchCoords } from './route.js';

/**
 * A trip decorated with bank choices: same interface createTrip returns —
 * createItinerary, the day panel and the strip consume it AS the trip — but
 * tripKm/absoluteKm/advance/lengthKm measure RIDDEN km on the composed path,
 * plus the bank/leg/crossing queries the new UI needs.
 *
 * @param {object} opts
 * @param {object} opts.trip - from createTrip()
 * @param {string[]} opts.chosenCrossingIds - crossing ids the plan chose
 * @param {Array} opts.crossings - the full table, sorted by kmCanonical
 * @param {object} opts.canonicalIndex - createRouteIndex(route)
 * @param {object|null} opts.altIndex - createRouteIndex(altRoute), null when absent
 * @param {Array<{startKm, endKm, bank}>} opts.segments - meta.segments bank info
 */
export function createPath({ trip, chosenCrossingIds = [], crossings = [], canonicalIndex, altIndex, segments = [] } = {}) {
  if (!trip || typeof trip.advance !== 'function') {
    throw new Error('createPath needs a trip (see createTrip in src/trip.js)');
  }
  const table = crossings;
  const byId = new Map(table.map((c) => [c.id, c]));

  // Chosen crossings that can actually compose: known id, inside the window,
  // and — when toggling ONTO the alt bank — a further anchor to ride toward.
  // Sorted along the trip's direction; parity below is positional.
  const chosen = chosenCrossingIds
    .map((id) => byId.get(id))
    .filter((c) => c && trip.contains(c.kmCanonical))
    .sort((a, b) => (a.kmCanonical - b.kmCanonical) * trip.direction);

  const first = table[0];
  const last = table[table.length - 1];
  const active = [];
  for (const c of chosen) {
    const ontoAlt = active.length % 2 === 0;
    if (ontoAlt) {
      const beyond = trip.direction === 1 ? c.kmCanonical < last?.kmCanonical : c.kmCanonical > first?.kmCanonical;
      if (!altIndex || !beyond) continue; // dead-end toggle: ignore (deviation 5)
    }
    active.push(c);
  }

  // Legs: consecutive [from, to] canonical spans, alternating bank line.
  // leg.crossingIn is the crossing ridden to ENTER this leg (null for the first).
  const canonicalBankAt = (km) =>
    segments.find((s) => km >= s.startKm && km <= s.endKm)?.bank ?? null;
  const flip = (bank) => (bank === 'left' ? 'right' : 'left');

  const legList = [];
  let cursor = trip.startKm;
  let onAlt = false;
  for (const c of active) {
    legList.push({ onAlt, fromKm: cursor, toKm: c.kmCanonical, crossingIn: legList.length ? active[legList.length - 1] : null });
    cursor = c.kmCanonical;
    onAlt = !onAlt;
  }
  legList.push({ onAlt, fromKm: cursor, toKm: trip.destinationKm, crossingIn: active.length ? active[active.length - 1] : null });

  const altSpan = (a, b) => Math.abs((altKmAt(table, b) ?? 0) - (altKmAt(table, a) ?? 0));
  const legRidden = (leg) => (leg.onAlt ? altSpan(leg.fromKm, leg.toKm) : Math.abs(leg.toKm - leg.fromKm));

  // Cumulative ridden km at each leg start, crossings included as steps.
  const legStartRidden = [];
  {
    let r = 0;
    for (const leg of legList) {
      if (leg.crossingIn) r += leg.crossingIn.lengthKm;
      legStartRidden.push(r);
      r += legRidden(leg);
    }
  }
  const riddenTotal = legStartRidden[legList.length - 1] + legRidden(legList[legList.length - 1]);

  const inLeg = (leg, km) =>
    trip.direction === 1 ? km >= leg.fromKm && km <= leg.toKm : km <= leg.fromKm && km >= leg.toKm;

  function tripKm(absoluteKm) {
    // Off-window: canonical rate, signed (deviation 4).
    const startSide = (absoluteKm - trip.startKm) * trip.direction;
    if (startSide < 0) return startSide;
    const endSide = (absoluteKm - trip.destinationKm) * trip.direction;
    if (endSide > 0) return riddenTotal + endSide;
    for (let i = 0; i < legList.length; i += 1) {
      const leg = legList[i];
      if (!inLeg(leg, absoluteKm)) continue;
      const partial = leg.onAlt ? altSpan(leg.fromKm, absoluteKm) : Math.abs(absoluteKm - leg.fromKm);
      return legStartRidden[i] + partial;
    }
    // Between legs can't happen (legs tile the window); keep the failure loud.
    throw new Error(`tripKm: km ${absoluteKm} not covered by any leg`);
  }

  function absoluteKm(riderKm) {
    if (riderKm <= 0) return trip.startKm + riderKm * trip.direction;
    if (riderKm >= riddenTotal) return trip.destinationKm + (riderKm - riddenTotal) * trip.direction;
    for (let i = legList.length - 1; i >= 0; i -= 1) {
      const leg = legList[i];
      let r = riderKm - legStartRidden[i];
      if (r < 0) continue;
      const len = legRidden(leg);
      if (r > len) r = len; // landed inside the NEXT crossing step: pin to this leg's end
      if (!leg.onAlt) return leg.fromKm + r * trip.direction;
      const altFrom = altKmAt(table, leg.fromKm);
      const altTo = altKmAt(table, leg.toKm);
      const dir = altTo >= altFrom ? 1 : -1;
      return canonicalKmFromAlt(table, altFrom + r * dir);
    }
    return trip.startKm;
  }

  return Object.freeze({
    startKm: trip.startKm,
    destinationKm: trip.destinationKm,
    totalKm: trip.totalKm,
    direction: trip.direction,
    lengthKm: riddenTotal,
    contains: trip.contains,
    clampKm: trip.clampKm,
    tripKm,
    absoluteKm,
    advance: (fromKm, distanceKm) => {
      const target = tripKm(fromKm) + distanceKm;
      return target >= riddenTotal ? trip.destinationKm : absoluteKm(target);
    },

    /** rider-word bank at a canonical km: segment bank, flipped on odd parity. */
    bankAt(km) {
      const base = canonicalBankAt(km);
      if (base === null) return null;
      const leg = legList.find((l) => inLeg(l, km));
      return leg?.onAlt ? flip(base) : base;
    },

    /** ordered legs for map / strip / rendering. */
    legs() {
      return legList.map((leg, i) => ({
        bank: leg.onAlt ? flip(canonicalBankAt(leg.fromKm) ?? 'right') : canonicalBankAt(leg.fromKm),
        onAlt: leg.onAlt,
        fromKm: leg.fromKm,
        toKm: leg.toKm,
        riddenLengthKm: legRidden(leg),
        startRiddenKm: legStartRidden[i],
        crossingIn: leg.crossingIn,
      }));
    },

    /** crossings whose canonical km lies in the oriented span (a, b], annotated. */
    crossingsBetween(a, b) {
      const from = tripKmRaw(a);
      const to = tripKmRaw(b);
      function tripKmRaw(km) { return (km - trip.startKm) * trip.direction; }
      const chosenIds = new Set(active.map((c) => c.id));
      return table
        .filter((c) => {
          const at = tripKmRaw(c.kmCanonical);
          return at > Math.min(from, to) && at <= Math.max(from, to);
        })
        .sort((x, y) => (x.kmCanonical - y.kmCanonical) * trip.direction)
        .map((c) => {
          const isChosen = chosenIds.has(c.id);
          const ontoAlt = !this ? false : undefined; // placeholder removed below
          return c;
        });
    },

    /** composed [lng,lat] polyline between two canonical km. */
    coords(a, b) {
      const out = [];
      for (const leg of legList) {
        const lo = trip.direction === 1 ? Math.max(leg.fromKm * 1, Math.min(a, b)) : 0;
        // simpler: clip in oriented space
        const f = clipToLeg(leg, a, b);
        if (!f) continue;
        const piece = leg.onAlt
          ? stretchAlt(f.from, f.to)
          : orient(stretchCoords(canonicalIndex, Math.min(f.from, f.to), Math.max(f.from, f.to)), f.from > f.to);
        for (const c of piece) out.push(c);
      }
      return out;

      function clipToLeg(leg, x, y) {
        const oa = (k) => (k - trip.startKm) * trip.direction;
        const spanLo = Math.min(oa(x), oa(y));
        const spanHi = Math.max(oa(x), oa(y));
        const legLo = Math.min(oa(leg.fromKm), oa(leg.toKm));
        const legHi = Math.max(oa(leg.fromKm), oa(leg.toKm));
        const lo = Math.max(spanLo, legLo);
        const hi = Math.min(spanHi, legHi);
        if (hi <= lo) return null;
        const back = (o) => trip.startKm + o * trip.direction;
        return trip.direction === 1 ? { from: back(lo), to: back(hi) } : { from: back(hi), to: back(lo) };
      }
      function stretchAlt(fromC, toC) {
        const fa = altKmAt(table, fromC);
        const ta = altKmAt(table, toC);
        return orient(stretchCoords(altIndex, Math.min(fa, ta), Math.max(fa, ta)), fa > ta);
      }
      function orient(coords, reversed) {
        return reversed ? coords.slice().reverse() : coords;
      }
    },

    /** [lng,lat] of a canonical km on the line actually ridden there. */
    pointAt(km) {
      const leg = legList.find((l) => inLeg(l, km));
      if (leg?.onAlt) {
        const a = altKmAt(table, km);
        if (a !== null) return pointAtKm(altIndex, a);
      }
      return pointAtKm(canonicalIndex, Math.min(Math.max(km, 0), canonicalIndex.totalKm));
    },

    /** the composing crossings, in ride order — what persists and what renders as legs. */
    activeCrossings: () => active.slice(),
  });
}
```

**Then fix `crossingsBetween`** — the annotation body written cleanly (the sketch above left it half-done; this is the real one):

```js
    crossingsBetween(a, b) {
      const oa = (km) => (km - trip.startKm) * trip.direction;
      const lo = Math.min(oa(a), oa(b));
      const hi = Math.max(oa(a), oa(b));
      const chosenIds = new Set(active.map((c) => c.id));
      return table
        .filter((c) => oa(c.kmCanonical) > lo && oa(c.kmCanonical) <= hi)
        .sort((x, y) => (x.kmCanonical - y.kmCanonical) * trip.direction)
        .map((c) => {
          const isChosen = chosenIds.has(c.id);
          const bankBefore = this?.bankAt ? null : null; // not used; parity decides below
          // Would pressing this cross toggle ONTO the alt line? Then it needs a
          // further anchor in trip direction (deviation 5). Crossing back is free.
          const priorParity = active.filter((x) => oa(x.kmCanonical) < oa(c.kmCanonical)).length;
          const ontoAlt = !isChosen && priorParity % 2 === 0;
          const beyond = trip.direction === 1 ? c.kmCanonical < last?.kmCanonical : c.kmCanonical > first?.kmCanonical;
          return { ...c, chosen: isChosen, canCross: isChosen || !ontoAlt || (!!altIndex && beyond) };
        });
    },
```

Note for the implementer: `crossingsBetween` must be a regular function on the returned object (not relying on `this`); delete the two placeholder lines when transcribing — they exist in this plan only to show what NOT to leave in.

- [ ] **Step 4: Run tests** — `npx vitest run src/path.test.js` → all PASS. Iterate until the mapping tests in Task 2 still pass too.
- [ ] **Step 5: Run the whole suite** — `npm test` → no regressions (nothing imports path.js yet).
- [ ] **Step 6: Commit** — `git commit -am "feat(path): createPath — a trip measured on the banks actually ridden"`

---

## Task 4: `scripts/lib/crossings.mjs` — derivation

**Files:**
- Create: `scripts/lib/crossings.mjs`
- Test: `scripts/lib/crossings.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lib/crossings.test.mjs
import { describe, it, expect } from 'vitest';
import { slugifyCrossingId, deriveCrossings, dedupeCrossings } from './crossings.mjs';

// Two parallel lines 200 m apart along lat, 10 km long along lng at lat 53.
const N = 41;
const line = (lat) => Array.from({ length: N }, (_, i) => [i * (10 / 111.32 / Math.cos((53 * Math.PI) / 180)) / (N - 1) * (N - 1) / (N - 1), lat]);
// simpler, evenly spaced in degrees — geometry only needs "near":
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
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run scripts/lib/crossings.test.mjs` → FAIL.
- [ ] **Step 3: Implement**

```js
// scripts/lib/crossings.mjs — derive bank crossings from OSM candidates.
// Pure: takes prepared ways (with inline geometry from `out geom`), two coord
// arrays, options. No fetching, no file I/O, no console.
import * as turf from '@turf/turf';

const UMLAUT = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' };

export function slugifyCrossingId(name, kmCanonical) {
  const flat = name
    .replace(/[äöüßÄÖÜ]/g, (ch) => UMLAUT[ch])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${flat}-${Math.round(kmCanonical)}`;
}

function snap(lineFeature, lngLat) {
  const s = turf.nearestPointOnLine(lineFeature, turf.point(lngLat), { units: 'kilometers' });
  return { km: s.properties.location, distM: s.properties.dist * 1000, coord: s.geometry.coordinates };
}

/**
 * @param {Array} ways - OSM elements with `.tags` and `.geometry` ([{lon,lat},…])
 * @param {Array<[number,number]>} canonicalCoords
 * @param {Array<[number,number]>} altCoords
 * @param {{maxSnapM?: number, maxLengthKm?: number, towns?: Array}} opts
 */
export function deriveCrossings(ways, canonicalCoords, altCoords, { maxSnapM = 250, maxLengthKm = 3, towns = [] } = {}) {
  const canonical = turf.lineString(canonicalCoords);
  const alt = turf.lineString(altCoords);
  const out = [];
  for (const way of ways) {
    if (!Array.isArray(way.geometry) || way.geometry.length < 2) continue;
    const ends = [way.geometry[0], way.geometry[way.geometry.length - 1]].map((p) => [p.lon, p.lat]);
    // Each line must be close to ONE of the two ends (either orientation).
    const snaps = ends.map((e) => ({ canonical: snap(canonical, e), alt: snap(alt, e) }));
    const pairings = [
      { c: snaps[0].canonical, a: snaps[1].alt },
      { c: snaps[1].canonical, a: snaps[0].alt },
    ];
    const best = pairings
      .filter((p) => p.c.distM <= maxSnapM && p.a.distM <= maxSnapM)
      .sort((p, q) => p.c.distM + p.a.distM - (q.c.distM + q.a.distM))[0];
    if (!best) continue;
    const lengthKm = turf.length(turf.lineString(way.geometry.map((p) => [p.lon, p.lat])), { units: 'kilometers' });
    if (lengthKm > maxLengthKm) continue;
    const kind = way.tags?.route === 'ferry' || way.tags?.ferry ? 'ferry' : 'bridge';
    const name = way.tags?.name ?? nearestTownName(towns, best.c.km, kind);
    const kmCanonical = Math.round(best.c.km * 100) / 100;
    out.push({
      id: slugifyCrossingId(name, kmCanonical),
      name,
      kind,
      kmCanonical,
      kmAlt: Math.round(best.a.km * 100) / 100,
      lengthKm: Math.round(lengthKm * 1000) / 1000,
      coord: [Math.round(best.c.coord[0] * 1e6) / 1e6, Math.round(best.c.coord[1] * 1e6) / 1e6],
    });
  }
  return out.sort((a, b) => a.kmCanonical - b.kmCanonical);
}

function nearestTownName(towns, km, kind) {
  let bestTown = null;
  let bestD = Infinity;
  for (const t of towns) {
    const d = Math.abs(t.routeDistanceKm - km);
    if (d < bestD) { bestD = d; bestTown = t; }
  }
  return bestTown ? `${bestTown.name} ${kind}` : `${kind} at km ${Math.round(km)}`;
}

/** merge candidates within 150 m on BOTH axes; the named/shorter one survives. */
export function dedupeCrossings(crossings, { withinKm = 0.15 } = {}) {
  const out = [];
  for (const c of crossings) {
    const twin = out.find(
      (o) => Math.abs(o.kmCanonical - c.kmCanonical) <= withinKm && Math.abs(o.kmAlt - c.kmAlt) <= withinKm,
    );
    if (!twin) { out.push(c); continue; }
    if (c.lengthKm < twin.lengthKm) out[out.indexOf(twin)] = c;
  }
  return out;
}
```

- [ ] **Step 4: Run tests** — `npx vitest run scripts/lib/crossings.test.mjs` → PASS. (Delete the unused `line` helper from the test if the linter of the day objects — `lineA`/`lineB` are the real fixtures.)
- [ ] **Step 5: Commit** — `git commit -am "feat(build): crossing derivation — project OSM bridges/ferries onto both banks"`

---

## Task 5: `build-data.mjs` — fetch GPX, assemble the two banks

**Files:**
- Modify: `scripts/build-data.mjs`
- Modify: `.gitignore` (add `src/data/gpx.raw/`)

No unit tests — this is orchestration verified by the build's own validation report, like everything else in the script.

- [ ] **Step 1: Add the GPX source constants and fetcher** (near `SOURCES`, `scripts/build-data.mjs:66`)

```js
import { parseGpxTracks } from './lib/gpx.mjs';

const GPX_SECTIONS = 'ABCDEFGHIJKLMNO'.split('');
const GPX_RAW_DIR = join(DATA_DIR, 'gpx.raw'); // gitignored
const gpxUrl = (section, side) =>
  'https://www.elberadweg.de/gps/' +
  encodeURIComponent(`Elberadweg - Labská stezka [Abschnitt ${section} ${side}].gpx`);

async function fetchGpxCached(section, side) {
  mkdirSync(GPX_RAW_DIR, { recursive: true });
  const file = join(GPX_RAW_DIR, `${section}-${side}.gpx`);
  if (!REFRESH && existsSync(file)) return readFileSync(file, 'utf8');
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await fetch(gpxUrl(section, side), { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) {
      const text = await res.text();
      writeFileSync(file, text);
      return text;
    }
    if (attempt === MAX_RETRIES) throw new Error(`GPX ${section} ${side}: HTTP ${res.status}`);
    await sleep(backoffMs(attempt));
  }
}

/** stitch a bank from its 15 section files: segments joined end-to-end,
 *  each section auto-reversed when its far end is nearer the running line. */
async function stitchBank(side) {
  let line = [];
  const joins = [];
  for (const section of GPX_SECTIONS) {
    const segs = parseGpxTracks(await fetchGpxCached(section, side));
    let coords = segs.flat(); // sections are single logical tracks; segments are pauses
    if (line.length) {
      const gapFwd = haversineM(line[line.length - 1], coords[0]);
      const gapRev = haversineM(line[line.length - 1], coords[coords.length - 1]);
      if (gapRev < gapFwd) coords = coords.slice().reverse();
      joins.push({ section, gapM: Math.min(gapFwd, gapRev) });
    }
    line = line.concat(coords);
  }
  const bad = joins.filter((j) => j.gapM > GAP_SOFT);
  if (bad.length) {
    throw new Error(`bank ${side}: hard joins ${bad.map((j) => `${j.section}:${Math.round(j.gapM)}m`).join(', ')}`);
  }
  return { coords: line, joins };
}
```

Also extend the imports at the top: `mkdirSync` from `node:fs`, `haversineM` is already imported from `./lib/route-assembly.mjs`.

- [ ] **Step 2: Rebuild `main()` steps 1–4 around the two banks**

Replace the German OSM sources with GPX banks; CZ stays. The canonical composite = left bank to the Hamburg junction, right bank to the border junction, CZ to Prague — same `findJunction` + `joinSegments` machinery, now fed GPX-derived coord arrays:

```js
// inside main(), replacing steps 1–3 for the German sources
const leftBank = await stitchBank('links');    // Cuxhaven → border, left bank
const rightBank = await stitchBank('rechts');  // Hamburg area → border (starts where the official right bank starts)

// simplify + round each bank ONCE, before any junction is derived, so every km
// downstream (canonical, alt, crossings) is measured on the exact committed shape
const prep = (coords) => roundCoordArray(
  turf.simplify(turf.lineString(coords), { tolerance: SIMPLIFY_TOLERANCE, highQuality: true, mutate: true }).geometry.coordinates,
);
const left = prep(leftBank.coords);
const right = prep(rightBank.coords);
const cz = /* existing stitched+trimmed EV7 coords, unchanged flow */;

const j1 = findJunction(left, right);   // Hamburg ferry area
const j2 = findJunction(right, cz);     // border link
const segments = [
  { key: 'left',  coords: left.slice(0, j1.indexA + 1),        source: 'official-gpx-left',  from: 'Cuxhaven', to: 'Hamburg', bank: 'left' },
  { key: 'right', coords: right.slice(j1.indexB, j2.indexA + 1), source: 'official-gpx-right', from: 'Hamburg', to: 'Schmilka', bank: 'right' },
  { key: 'cz',    coords: cz.slice(j2.indexB),                 source: 'eurovelo-7-cz',      from: 'Hřensko', to: 'Prague', bank: null },
];
const joined = joinSegments(segments, { bridges: BRIDGES });
```

(Adapt to `findJunction`'s real return shape at `scripts/lib/route-assembly.mjs:63` — it returns the closest-approach pair with indexes on each line; use exactly what `trimSources` uses today at `:612`. Keep `orient()` calls if a bank arrives reversed — the left bank must start at Cuxhaven, checked against `ANCHORS.CUXHAVEN`.)

- [ ] **Step 3: Update identity + bounds constants**

```js
const ROUTE_ID = 'cuxhaven-prague-official-v2';
// Official banks measure longer than the OSM composite; re-base after the first run:
const LEN_HARD_MIN = 850, LEN_HARD_MAX = 1400;
const LEN_NOMINAL_MIN = 1000, LEN_NOMINAL_MAX = 1200;
```

- [ ] **Step 4: `.gitignore`** — add the line `src/data/gpx.raw/` under `src/data/route.raw.*.json`.

- [ ] **Step 5: Run the build** — `npm run build:data`
Expected: validation report prints both junction distances, total km in bounds, monotonicity PASS, doubling-back under 5%. Iterate on join gaps here — this step is the plan's known-unknown; the spike de-risked it but the guards decide.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(build): assemble both German banks from official GPX; canonical line rebuilt"`
(Raw GPX stays out via .gitignore; regenerated `route.json`/`route.meta.json` are in.)

---

## Task 6: `build-data.mjs` — alt line, crossings, meta

**Files:**
- Modify: `scripts/build-data.mjs`
- Create (generated): `src/data/route.alt.json`, `src/data/crossings.json`

- [ ] **Step 1: Fetch crossing candidates over the between-banks corridor**

After the canonical write, add step 6b:

```js
import { deriveCrossings, dedupeCrossings } from './lib/crossings.mjs';

// Candidates: bridge ways with bicycle access + ferries, chunked along the
// RIGHT bank (the corridor between banks is never wider than the town corridor).
const crossingQuery = (bbox) => `[out:json][timeout:180];
( way["bridge"]["highway"~"^(cycleway|path|footway|track|residential|unclassified|tertiary|secondary|primary)$"]["bicycle"!~"^no$"](${bbox});
  way["route"="ferry"](${bbox});
);out geom;`;
const crossingBoxes = chunkBboxes(right, { chunkKm: CHUNK_KM, padKm: 3 });
const crossingOsm = await fetchByChunks(crossingBoxes, crossingQuery, 'crossings', (i) => join(tmpdir(), `elbe-crossings-${i}.json`));
const rawCrossings = deriveCrossings(
  crossingOsm.elements.filter((e) => e.type === 'way'),
  canonicalCoords,       // joined.coords — the whole canonical line
  altCoords,             // the alt slice, defined in step 2 below
  { maxSnapM: 250, maxLengthKm: 3, towns },
);
const crossings = dedupeCrossings(rawCrossings);
```

Note `out geom;` (inline way geometry) — `deriveCrossings` expects `way.geometry`, not node refs.

- [ ] **Step 2: Slice the alt line between the outermost crossings and write both files**

The alt line is the LEFT bank from the first to the last crossing. Chicken-and-egg with step 1 (derivation needs the alt line) resolves by deriving against the *full* left bank first, then slicing and re-basing `kmAlt`:

```js
// derive against the full left bank (kmAlt measured from Cuxhaven), then:
const firstC = crossings[0];
const lastC = crossings[crossings.length - 1];
const altStart = firstC.kmAlt;
const altCoordsSliced = stretchOfCoords(left, firstC.kmAlt, lastC.kmAlt); // slice by cumulative km — reuse cumulativeAlongM
for (const c of crossings) c.kmAlt = Math.round((c.kmAlt - altStart) * 100) / 100;

writeFileSync(join(DATA_DIR, 'route.alt.json'), JSON.stringify(
  { type: 'Feature', properties: { bank: 'left' }, geometry: { type: 'LineString', coordinates: altCoordsSliced } },
));
writeFileSync(join(DATA_DIR, 'crossings.json'), JSON.stringify(crossings, null, 1));
```

(`stretchOfCoords` — a 15-line local helper walking `cumulativeAlongM(left)` and interpolating both ends, mirroring `src/route.js`'s `stretchCoords` but in metres; place it next to `roundCoordArray`.)

- [ ] **Step 3: Validation additions** (inside `validate()` or right after)

```js
console.log(`\nCrossings: ${crossings.length} (${crossings.filter((c) => c.kind === 'ferry').length} ferries)`);
if (crossings.length < 15 || crossings.length > 60) {
  throw new Error(`crossing count ${crossings.length} outside hard bounds 15–60`);
}
if (crossings.length < 25 || crossings.length > 45) {
  console.warn(`  ! crossing count outside nominal 25–45 — eyeball the table`);
}
const kmsA = crossings.map((c) => c.kmAlt);
if (!kmsA.every((v, i) => i === 0 || v > kmsA[i - 1])) {
  throw new Error('crossings are not strictly increasing on the alt axis — a projection landed wrong');
}
for (const c of crossings) if (!c.name) throw new Error(`crossing at km ${c.kmCanonical} has no name`);
```

- [ ] **Step 4: Extend the meta literal** (at the existing write, `scripts/build-data.mjs:1044`)

```js
  segments: joined.segments.map((seg) => ({ /* existing fields */, bank: seg.bank ?? null })),
  alt: {
    lengthKm: round(turf.length(turf.lineString(altCoordsSliced), { units: 'kilometers' }), 2),
    fromCrossing: crossings[0].id,
    toCrossing: crossings[crossings.length - 1].id,
  },
  crossingCount: crossings.length,
```

- [ ] **Step 5: Run** — `npm run build:data` → crossings table prints, bounds hold, `route.alt.json` + `crossings.json` exist. Then `npm run build:elevation` (regenerates `elevation.json` for the new line; its `routeId` comes from meta, which now says `cuxhaven-prague-official-v2` — verify by reading the first line of the output file).
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(build): derive crossings, write route.alt.json + crossings.json, meta v2"`

---

## Task 7: `build-data.mjs` — bank tags on towns and POIs

**Files:** Modify: `scripts/build-data.mjs`

- [ ] **Step 1: Tag each town/POI with its bank**

In `buildTowns` (`:800`) and `buildPois` (`:913`), after `offsetKm` is computed against the canonical line, compute the alt offset too and classify. The emit gains one field:

```js
import { canonicalKmFromAlt } from '../src/path.js';

// once, before the loops: an alt snap helper over the sliced alt line
const altFeature = turf.lineString(altCoordsSliced);
function altSnap(lngLat) {
  const s = turf.nearestPointOnLine(altFeature, turf.point(lngLat), { units: 'kilometers' });
  return { km: s.properties.location, offsetKm: s.properties.dist };
}
// per place, where offsetKm (canonical) is already known:
const a = altSnap([lng, lat]);
const nearCanonical = offsetKm <= MAX_OFFSET;          // the existing per-kind bound
const nearAlt = a.offsetKm <= MAX_OFFSET;
if (!nearCanonical && !nearAlt) continue;              // replaces the existing single-line filter
let bank;
if (nearCanonical && nearAlt) bank = 'both';
else if (nearAlt) bank = 'left';
else bank = bankOfCanonicalSegment(routeDistanceKm);   // 'left' | 'right' | null from the segments table
// an alt-only place keys its canonical km through the mapping:
const keyKm = nearCanonical ? routeDistanceKm : canonicalKmFromAlt(crossings, a.km);
if (keyKm === null) continue;                          // off the alt coverage: not on the road
```

`bankOfCanonicalSegment(km)` is a 6-line lookup over the `segments` array (same rule as `path.js`'s `canonicalBankAt`). Emit `bank` and use `round(keyKm, 1)` as `routeDistanceKm`. The array MUST be re-sorted by `routeDistanceKm` after the loop — alt-mapped kms interleave.

- [ ] **Step 2: Extend `validatePois`** to print per-bank counts:

```js
const perBank = pois.reduce((m, p) => ((m[p.bank] = (m[p.bank] ?? 0) + 1), m), {});
console.log('POIs per bank:', perBank);
```

- [ ] **Step 3: Run** — `npm run build:data` → towns/pois carry `bank`, still ascending by `routeDistanceKm` (spot-check `head src/data/towns.json`).
- [ ] **Step 4: Run app tests** — `npm test` → `towns.test.js`/`pois.test.js` still green (they don't know `bank`; extra fields are inert).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(build): towns and POIs carry their bank; alt-bank places keyed through the mapping"`

---

## Task 8: storage schema 5

**Files:**
- Modify: `src/storage.js`
- Test: `src/storage.test.js`

- [ ] **Step 1: Write the failing tests** (append to the existing suite, reusing its `memStorage()` helper and store fixtures)

```js
describe('crossings on the plan (schema 5)', () => {
  it('a fresh plan has an empty crossings list', () => {
    const store = createPlanStore({ storage: memStorage(), routeId: 'r1', totalKm: 1000 });
    store.load();
    expect(store.getActivePlan().crossings).toEqual([]);
  });

  it('saveActivePlan round-trips crossing ids', () => {
    const storage = memStorage();
    const store = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], crossings: ['magdeburg-sternbruecke-479'] });
    const again = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    again.load();
    expect(again.getActivePlan().crossings).toEqual(['magdeburg-sternbruecke-479']);
  });

  it('non-string entries are dropped on read, silently', () => {
    const storage = memStorage();
    const store = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], crossings: ['ok-1', 42, null, 'ok-2'] });
    const again = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    again.load();
    expect(again.getActivePlan().crossings).toEqual(['ok-1', 'ok-2']);
  });

  it('a v4 blob (no crossings field) reads as an empty list', () => {
    // craft a v4 blob through a store, then strip the field the way an old build left it
    const storage = memStorage();
    const store = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    store.load();
    const blob = JSON.parse(storage.getItem('elberadweg-plans'));
    blob.schemaVersion = 4;
    for (const p of blob.plans) delete p.crossings;
    storage.setItem('elberadweg-plans', JSON.stringify(blob));
    const again = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    again.load();
    expect(again.getActivePlan().crossings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/storage.test.js` → 4 FAIL.
- [ ] **Step 3: Implement** — four edits in `src/storage.js`:

```js
const SCHEMA_VERSION = 5;
const READABLE_SCHEMA_VERSIONS = new Set([SCHEMA_VERSION, 4, 3, 2]);
```

`normalizePlan` gains (before the closing brace of the returned object):

```js
    // Crossing ids the rider chose. Ids only — km and names live in
    // crossings.json, and an id the table no longer knows is main.js's problem
    // (dropped with a warning there), not a reason to reject the plan here.
    crossings: Array.isArray(plan.crossings) ? plan.crossings.filter((id) => typeof id === 'string') : [],
```

`emptyPlan` gains `crossings: [],` next to `breaks: []`. In `saveActivePlan`, where `days`/`breaks` are written, add:

```js
    if (Array.isArray(payload.crossings)) {
      plan.crossings = payload.crossings.filter((id) => typeof id === 'string');
    }
```

Update the header comment (`src/storage.js:6-11`) to describe v5, and the JSDoc `saveActivePlan` payload type to `{days, breaks, crossings?, startKm?, destinationKm?}`.

- [ ] **Step 4: Run** — `npx vitest run src/storage.test.js` → PASS, including all pre-existing cases.
- [ ] **Step 5: Commit** — `git commit -am "feat(storage): schema 5 — plans carry chosen crossing ids"`

---

## Task 9: loaders in `src/route.js`

**Files:**
- Modify: `src/route.js`
- Test: `src/route.test.js`

- [ ] **Step 1: Write the failing tests** (append)

```js
describe('alt data loaders', () => {
  it('loadAltRoute returns a LineString feature', async () => {
    const alt = await loadAltRoute();
    expect(alt.geometry.type).toBe('LineString');
    expect(alt.geometry.coordinates.length).toBeGreaterThan(100);
  });
  it('loadCrossings returns the sorted table', async () => {
    const crossings = await loadCrossings();
    expect(crossings.length).toBeGreaterThan(10);
    expect(crossings[0]).toMatchObject({ id: expect.any(String), kmCanonical: expect.any(Number), kmAlt: expect.any(Number) });
    const kms = crossings.map((c) => c.kmCanonical);
    expect([...kms].sort((a, b) => a - b)).toEqual(kms);
  });
});
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** (mirror `loadRoute`'s dynamic-import pattern at `src/route.js:159`):

```js
/** The left-bank line between the outermost crossings. */
export async function loadAltRoute() {
  const mod = await import('./data/route.alt.json');
  return mod.default;
}

/** The crossing table, sorted by kmCanonical. */
export async function loadCrossings() {
  const mod = await import('./data/crossings.json');
  return mod.default;
}
```

- [ ] **Step 4: Run** — `npx vitest run src/route.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(route): loaders for the alt line and the crossing table"`

---

## Task 10: day panel — crossing legs + "Crossings you pass today"

**Files:**
- Modify: `src/day-panel.js`
- Test: `src/day-panel.test.js`

State additions consumed by `render()`: `dayCrossings` — the annotated rows from `path.crossingsBetween(day.startKm, day.endKm)`. Chosen ones render as legs; unchosen ones render in the group with a Cross button. Two new callbacks: `onAddCrossing(id)`, `onRemoveCrossing(id)`.

- [ ] **Step 1: Write the failing tests** (append; extend the `mount()` callbacks with `onAddCrossing: vi.fn(), onRemoveCrossing: vi.fn()`)

```js
const CROSSINGS = [
  { id: 'rogaetz-ferry-192', name: 'Rogätz–Grieben ferry', kind: 'ferry', kmCanonical: 192.1, lengthKm: 0.4, chosen: false, canCross: true },
  { id: 'magdeburg-sternbruecke-209', name: 'Magdeburg, Sternbrücke', kind: 'bridge', kmCanonical: 208.9, lengthKm: 0.6, chosen: true, canCross: true },
  { id: 'schoenebeck-bruecke-223', name: 'Schönebeck bridge', kind: 'bridge', kmCanonical: 222.7, lengthKm: 0.5, chosen: false, canCross: false },
];

describe('crossings in the day panel', () => {
  it('renders a chosen crossing as a removable leg at its km', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'Tangermünde', dayCrossings: CROSSINGS });
    const leg = el.querySelector('.day-card__leg--crossing');
    expect(leg.textContent).toContain('Magdeburg, Sternbrücke');
    expect(leg.textContent).toContain('⇄');
    leg.querySelector('[data-action="remove-crossing"]').click();
    expect(callbacks.onRemoveCrossing).toHaveBeenCalledWith('magdeburg-sternbruecke-209');
  });

  it('offers unchosen crossings with a Cross button, ferries hinted', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'x', dayCrossings: CROSSINGS });
    const rows = [...el.querySelectorAll('.day-crossings__row')];
    expect(rows).toHaveLength(2); // the chosen one is a leg, not a row
    expect(rows[0].textContent).toContain('⛴');
    expect(rows[0].textContent).toContain('check operating times');
    rows[0].querySelector('[data-action="add-crossing"]').click();
    expect(callbacks.onAddCrossing).toHaveBeenCalledWith('rogaetz-ferry-192');
  });

  it('a canCross:false row renders disabled', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'x', dayCrossings: CROSSINGS });
    const btn = [...el.querySelectorAll('[data-action="add-crossing"]')].find((b) => b.dataset.crossingId === 'schoenebeck-bruecke-223');
    expect(btn.disabled).toBe(true);
  });

  it('renders no group at all when the day passes no crossings', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'x', dayCrossings: [] });
    expect(el.querySelector('.day-crossings')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/day-panel.test.js` → 4 FAIL.
- [ ] **Step 3: Implement** in `src/day-panel.js`:

(a) `render()` destructures `dayCrossings = []` alongside `breaks`.

(b) In `legs(day, breaks, trip)` — change signature to `legs(day, breaks, trip, dayCrossings)` and interleave chosen crossings as entries by km. Simplest faithful approach: before the loop, merge

```js
  const crossingLegs = dayCrossings
    .filter((c) => c.chosen)
    .map((c) => ({ __crossing: true, ...c, routeDistanceKm: c.kmCanonical }));
  const entries = [...breaks, ...crossingLegs].sort(
    (a, b) => (trip.tripKm(a.routeDistanceKm) - trip.tripKm(b.routeDistanceKm)),
  );
```

and inside the loop render a `__crossing` entry as:

```js
  `<li class="day-card__leg day-card__leg--crossing">
     <span class="day-card__leg-text">${dist} ⇄ <b>Cross to the other bank</b> · ${esc(c.name)}${c.kind === 'ferry' ? ' ⛴' : ''}</span>
     <span class="leg-actions">
       <button type="button" class="row-remove" data-action="remove-crossing"
               data-crossing-id="${esc(c.id)}" title="Remove crossing" aria-label="Remove crossing: ${esc(c.name)}">✕</button>
     </span>
   </li>`
```

(`dist` via the same `rideKm(trip, prevKm, c.routeDistanceKm)` the break rows use; the crossing participates in `prevKm` chaining so the next leg reads distance from the crossing.)

(c) New markup fn after `snapNote`:

```js
function crossingsGroup(dayCrossings) {
  const rows = dayCrossings.filter((c) => !c.chosen);
  if (!rows.length) return '';
  return `
    <div class="day-crossings">
      <div class="day-crossings__label">Crossings you pass today</div>
      ${rows
        .map(
          (c) => `
        <div class="day-crossings__row">
          <span>${c.kind === 'ferry' ? '⛴' : '🌉'} ${esc(c.name)}${
            c.kind === 'ferry' ? ' <span class="day-crossings__hint">check operating times</span>' : ''
          }</span>
          <button type="button" class="btn btn--sm" data-action="add-crossing"
                  data-crossing-id="${esc(c.id)}" ${c.canCross ? '' : 'disabled'}
                  title="${c.canCross ? 'Cross to the other bank here' : 'The other bank ends here — no onward riding'}">⇄ Cross</button>
        </div>`,
        )
        .join('')}
    </div>`;
}
```

Insert `${crossingsGroup(dayCrossings)}` into the day-card template after the legs `<ol>` and before the day actions.

(d) Dispatch — two new branches in the delegated click handler, placed with the break branches (BEFORE the `!current.day` guard is fine; ids are self-contained):

```js
  const addC = e.target.closest('[data-action="add-crossing"]');
  if (addC) return callbacks.onAddCrossing?.(addC.dataset.crossingId);
  const removeC = e.target.closest('[data-action="remove-crossing"]');
  if (removeC) return callbacks.onRemoveCrossing?.(removeC.dataset.crossingId);
```

(e) `src/style.css` — append:

```css
.day-crossings { margin-top: 10px; padding: 8px 10px; background: #f2f6f3; border-radius: 8px; }
.day-crossings__label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7570; margin-bottom: 6px; }
.day-crossings__row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 3px 0; font-size: 13px; }
.day-crossings__hint { font-size: 11px; color: #a15d1a; }
.day-card__leg--crossing { background: #fff8f0; border-radius: 6px; }
```

- [ ] **Step 4: Run** — `npx vitest run src/day-panel.test.js` → all PASS (old and new).
- [ ] **Step 5: Commit** — `git commit -am "feat(day-panel): cross to the other bank as a day-planning action"`

---

## Task 11: map — alt line, crossing markers

**Files:**
- Modify: `src/map.js`
- Test: `src/map.test.js`

- [ ] **Step 1: Write the failing tests** (append, reusing the suite's Leaflet-in-jsdom mount)

```js
describe('two banks on the map', () => {
  it('draws the alt line faint when given one', () => {
    const map = createMap({ routeFeature: ROUTE, altRouteFeature: ROUTE });
    expect(document.querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
  });

  it('setCrossingMarkers renders ⇄ markers and clicks report the id', () => {
    const onCrossingClick = vi.fn();
    const map = createMap({ routeFeature: ROUTE, onCrossingClick });
    map.setCrossingMarkers([
      { id: 'x-1', name: 'X bridge', kind: 'bridge', coord: [9.9, 53.5], chosen: false, canCross: true },
    ]);
    const el = document.querySelector('.crossing-marker');
    expect(el).not.toBeNull();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCrossingClick).toHaveBeenCalledWith('x-1');
  });

  it('a chosen crossing gets the chosen modifier class', () => {
    const map = createMap({ routeFeature: ROUTE });
    map.setCrossingMarkers([{ id: 'x', name: 'X', kind: 'ferry', coord: [9.9, 53.5], chosen: true, canCross: true }]);
    expect(document.querySelector('.crossing-marker--chosen')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement** in `src/map.js`:

(a) Options: `createMap({ routeFeature, altRouteFeature, onRouteClick, onPickPoint, onPoiClick, onPoiHover, onUserMove, onCrossingClick })`. After the `routeLayer` block (`:259`):

```js
  const ALT_ROUTE_STYLE = { color: '#9fb6a8', weight: 2, opacity: 0.6, dashArray: '4 7' };
  if (altRouteFeature) {
    L.geoJSON(altRouteFeature, { renderer, smoothFactor: 1.5, style: () => ALT_ROUTE_STYLE }).addTo(map);
  }
```

(b) A `crossingLayer = L.layerGroup().addTo(map)` next to the other groups (`:434`), plus:

```js
  const crossingIcon = (chosen) =>
    L.divIcon({
      className: `crossing-marker${chosen ? ' crossing-marker--chosen' : ''}`,
      html: '⇄',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });

  function setCrossingMarkers(crossings) {
    crossingLayer.clearLayers();
    for (const c of crossings) {
      const marker = L.marker([c.coord[1], c.coord[0]], {
        icon: crossingIcon(c.chosen),
        zIndexOffset: 420,
        opacity: c.canCross || c.chosen ? 1 : 0.45,
      });
      marker.bindTooltip(escapeHtml(`${c.name}${c.kind === 'ferry' ? ' (ferry)' : ''}`));
      marker.on('click', () => { if (typeof onCrossingClick === 'function') onCrossingClick(c.id); });
      marker.addTo(crossingLayer);
    }
  }
```

Export `setCrossingMarkers` in the returned object (`:711`). CSS append:

```css
.crossing-marker { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #d9822b; color: #fff; font-size: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.35); cursor: pointer; }
.crossing-marker--chosen { background: #2e7d4f; }
```

- [ ] **Step 4: Run** — `npx vitest run src/map.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(map): faint alt bank + clickable crossing markers"`

---

## Task 12: strip — the bank ribbon

**Files:**
- Modify: `src/strip.js`, `src/strip-markup.js`
- Test: `src/strip.test.js`

- [ ] **Step 1: Write the failing tests** (append, using the suite's `mount(width)` helper)

```js
describe('bank ribbon', () => {
  const LEGS = [
    { bank: 'right', onAlt: false, fromKm: 0, toKm: 300, riddenLengthKm: 300, crossingIn: null },
    { bank: 'left', onAlt: true, fromKm: 300, toKm: 650, riddenLengthKm: 342, crossingIn: { id: 'm-479', name: 'Magdeburg', kmCanonical: 300 } },
  ];

  it('renders one span per leg, positioned by km', () => {
    const { strip, el } = mount(600);
    strip.render({ days: [], breaks: [], bankLegs: LEGS });
    const spans = [...el.querySelectorAll('.strip__bank')];
    expect(spans).toHaveLength(2);
    expect(spans[0].className).toContain('strip__bank--right');
    expect(spans[1].className).toContain('strip__bank--left');
    // 300 of 650 km ≈ 46% of the width
    expect(parseFloat(spans[1].style.left)).toBeGreaterThan(250);
  });

  it('marks each crossing with a tick at its km', () => {
    const { strip, el } = mount(600);
    strip.render({ days: [], breaks: [], bankLegs: LEGS });
    const tick = el.querySelector('.strip__bank-tick');
    expect(tick).not.toBeNull();
    expect(tick.title).toContain('Magdeburg');
  });

  it('renders nothing without bankLegs (single-bank compatibility)', () => {
    const { strip, el } = mount(600);
    strip.render({ days: [], breaks: [] });
    expect(el.querySelector('.strip__banks').innerHTML).toBe('');
  });
});
```

(Adapt the mount destructure to the suite's actual helper shape — it returns the strip and keeps `el` in scope; follow the file's existing describes.)

- [ ] **Step 2: Run to verify failure**, **Step 3: Implement**:

(a) `src/strip.js` template (`:69`) gains `<div class="strip__banks"></div>` between the axis and scale divs, plus `const banksEl = el.querySelector('.strip__banks');`. State copy (`:185`) gains `bankLegs: next.bankLegs`. Render body (`:208`) gains, after `axisEl.innerHTML = ...`:

```js
  banksEl.innerHTML = banksMarkup(state, axis);
```

(b) `src/strip-markup.js` — new export (uses the existing `kmToX` from `strip-geometry.js`, already imported there):

```js
/**
 * The bank ribbon: one span per composed-path leg, a ⇄ tick at each chosen
 * crossing. Read-only — acting on crossings is the day panel's job.
 */
export function banksMarkup(state, axis) {
  const legs = state.bankLegs;
  if (!Array.isArray(legs) || !legs.length) return '';
  const x = (km) => kmToX(km, axis);
  const spans = legs
    .map((leg) => {
      const a = x(leg.fromKm);
      const b = x(leg.toKm);
      const left = Math.min(a, b);
      const width = Math.abs(b - a);
      const cls = leg.bank ? `strip__bank--${leg.bank}` : 'strip__bank--single';
      return `<span class="strip__bank ${cls}" style="left:${Math.round(left)}px;width:${Math.round(width)}px" title="${leg.bank ?? 'single'} bank · ${Math.round(leg.riddenLengthKm)} km"></span>`;
    })
    .join('');
  const ticks = legs
    .filter((leg) => leg.crossingIn)
    .map((leg) => `<span class="strip__bank-tick" style="left:${Math.round(x(leg.fromKm))}px" title="⇄ ${esc(leg.crossingIn.name)}">⇄</span>`)
    .join('');
  return spans + ticks;
}
```

(c) CSS append:

```css
.strip__banks { position: relative; height: 8px; margin: 2px 0 1px; }
.strip__bank { position: absolute; top: 1px; height: 6px; border-radius: 3px; }
.strip__bank--right { background: #2e7d4f; }
.strip__bank--left { background: #7fb069; }
.strip__bank--single { background: #b9c4bd; }
.strip__bank-tick { position: absolute; top: -5px; transform: translateX(-50%); font-size: 10px; color: #d9822b; }
```

- [ ] **Step 4: Run** — `npx vitest run src/strip.test.js` → PASS (the new describes and all pre-existing ones — the empty-ribbon case covers every old test that passes no `bankLegs`).
- [ ] **Step 5: Commit** — `git commit -am "feat(strip): read-only bank ribbon with crossing ticks"`

---

## Task 13: `main.js` — wire the path through everything

**Files:** Modify: `src/main.js`

No new unit tests — main.js is the untested orchestrator by the codebase's own convention; behavior is pinned by the module tests above and verified by hand in Task 14.

- [ ] **Step 1: Load the new data + build indexes** (with the existing `Promise.all`, `:33-43`)

```js
import { loadAltRoute, loadCrossings } from './route.js';
import { createPath, canonicalKmFromAlt } from './path.js';

// in the Promise.all: loadAltRoute().catch(() => null), loadCrossings().catch(() => [])
const altIndex = altRoute ? createRouteIndex(altRoute) : null;
```

- [ ] **Step 2: Path lifecycle** — `let path;` beside `trip`/`itinerary` (`:85`), and `loadPlanIntoModel` (`:356`) becomes:

```js
function loadPlanIntoModel(plan) {
  trip = createTrip({ startKm: plan?.startKm, destinationKm: plan?.destinationKm, totalKm });
  const known = new Set(crossings.map((c) => c.id));
  const chosen = (plan?.crossings ?? []).filter((id) => {
    if (known.has(id)) return true;
    console.warn(`plan crossing "${id}" is not in crossings.json — dropped`);
    return false;
  });
  path = createPath({ trip, chosenCrossingIds: chosen, crossings, canonicalIndex: routeIndex, altIndex, segments: meta.segments });
  itinerary = createItinerary({ trip: path });
  itinerary.hydrate({ days: plan?.days ?? [], breaks: plan?.breaks ?? [] });
}
```

Same replacement inside `setTripWindow` (`:1111-1126`) — it rebuilds the pair; it now rebuilds the trio, reusing the active plan's chosen ids.

- [ ] **Step 3: Every `trip` handed to a render becomes `path`.** Concretely: `renderDayPanel` (`:569`) passes `trip: path` and adds `dayCrossings: day ? path.crossingsBetween(day.startKm, day.endKm) : []`; `renderStrip` (`:548`) passes `trip: path` plus `bankLegs: path.legs()`; `proposeEnd`/`wouldReverse` call sites keep the raw `trip` (window geometry is canonical); `tripHeadline` gets `path` (ridden lengths are the honest headline).

- [ ] **Step 4: Persist crossings** — `persistPlan` (`:368`) payload gains:

```js
    crossings: path.activeCrossings().map((c) => c.id)
      .concat((store.getActivePlan()?.crossings ?? []).filter((id) => !path.activeCrossings().some((c) => c.id === id) && crossings.some((t) => t.id === id) && !trip.contains(crossings.find((t) => t.id === id).kmCanonical))),
```

Wait — that one-liner is exactly the kind of clever nobody can read. Write it as a helper directly above `persistPlan`:

```js
// Chosen ids to persist: the ones composing the path now, PLUS previously
// chosen ids whose crossing sits outside the current window — kept so that
// shrinking and re-growing the window does not forget choices (spec §4).
function crossingIdsToPersist() {
  const activeIds = new Set(path.activeCrossings().map((c) => c.id));
  const dormant = (store.getActivePlan()?.crossings ?? []).filter((id) => {
    const c = crossings.find((t) => t.id === id);
    return c && !activeIds.has(id) && !trip.contains(c.kmCanonical);
  });
  return [...activeIds, ...dormant];
}
```

and use `crossings: crossingIdsToPersist(),` in the payload.

- [ ] **Step 5: The two handlers** (next to `handleRemoveBreak`, `:805`)

```js
function handleAddCrossing(id) {
  const current = store.getActivePlan();
  const ids = new Set(current?.crossings ?? []);
  ids.add(id);
  rebuildWithCrossings([...ids]);
}

function handleRemoveCrossing(id) {
  const current = store.getActivePlan();
  rebuildWithCrossings((current?.crossings ?? []).filter((x) => x !== id));
}

// The path changes shape, so days must re-derive: capture stored day shape,
// rebuild the trio, re-hydrate — the same dance setTripWindow already does.
function rebuildWithCrossings(ids) {
  const days = itinerary.getDays().map((d) => ({ targetKm: d.targetKm, townChoice: d.townChoice }));
  const breaks = itinerary.getBreaks();
  loadPlanIntoModel({ ...store.getActivePlan(), days, breaks, crossings: ids });
  persistPlan();
  renderAll();
}
```

Hand both to `createDayPanel` (`:260`): `onAddCrossing: handleAddCrossing, onRemoveCrossing: handleRemoveCrossing`.

- [ ] **Step 6: Map wiring**
- `createMap` options (`:154`): add `altRouteFeature: altRoute, onCrossingClick: handleAddCrossingOrRemove` where:

```js
function handleAddCrossingOrRemove(id) {
  const current = store.getActivePlan();
  if ((current?.crossings ?? []).includes(id)) handleRemoveCrossing(id);
  else handleAddCrossing(id);
}
```

- In `renderAll` (`:754`), inside the `!dragging` branch:

```js
    map.setCrossingMarkers(path.crossingsBetween(trip.startKm, trip.destinationKm));
```

- Focused-day highlight (`:701-708`): replace `stretchCoords(routeIndex, lo, hi)` with `path.coords(day.startKm, day.endKm)`.
- Day pins (`:682`) and start pin (`:674`): replace `pointAtKm(routeIndex, km)` with `path.pointAt(km)`.
- Custom-stop draft dot (`:1009`): `path.pointAt(km)`.

- [ ] **Step 7: Dual-line click snapping** — in `handleRouteClick` (`:1001`) and `handlePickPoint` (`:1061`), replace the single `snap(route, lngLat)` with:

```js
function snapToEitherLine(lngLat) {
  const c = snap(route, lngLat);
  if (!altRoute) return c;
  const a = snap(altRoute, lngLat);
  const aCanonical = canonicalKmFromAlt(crossings, a.distanceKm);
  const aOffM = distanceToM(a.coord, lngLat);
  const cOffM = distanceToM(c.coord, lngLat);
  if (aCanonical !== null && aOffM < cOffM) return { distanceKm: aCanonical, coord: a.coord };
  return c;
}
```

with `distanceToM` a tiny local haversine (copy the 8-line helper from `scripts/lib/route-assembly.mjs:17`, or simpler: `turf.distance` — main.js already transitively depends on turf via route.js; import `distance` where `snap` is imported).

- [ ] **Step 8: Full suite + build** — `npm test` → all green. `npm run build` → vite build succeeds (the two new JSON files bundle).
- [ ] **Step 9: Commit** — `git commit -am "feat(main): the plan rides a composed path — crossings wired end to end"`

---

## Task 14: docs, verification, finish

**Files:** Modify: `README.md`

- [ ] **Step 1: README** — update the route description (both banks, official GPX source, crossing count from the meta), the data-files table (`route.alt.json`, `crossings.json`), and the build instructions (`npm run build:data` now also fetches GPX; `--refresh` covers it).

- [ ] **Step 2: Full verification**

```
npm test                 → every suite green
npm run build:data       → validation report: lengths, crossings 15–60, monotonicity PASS
npm run build            → bundles
npm run dev              → manual: the Magdeburg scenario
```

Manual script (the spec's defining scenario): new plan, start Hamburg, destination Dresden; add days to reach Magdeburg's day; in that day's panel press ⇄ Cross at a Magdeburg bridge → the crossing appears as a leg, later legs show the other bank, the map line hops the river, the strip ribbon splits, later days shift; press ✕ → everything returns. Reload the page → the crossing survived storage.

- [ ] **Step 3: Commit + finish** — `git commit -am "docs: two banks in the README"`, then use superpowers:finishing-a-development-branch (options: merge to master / PR / keep).

---

## Self-Review (performed while writing)

- **Spec coverage:** §1 sources/assembly → Tasks 1, 5; §2 derivation+validation → Tasks 4, 6; §3 files/meta → Tasks 6, 7, 9; §4 path model → Tasks 2, 3 (with deviations 2, 4, 5 recorded); §5 day panel → Task 10; §6 map/strip → Tasks 11, 12, 13; §7 towns/POIs → Task 7 (bank badges in the places list are display-only and land with Task 13's state plumbing — the `bank` field flows through untouched rows); §8 storage → Task 8 + main.js drop-with-warning in Task 13; §9 testing table → mirrored per task. Elevation §6: deviation 3.
- **Placeholder scan:** none left; the two deliberately-marked sketch lines in Task 3's `crossingsBetween` are called out with replacement code.
- **Type consistency:** `createPath` opts `{trip, chosenCrossingIds, crossings, canonicalIndex, altIndex, segments}` used identically in Tasks 3 and 13; crossing record `{id, name, kind, kmCanonical, kmAlt, lengthKm, coord}` identical in Tasks 4, 6, and the fixtures of 3, 10, 11; day-panel state key `dayCrossings` and callbacks `onAddCrossing`/`onRemoveCrossing` identical in Tasks 10 and 13; strip state key `bankLegs` identical in Tasks 12 and 13; storage payload key `crossings` identical in Tasks 8 and 13.

**One known judgement call for the executor:** the §7 places-list badge ("other side") is intentionally thin — towns/POIs carry `bank`, and `places.js` rows may append a small `· other side` span when `poi.bank` is neither `'both'` nor `path.bankAt(poi.routeDistanceKm)`. If that one-line render addition grows beyond ~20 lines, stop and split it into its own task with a test.
