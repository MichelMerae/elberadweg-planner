#!/usr/bin/env node
/**
 * build-elevation.mjs — samples elevation along the built route.
 *
 * Produces src/data/elevation.json: a flat array of integer metres, one every
 * ELEVATION_SPACING_M along route.json, stamped with the routeId it was sampled
 * from.
 *
 * Separate from build-data.mjs on purpose. It talks to a different upstream
 * (Open-Meteo, not Overpass), and a towns refresh should not re-fetch a hundred
 * elevation requests.
 *
 * Source: Open-Meteo's elevation API — Copernicus DEM GLO-90, no API key, 10k
 * requests/day. Verified against known points before this script was written:
 * Hamburg 5 m, Dresden 115 m, Prague 184 m, Bad Schandau 176 m.
 *
 * Run:  node scripts/build-elevation.mjs [--refresh]
 *   --refresh  re-fetch instead of using the cached batches.
 *
 * MUST run after build-data.mjs: it reads the finished geometry, and it refuses to
 * write a profile whose routeId disagrees with route.meta.json.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as turf from '@turf/turf';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'src', 'data');
const ROUTE_JSON = join(DATA_DIR, 'route.json');
const ROUTE_META_JSON = join(DATA_DIR, 'route.meta.json');
const ELEVATION_JSON = join(DATA_DIR, 'elevation.json');

// 250 m, set by the provider's quota rather than by taste.
//
// 100 m would match the DEM's ~90 m resolution exactly, but Open-Meteo's free
// allowance is weighted by NUMBER OF LOCATIONS, not by requests — measured: six
// consecutive 100-location batches returned HTTP 429, which is ~600 locations and
// exactly their per-minute ceiling. At 100 m this route is 10,265 samples, i.e. an
// entire day's 10,000 allowance for one build.
//
// At 250 m it is 4,107 samples: inside the hourly budget, a fraction of the daily
// one, and still ~3 samples per pixel on a 1400 px strip where one pixel is 0.73 km.
// The cost is real but small — a climb shorter than 250 m gets averaged away — and
// the 5 m hysteresis threshold on ascent already discards features that size.
const ELEVATION_SPACING_M = 250;

// Measured, not assumed: 101 coordinates returns
// "Parameter 'latitude' and 'longitude' must not exceed 100 coordinates."
const BATCH_SIZE = 100;

const ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
// 12 s between requests keeps ~500 locations/minute, under the observed ~600 ceiling.
// 42 batches then take ~8 minutes, and each is cached, so an interrupted run resumes.
const REQUEST_GAP_MS = 12000;
const MAX_RETRIES = 6;
const MAX_BACKOFF_MS = 120000;

// Sanity bounds for a river valley from the North Sea to Prague. Anything outside
// means the sampling walked off the route.
const MIN_PLAUSIBLE_M = -10;
const MAX_PLAUSIBLE_M = 400;

// Endpoint expectations, and how far off they may be before the build fails.
const ENDPOINT_CHECKS = [
  { name: 'origin', atKm: 0, expectM: 3 },
  { name: 'destination', atKm: null, expectM: 184 }, // null => the route's end
];
const ENDPOINT_TOLERANCE_M = 20;

const REFRESH = process.argv.includes('--refresh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cachePath(routeId, batchIndex) {
  return join(tmpdir(), `elberadweg-elevation.${routeId}.${batchIndex}.json`);
}

/** POST-free GET with retry + backoff; returns the elevation array for one batch. */
async function fetchBatch(points, routeId, batchIndex) {
  const path = cachePath(routeId, batchIndex);
  if (!REFRESH && existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  const latitude = points.map(([, lat]) => lat.toFixed(5)).join(',');
  const longitude = points.map(([lng]) => lng.toFixed(5)).join(',');
  const url = `${ENDPOINT}?latitude=${latitude}&longitude=${longitude}`;

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'elberadweg-day-planner/1.0 (build-elevation script)' },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      if (json.error) throw new Error(json.reason || 'API reported an error');
      if (!Array.isArray(json.elevation)) throw new Error('response has no elevation[]');
      if (json.elevation.length !== points.length) {
        throw new Error(`asked for ${points.length} elevations, got ${json.elevation.length}`);
      }
      writeFileSync(path, JSON.stringify(json.elevation));
      return json.elevation;
    } catch (err) {
      lastErr = err;
      // Start the backoff high: a 429 here means a per-minute location budget was
      // exhausted, and that clears on the order of a minute, not a second.
      const wait = Math.min(MAX_BACKOFF_MS, 15000 * 2 ** attempt);
      console.warn(
        `[fetch] batch ${batchIndex}: ${err.message}; waiting ${Math.round(wait / 1000)}s ` +
          `(attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(wait);
    }
  }
  throw new Error(`batch ${batchIndex} failed after ${MAX_RETRIES} attempts: ${lastErr?.message}`);
}

function validate(elevationsM, totalKm, expectedCount) {
  console.log('\n===== ELEVATION VALIDATION =====');
  console.log(`Samples: ${elevationsM.length} (expected ${expectedCount})`);
  if (elevationsM.length !== expectedCount) {
    throw new Error(`sample count ${elevationsM.length} != expected ${expectedCount}`);
  }

  const bad = elevationsM.findIndex((m) => !Number.isFinite(m));
  if (bad >= 0) {
    throw new Error(`sample ${bad} (km ${((bad * ELEVATION_SPACING_M) / 1000).toFixed(1)}) is not a number`);
  }

  const minM = Math.min(...elevationsM);
  const maxM = Math.max(...elevationsM);
  console.log(`Range: ${minM} m … ${maxM} m over ${totalKm.toFixed(1)} km`);
  if (minM < MIN_PLAUSIBLE_M || maxM > MAX_PLAUSIBLE_M) {
    throw new Error(
      `range ${minM}…${maxM} m is outside the plausible ${MIN_PLAUSIBLE_M}…${MAX_PLAUSIBLE_M} m ` +
        `for this corridor — the sampling has probably walked off the route`,
    );
  }

  for (const check of ENDPOINT_CHECKS) {
    const index = check.atKm === null ? elevationsM.length - 1 : Math.round((check.atKm * 1000) / ELEVATION_SPACING_M);
    const got = elevationsM[index];
    const off = Math.abs(got - check.expectM);
    console.log(`${check.name}: ${got} m (expected ~${check.expectM} m, off by ${off})`);
    if (off > ENDPOINT_TOLERANCE_M) {
      throw new Error(
        `${check.name} elevation ${got} m is ${off} m from the expected ${check.expectM} m ` +
          `(tolerance ${ENDPOINT_TOLERANCE_M}) — wrong route, or the samples are misaligned`,
      );
    }
  }

  // Descriptive only: how much climbing the profile implies at a 5 m threshold. Not
  // asserted, because it is exactly the figure that is sampling-dependent — printed
  // so a wild change between builds is visible.
  let ascent = 0;
  let reference = elevationsM[0];
  for (const m of elevationsM) {
    const d = m - reference;
    if (Math.abs(d) >= 5) {
      if (d > 0) ascent += d;
      reference = m;
    }
  }
  console.log(`Implied total ascent at a 5 m threshold: ~${Math.round(ascent)} m (descriptive only)`);
  console.log('================================\n');

  return { minM, maxM };
}

async function main() {
  if (!existsSync(ROUTE_JSON) || !existsSync(ROUTE_META_JSON)) {
    throw new Error('route.json / route.meta.json missing — run `npm run build:data` first');
  }
  const route = JSON.parse(readFileSync(ROUTE_JSON, 'utf8'));
  const meta = JSON.parse(readFileSync(ROUTE_META_JSON, 'utf8'));
  const routeId = meta.routeId;
  if (!routeId) throw new Error('route.meta.json has no routeId');

  const totalKm = turf.length(route, { units: 'kilometers' });
  const stepKm = ELEVATION_SPACING_M / 1000;
  const count = Math.floor(totalKm / stepKm) + 1;
  console.log(
    `Elevation pipeline — ${routeId}, ${totalKm.toFixed(2)} km, ` +
      `${count} samples every ${ELEVATION_SPACING_M} m, refresh=${REFRESH}`,
  );

  // Sample positions first, so a fetch failure never leaves a half-sampled route.
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push(turf.along(route, i * stepKm, { units: 'kilometers' }).geometry.coordinates);
  }
  console.log(`[sample] ${points.length} positions`);

  const elevationsM = [];
  const batches = Math.ceil(points.length / BATCH_SIZE);
  for (let b = 0; b < batches; b++) {
    const slice = points.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
    const fromCache = !REFRESH && existsSync(cachePath(routeId, b));
    const values = await fetchBatch(slice, routeId, b);
    // Integers: the DEM's vertical accuracy does not support decimals, and 10k
    // integers is a third of the JSON that 10k floats would be.
    for (const v of values) elevationsM.push(Math.round(v));
    if ((b + 1) % 10 === 0 || b === batches - 1) {
      console.log(`[fetch] ${b + 1}/${batches} batches (${elevationsM.length} samples)`);
    }
    if (!fromCache && b < batches - 1) await sleep(REQUEST_GAP_MS);
  }

  const { minM, maxM } = validate(elevationsM, totalKm, count);

  const payload = {
    routeId,
    spacingM: ELEVATION_SPACING_M,
    count: elevationsM.length,
    minM,
    maxM,
    source: 'Open-Meteo elevation API (Copernicus DEM GLO-90)',
    builtAt: new Date().toISOString(),
    elevationsM,
  };
  writeFileSync(ELEVATION_JSON, JSON.stringify(payload));
  console.log(`[write] ${ELEVATION_JSON} (${elevationsM.length} samples)`);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nELEVATION BUILD FAILED:', err.message);
  process.exit(1);
});
