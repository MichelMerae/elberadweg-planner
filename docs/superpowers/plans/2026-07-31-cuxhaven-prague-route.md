# Cuxhaven → Prague Route Dataset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Hamburg → Dresden route dataset with a ~1050–1100 km Cuxhaven → Prague corridor assembled from three OSM sources, and move both endpoint names out of hardcoded strings into `route.meta.json`.

**Architecture:** Three sources are stitched, trimmed, simplified and rounded *independently*, then concatenated by `joinSegments()` with two declared ferry bridges whose measured length is bounded. Towns and POIs move from one continent-sized bbox to an `around:` corridor query on a subsampled route. New pure helpers live in `scripts/lib/route-assembly.mjs` and are unit-tested; `scripts/build-data.mjs` becomes the orchestrator. On the app side, endpoint names come from meta, and a plan built against a *different corridor* is archived rather than read.

**Tech Stack:** Node 18+ ESM, `@turf/turf` 7, Overpass QL, vitest 4 (environment `node`; `scripts/**/*.test.mjs` is already inside vitest's default include), Vite 8, vanilla JS + Leaflet 1.9.

**Spec:** `docs/superpowers/specs/2026-07-31-cuxhaven-prague-route-design.md`

---

## Deviations from the spec, decided while planning

Recorded here rather than silently applied.

1. **The reset is keyed on `routeId`; the existing banner keeps its job.** `main.js:19-20` and `:270` already show *"The route data changed since you last planned this trip — day distances may have shifted"* when a plan's `routeVersion` differs from `meta.builtAt`. That is the right response to rebuilding the *same* corridor. The archive-and-reset is a different event — a corridor whose km are re-based — so it branches on the new stable `routeId`, and the banner is left alone. The spec said "no notice UI"; the truth is the notice already exists and is correct for the case it covers.
2. **Raw OSM is cached per segment** (`route.raw.left.json`, `route.raw.right.json`, `route.raw.cz.json`) rather than in one file. Sixteen relations including EV7's 1537 ways in a single Overpass call risks the 300 s timeout, and per-segment caches let one source be refreshed alone. `.gitignore` widens to `src/data/route.raw.*.json`.
3. **Segments are simplified and rounded *before* joining**, not after. Then `joinSegments()`'s km are exactly the km of the file that gets written — no drift between `meta.segments[].endKm` and what the app measures. A consistency assertion checks `joinSegments` total against `turf.length` within 0.05 km.
4. **`haversineM` uses R = 6371008.8 m**, matching turf's earth radius, so the two length measurements agree to millimetres instead of drifting ~1.5 m per 1000 km.
5. **Corridor radii are derived, not guessed.** Circles of radius *r* centred every *s* km along a line cover a band of half-width `sqrt(r² - (s/2)²)`. At s = 2 km: towns need ≥5 km, so r = 5.5 km gives `sqrt(30.25 - 1) = 5.4 km` ✓; POIs need ≥3 km, so r = 3.5 km gives `sqrt(12.25 - 1) = 3.35 km` ✓. Using r = 3 km for POIs would have left 2.83 km — a silent shortfall against the 3 km sight corridor.
6. **The banded-bbox fallback is not built up front.** Corridor queries are implemented; if Overpass rejects or crawls on a 534-point list, the fallback gets written then. Building both without knowing which is needed is speculative.
7. **A feature branch, not a worktree.** Nothing else is running against this checkout, and a worktree would need its own `npm install` before the data build could run. Branch: `route-cuxhaven-prague`.
8. **Task 0 is a throwaway spike.** The single largest unknown is whether EV7 stitches cleanly through Prague. Discovering that after writing four tested helpers wastes the effort; the spike answers it in one script that is never committed.

---

## File Structure

**Create:**
- `scripts/lib/route-assembly.mjs` — pure geometry and assembly helpers: `haversineM`, `cumulativeAlongM`, `anchorSnap`, `joinSegments`, `doublingBackReport`, `corridorPoints`. No fetching, no file I/O, no `console`.
- `scripts/lib/route-assembly.test.mjs` — unit tests for all of the above.

**Modify:**
- `scripts/build-data.mjs` — three-source orchestration, corridor queries, new validation report, new meta writer.
- `src/storage.js` — `routeId` plumbing, schema v3, archive-and-reset.
- `src/storage.test.js` — cases for matching / mismatched / absent `routeId`, and backup-key collision.
- `src/strip-markup.js` — `summaryMarkup` / `scaleMarkup` take endpoint names.
- `src/strip.js` — state carries `originName` / `destinationName`.
- `src/strip.test.js` — updated assertions, plus a test that names come from state.
- `src/map.js` — start-pin title takes the origin name.
- `src/map.test.js` — start-pin title assertion.
- `src/main.js` — wires names and `routeId` from meta; `hasReachedDresden` → `hasReachedDestination`.
- `src/itinerary.js` — contract comment stops naming Hamburg/Dresden.
- `index.html` — header span becomes a placeholder filled at runtime.
- `.gitignore` — `src/data/route.raw.*.json`.
- `README.md` — lines 4, 90, 105–106.
- `src/data/route.json`, `route.meta.json`, `towns.json`, `pois.json` — regenerated.

**Why this split:** `build-data.mjs` is already 727 lines and is the one file in the repo with no tests, because everything in it is entangled with fetching and logging. The four genuinely tricky new algorithms go behind a pure interface so they can be tested at all; the script keeps orchestration, I/O and the validation report, which are verified by running it.

---

## Task 0: Spike — do the three sources actually stitch?

**Throwaway. Nothing here gets committed.** Purpose: answer the one question that could invalidate the whole plan before any real code is written.

**Files:**
- Create (scratchpad only): `<scratchpad>/spike-assemble.mjs`

- [ ] **Step 1: Write the spike**

Fetch all three sources, stitch each with a copy of the existing algorithm, trim to the anchors, and print lengths, gap counts, the two bridge distances, and a doubling-back figure per segment.

```js
// <scratchpad>/spike-assemble.mjs
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as turf from '@turf/turf';

const CACHE = (name) => `${process.env.SPIKE_DIR}/raw-${name}.json`;
const SOURCES = {
  left:  [2599008, 2599035],
  right: [2599011, 2599013, 2599015, 2599016, 2599018, 2599020, 2599024,
          2599025, 2599026, 7758087, 2599030, 2599032, 2599033],
  cz:    [2775754],
};
const ANCHORS = {
  CUXHAVEN:     [8.7166, 53.8917],
  FINKENWERDER: [9.8760, 53.5372],
  HAMBURG:      [9.9686, 53.5457],
  SCHOENA:      [14.2372, 50.8703],
  PRAGUE:       [14.4114, 50.0865],
};

const R = 6371008.8;
function havM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function fetchRels(name, ids) {
  if (existsSync(CACHE(name))) return JSON.parse(readFileSync(CACHE(name), 'utf8'));
  const query = `[out:json][timeout:300]; rel(id:${ids.join(',')}); out body; >; out skel qt;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded',
               'User-Agent': 'elberadweg-planner/spike (michel.merae@jobleads.com)' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const json = await res.json();
  writeFileSync(CACHE(name), JSON.stringify(json));
  return json;
}

function stitch(osm, ids) {
  const nodes = new Map(), ways = new Map(), rels = new Map();
  for (const el of osm.elements) {
    if (el.type === 'node') nodes.set(el.id, [el.lon, el.lat]);
    else if (el.type === 'way') ways.set(el.id, el.nodes || []);
    else if (el.type === 'relation') rels.set(el.id, el);
  }
  const ordered = [];
  for (const id of ids) {
    for (const m of rels.get(id)?.members || []) {
      if (m.type !== 'way' || m.role === 'backward' || m.role === 'alternative') continue;
      ordered.push(m.ref);
    }
  }
  const resolved = ordered
    .map((w) => (ways.get(w) || []).map((n) => nodes.get(n)).filter(Boolean))
    .filter((c) => c.length >= 2);
  const route = [];
  let soft = 0, hard = 0;
  resolved.forEach((coords, i) => {
    let c = coords;
    if (route.length === 0) {
      const next = resolved[i + 1];
      if (next) {
        const dEnd = Math.min(havM(c.at(-1), next[0]), havM(c.at(-1), next.at(-1)));
        const dStart = Math.min(havM(c[0], next[0]), havM(c[0], next.at(-1)));
        if (dStart < dEnd) c = c.slice().reverse();
      }
      route.push(...c);
      return;
    }
    const tail = route.at(-1);
    if (havM(tail, c.at(-1)) < havM(tail, c[0])) c = c.slice().reverse();
    const gap = havM(tail, c[0]);
    if (gap > 800) hard++;
    else if (gap > 60) soft++;
    route.push(...(gap < 1 ? c.slice(1) : c));
  });
  return { coords: route, soft, hard };
}

function trim(line, a, b) {
  const s = turf.nearestPointOnLine(line, turf.point(a), { units: 'kilometers' });
  const e = turf.nearestPointOnLine(line, turf.point(b), { units: 'kilometers' });
  console.log(`      anchor offsets: ${s.properties.dist.toFixed(2)} km / ${e.properties.dist.toFixed(2)} km`);
  let sliced = turf.lineSlice(s, e, line);
  const c = sliced.geometry.coordinates;
  if (havM(c.at(-1), a) < havM(c[0], a)) sliced.geometry.coordinates = c.slice().reverse();
  return sliced;
}

const built = {};
for (const [name, ids] of Object.entries(SOURCES)) {
  const osm = await fetchRels(name, ids);
  const { coords, soft, hard } = stitch(osm, ids);
  const raw = turf.lineString(coords);
  console.log(`\n${name}: ${coords.length} pts, raw ${turf.length(raw, { units: 'kilometers' }).toFixed(1)} km, gaps ${soft} soft / ${hard} hard`);
  built[name] = raw;
}

const left  = trim(built.left,  ANCHORS.CUXHAVEN, ANCHORS.FINKENWERDER);
const right = trim(built.right, ANCHORS.HAMBURG,  ANCHORS.SCHOENA);
const cz    = trim(built.cz,    ANCHORS.SCHOENA,  ANCHORS.PRAGUE);

for (const [name, seg] of Object.entries({ left, right, cz })) {
  console.log(`${name} trimmed: ${turf.length(seg, { units: 'kilometers' }).toFixed(1)} km, ${seg.geometry.coordinates.length} pts`);
}
const b1 = havM(left.geometry.coordinates.at(-1), right.geometry.coordinates[0]) / 1000;
const b2 = havM(right.geometry.coordinates.at(-1), cz.geometry.coordinates[0]) / 1000;
console.log(`\nbridge Hamburg: ${b1.toFixed(2)} km   (ceiling 3)`);
console.log(`bridge border:  ${b2.toFixed(2)} km   (ceiling 1)`);
const total = [left, right, cz].reduce((s, l) => s + turf.length(l, { units: 'kilometers' }), 0) + b1 + b2;
console.log(`TOTAL: ${total.toFixed(1)} km`);
```

- [ ] **Step 2: Run it**

Run: `SPIKE_DIR=<scratchpad> node <scratchpad>/spike-assemble.mjs`
Expected: three segment lengths, two bridge measurements, a total in the 1000–1150 km band, and hard-gap counts of 0.

- [ ] **Step 3: Decide before proceeding**

- Total outside 950–1200 km, or any hard gap in a segment → **stop and diagnose**; do not continue to Task 1. Likely causes: an anchor snapping to the wrong bank, or a relation with `alternative` members that need excluding.
- Hamburg bridge > 3 km → the `FINKENWERDER` or `HAMBURG` anchor is wrong; correct the coordinate and re-run.
- Border bridge > 1 km → EV7 crosses somewhere other than Schöna; re-anchor to the actual crossing and record it.
- All within bounds → record the measured numbers in the plan's ledger and proceed. **Do not commit the spike.**

---

## Task 1: `anchorSnap` — snap an anchor, fail loudly when it misses

**Files:**
- Create: `scripts/lib/route-assembly.mjs`
- Test: `scripts/lib/route-assembly.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
// scripts/lib/route-assembly.test.mjs
import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import { haversineM, anchorSnap } from './route-assembly.mjs';

// A ~111 km meridian segment: 1 degree of latitude at the equator.
const line = turf.lineString([[0, 0], [0, 0.5], [0, 1]]);

describe('haversineM', () => {
  it('measures a degree of latitude as ~111.19 km', () => {
    expect(haversineM([0, 0], [0, 1]) / 1000).toBeCloseTo(111.195, 2);
  });

  it('agrees with turf.length to within a metre over the same line', () => {
    const mine = haversineM([0, 0], [0, 0.5]) + haversineM([0, 0.5], [0, 1]);
    const turfs = turf.length(line, { units: 'kilometers' }) * 1000;
    expect(Math.abs(mine - turfs)).toBeLessThan(1);
  });
});

describe('anchorSnap', () => {
  it('returns the location along the line for a point on it', () => {
    const snap = anchorSnap(line, [0, 0.5], { name: 'mid' });
    expect(snap.locationKm).toBeCloseTo(55.6, 0);
    expect(snap.offsetKm).toBeCloseTo(0, 3);
  });

  it('accepts a point just off the line and reports the offset', () => {
    const snap = anchorSnap(line, [0.01, 0.5], { name: 'near', maxOffsetKm: 2 });
    expect(snap.offsetKm).toBeGreaterThan(0.5);
    expect(snap.offsetKm).toBeLessThan(1.5);
  });

  it('throws when the anchor is further away than maxOffsetKm, naming it', () => {
    expect(() => anchorSnap(line, [1, 0.5], { name: 'FINKENWERDER', maxOffsetKm: 2 }))
      .toThrow(/FINKENWERDER/);
  });

  it('reports the measured distance in the error so a wrong coordinate is diagnosable', () => {
    expect(() => anchorSnap(line, [1, 0.5], { name: 'x', maxOffsetKm: 2 }))
      .toThrow(/11[0-9]\.[0-9]{2} km/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run scripts/lib/route-assembly.test.mjs`
Expected: FAIL — `Failed to resolve import "./route-assembly.mjs"`.

- [ ] **Step 3: Implement**

```js
// scripts/lib/route-assembly.mjs
// Pure geometry and assembly helpers for the data build. No fetching, no file
// I/O, no console — everything here is a function of its arguments, so the parts
// of the pipeline that can be wrong in subtle ways are the parts that are tested.
//
// Coordinates are [lng, lat] throughout, matching GeoJSON and the rest of the
// pipeline.

import * as turf from '@turf/turf';

// Turf's earth radius, so haversineM and turf.length agree. With 6371000 the two
// drift ~1.5 m per 1000 km, which is enough to make a "segments and total agree"
// assertion fail for no real reason.
const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance in metres between two [lng,lat] points. */
export function haversineM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Cumulative distance in metres from the first coordinate, one entry per coordinate. */
export function cumulativeAlongM(coords) {
  const along = [0];
  for (let i = 1; i < coords.length; i++) {
    along[i] = along[i - 1] + haversineM(coords[i - 1], coords[i]);
  }
  return along;
}

/**
 * Snap an anchor point onto a line.
 *
 * Throws when the anchor lands further than `maxOffsetKm` away. Without that
 * check a mistyped coordinate — or a relation set that does not contain the place
 * at all — silently trims the route somewhere else entirely, and the only
 * symptom is a length that looks plausible.
 *
 * @returns {{point: object, offsetKm: number, locationKm: number}}
 */
export function anchorSnap(line, anchor, { name = 'anchor', maxOffsetKm = 2 } = {}) {
  const snap = turf.nearestPointOnLine(line, turf.point(anchor), { units: 'kilometers' });
  const offsetKm = snap.properties.dist;
  if (offsetKm > maxOffsetKm) {
    throw new Error(
      `${name} anchor [${anchor.join(', ')}] lies ${offsetKm.toFixed(2)} km from the line ` +
        `(max ${maxOffsetKm} km) — wrong coordinate, or the relations do not cover it`,
    );
  }
  return { point: snap, offsetKm, locationKm: snap.properties.location };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run scripts/lib/route-assembly.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/route-assembly.mjs scripts/lib/route-assembly.test.mjs
git commit -m "feat(build): add anchorSnap with a maximum-offset guard"
```

---

## Task 2: `joinSegments` — concatenate with declared, bounded bridges

**Files:**
- Modify: `scripts/lib/route-assembly.mjs`
- Test: `scripts/lib/route-assembly.test.mjs`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```js
import { joinSegments } from './route-assembly.mjs';

// Three 1-degree-longitude-apart fragments at the equator, ~111 km each, with
// ~111 km gaps between them. Big round numbers make the km bookkeeping readable.
const segAt = (lng) => [[lng, 0], [lng + 1, 0]];

describe('joinSegments', () => {
  const segments = () => [
    { name: 'left', coords: segAt(0) },
    { name: 'right', coords: segAt(2) },
    { name: 'cz', coords: segAt(4) },
  ];
  const bridges = () => [
    { name: 'ferry A', maxKm: 200 },
    { name: 'ferry B', maxKm: 200 },
  ];

  it('concatenates every coordinate in order', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.coords).toEqual([
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
    ]);
  });

  it('reports a total equal to the joined polyline length', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    const turfKm = turf.length(turf.lineString(out.coords), { units: 'kilometers' });
    expect(out.totalKm).toBeCloseTo(turfKm, 3);
  });

  it('gives each segment the km range it occupies in the joined line', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.segments[0].startKm).toBeCloseTo(0, 3);
    expect(out.segments[0].endKm).toBeCloseTo(111.195, 1);
    // segment 1 starts after segment 0 plus the bridge
    expect(out.segments[1].startKm).toBeCloseTo(222.39, 1);
    expect(out.segments[2].endKm).toBeCloseTo(out.totalKm, 3);
  });

  it('places each bridge at the end of the segment before it', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.bridges).toHaveLength(2);
    expect(out.bridges[0].km).toBeCloseTo(out.segments[0].endKm, 3);
    expect(out.bridges[1].km).toBeCloseTo(out.segments[1].endKm, 3);
    expect(out.bridges[0].name).toBe('ferry A');
  });

  it('measures each bridge length', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.bridges[0].lengthKm).toBeCloseTo(111.195, 1);
  });

  it('leaves no gap between a bridge and the segment after it', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.bridges[0].km + out.bridges[0].lengthKm).toBeCloseTo(out.segments[1].startKm, 3);
  });

  it('throws when a bridge exceeds its ceiling, naming it and its measurement', () => {
    expect(() =>
      joinSegments(segments(), { bridges: [{ name: 'ferry A', maxKm: 3 }, { name: 'ferry B', maxKm: 200 }] }),
    ).toThrow(/ferry A.*111\.\d+ km.*3 km/);
  });

  it('throws when the bridge count does not match the segment count', () => {
    expect(() => joinSegments(segments(), { bridges: [{ name: 'only one', maxKm: 200 }] }))
      .toThrow(/2 bridge/);
  });

  it('accepts a single segment with no bridges', () => {
    const out = joinSegments([{ name: 'solo', coords: segAt(0) }], { bridges: [] });
    expect(out.bridges).toEqual([]);
    expect(out.segments[0].startKm).toBe(0);
  });

  it('throws on a segment with fewer than two coordinates', () => {
    expect(() => joinSegments([{ name: 'stub', coords: [[0, 0]] }], { bridges: [] }))
      .toThrow(/stub/);
  });

  it('carries arbitrary segment metadata through to the output', () => {
    const out = joinSegments(
      [{ name: 'left', coords: segAt(0), source: 'elberadweg-left', relations: [1, 2] }],
      { bridges: [] },
    );
    expect(out.segments[0].source).toBe('elberadweg-left');
    expect(out.segments[0].relations).toEqual([1, 2]);
    expect(out.segments[0].coords).toBeUndefined(); // geometry does not belong in meta
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run scripts/lib/route-assembly.test.mjs`
Expected: FAIL — `joinSegments is not a function` (or an import error).

- [ ] **Step 3: Implement**

Append to `scripts/lib/route-assembly.mjs`:

```js
/**
 * Concatenate pre-trimmed segments into one coordinate array, recording where
 * each segment sits and how long each join turned out to be.
 *
 * The joins are *declared*, not discovered. Feeding all sixteen relations to one
 * stitcher would surface the Finkenwerder ferry as a generic hard-gap warning,
 * indistinguishable from corrupt data — and would let a genuine break hide among
 * the warnings that are expected. Here every join is named up front and carries a
 * ceiling, so an unexpected distance fails the build instead of being logged.
 *
 * Segments must already be trimmed, simplified and rounded: the km recorded here
 * are measured on the coordinates as given, so they are exactly the km of the
 * file that gets written.
 *
 * @param {Array<{name: string, coords: number[][]}>} segments - in route order.
 * @param {{bridges: Array<{name: string, maxKm: number}>}} opts - one fewer
 *   bridge than there are segments, in the same order as the joins.
 * @returns {{coords: number[][], totalKm: number,
 *            segments: Array<object & {startKm: number, endKm: number}>,
 *            bridges: Array<{name: string, km: number, lengthKm: number}>}}
 */
export function joinSegments(segments, { bridges = [] } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('joinSegments needs at least one segment');
  }
  const needed = segments.length - 1;
  if (bridges.length !== needed) {
    throw new Error(
      `joinSegments needs ${needed} bridge(s) for ${segments.length} segment(s), got ${bridges.length}`,
    );
  }

  const coords = [];
  const outSegments = [];
  const outBridges = [];
  let alongM = 0; // length of `coords` so far

  segments.forEach((segment, index) => {
    const { coords: segCoords, ...rest } = segment;
    if (!Array.isArray(segCoords) || segCoords.length < 2) {
      throw new Error(
        `segment "${segment.name}" has ${segCoords?.length ?? 0} coordinate(s), needs at least 2`,
      );
    }

    if (index > 0) {
      const bridge = bridges[index - 1];
      const gapM = haversineM(coords[coords.length - 1], segCoords[0]);
      const gapKm = gapM / 1000;
      if (gapKm > bridge.maxKm) {
        throw new Error(
          `bridge "${bridge.name}" measures ${gapKm.toFixed(2)} km, above its ${bridge.maxKm} km ` +
            `ceiling — the segments do not meet where they were expected to`,
        );
      }
      // The bridge starts where the previous segment ended. The joined polyline
      // spans it implicitly, so alongM has to account for it before the next
      // segment's own first vertex.
      outBridges.push({ name: bridge.name, km: alongM / 1000, lengthKm: gapKm });
      alongM += gapM;
    }

    const startM = alongM;
    coords.push(...segCoords);
    alongM += cumulativeAlongM(segCoords)[segCoords.length - 1];
    outSegments.push({ ...rest, startKm: startM / 1000, endKm: alongM / 1000 });
  });

  return { coords, totalKm: alongM / 1000, segments: outSegments, bridges: outBridges };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run scripts/lib/route-assembly.test.mjs`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/route-assembly.mjs scripts/lib/route-assembly.test.mjs
git commit -m "feat(build): join route segments with declared, bounded bridges"
```

---

## Task 3: `doublingBackReport` — measure spur inflation

**Files:**
- Modify: `scripts/lib/route-assembly.mjs`
- Test: `scripts/lib/route-assembly.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { doublingBackReport } from './route-assembly.mjs';

describe('doublingBackReport', () => {
  // ~1.1 km per 0.01 degree of latitude, so these are readable distances.
  const straight = [];
  for (let i = 0; i <= 100; i++) straight.push([0, i * 0.01]);

  it('reports nothing for a line that never revisits itself', () => {
    const out = doublingBackReport(straight);
    expect(out.flaggedKm).toBeCloseTo(0, 3);
    expect(out.percent).toBeCloseTo(0, 3);
    expect(out.clusters).toEqual([]);
  });

  it('flags an out-and-back spur', () => {
    // Out 20 km, back along the same coordinates, then onward.
    const spur = [...straight.slice(0, 20), ...straight.slice(0, 20).reverse(), ...straight.slice(20)];
    const out = doublingBackReport(spur);
    expect(out.flaggedKm).toBeGreaterThan(20);
    expect(out.percent).toBeGreaterThan(10);
    expect(out.clusters.length).toBeGreaterThan(0);
  });

  it('does not flag a hairpin that is close along the route as well as in space', () => {
    // A tight zigzag: consecutive points stay within metres of each other, but
    // never more than minAlongKm apart measured along the line.
    const hairpin = [];
    for (let i = 0; i < 40; i++) hairpin.push([i % 2 === 0 ? 0 : 0.0001, i * 0.0001]);
    const out = doublingBackReport(hairpin, { minAlongKm: 1 });
    expect(out.flaggedKm).toBeCloseTo(0, 3);
  });

  it('respects a widened radius', () => {
    // Two parallel lines 50 m apart: invisible at 30 m, flagged at 80 m.
    const parallel = [...straight.slice(0, 30), ...straight.slice(0, 30).reverse().map(([lng, lat]) => [lng + 0.00075, lat])];
    expect(doublingBackReport(parallel, { radiusM: 30 }).flaggedKm).toBeCloseTo(0, 1);
    expect(doublingBackReport(parallel, { radiusM: 120 }).flaggedKm).toBeGreaterThan(10);
  });

  it('returns clusters ordered longest first, with km positions', () => {
    const spur = [...straight.slice(0, 20), ...straight.slice(0, 20).reverse(), ...straight.slice(20)];
    const out = doublingBackReport(spur);
    const lengths = out.clusters.map((c) => c.lengthKm);
    expect([...lengths].sort((a, b) => b - a)).toEqual(lengths);
    expect(out.clusters[0].endKm).toBeGreaterThanOrEqual(out.clusters[0].startKm);
  });

  it('reports the route total it measured against', () => {
    const out = doublingBackReport(straight);
    expect(out.totalKm).toBeCloseTo(111.195, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run scripts/lib/route-assembly.test.mjs`
Expected: FAIL — `doublingBackReport is not a function`.

- [ ] **Step 3: Implement**

```js
/**
 * How much of a line doubles back on itself: the km whose vertices lie within
 * `radiusM` of a part of the same line more than `minAlongKm` away measured
 * *along* it.
 *
 * The along-route condition is what makes this useful. A cycle route is full of
 * vertices metres from their neighbours; only a return past a point already
 * ridden indicates a spur, and a spur means every distance the app quotes is
 * inflated. One stage's `alternative` members once produced a spurious 8.6 km
 * jump this way.
 *
 * Uses a flat lat/lng grid for neighbour lookup, so cost is linear in vertices
 * rather than quadratic. Cell size is a degree figure, not metres: at these
 * latitudes 0.0005 degrees is 35–56 m, comfortably above a 30 m radius, and the
 * ±2 cell sweep covers the rest.
 *
 * @returns {{flaggedKm: number, totalKm: number, percent: number,
 *            clusters: Array<{startKm: number, endKm: number, lengthKm: number}>}}
 */
export function doublingBackReport(
  coords,
  { radiusM = 30, minAlongKm = 1, cellDeg = 0.0005 } = {},
) {
  const along = cumulativeAlongM(coords);
  const totalM = along[along.length - 1] ?? 0;
  const minAlongM = minAlongKm * 1000;

  const grid = new Map();
  const cellKey = (lng, lat) => `${Math.floor(lng / cellDeg)},${Math.floor(lat / cellDeg)}`;
  coords.forEach(([lng, lat], i) => {
    const key = cellKey(lng, lat);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });

  const flagged = new Set();
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    const cx = Math.floor(lng / cellDeg);
    const cy = Math.floor(lat / cellDeg);
    let hit = false;
    for (let dx = -2; dx <= 2 && !hit; dx++) {
      for (let dy = -2; dy <= 2 && !hit; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) || []) {
          if (Math.abs(along[i] - along[j]) <= minAlongM) continue;
          if (haversineM(coords[i], coords[j]) <= radiusM) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) flagged.add(i);
  }

  // Turn flagged vertices into km, and into contiguous runs so the report can
  // point at where the trouble is rather than only how much of it there is.
  let flaggedM = 0;
  const clusters = [];
  let run = null;
  for (let i = 0; i < coords.length; i++) {
    if (flagged.has(i)) {
      if (i > 0) flaggedM += along[i] - along[i - 1];
      if (run) run.endM = along[i];
      else run = { startM: along[i], endM: along[i] };
    } else if (run) {
      clusters.push(run);
      run = null;
    }
  }
  if (run) clusters.push(run);

  const out = clusters.map(({ startM, endM }) => ({
    startKm: startM / 1000,
    endKm: endM / 1000,
    lengthKm: (endM - startM) / 1000,
  }));
  out.sort((a, b) => b.lengthKm - a.lengthKm);

  return {
    flaggedKm: flaggedM / 1000,
    totalKm: totalM / 1000,
    percent: totalM > 0 ? (flaggedM / totalM) * 100 : 0,
    clusters: out,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run scripts/lib/route-assembly.test.mjs`
Expected: PASS, 23 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/route-assembly.mjs scripts/lib/route-assembly.test.mjs
git commit -m "feat(build): measure how much of the route doubles back on itself"
```

---

## Task 4: `corridorPoints` — subsample the route for `around:` queries

**Files:**
- Modify: `scripts/lib/route-assembly.mjs`
- Test: `scripts/lib/route-assembly.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import { corridorPoints } from './route-assembly.mjs';

describe('corridorPoints', () => {
  const long = turf.lineString([[0, 0], [0, 1]]); // ~111.195 km

  it('samples about every spacingKm, plus the final coordinate', () => {
    const pts = corridorPoints(long, 10);
    // 0,10,...,110 = 12 samples, plus the endpoint
    expect(pts).toHaveLength(13);
  });

  it('starts at the line start and ends at the line end', () => {
    const pts = corridorPoints(long, 10);
    expect(pts[0][1]).toBeCloseTo(0, 4);
    expect(pts[pts.length - 1][1]).toBeCloseTo(1, 6);
  });

  it('yields at least two points for a line shorter than the spacing', () => {
    const short = turf.lineString([[0, 0], [0, 0.001]]); // ~111 m
    expect(corridorPoints(short, 2).length).toBeGreaterThanOrEqual(2);
  });

  it('returns [lng,lat] pairs', () => {
    const pts = corridorPoints(long, 50);
    for (const p of pts) {
      expect(Array.isArray(p)).toBe(true);
      expect(p).toHaveLength(2);
    }
  });

  it('spaces consecutive samples by roughly the requested distance', () => {
    const pts = corridorPoints(long, 10);
    const gap = haversineM(pts[0], pts[1]) / 1000;
    expect(gap).toBeCloseTo(10, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run scripts/lib/route-assembly.test.mjs`
Expected: FAIL — `corridorPoints is not a function`.

- [ ] **Step 3: Implement**

```js
/**
 * Sample a line every `spacingKm`, plus its final coordinate, for use as an
 * Overpass `around:` coordinate list.
 *
 * Why this exists: the Cuxhaven → Prague bounding box spans roughly 5.5° × 6.5°
 * and contains Berlin, Hannover, Leipzig and Nuremberg's latitude band. Querying
 * POIs in that rectangle fetches an enormous amount that the off-route filter
 * then discards, and very likely times out first.
 *
 * Coverage geometry, which sets the radius the caller must pass: circles of
 * radius r centred every s km along a line cover a band of half-width
 * sqrt(r² - (s/2)²). At s = 2 km, r = 3.5 km covers 3.35 km (enough for the 3 km
 * sight corridor) and r = 5.5 km covers 5.4 km (enough for the 5 km town
 * corridor). r = 3 km would cover only 2.83 km — a silent shortfall.
 */
export function corridorPoints(line, spacingKm = 2) {
  const totalKm = turf.length(line, { units: 'kilometers' });
  const points = [];
  for (let km = 0; km < totalKm; km += spacingKm) {
    points.push(turf.along(line, km, { units: 'kilometers' }).geometry.coordinates);
  }
  const coords = line.geometry.coordinates;
  points.push(coords[coords.length - 1]);
  return points;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run scripts/lib/route-assembly.test.mjs`
Expected: PASS, 28 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/route-assembly.mjs scripts/lib/route-assembly.test.mjs
git commit -m "feat(build): subsample the route into an around-query corridor"
```

---

## Task 5: Rebuild `build-data.mjs` around three sources

**Files:**
- Modify: `scripts/build-data.mjs`
- Modify: `.gitignore`

No unit tests: this is orchestration, fetching and logging. Its acceptance gate is the validation report in Task 8.

- [ ] **Step 1: Replace the configuration block**

Replace the `STAGE_RELATIONS` / `BANK` / anchor / checkpoint / length-bound constants (lines 43–74 and 392–404) with:

```js
// The three sources, in route order. Each is stitched, trimmed, simplified and
// rounded on its own, then joined by joinSegments().
//
// The left bank covers Cuxhaven -> Hamburg because Cuxhaven is a LEFT-bank town:
// the right-bank superroute (22327) terminates at Brunsbüttel. The right bank's
// own Wedel -> Landungsbrücken half is trimmed away, the left bank having covered
// that stretch on the other side of the river.
const SOURCES = [
  {
    key: 'left',
    source: 'elberadweg-left',
    from: 'Cuxhaven',
    to: 'Finkenwerder',
    relations: [
      2599008, // Cuxhaven -> Freiburg (Elbe)   [linkselbisch A]
      2599035, // Freiburg (Elbe) -> Finkenwerder [linkselbisch B]
    ],
    trim: ['CUXHAVEN', 'FINKENWERDER'],
  },
  {
    key: 'right',
    source: 'elberadweg-right',
    from: 'Landungsbrücken',
    to: 'Schöna',
    relations: [
      2599011, // Wedel -> Kirchwerder (Hamburg is mid-stage; trimmed at Landungsbrücken)
      2599013, // Ochsenwerder -> Lauenburg
      2599015, // Lauenburg -> Bitter
      2599016, // Bitter -> Wittenberge
      2599018, // Wittenberge -> Havelberg
      2599020, // Havelberg -> Tangermünde
      2599024, // Tangermünde -> Magdeburg
      2599025, // Magdeburg -> Dessau-Roßlau
      2599026, // Dessau-Roßlau -> Elster
      7758087, // Elster -> Belgern
      2599030, // Belgern -> Meißen
      2599032, // Meißen -> Heidenau
      2599033, // Heidenau -> Schöna (the DE/CZ border)
    ],
    trim: ['HAMBURG', 'SCHOENA'],
  },
  {
    key: 'cz',
    source: 'eurovelo-7-cz',
    from: 'Hřensko',
    to: 'Prague',
    // EV7's Czech part runs the border -> Ústí -> Mělník -> Prague -> the Austrian
    // border as one flat way list, so the Elbe and the Vltava arrive together and
    // there is no junction to invent at Mělník. Trimmed at Prague.
    relations: [2775754],
    trim: ['SCHOENA', 'PRAGUE'],
  },
];

// The two joins between the sources. Both are ferries: real water, not stitching
// artefacts. Named and bounded so a genuine break cannot hide inside one.
const BRIDGES = [
  { name: 'Finkenwerder–Landungsbrücken ferry', maxKm: 3 },
  { name: 'Schöna–Hřensko ferry', maxKm: 1 },
];

// Trim anchors ([lng,lat]). anchorSnap() fails the build if any lands further
// than ANCHOR_MAX_OFFSET_KM from its line.
const ANCHORS = {
  CUXHAVEN: [8.7166, 53.8917],     // Kugelbake, the Elbe-mouth marker
  FINKENWERDER: [9.876, 53.5372],  // Finkenwerder ferry pier
  HAMBURG: [9.9686, 53.5457],      // Landungsbrücken — unchanged from the old build
  SCHOENA: [14.2372, 50.8703],     // Schöna ferry, at the border
  PRAGUE: [14.4114, 50.0865],      // Charles Bridge
};
const ANCHOR_MAX_OFFSET_KM = 2;

// Monotonicity checkpoints ([lng,lat]) — must lie strictly in route order.
// Mělník precedes Prague because the Vltava leg runs upstream: they are ~50 km
// apart along the route and ~45 km apart straight-line, so this is a real
// assertion rather than an accident of ordering.
const CHECKPOINTS = [
  { name: 'Freiburg (Elbe)', pt: [9.2833, 53.825] },
  { name: 'Stade', pt: [9.4757, 53.5928] },
  { name: 'Hamburg', pt: [9.9686, 53.5457] },
  { name: 'Lauenburg', pt: [10.5586, 53.3739] },
  { name: 'Wittenberge', pt: [11.75, 52.995] },
  { name: 'Magdeburg', pt: [11.629, 52.126] },
  { name: 'Meißen', pt: [13.472, 51.162] },
  { name: 'Ústí nad Labem', pt: [14.04, 50.6607] },
  { name: 'Mělník', pt: [14.474, 50.351] },
];

// Route identity. Stable across rebuilds of the SAME corridor — plans are reset
// when this changes, and only when it changes, so a plain data refresh does not
// throw away anyone's trip. (main.js separately banners on meta.builtAt.)
const ROUTE_ID = 'cuxhaven-prague-ev7-v1';
const ORIGIN_NAME = 'Cuxhaven';
const DESTINATION_NAME = 'Prague';

// Length bounds (km). The old Hamburg -> Dresden route measured 650.24 km, which
// was audited on 2026-07-31 and is honest: doubling-back was 1.3%, and milestone
// distances run slightly SHORT against signposted values. Adding ~185 km of left
// bank and ~230 km past Dresden puts the nominal band here.
const LEN_HARD_MIN = 850;
const LEN_HARD_MAX = 1350;
const LEN_NOMINAL_MIN = 1000;
const LEN_NOMINAL_MAX = 1150;

// Fail above this much doubling-back. Not an investigation — a regression guard
// against a new stitching fault in the three added sources.
const DOUBLING_BACK_MAX_PERCENT = 5;

// Corridor sampling. See corridorPoints() for why the radii are what they are.
const CORRIDOR_SPACING_KM = 2;
const TOWN_AROUND_M = 5500;
const POI_AROUND_M = 3500;
```

- [ ] **Step 2: Import the helpers and delete the local haversine**

Replace the local `haversineM` definition (lines 115–127) with an import, keeping `round` local:

```js
import {
  haversineM,
  anchorSnap,
  joinSegments,
  doublingBackReport,
  corridorPoints,
} from './lib/route-assembly.mjs';
```

- [ ] **Step 3: Make the raw cache per source**

Replace the single `ROUTE_RAW_CACHE` constant:

```js
const rawCachePath = (key) => join(DATA_DIR, `route.raw.${key}.json`); // gitignored
```

- [ ] **Step 4: Generalise `orderedWayList` to take relation ids**

It currently closes over the module-level `STAGE_RELATIONS`. Change the signature:

```js
function orderedWayList(relations, relationIds) {
  const list = [];
  for (const relId of relationIds) {
    const rel = relations.get(relId);
    if (!rel) {
      console.warn(`[stitch] WARNING: relation ${relId} missing from OSM data`);
      continue;
    }
    for (const m of rel.members || []) {
      if (m.type !== 'way') continue;
      if (m.role === 'backward' || m.role === 'alternative') continue;
      list.push({ stageId: relId, wayId: m.ref });
    }
  }
  return list;
}
```

- [ ] **Step 5: Replace `trimToAnchors` with a two-anchor version**

```js
/**
 * Trim a stitched line to two anchors and orient it start -> end.
 *
 * Both anchors are snapped with a maximum-offset guard: a mistyped coordinate
 * would otherwise slice the route somewhere else entirely and report a plausible
 * length.
 */
function trimToAnchors(line, startKey, endKey, label) {
  const startSnap = anchorSnap(line, ANCHORS[startKey], {
    name: `${label}/${startKey}`,
    maxOffsetKm: ANCHOR_MAX_OFFSET_KM,
  });
  const endSnap = anchorSnap(line, ANCHORS[endKey], {
    name: `${label}/${endKey}`,
    maxOffsetKm: ANCHOR_MAX_OFFSET_KM,
  });
  console.log(
    `[trim] ${label}: ${startKey} offset ${startSnap.offsetKm.toFixed(2)} km @ ${startSnap.locationKm.toFixed(1)} km, ` +
      `${endKey} offset ${endSnap.offsetKm.toFixed(2)} km @ ${endSnap.locationKm.toFixed(1)} km`,
  );

  const trimmed = turf.lineSlice(startSnap.point, endSnap.point, line);
  const coords = trimmed.geometry.coordinates;
  if (
    haversineM(coords[coords.length - 1], ANCHORS[startKey]) <
    haversineM(coords[0], ANCHORS[startKey])
  ) {
    trimmed.geometry.coordinates = coords.slice().reverse();
    console.log(`[trim] ${label}: reversed slice to enforce ${startKey} -> ${endKey} order`);
  }
  return trimmed;
}
```

- [ ] **Step 6: Add the per-source builder**

```js
/** Fetch, stitch, trim, simplify and round one source. */
async function buildSegment(spec) {
  const query =
    `[out:json][timeout:300]; ` +
    `rel(id:${spec.relations.join(',')}); ` +
    `out body; >; out skel qt;`;
  const rawOsm = await fetchCached(query, rawCachePath(spec.key), `route/${spec.key}`);

  const { nodes, ways, relations } = indexOsm(rawOsm);
  console.log(`[index] ${spec.key}: ${nodes.size} nodes, ${ways.size} ways, ${relations.size} relations`);

  const orderedWays = orderedWayList(relations, spec.relations);
  console.log(`[stitch] ${spec.key}: ${orderedWays.length} ordered ways`);
  const { coords, softGaps, hardGaps } = stitch(orderedWays, ways, nodes);

  let line = turf.cleanCoords(turf.lineString(coords));
  console.log(
    `[stitch] ${spec.key}: ${coords.length} points, raw ` +
      `${turf.length(line, { units: 'kilometers' }).toFixed(1)} km, gaps ${softGaps} soft / ${hardGaps} hard`,
  );

  let trimmed = trimToAnchors(line, spec.trim[0], spec.trim[1], spec.key);
  // Simplify and round BEFORE joining, so joinSegments measures the coordinates
  // that actually get written and meta km never drift from the file's km.
  turf.simplify(trimmed, { tolerance: SIMPLIFY_TOLERANCE, highQuality: true, mutate: true });
  trimmed = roundCoords(trimmed);
  const km = turf.length(trimmed, { units: 'kilometers' });
  console.log(
    `[segment] ${spec.key}: ${trimmed.geometry.coordinates.length} points, ${km.toFixed(2)} km ` +
      `(${spec.from} -> ${spec.to})`,
  );

  return {
    name: spec.key,
    source: spec.source,
    from: spec.from,
    to: spec.to,
    relations: spec.relations,
    coords: trimmed.geometry.coordinates,
    softGaps,
    hardGaps,
  };
}
```

- [ ] **Step 7: Commit**

```bash
git add scripts/build-data.mjs .gitignore
git commit -m "refactor(build): drive the route build from three declared sources"
```

Also in this commit, change `.gitignore`'s `src/data/route.raw.osm.json` line to `src/data/route.raw.*.json`.

---

## Task 6: New validation report and meta writer

**Files:**
- Modify: `scripts/build-data.mjs`

- [ ] **Step 1: Replace `validate`**

```js
/**
 * Validate the joined route and print the report that is this pipeline's real
 * acceptance gate. Throws on anything that would ship wrong distances.
 */
function validate(line, joined) {
  const totalKm = turf.length(line, { units: 'kilometers' });
  console.log('\n===== VALIDATION REPORT =====');
  console.log(`Total length: ${totalKm.toFixed(2)} km (nominal ${LEN_NOMINAL_MIN}–${LEN_NOMINAL_MAX})`);

  // joinSegments measured the same coordinates with haversine; turf measures the
  // written line. They must agree, or the km recorded in meta describe a
  // different line from the one in route.json.
  if (Math.abs(totalKm - joined.totalKm) > 0.05) {
    throw new Error(
      `assembled total ${joined.totalKm.toFixed(3)} km disagrees with the written line ` +
        `${totalKm.toFixed(3)} km by more than 50 m — meta km would not describe route.json`,
    );
  }

  if (totalKm < LEN_HARD_MIN || totalKm > LEN_HARD_MAX) {
    throw new Error(
      `Total length ${totalKm.toFixed(1)} km is wildly out of range (${LEN_HARD_MIN}–${LEN_HARD_MAX}).`,
    );
  }
  if (totalKm < LEN_NOMINAL_MIN || totalKm > LEN_NOMINAL_MAX) {
    console.warn(
      `[validate] length ${totalKm.toFixed(1)} km outside nominal ${LEN_NOMINAL_MIN}–${LEN_NOMINAL_MAX} (still within hard bounds)`,
    );
  }

  console.log('\nSegments:');
  for (const seg of joined.segments) {
    console.log(
      `  ${seg.name.padEnd(6)} ${seg.from} -> ${seg.to}`.padEnd(48) +
        `km ${seg.startKm.toFixed(1)} – ${seg.endKm.toFixed(1)}  (${(seg.endKm - seg.startKm).toFixed(1)} km)`,
    );
  }
  console.log('Bridges:');
  for (const bridge of joined.bridges) {
    console.log(`  ${bridge.name.padEnd(40)} @ km ${bridge.km.toFixed(1)}  ${(bridge.lengthKm * 1000).toFixed(0)} m`);
  }

  // Monotonicity.
  const locations = CHECKPOINTS.map((c) => {
    const snap = turf.nearestPointOnLine(line, turf.point(c.pt), { units: 'kilometers' });
    return { name: c.name, loc: snap.properties.location, off: snap.properties.dist };
  });
  console.log('\nMonotonicity checkpoints (km along route, offset km):');
  for (const l of locations) {
    console.log(`  ${l.name.padEnd(16)} @ ${l.loc.toFixed(1)} km (offset ${l.off.toFixed(2)} km)`);
  }
  for (let i = 1; i < locations.length; i++) {
    if (locations[i].loc <= locations[i - 1].loc) {
      throw new Error(
        `Monotonicity failed: ${locations[i - 1].name} @ ${locations[i - 1].loc.toFixed(1)} km is not ` +
          `before ${locations[i].name} @ ${locations[i].loc.toFixed(1)} km`,
      );
    }
  }
  console.log('Monotonicity: PASS (strictly increasing)');

  // Doubling-back guard.
  const db = doublingBackReport(line.geometry.coordinates);
  console.log(
    `\nDoubling-back: ${db.flaggedKm.toFixed(1)} km of ${db.totalKm.toFixed(1)} km ` +
      `(${db.percent.toFixed(1)}%, max ${DOUBLING_BACK_MAX_PERCENT}%) in ${db.clusters.length} clusters`,
  );
  for (const c of db.clusters.slice(0, 5)) {
    console.log(`  km ${c.startKm.toFixed(1)}–${c.endKm.toFixed(1)} = ${c.lengthKm.toFixed(2)} km`);
  }
  if (db.percent > DOUBLING_BACK_MAX_PERCENT) {
    throw new Error(
      `Doubling-back is ${db.percent.toFixed(1)}% of the route (max ${DOUBLING_BACK_MAX_PERCENT}%) — ` +
        `the stitch is producing out-and-back spurs, and every distance the app quotes would be inflated`,
    );
  }

  return { totalKm, doublingBackPercent: db.percent };
}
```

- [ ] **Step 2: Replace the meta writer in `main()`**

```js
  trimmed.properties = {
    name: `Elberadweg + EuroVelo 7: ${ORIGIN_NAME} → ${DESTINATION_NAME}`,
    routeId: ROUTE_ID,
  };
  writeFileSync(ROUTE_JSON, JSON.stringify(trimmed));

  const meta = {
    routeId: ROUTE_ID,
    totalKm: round(totalKm, 2),
    origin: { name: ORIGIN_NAME, km: 0 },
    destination: { name: DESTINATION_NAME, km: round(totalKm, 2) },
    segments: joined.segments.map((seg) => ({
      source: seg.source,
      from: seg.from,
      to: seg.to,
      relations: seg.relations,
      startKm: round(seg.startKm, 2),
      endKm: round(seg.endKm, 2),
    })),
    bridges: joined.bridges.map((b) => ({
      name: b.name,
      km: round(b.km, 2),
      lengthKm: round(b.lengthKm, 3),
    })),
    builtAt: new Date().toISOString(),
    simplifyTolerance: SIMPLIFY_TOLERANCE,
    pointCount,
    doublingBackPercent: round(doublingBackPercent, 2),
  };
  writeFileSync(ROUTE_META_JSON, JSON.stringify(meta, null, 2));
```

- [ ] **Step 3: Rewrite `main()`'s route phase**

```js
async function main() {
  console.log(`Elberadweg data pipeline — ${ORIGIN_NAME} → ${DESTINATION_NAME}, refresh=${REFRESH}`);

  // 1-3. Build each source independently.
  const segments = [];
  for (const spec of SOURCES) segments.push(await buildSegment(spec));

  const totalHard = segments.reduce((n, s) => n + s.hardGaps, 0);
  const totalSoft = segments.reduce((n, s) => n + s.softGaps, 0);

  // 4. Join with the declared bridges.
  const joined = joinSegments(segments, { bridges: BRIDGES });
  let trimmed = turf.lineString(joined.coords);
  const pointCount = joined.coords.length;
  console.log(`\n[join] ${pointCount} points, ${joined.totalKm.toFixed(2)} km`);

  // 5. Validate.
  const { totalKm, doublingBackPercent } = validate(trimmed, joined);
  console.log(`Gaps within segments: ${totalSoft} soft, ${totalHard} hard`);
  console.log('=============================\n');

  // 6. Write route + meta.  (meta writer from step 2 goes here)
  // 7. Towns.  8. POIs.  — unchanged call sites, corridor-based bodies (Task 7)
}
```

Keep the existing towns/POIs call sites and the closing `console.log('\nDone.')`.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-data.mjs
git commit -m "feat(build): validate segments, bridges, monotonicity and doubling-back"
```

---

## Task 7: Corridor queries for towns and POIs

**Files:**
- Modify: `scripts/build-data.mjs`

- [ ] **Step 1: Add the corridor helper**

```js
/**
 * An Overpass `around:` clause prefix for the whole route corridor.
 *
 * Replaces a bounding box that would span ~5.5° × 6.5° and contain Berlin,
 * Hannover, Leipzig and Nuremberg's latitude band. The coordinate list is ~530
 * points at 2 km spacing, which makes for a ~9 KB clause — repeated per clause,
 * still a trivial POST.
 */
function aroundClause(points, radiusM) {
  const coords = points.map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(',');
  return `around:${radiusM},${coords}`;
}
```

- [ ] **Step 2: Rewrite `buildTowns`**

```js
async function buildTowns(trimmed, corridor) {
  const around = aroundClause(corridor, TOWN_AROUND_M);
  const query =
    `[out:json][timeout:600];` +
    `( node["place"~"^(city|town|village)$"](${around}); );` +
    `out body;`;

  const osm = await fetchCached(query, TOWNS_RAW_CACHE, 'towns');

  const towns = [];
  for (const el of osm.elements) {
    if (el.type !== 'node' || !el.tags?.name) continue;
    const snap = turf.nearestPointOnLine(trimmed, turf.point([el.lon, el.lat]), {
      units: 'kilometers',
    });
    const offsetKm = snap.properties.dist;
    if (offsetKm > 5) continue;
    towns.push({
      name: el.tags.name,
      place: el.tags.place,
      lat: round(el.lat),
      lng: round(el.lon),
      routeDistanceKm: round(snap.properties.location, 1),
      offsetKm: round(offsetKm, 2),
    });
  }
  towns.sort((a, b) => a.routeDistanceKm - b.routeDistanceKm);
  return towns;
}
```

- [ ] **Step 3: Rewrite `buildPois`'s query**

Replace the bbox computation and query string; everything below `const osm = await fetchCached(...)` is unchanged.

```js
async function buildPois(trimmed, corridor) {
  const a = aroundClause(corridor, POI_AROUND_M);
  const query =
    `[out:json][timeout:900];` +
    `(` +
    `nwr["amenity"~"^(cafe|restaurant|fast_food|ice_cream|biergarten)$"](${a});` +
    `nwr["shop"="bakery"](${a});` +
    `nwr["tourism"="viewpoint"](${a});` +
    `nwr["natural"="waterfall"](${a});` +
    `nwr["historic"~"^(castle|monument|ruins|fort|city_gate|tower)$"](${a});` +
    `nwr["man_made"="lighthouse"](${a});` +
    `nwr["man_made"="tower"]["tower:type"="observation"](${a});` +
    `nwr["man_made"="bridge"]["name"](${a});` +
    `);` +
    `out center;`;

  const osm = await fetchCached(query, POIS_RAW_CACHE, 'pois');
  // … unchanged classify/name/dedupe/sort body …
}
```

- [ ] **Step 4: Build the corridor once in `main()` and pass it to both**

```js
  const corridor = corridorPoints(trimmed, CORRIDOR_SPACING_KM);
  console.log(`[corridor] ${corridor.length} sample points at ${CORRIDOR_SPACING_KM} km spacing`);

  const towns = await buildTowns(trimmed, corridor);
  writeFileSync(TOWNS_JSON, JSON.stringify(towns, null, 2));
  console.log(`[write] ${TOWNS_JSON} (${towns.length} towns)`);

  const pois = await buildPois(trimmed, corridor);
  validatePois(pois);
  writeFileSync(POIS_JSON, JSON.stringify(pois, null, 2));
  console.log(`[write] ${POIS_JSON} (${pois.length} POIs)`);
```

- [ ] **Step 5: Commit**

```bash
git add scripts/build-data.mjs
git commit -m "feat(build): fetch towns and POIs along the route corridor, not its bbox"
```

---

## Task 8: Run the build for real

**Files:**
- Modify: `src/data/route.json`, `route.meta.json`, `towns.json`, `pois.json`

- [ ] **Step 1: Run it**

Run: `npm run build:data 2>&1 | tee <scratchpad>/build-log.txt`
Expected: a validation report with total length 1000–1150 km, all anchor offsets under 2 km, both bridges under their ceilings, monotonicity PASS, doubling-back under 5%, and non-zero town and POI counts.

- [ ] **Step 2: Check the report against the gates**

Every one of these must hold before committing data:
- total length inside the hard bounds, and inside nominal or with a recorded reason
- zero hard gaps *within* segments (the two ferries are bridges, not gaps)
- monotonicity PASS
- doubling-back under 5%
- towns > 300, POIs > 4000 (the old 650 km route had 4971 POIs; a longer corridor should exceed that)

If the Overpass corridor query times out or is rejected, implement the banded-bbox fallback: split the route bbox into six latitude bands, fetch each with the existing retry machinery, and concatenate `elements` before the unchanged filter loop.

- [ ] **Step 3: Sanity-check the output independently**

Run a one-off script that loads the new `route.json` and prints the route km of Hamburg, Dresden and Prague from `towns.json`, plus the first and last coordinates.
Expected: Hamburg ~183–190 km, Dresden ~835–855 km, Prague at the end; first coordinate near `[8.72, 53.89]`, last near `[14.41, 50.09]`.

- [ ] **Step 4: Commit the data**

```bash
git add src/data/route.json src/data/route.meta.json src/data/towns.json src/data/pois.json
git commit -m "data: rebuild the route corridor as Cuxhaven -> Prague"
```

---

## Task 9: Endpoint names in the strip

**Files:**
- Modify: `src/strip-markup.js:121-131`, `:167-177`, `:186-194`
- Modify: `src/strip.js:35`, `:100-118`
- Test: `src/strip.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `src/strip.test.js`:

```js
describe('endpoint names', () => {
  it('counts down to the destination the state names', () => {
    const el = mountLive([100], { totalKm: 400, destinationName: 'Prague' });
    expect(el.querySelector('.strip__summary').textContent).toContain('300 km to Prague');
  });

  it('names the origin and destination on the scale line', () => {
    const el = mountLive([100], { totalKm: 400, originName: 'Cuxhaven', destinationName: 'Prague' });
    const scale = el.querySelector('.strip__scale').textContent;
    expect(scale).toContain('km 0 · Cuxhaven');
    expect(scale).toContain('km 400 · Prague');
  });

  it('flags the destination on the remainder', () => {
    const el = mountLive([100], { totalKm: 400, destinationName: 'Prague' });
    expect(el.querySelector('.strip__flag').textContent).toContain('Prague');
  });

  it('says the destination is reached once the plan arrives', () => {
    const el = mountLive([400], { totalKm: 400, destinationName: 'Prague' });
    expect(el.querySelector('.strip__finish').textContent).toContain('Prague reached');
  });

  it('falls back to neutral words when no names are given, so the module mounts alone', () => {
    const el = mountLive([100], { totalKm: 400 });
    const text = el.textContent;
    expect(text).toContain('km to finish');
    expect(text).toContain('km 0 · start');
  });
});
```

Update `mountLive` to forward the two new options into `strip.render`, and update the three existing assertions that name Dresden (`strip.test.js:606`, `:842`, and the arrival test near `:816`) to pass `destinationName: 'Dresden'` so they keep testing what they were testing.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/strip.test.js`
Expected: FAIL — the new tests see "to Dresden" and "· Hamburg".

- [ ] **Step 3: Implement in `strip-markup.js`**

```js
/** The line above the axis: how far the plan reaches, and the average day. */
export function summaryMarkup({ days, totalKm, destinationName = 'finish' }) {
  const planned = days.length ? days[days.length - 1].endKm : 0;
  const remaining = Math.max(0, totalKm - planned);
  const avg = days.length ? round1(planned / days.length) : 0;
  const right = days.length
    ? `${days.length} ${days.length === 1 ? 'day' : 'days'} · ⌀ ${avg} km/day`
    : 'no days yet';
  return `
      <span><b>${round1(planned)} / ${round1(totalKm)} km planned</b> · ${round1(remaining)} km to ${esc(destinationName)}</span>
      <span>${right}</span>`;
}
```

In `axisMarkup`, the remainder flag:

```js
             <span class="strip__flag">⚑ ${esc(state.destinationName ?? 'finish')}</span>
```

And `scaleMarkup`:

```js
export function scaleMarkup(state, layout) {
  const arrived = state.days.length > 0 && tailBox(layout).width <= 0;
  const origin = esc(state.originName ?? 'start');
  const destination = esc(state.destinationName ?? 'finish');
  return (
    `<span>km 0 · ${origin}</span>` +
    (arrived
      ? `<span class="strip__finish">⚑ km ${round1(state.totalKm)} · ${destination} reached</span>`
      : `<span>km ${round1(state.totalKm)} · ${destination}</span>`)
  );
}
```

- [ ] **Step 4: Implement in `strip.js`**

Extend the initial state and `render`:

```js
  let state = { days: [], totalKm: 0, focusedIndex: null, breaks: [], originName: 'start', destinationName: 'finish' };
```

```js
    state = {
      days: next.days || [],
      totalKm: next.totalKm || 0,
      focusedIndex: next.focusedIndex ?? null,
      breaks: next.breaks || [],
      // Defaulted rather than required: the strip is mounted on its own in tests
      // and must not render "undefined" as a destination.
      originName: next.originName ?? state.originName ?? 'start',
      destinationName: next.destinationName ?? state.destinationName ?? 'finish',
    };
```

Note the `?? state.…` fallback: `render()` is called with no argument on resize, and must not lose the names.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/strip.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/strip.js src/strip-markup.js src/strip.test.js
git commit -m "feat(strip): take endpoint names from state instead of hardcoding them"
```

---

## Task 10: Origin name on the map's start pin

**Files:**
- Modify: `src/map.js:392-398`
- Test: `src/map.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('titles the start pin with the origin name it was given', () => {
  const { map } = mountMap({ originName: 'Cuxhaven' });
  expect(startPinTitle(map)).toBe('Start — Cuxhaven');
});

it('falls back to a neutral title with no origin name', () => {
  const { map } = mountMap({});
  expect(startPinTitle(map)).toBe('Start');
});
```

Follow the file's existing mounting helper and marker-inspection idiom rather than inventing one; read `src/map.test.js` first and match it.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/map.test.js`
Expected: FAIL — title is `'Start — Hamburg'`.

- [ ] **Step 3: Implement**

`createMap` gains an `originName` option, and the pin becomes:

```js
  // Static start pin at km 0 — the first route coordinate.
  const startTitle = originName ? `Start — ${originName}` : 'Start';
```

with `title: startTitle` at the marker.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/map.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/map.js src/map.test.js
git commit -m "feat(map): title the start pin from the origin name"
```

---

## Task 11: Archive and reset a plan built against another corridor

**Files:**
- Modify: `src/storage.js`
- Test: `src/storage.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('routeId reset', () => {
  const blob = (routeId, name = 'Old plan') =>
    JSON.stringify({
      schemaVersion: 3,
      activePlanId: 'p1',
      routeId,
      plans: [{ id: 'p1', name, createdAt: 'a', updatedAt: 'b', days: [{ targetKm: 80 }], breaks: [] }],
    });

  it('reads a blob whose routeId matches', () => {
    const storage = fakeStorage({ 'elberadweg-plans': blob('cuxhaven-prague-ev7-v1') });
    const store = createPlanStore({ storage, routeId: 'cuxhaven-prague-ev7-v1' });
    store.load();
    expect(store.getActivePlan().name).toBe('Old plan');
  });

  it('archives and resets a blob whose routeId differs', () => {
    const storage = fakeStorage({ 'elberadweg-plans': blob('hamburg-dresden-right-v1') });
    const store = createPlanStore({ storage, routeId: 'cuxhaven-prague-ev7-v1' });
    store.load();
    expect(store.getActivePlan().name).toBe('My plan');
    expect(store.getActivePlan().days).toEqual([]);
    expect(storage.getItem('elberadweg-plans-backup-hamburg-dresden-right-v1')).toContain('Old plan');
  });

  it('archives a v2 blob with no routeId under a v2 key', () => {
    const storage = fakeStorage({
      'elberadweg-plans': JSON.stringify({
        schemaVersion: 2,
        activePlanId: 'p1',
        plans: [{ id: 'p1', name: 'Legacy', createdAt: 'a', updatedAt: 'b', days: [], breaks: [] }],
      }),
    });
    const store = createPlanStore({ storage, routeId: 'cuxhaven-prague-ev7-v1' });
    store.load();
    expect(storage.getItem('elberadweg-plans-backup-v2')).toContain('Legacy');
    expect(store.getActivePlan().name).toBe('My plan');
  });

  it('archives favorites alongside the plans', () => {
    const storage = fakeStorage({
      'elberadweg-plans': blob('hamburg-dresden-right-v1'),
      'elberadweg-favorites': JSON.stringify({ schemaVersion: 1, favorites: [{ name: 'Café', kind: 'food', routeDistanceKm: 12 }] }),
    });
    const store = createPlanStore({ storage, routeId: 'cuxhaven-prague-ev7-v1' });
    store.load();
    expect(storage.getItem('elberadweg-favorites-backup-hamburg-dresden-right-v1')).toContain('Café');
    expect(storage.getItem('elberadweg-favorites')).toBe(null);
  });

  it('never overwrites an existing backup', () => {
    const storage = fakeStorage({
      'elberadweg-plans': blob('hamburg-dresden-right-v1', 'Second'),
      'elberadweg-plans-backup-hamburg-dresden-right-v1': '{"first":true}',
    });
    const store = createPlanStore({ storage, routeId: 'cuxhaven-prague-ev7-v1' });
    store.load();
    expect(storage.getItem('elberadweg-plans-backup-hamburg-dresden-right-v1')).toBe('{"first":true}');
    expect(storage.getItem('elberadweg-plans-backup-hamburg-dresden-right-v1-2')).toContain('Second');
  });

  it('stamps the current routeId onto what it writes', () => {
    const storage = fakeStorage({});
    const store = createPlanStore({ storage, routeId: 'cuxhaven-prague-ev7-v1' });
    store.load();
    expect(JSON.parse(storage.getItem('elberadweg-plans')).routeId).toBe('cuxhaven-prague-ev7-v1');
  });

  it('does not archive when no routeId is configured, so the module stays usable alone', () => {
    const storage = fakeStorage({ 'elberadweg-plans': blob('anything') });
    const store = createPlanStore({ storage });
    store.load();
    expect(store.getActivePlan().name).toBe('Old plan');
  });
});
```

Use the file's existing fake-storage helper; read `src/storage.test.js` first and match its idiom (it must support `getItem` returning `null` for absent keys).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/storage.test.js`
Expected: FAIL — the blob is read, no backup key is written.

- [ ] **Step 3: Implement**

```js
const SCHEMA_VERSION = 3;
const PREVIOUS_SCHEMA_VERSION = 2;
```

```js
  /**
   * Move a key's value to a backup key, never overwriting one that exists.
   *
   * A second rebuild against the same old routeId must not destroy the first
   * backup, so an occupied key gets a -2, -3, … suffix.
   */
  function archive(key, oldRouteId) {
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      return;
    }
    if (!raw) return;
    const base = `${key}-backup-${oldRouteId ?? `v${PREVIOUS_SCHEMA_VERSION}`}`;
    let target = base;
    for (let n = 2; storage.getItem(target) != null; n++) target = `${base}-${n}`;
    try {
      storage.setItem(target, raw);
      storage.removeItem?.(key);
    } catch {
      // Best-effort: if the backup cannot be written the reset still happens,
      // which is the part that keeps wrong distances off the screen.
    }
  }
```

`readV2` becomes `readPlans`, accepting both schema versions and reporting the blob's routeId:

```js
  // Parses the stored blob; returns {state, routeId, schemaVersion} or null on any
  // problem (missing key, invalid JSON, unknown schema, empty plans list).
  function readPlans() {
    try {
      const raw = storage.getItem(PLANS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const version = parsed?.schemaVersion;
      if (
        !parsed ||
        (version !== SCHEMA_VERSION && version !== PREVIOUS_SCHEMA_VERSION) ||
        !Array.isArray(parsed.plans) ||
        parsed.plans.length === 0
      ) {
        return null;
      }
      const plans = parsed.plans.map(normalizePlan);
      let activePlanId = parsed.activePlanId;
      if (!plans.some((plan) => plan.id === activePlanId)) {
        activePlanId = mostRecentlyUpdated(plans).id;
      }
      return { state: { activePlanId, plans }, routeId: parsed.routeId ?? null };
    } catch {
      return null;
    }
  }
```

`load()` gains the corridor check:

```js
  function load() {
    let next = null;
    const stored = readPlans();
    if (stored) {
      // A different corridor means every stored km measures from a different
      // origin: day boundaries, break positions and favorite keys all point
      // somewhere else. There is no honest migration while days[0] must start at
      // km 0, so archive rather than read. An absent routeId is treated as
      // different — it predates the corridor being recorded at all.
      const mismatch = routeId && stored.routeId !== routeId;
      if (mismatch) {
        archive(PLANS_KEY, stored.routeId);
        archive(FAVORITES_KEY, stored.routeId);
      } else {
        next = stored.state;
      }
    }
    if (!next) {
      try {
        next = migrateV1();
      } catch {
        next = null;
      }
    }
    state = next ?? freshState();
    persist();
    return meta();
  }
```

and `persist()` records the corridor:

```js
      storage.setItem(
        PLANS_KEY,
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          routeId,
          activePlanId: state.activePlanId,
          plans: state.plans,
        }),
      );
```

Finally, `createPlanStore` takes `routeId`:

```js
export function createPlanStore({ storage, routeVersion, routeId } = {}) {
```

with the JSDoc gaining:

```
 * @param {string} [opts.routeId] - current corridor id (`meta.routeId`). A stored
 *   blob from a different corridor is archived and reset rather than read: its km
 *   measure from a different origin. Omit to disable the check entirely.
```

**Careful:** `migrateV1()` must only run when there was no usable v2/v3 blob, *not* after an archive — a v1 payload from the old corridor is just as wrong. Guard it:

```js
    if (!next && !archived) {
```

where `archived` is set true in the mismatch branch.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/storage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage.js src/storage.test.js
git commit -m "feat(storage): archive plans built against a different route corridor"
```

---

## Task 12: Wire meta through `main.js`, `index.html` and the prose

**Files:**
- Modify: `src/main.js:48`, `:277`, `:284`, `:312`, `:335`, `:581`
- Modify: `index.html:27`
- Modify: `src/itinerary.js:66-68`
- Modify: `README.md:4`, `:90`, `:105-106`

- [ ] **Step 1: Wire the store and the strip**

```js
  const store = createPlanStore({
    storage: window.localStorage,
    routeVersion: meta.builtAt,
    routeId: meta.routeId,
  });
```

```js
  function renderStrip(focusedIndex) {
    strip.render({
      days: itinerary.getDays(),
      totalKm,
      focusedIndex,
      breaks: itinerary.getBreaks(),
      originName: meta.origin.name,
      destinationName: meta.destination.name,
    });
  }
```

- [ ] **Step 2: Replace the three `'Hamburg'` literals and the Dresden function name**

```js
  const ORIGIN_NAME = meta.origin.name;
```

- `fromNameFor`: `if (index === 0) return ORIGIN_NAME;`
- `renderDayPanel`: `fromName: day ? fromNameFor(day.index) : ORIGIN_NAME,`
- `renderPlaces`: `fromName: day ? fromNameFor(day.index) : ORIGIN_NAME,`
- `hasReachedDresden()` → `hasReachedDestination()`, including the call site at `:581`
- Its comment loses "Dresden": "The plan is complete when the last endKm is within the shared arrival tolerance of the route total."

- [ ] **Step 3: Pass the origin name to the map**

```js
  const map = createMap({ /* … existing options …, */ originName: ORIGIN_NAME });
```

Match the existing `createMap` call's option style.

- [ ] **Step 4: Fill the header from meta**

`index.html`:

```html
        Elberadweg Day Planner <span id="app-route"></span>
```

`main.js`, in `boot()` after meta is read:

```js
  // The header names the corridor, which is data, not markup.
  const routeLabel = document.getElementById('app-route');
  if (routeLabel) routeLabel.textContent = `${meta.origin.name} → ${meta.destination.name}`;
```

- [ ] **Step 5: Update the prose**

- `src/itinerary.js:66-68` — "Creates a multi-day itinerary model for a route running from its origin (km 0) to its destination (km totalKm)."
- `README.md:4` — "from **Cuxhaven to Prague**"
- `README.md:90` — the green start pin is at the origin, not "at Hamburg"
- `README.md:105-106` — describe three sources joined by two ferry bridges, trimmed to the Cuxhaven and Prague anchors

- [ ] **Step 6: Verify the whole suite and the app**

Run: `npm test`
Expected: PASS, all files.

Then run the dev server and confirm in a browser: the header says "Cuxhaven → Prague", the strip's scale line reads `km 0 · Cuxhaven` … `km <total> · Prague`, the summary counts down to Prague, and the old plan is gone with a fresh "My plan" in its place.

- [ ] **Step 7: Commit**

```bash
git add src/main.js src/itinerary.js index.html README.md
git commit -m "feat: name the route's endpoints from meta everywhere"
```

---

## Task 13: Review, merge, push

- [ ] **Step 1: Grep for stale prose**

```bash
git grep -n "Dresden\|hasReachedDresden" -- src index.html README.md docs/superpowers/specs/2026-07-31-cuxhaven-prague-route-design.md
```

Expected: only legitimate remaining hits — the timeline-layout spec and plan (historical documents), and `strip.test.js` where "Dresden" is passed deliberately as a test name. Any hit in `src/*.js` outside a test fixture is a miss to fix.

- [ ] **Step 2: Two-stage review**

First pass against the spec: is every section implemented, and are the deviations the ones recorded at the top of this plan? Second pass for quality: dead parameters, duplicated constants, comments describing the old behaviour.

- [ ] **Step 3: Full verification**

```bash
npm test
npm run build
```
Expected: all tests pass; Vite build succeeds.

- [ ] **Step 4: Merge and push**

```bash
git checkout master
git merge --no-ff route-cuxhaven-prague -m "Merge the Cuxhaven-Prague route corridor"
git push origin master
```

- [ ] **Step 5: Record the outcome in the spec**

Append an addendum to the spec: measured total length, segment and bridge figures, doubling-back percentage, town and POI counts, whether the corridor query held up, and any deviation not already listed.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §1 Sources | 5 (SOURCES config) |
| §2 Assembly, declared bridges | 2 (`joinSegments`), 5 (`buildSegment`) |
| §3 Anchors + snap-offset check | 1 (`anchorSnap`), 5 (`trimToAnchors`) |
| §4 Corridor query for towns/POIs | 4 (`corridorPoints`), 7 |
| §5 Validation, monotonicity, doubling-back guard | 3, 6 |
| §6 `route.meta.json` shape | 6 |
| §7 App changes (7 files) | 9, 10, 12 |
| §8 Stored data archive/reset | 11 |
| §9 Testing | 1–4, 9, 10, 11 |

**Gaps found and closed while reviewing:**
- The spec's §7 table lists `strip.js`, `strip-markup.js`, `main.js`, `map.js`, `index.html`, `itinerary.js` and `README.md`. `map.js` and `index.html` had no task; Tasks 10 and 12 now cover them.
- `render()` with no argument (the ResizeObserver path) would have dropped the endpoint names. Task 9's state merge keeps them.
- `migrateV1()` would have resurrected a v1 payload from the old corridor immediately after archiving the v3 one. Task 11 guards it.
- The spec did not say whether `joinSegments` runs before or after simplification. Deviation 3 settles it: before, so meta km match the written file.

**Placeholder scan:** no TBDs; every code step carries its code. Task 8's fallback is conditional rather than vague — the condition and the implementation are both stated.

**Placeholder scan (second pass):** Task 1's step listing no longer contains the `toBeLessThan` note that was itself a placeholder; the assertion is written correctly inline.

**Type consistency:** `anchorSnap` returns `{point, offsetKm, locationKm}`, used as such in `trimToAnchors`. `joinSegments` returns `{coords, totalKm, segments, bridges}`, consumed in `main()` and `validate()`. `doublingBackReport` returns `{flaggedKm, totalKm, percent, clusters}`, consumed in `validate()`. Segment objects carry `{name, source, from, to, relations, coords, softGaps, hardGaps}` from `buildSegment` and lose `coords` in meta. `createPlanStore` takes `{storage, routeVersion, routeId}` and `main.js` passes all three.

## Ledger

Filled in during execution — measured numbers, surprises, and anything decided at the keyboard rather than here.
