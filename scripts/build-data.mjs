#!/usr/bin/env node
/**
 * build-data.mjs — Build-time data pipeline for the Elberadweg Day Planner.
 *
 * Produces:
 *   src/data/route.json       — Feature<LineString>, Cuxhaven -> Prague, [lng,lat]
 *   src/data/route.meta.json  — metadata about the built route
 *   src/data/towns.json       — towns near the route, sorted by distance along it
 *   src/data/pois.json        — food stops & sights near the route
 *
 * THREE sources, because no single one spans the corridor:
 *   - Elberadweg LEFT bank: elberadweg.de's official GPX, the 15 lettered sections
 *     A–O of "[Abschnitt X links]". Cuxhaven -> the Czech border, 827 km.
 *   - Elberadweg RIGHT bank: the same 15 sections, "rechts". Brunsbüttel -> the
 *     border, 799 km. The official right bank does not run to Cuxhaven, which is
 *     why the canonical line takes the LEFT bank down to the Hamburg hand-over.
 *   - EuroVelo 7, Czech part (OSM 2775754): the border -> Prague, Elbe and Vltava in
 *     one relation, so there is no junction to invent at Mělník. The official site
 *     publishes no bank variants past the border, so this source stays on OSM.
 *
 * The canonical line — the single km axis every stored km in the app refers to — is
 * the left bank down to the Hamburg hand-over, the right bank on to the border, then
 * the Czech line to Prague, concatenated by joinSegments() across two declared joins.
 *
 * Interior trim points are DERIVED by findJunction(), because guessing a coordinate
 * for the place two lines meet is guessing an answer the data already holds. The
 * Hamburg one is derived inside a DECLARED neighbourhood, though: the two banks run
 * the whole corridor in parallel and come within 50 m of each other in 33 places,
 * sharing an exact vertex at Magdeburg, so an unconstrained closest approach returns
 * Magdeburg and moves the bank change 350 km from where it was meant to be. WHICH
 * crossing the canonical line uses is a decision, so it is declared; only the
 * hand-over vertices are measured. Cuxhaven and Prague are anchored, having no
 * neighbouring line to derive them from.
 *
 * Both banks are simplified and rounded ONCE, before any junction is derived, so a
 * km measured anywhere on a bank is the km the canonical line reports for that same
 * place. That is what lets a later step slice the same banks for the alternate line
 * and the crossing table without the two km axes drifting apart.
 *
 * Run:  node scripts/build-data.mjs [--refresh]
 *   --refresh  force re-fetch of the GPX sections and of Overpass, instead of using
 *              the cached raw files.
 *
 * Overpass is flaky, so fetching uses retry + exponential backoff, honours
 * 429/Retry-After, falls back across mirrors, and caches the raw response per source
 * (so one source can be refreshed without re-fetching 40k elements). The GPX sections
 * are cached the same way, one file per section and side.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as turf from '@turf/turf';
import {
  haversineM,
  cumulativeAlongM,
  findJunction,
  joinSegments,
  doublingBackReport,
  chunkBboxes,
} from './lib/route-assembly.mjs';
import { parseGpxTracks } from './lib/gpx.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'src', 'data');
const rawCachePath = (key) => join(DATA_DIR, `route.raw.${key}.json`); // gitignored
// Place queries cache PER CHUNK (see fetchByChunks), so a run interrupted at chunk
// 7 of 11 resumes rather than re-fetching everything. Paths are built at the call
// site; nothing global to declare here.

const ROUTE_JSON = join(DATA_DIR, 'route.json');
const ROUTE_META_JSON = join(DATA_DIR, 'route.meta.json');
const TOWNS_JSON = join(DATA_DIR, 'towns.json');
const POIS_JSON = join(DATA_DIR, 'pois.json');

// The three sources, in route order.
//
// `kind` picks the fetcher: 'gpx-bank' pulls the 15 official sections for one side
// of the river, 'osm-relations' queries Overpass for a relation list.
//
// `trimStart`/`trimEnd` name how each end is decided: 'junction' means derived from
// the neighbouring source, an ANCHORS key means a fixed coordinate.
//
// `orientTowards` names what turns the stitched line into route order: an ANCHORS
// key, or another source's 'start'/'end'. Resolved in route order, so a source can
// only orient against one already oriented.
const SOURCES = [
  {
    key: 'left',
    kind: 'gpx-bank',
    side: 'links',
    bank: 'left',
    source: 'official-gpx-left',
    from: 'Cuxhaven',
    to: 'Hamburg',
    trimStart: 'CUXHAVEN',
    trimEnd: 'junction',
    orientTowards: 'CUXHAVEN',
  },
  {
    key: 'right',
    kind: 'gpx-bank',
    side: 'rechts',
    bank: 'right',
    source: 'official-gpx-right',
    from: 'Hamburg',
    to: 'Schmilka',
    trimStart: 'junction',
    trimEnd: 'junction',
    // NOT the left bank's end: both banks now run the whole way to the border, so
    // that end is the border and aiming this one at it would reverse it. The banks
    // run the same way, so the left bank's START is the reference.
    orientTowards: { source: 'left', at: 'start' },
  },
  {
    key: 'cz',
    kind: 'osm-relations',
    bank: null,
    source: 'eurovelo-7-cz',
    from: 'Hřensko',
    to: 'Prague',
    // EV7's Czech part runs border -> Ústí -> Mělník -> Prague -> the Austrian
    // border as one flat way list. Its 128 km jump lies south of Prague, so the
    // Prague trim discards it.
    relations: [2775754],
    trimStart: 'junction',
    trimEnd: 'PRAGUE',
    orientTowards: { source: 'right', at: 'end' },
  },
];

// The two joins between sources, in the same order as the joins themselves.
//
// `searchNear`/`searchRadiusKm` confine the junction search (see findJunctionNear).
// Hamburg needs it and the border does not: the banks run parallel for 800 km, while
// the German and Czech lines approach each other only at the border.
//
// The Hamburg join is NOT the Finkenwerder–Teufelsbrück ferry the OSM build used.
// The official left-bank track rides that ferry itself and then continues along the
// north shore, so both banks share the promenade from Teufelsbrück to the
// Landungsbrücken and meet there with 15 m between them. The ceiling is set low
// because the seam is a shared path, not water — anything above a few hundred metres
// means the search landed somewhere it should not have.
//
// The border link is real water: 3.26 km, unchanged from the OSM build even though
// the German side of it is now a different line, and verified irreducible (no
// right-bank vertex anywhere gets closer to the Czech route's start).
const BRIDGES = [
  {
    name: 'Hamburg bank change (Landungsbrücken)',
    maxKm: 0.5,
    searchNear: [9.9686, 53.5457],
    searchRadiusKm: 12,
  },
  { name: 'Schmilka–Hřensko border link', maxKm: 4 },
];

// The official GPX downloads: 15 lettered sections per side, both sides complete.
const GPX_SECTIONS = 'ABCDEFGHIJKLMNO'.split('');
const GPX_RAW_DIR = join(DATA_DIR, 'gpx.raw'); // gitignored
const gpxUrl = (section, side) =>
  'https://www.elberadweg.de/gps/' +
  encodeURIComponent(`Elberadweg - Labská stezka [Abschnitt ${section} ${side}].gpx`);

// Outer trim anchors ([lng,lat]). Each is located to its nearest route vertex and
// fails the build past ANCHOR_MAX_OFFSET_KM.
const ANCHORS = {
  CUXHAVEN: [8.6839, 53.8917], // Kugelbake, the Elbe-mouth marker
  PRAGUE: [14.4114, 50.0865], // Charles Bridge
};
const ANCHOR_MAX_OFFSET_KM = 2;

// How far apart consecutive sources may be before the junction is not believable.
const JUNCTION_MAX_GAP_KM = 6;

// Monotonicity checkpoints ([lng,lat]) — must lie strictly in route order.
// Mělník precedes Prague because the Vltava leg runs upstream: they are ~59 km
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

// Route identity. Stable across rebuilds of the SAME corridor: storage resets
// stored plans when this changes and only when it changes, so a plain data refresh
// does not throw away a trip. (main.js separately banners on meta.builtAt.)
const ROUTE_ID = 'cuxhaven-prague-official-v2';
const ORIGIN_NAME = 'Cuxhaven';
const DESTINATION_NAME = 'Prague';

// Length bounds (km). The first official-GPX build measured 1000.40 km: 138.7 km of
// left bank down to the Hamburg hand-over, 687.3 km of right bank on to Schmilka,
// 171.1 km of EV7 to Prague, plus the 3.26 km border link.
//
// That is 26 km SHORTER than the 1026.5 km OSM composite it replaces — over this
// corridor the official routing is the shorter one, not the longer one. (End to end
// the banks measure 827 km and 799 km; the composite uses only the first 139 km of
// the left one, which is why the total resembles neither.)
//
// The nominal window is wide enough that a data refresh moving the route a few km
// does not cry wolf, and tight enough that a section going missing, or the Hamburg
// seam sliding to a different crossing, reads as more than a rounding change.
const LEN_HARD_MIN = 850;
const LEN_HARD_MAX = 1400;
const LEN_NOMINAL_MIN = 950;
const LEN_NOMINAL_MAX = 1075;

// Fail above this much doubling-back. A regression guard against a new stitching
// fault, not an investigation: the official banks measure 0.1%, against the 1.15%
// of the OSM composite they replace, so the headroom here is enormous.
const DOUBLING_BACK_MAX_PERCENT = 5;

// Hard gaps that survive INSIDE a trimmed segment get straight-bridged, which
// silently adds distance nobody can ride. There are currently none: the banks' own
// section joins are all well under GAP_SOFT and are checked as they are stitched,
// and the Czech relation's three hard gaps — including a 128 km jump — all sit
// outside the Prague trim. The five that the OSM German sources used to contribute
// (~5.8 km, mostly in the Hamburg harbour passage) left with those sources. So this
// budget now guards a measured zero, and catches the first gap to appear.
const INTERNAL_GAP_BUDGET_KM = 8;

// Place queries go out as per-chunk bounding boxes along the route.
//
// Two other shapes were tried and measured. ONE box for the whole corridor spans
// ~5.5° × 6.5° and contains Berlin, Hannover, Leipzig and Nuremberg's latitude
// band. An `around:` coordinate corridor — the obvious fix — Overpass would not
// serve: 515 coordinates at 2 km spacing returned HTTP 504 then a dropped
// connection, and 130 coordinates at 8 km spacing failed identically across two
// mirrors, for the SINGLE-clause towns query. Evaluating a union of hundreds of
// circles is expensive; a bounding box is what a spatial index is fast at.
const CHUNK_KM = 100;

// Padding must be at least the corridor half-width each filter keeps, or places
// that pass the filter were never in the query. Asserted below rather than trusted:
// getting it wrong loses places silently, in a band along the whole route, and
// nothing downstream would ever report it.
const TOWN_MAX_OFFSET_KM = 5;
const TOWN_PAD_KM = 6;
const POI_PAD_KM = 4;

function assertChunkPadding() {
  const checks = [
    { what: 'towns', padKm: TOWN_PAD_KM, needKm: TOWN_MAX_OFFSET_KM },
    { what: 'food', padKm: POI_PAD_KM, needKm: POI_MAX_OFFSET.food },
    { what: 'sights', padKm: POI_PAD_KM, needKm: POI_MAX_OFFSET.sight },
  ];
  for (const { what, padKm, needKm } of checks) {
    if (!(padKm >= needKm)) {
      throw new Error(
        `chunk padding for ${what} is ${padKm} km but the filter keeps ${needKm} km — ` +
          `the query would silently miss places along the whole route`,
      );
    }
    console.log(`[chunks] ${what}: pad ${padKm} km covers the ${needKm} km filter`);
  }
}

/**
 * Fetch one Overpass clause set across every chunk box, concatenating the elements.
 *
 * Chunk boxes overlap by their padding, so the same element arrives more than once;
 * dedupe by type+id before anything downstream counts or filters it.
 *
 * The cache is keyed by the BOX, not by the chunk's position in the list. Chunk 7 of
 * a rebuilt route covers different ground from chunk 7 of the old one, so an
 * index-keyed cache answers the new query with the old corridor's places — the towns
 * would be real, the km beside them would be measured on a line they were never
 * queried along, and nothing downstream could tell.
 */
async function fetchByChunks(boxes, buildQuery, label, cachePath) {
  const seen = new Set();
  const elements = [];
  for (const [i, box] of boxes.entries()) {
    const bbox =
      `${box.south.toFixed(4)},${box.west.toFixed(4)},` +
      `${box.north.toFixed(4)},${box.east.toFixed(4)}`;
    const osm = await fetchCached(
      buildQuery(bbox),
      cachePath(bbox),
      `${label} ${i + 1}/${boxes.length} (km ${box.startKm.toFixed(0)}–${box.endKm.toFixed(0)})`,
    );
    for (const el of osm.elements || []) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(el);
    }
  }
  console.log(`[fetch] ${label}: ${elements.length} unique elements across ${boxes.length} chunks`);
  return elements;
}

const SIMPLIFY_TOLERANCE = 0.00008;
const COORD_DECIMALS = 6;

// POI corridor half-widths (km off route) — food kept tighter than sights.
const POI_MAX_OFFSET = { food: 2, sight: 3 };
// Near-duplicate merge radius (metres) for POIs sharing a normalized name.
const POI_DEDUPE_M = 100;

// Fallback display labels for unnamed food POIs, keyed by category.
const FOOD_FALLBACK_LABEL = {
  cafe: 'Café',
  bakery: 'Bakery',
  restaurant: 'Restaurant',
  fast_food: 'Fast food',
  ice_cream: 'Ice cream',
  biergarten: 'Biergarten',
};

// Gap thresholds (metres) between the current route tail and the next way's start.
const GAP_JOIN = 1;      // < this => shared vertex, dedupe
const GAP_SILENT = 60;   // <= this => connect silently
const GAP_SOFT = 800;    // <= this => straight-bridge + warn; above => hard gap

// Overpass endpoints (primary first, then mirrors).
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const USER_AGENT =
  'elberadweg-day-planner/1.0 (build-data script; contact michel.merae@jobleads.com)';
const MAX_RETRIES = 4;

const REFRESH = process.argv.includes('--refresh');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const round = (n, d = COORD_DECIMALS) => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

// ---------------------------------------------------------------------------
// Overpass fetching (retry + backoff + mirror fallback + cache)
// ---------------------------------------------------------------------------

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

const backoffMs = (attempt) =>
  Math.min(30000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 1000);

/**
 * POST an Overpass QL query, trying each endpoint with retries. Returns parsed JSON.
 * Throws if every endpoint/attempt fails.
 */
async function overpassPost(query, label) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        console.log(`[fetch] ${label}: ${url} (attempt ${attempt + 1}/${MAX_RETRIES})`);
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: 'data=' + encodeURIComponent(query),
        });

        // Rate-limited / gateway busy — wait and retry the same endpoint.
        if ([429, 502, 503, 504].includes(res.status)) {
          lastErr = new Error(`HTTP ${res.status} from ${url}`);
          const wait = parseRetryAfter(res.headers.get('retry-after')) ?? backoffMs(attempt);
          console.warn(`[fetch] ${url} -> HTTP ${res.status}; waiting ${Math.round(wait)}ms`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

        const text = await res.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`non-JSON response (${text.slice(0, 120)}…)`);
        }
        if (!json.elements || !Array.isArray(json.elements)) {
          throw new Error('response missing elements[]');
        }
        console.log(`[fetch] ${label}: got ${json.elements.length} elements`);
        return json;
      } catch (err) {
        lastErr = err;
        const wait = backoffMs(attempt);
        console.warn(`[fetch] ${url} error: ${err.message}; waiting ${Math.round(wait)}ms`);
        await sleep(wait);
      }
    }
    console.warn(`[fetch] giving up on ${url}, trying next mirror…`);
  }
  throw new Error(`All Overpass endpoints failed for ${label}: ${lastErr?.message}`);
}

/** Fetch (or load from cache) the raw OSM JSON for the given query. */
async function fetchCached(query, cachePath, label) {
  if (!REFRESH && existsSync(cachePath)) {
    console.log(`[cache] ${label}: reusing ${cachePath}`);
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }
  const json = await overpassPost(query, label);
  writeFileSync(cachePath, JSON.stringify(json));
  console.log(`[cache] ${label}: wrote ${cachePath}`);
  return json;
}

// ---------------------------------------------------------------------------
// Official GPX fetching (retry + backoff + cache)
// ---------------------------------------------------------------------------

/**
 * Fetch (or load from cache) one section file of one bank.
 *
 * A failed request is never cached: an error page written to `A-links.gpx` would be
 * reused on every later run and the section would be silently missing from the bank,
 * so the body is checked for track points before it is kept.
 */
async function fetchGpxCached(section, side) {
  mkdirSync(GPX_RAW_DIR, { recursive: true });
  const file = join(GPX_RAW_DIR, `${section}-${side}.gpx`);
  if (!REFRESH && existsSync(file)) return readFileSync(file, 'utf8');

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(gpxUrl(section, side), { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      if (!text.includes('<trkpt')) {
        throw new Error(`response carries no track points (${text.slice(0, 80)}…)`);
      }
      writeFileSync(file, text);
      console.log(`[gpx] ${section} ${side}: fetched ${text.length} bytes`);
      return text;
    } catch (err) {
      lastErr = err;
      const wait = backoffMs(attempt);
      console.warn(`[gpx] ${section} ${side}: ${err.message}; waiting ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`GPX ${section} ${side}: ${lastErr.message}`);
}

/**
 * Stitch one bank from its 15 section files, end to end.
 *
 * Every join is measured, whether it is a section boundary or a <trkseg> pause inside
 * one file, because both are places the line can jump without saying so. Measured on
 * the current files: no file contains more than one <trkseg>, and the worst section
 * boundary is 203 m (links G) — well inside GAP_SOFT, so nothing here is bridging
 * distance worth reporting. The guard is what keeps that true.
 *
 * Each piece is reversed when its far end sits nearer the running line. Both banks
 * currently arrive already ordered Cuxhaven -> border, so this never fires; it is
 * cheap insurance against a section being republished the other way round.
 */
async function assembleBank(side) {
  let coords = [];
  const joins = [];

  for (const section of GPX_SECTIONS) {
    const pieces = parseGpxTracks(await fetchGpxCached(section, side));
    pieces.forEach((piece, pieceIndex) => {
      let next = piece;
      if (coords.length) {
        const tail = coords[coords.length - 1];
        const gapFwd = haversineM(tail, next[0]);
        const gapRev = haversineM(tail, next[next.length - 1]);
        if (gapRev < gapFwd) {
          console.log(`[gpx] ${side} ${section}: piece ${pieceIndex} reversed`);
          next = next.slice().reverse();
        }
        joins.push({
          where: pieceIndex === 0 ? section : `${section}#${pieceIndex}`,
          gapM: Math.min(gapFwd, gapRev),
        });
      }
      coords = coords.concat(next);
    });
  }

  const hard = joins.filter((j) => j.gapM > GAP_SOFT);
  if (hard.length) {
    throw new Error(
      `bank ${side}: hard joins ${hard.map((j) => `${j.where}:${Math.round(j.gapM)}m`).join(', ')} ` +
        `— the sections do not meet, so the bank would be bridged across open ground`,
    );
  }
  return { coords, joins };
}

// ---------------------------------------------------------------------------
// Raw OSM -> indexed maps
// ---------------------------------------------------------------------------

/**
 * Index raw OSM elements into lookup maps.
 * @returns {{nodes: Map<number,[number,number]>, ways: Map<number,number[]>,
 *            relations: Map<number,object>}}
 */
function indexOsm(osm) {
  const nodes = new Map(); // id -> [lng,lat]
  const ways = new Map(); // id -> [nodeId, …]
  const relations = new Map(); // id -> relation element (with members[])
  for (const el of osm.elements) {
    if (el.type === 'node') {
      nodes.set(el.id, [el.lon, el.lat]);
    } else if (el.type === 'way') {
      ways.set(el.id, el.nodes || []);
    } else if (el.type === 'relation') {
      relations.set(el.id, el);
    }
  }
  return { nodes, ways, relations };
}

/** Resolve a way id to its ordered coordinate list [[lng,lat], …]. */
function wayCoords(wayId, ways, nodes) {
  const refs = ways.get(wayId);
  if (!refs) return null;
  const coords = [];
  for (const ref of refs) {
    const c = nodes.get(ref);
    if (c) coords.push(c);
  }
  return coords.length >= 2 ? coords : null;
}

// ---------------------------------------------------------------------------
// Stitching
// ---------------------------------------------------------------------------

/**
 * Flatten a source's stage relations into an ordered list of ways, preserving
 * relation-member order and dropping members with role "backward".
 * @returns {{stageId:number, wayId:number}[]}
 */
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
      // Drop parallel/variant members that are not part of the forward through-line:
      //  - "backward": the reverse-direction carriageway of a split way
      //  - "alternative": an alternate routing variant (caused a spurious ~8.6 km
      //    jump in stage 2599018 when included)
      if (m.role === 'backward' || m.role === 'alternative') continue;
      list.push({ stageId: relId, wayId: m.ref });
    }
  }
  return list;
}

/**
 * Stitch the ordered ways into a single coordinate array.
 *
 * Gaps are recorded WITH the vertex index they occur at, not just counted: a gap
 * that a later trim discards is harmless, and one that survives inside the kept
 * range silently adds straight-line distance nobody can ride. Only the index makes
 * those two distinguishable.
 *
 * @returns {{coords:number[][], softGaps:number, hardGaps:number,
 *            gaps:Array<{gapM:number, index:number, stageId:number, wayId:number}>}}
 */
function stitch(orderedWays, ways, nodes) {
  const route = [];
  const gaps = [];
  let softGaps = 0;
  let hardGaps = 0;
  let missing = 0;

  // Pre-resolve coords so we can look ahead for the first way's orientation.
  const resolved = orderedWays
    .map((w) => ({ ...w, coords: wayCoords(w.wayId, ways, nodes) }))
    .filter((w) => {
      if (!w.coords) {
        missing++;
        console.warn(`[stitch] WARNING: way ${w.wayId} (stage ${w.stageId}) has no coords`);
        return false;
      }
      return true;
    });

  for (let i = 0; i < resolved.length; i++) {
    const { stageId, wayId } = resolved[i];
    let coords = resolved[i].coords;

    if (route.length === 0) {
      // First way: orient it so its far end points toward the next way, so the
      // route grows in the correct direction from the very start.
      const next = resolved[i + 1]?.coords;
      if (next) {
        const start = coords[0];
        const end = coords[coords.length - 1];
        const nStart = next[0];
        const nEnd = next[next.length - 1];
        const dEnd = Math.min(haversineM(end, nStart), haversineM(end, nEnd));
        const dStart = Math.min(haversineM(start, nStart), haversineM(start, nEnd));
        if (dStart < dEnd) coords = coords.slice().reverse();
      }
      route.push(...coords);
      continue;
    }

    const tail = route[route.length - 1];
    const start = coords[0];
    const end = coords[coords.length - 1];

    // Orient: connect the nearer endpoint to the current tail.
    if (haversineM(tail, end) < haversineM(tail, start)) {
      coords = coords.slice().reverse();
    }

    const gap = haversineM(tail, coords[0]);
    let toAppend;
    if (gap < GAP_JOIN) {
      toAppend = coords.slice(1); // shared join vertex — dedupe
    } else if (gap <= GAP_SILENT) {
      toAppend = coords; // small connector, connect silently
    } else if (gap <= GAP_SOFT) {
      softGaps++;
      gaps.push({ gapM: gap, index: route.length, stageId, wayId });
      toAppend = coords;
    } else {
      hardGaps++;
      gaps.push({ gapM: gap, index: route.length, stageId, wayId });
      console.warn(
        `[stitch] ‼ HARD GAP ${gap.toFixed(0)}m before way ${wayId} (stage ${stageId}) — straight-bridging`
      );
      toAppend = coords;
    }
    route.push(...toAppend);
  }

  if (missing) console.warn(`[stitch] ${missing} way(s) skipped for missing coords`);
  return { coords: route, softGaps, hardGaps, gaps };
}

// ---------------------------------------------------------------------------
// Trim / simplify / round
// ---------------------------------------------------------------------------

/** Round a coordinate array in place of a feature, so segments can be handled as arrays. */
function roundCoordArray(coords) {
  return coords.map(([lng, lat]) => [round(lng), round(lat)]);
}

/**
 * Simplify and round a coordinate array into its committed shape.
 *
 * Whatever comes out of here is what gets written, so it is also what every km in
 * the pipeline is measured on. Note that a simplified line has legitimately long
 * straight segments — a dead-straight dyke path can run kilometres between two kept
 * vertices — so vertex spacing after this point says nothing about gaps in the
 * source. Gaps are detected before simplification, or not at all.
 */
function simplifyAndRound(coords) {
  const line = turf.lineString(coords);
  turf.simplify(line, { tolerance: SIMPLIFY_TOLERANCE, highQuality: true, mutate: true });
  return roundCoordArray(line.geometry.coordinates);
}

/**
 * findJunction, optionally confined to a declared neighbourhood.
 *
 * Where two sources END near each other, their closest approach IS the junction and
 * needs no hint. The two banks are not like that: they run the whole corridor in
 * parallel and touch wherever the official routes share a crossing — measured, 33
 * places within 50 m, including an exact shared vertex at Magdeburg. Unconstrained,
 * the search returns Magdeburg, and the canonical line changes banks 350 km from
 * where it was meant to, at a length that still looks entirely plausible.
 *
 * So the neighbourhood is declared and the hand-over is still measured: the search
 * is told which crossing to use, not where the two lines meet inside it. The subsets
 * are only a window — every index and distance returned refers to the whole source.
 */
function findJunctionNear(coordsA, coordsB, { searchNear, searchRadiusKm }, opts) {
  if (!searchNear) return findJunction(coordsA, coordsB, opts);

  const near = (coords) => {
    const indexes = [];
    for (let i = 0; i < coords.length; i++) {
      if (haversineM(coords[i], searchNear) <= searchRadiusKm * 1000) indexes.push(i);
    }
    return indexes;
  };
  const indexesA = near(coordsA);
  const indexesB = near(coordsB);
  if (!indexesA.length || !indexesB.length) {
    throw new Error(
      `${opts.name}: the ${searchRadiusKm} km neighbourhood of [${searchNear}] contains no ` +
        `vertices of the ${indexesA.length ? 'second' : 'first'} line — the declared crossing ` +
        `is not on the route`,
    );
  }

  const found = findJunction(
    indexesA.map((i) => coordsA[i]),
    indexesB.map((i) => coordsB[i]),
    opts,
  );
  const indexA = indexesA[found.indexA];
  const indexB = indexesB[found.indexB];
  return {
    ...found,
    indexA,
    indexB,
    alongKmA: cumulativeAlongM(coordsA)[indexA] / 1000,
    alongKmB: cumulativeAlongM(coordsB)[indexB] / 1000,
    pointA: coordsA[indexA],
    pointB: coordsB[indexB],
  };
}

/**
 * Locate an outer anchor's nearest vertex, with a maximum-offset guard.
 *
 * Vertex-based rather than perpendicular, so every trim point in this pipeline is
 * an index into the stitched coordinates and the segments concatenate without any
 * invented geometry. The guard matters: the first Cuxhaven anchor was 2.3 km out in
 * longitude, and without a check a wrong coordinate trims somewhere else entirely
 * while still reporting a plausible length.
 */
function anchorIndex(coords, key) {
  const found = findJunction(coords, [ANCHORS[key]], {
    maxGapKm: ANCHOR_MAX_OFFSET_KM,
    name: `${key} anchor`,
  });
  return { index: found.indexA, offsetKm: found.gapM / 1000, alongKm: found.alongKmA };
}

/**
 * Orient a stitched line so it runs in route order (start nearest `towards`).
 *
 * Relation member order gives no guarantee of direction, and the first-way
 * orientation heuristic in stitch() only aligns the line with itself. The GPX banks
 * arrive in route order today, but nothing in the format promises they will.
 */
function orient(coords, towards, label) {
  if (haversineM(coords[coords.length - 1], towards) < haversineM(coords[0], towards)) {
    console.log(`[orient] ${label}: reversed`);
    return coords.slice().reverse();
  }
  return coords;
}

/**
 * Resolve a source's `orientTowards` declaration to a [lng,lat] to point its start at.
 *
 * A source may only be oriented against an EARLIER one, whose own direction is
 * already settled — otherwise the reference itself could be back to front, and the
 * error would be a route silently assembled in the wrong order.
 */
function orientTarget(spec, index, specs, stitched) {
  if (typeof spec.orientTowards === 'string') return ANCHORS[spec.orientTowards];

  const { source, at } = spec.orientTowards;
  const targetIndex = specs.findIndex((s) => s.key === source);
  if (targetIndex < 0 || targetIndex >= index) {
    throw new Error(
      `${spec.key}: orientTowards names "${source}", which is not an earlier source — ` +
        `its direction is not settled yet, so it cannot be used as a reference`,
    );
  }
  const { coords } = stitched[targetIndex];
  return at === 'start' ? coords[0] : coords[coords.length - 1];
}

// ---------------------------------------------------------------------------
// Per-source build
// ---------------------------------------------------------------------------

/**
 * Fetch and stitch one source into an untrimmed coordinate array.
 *
 * `prepared` says whether the coordinates are already in their committed shape.
 * Banks are: they are simplified here, before their junction is derived, so that the
 * indices the junction hands back point into the exact geometry that gets written,
 * and a km measured on a whole bank matches the km the canonical line reports for
 * the same place. The OSM source is not: it carries gap records that index into its
 * stitched coordinates, so it keeps being simplified after it is trimmed.
 */
async function stitchSource(spec) {
  if (spec.kind === 'gpx-bank') return stitchBankSource(spec);
  return stitchRelationSource(spec);
}

/** Fetch, stitch, simplify and round one official bank. */
async function stitchBankSource(spec) {
  const { coords, joins } = await assembleBank(spec.side);
  const cleaned = turf.cleanCoords(turf.lineString(coords)).geometry.coordinates;
  const prepared = simplifyAndRound(cleaned);

  const worst = joins.reduce((a, b) => (b.gapM > a.gapM ? b : a), { where: '—', gapM: 0 });
  const joinKm = joins.reduce((sum, j) => sum + j.gapM, 0) / 1000;
  console.log(
    `[stitch] ${spec.key}: ${GPX_SECTIONS.length} sections -> ${coords.length} points -> ` +
      `${prepared.length} simplified, ` +
      `${turf.length(turf.lineString(prepared), { units: 'kilometers' }).toFixed(1)} km, ` +
      `${joins.length} joins totalling ${(joinKm * 1000).toFixed(0)} m (worst ${worst.where} ` +
      `${worst.gapM.toFixed(0)} m)`,
  );

  // No gap records: every join above is under GAP_SOFT, and after simplification a
  // long straight segment is the shape of the path, not a hole in it.
  return { coords: prepared, gaps: [], prepared: true };
}

/** Fetch and stitch one OSM relation source into an untrimmed coordinate array. */
async function stitchRelationSource(spec) {
  const query =
    `[out:json][timeout:300]; ` +
    `rel(id:${spec.relations.join(',')}); ` +
    `out body; >; out skel qt;`;
  const rawOsm = await fetchCached(query, rawCachePath(spec.key), `route/${spec.key}`);

  const { nodes, ways, relations } = indexOsm(rawOsm);
  console.log(
    `[index] ${spec.key}: ${nodes.size} nodes, ${ways.size} ways, ${relations.size} relations`,
  );

  const orderedWays = orderedWayList(relations, spec.relations);
  const { coords, softGaps, hardGaps, gaps } = stitch(orderedWays, ways, nodes);

  // cleanCoords on the array, not a feature, so index bookkeeping stays ours.
  const cleaned = turf.cleanCoords(turf.lineString(coords)).geometry.coordinates;
  console.log(
    `[stitch] ${spec.key}: ${orderedWays.length} ways -> ${cleaned.length} points, ` +
      `${turf.length(turf.lineString(cleaned), { units: 'kilometers' }).toFixed(1)} km, ` +
      `gaps ${softGaps} soft / ${hardGaps} hard`,
  );

  // cleanCoords can drop duplicate vertices, which shifts the gap indices stitch()
  // recorded. Re-derive them by position rather than trusting the old index: each
  // gap's far side is a coordinate, and that coordinate is still in the line.
  const positionOf = new Map(cleaned.map(([lng, lat], i) => [`${lng},${lat}`, i]));
  const rebased = gaps
    .map((g) => {
      const far = coords[g.index];
      const index = far ? positionOf.get(`${far[0]},${far[1]}`) : undefined;
      return index === undefined ? null : { ...g, index };
    })
    .filter(Boolean);

  return { coords: cleaned, softGaps, hardGaps, gaps: rebased };
}

/**
 * Decide both trim points for every source, then cut — simplifying any source not
 * already in its committed shape.
 *
 * Interior trims come from findJunction against the neighbouring source; outer trims
 * come from an anchor. Either way what leaves here is final geometry, so the km
 * joinSegments measures are exactly the km of the written file. The banks reach that
 * shape before their junction is derived and the OSM source reaches it here — see
 * stitchSource for why the two differ.
 */
function trimSources(specs, stitched) {
  // Junction i sits between source i and source i+1, and is the same join as
  // BRIDGES[i] — which is where its search neighbourhood, if it needs one, is declared.
  const junctions = [];
  for (let i = 0; i + 1 < specs.length; i++) {
    const found = findJunctionNear(stitched[i].coords, stitched[i + 1].coords, BRIDGES[i], {
      maxGapKm: JUNCTION_MAX_GAP_KM,
      name: `${specs[i].key}→${specs[i + 1].key} junction`,
    });
    console.log(
      `[junction] ${specs[i].key}→${specs[i + 1].key}: ${found.gapM.toFixed(0)} m — ` +
        `${specs[i].key} km ${found.alongKmA.toFixed(1)} [${found.pointA.map((n) => n.toFixed(4))}] -> ` +
        `${specs[i + 1].key} km ${found.alongKmB.toFixed(1)} [${found.pointB.map((n) => n.toFixed(4))}]`,
    );
    junctions.push(found);
  }

  return specs.map((spec, i) => {
    const { coords, gaps, prepared } = stitched[i];

    let startIndex;
    if (spec.trimStart === 'junction') {
      startIndex = junctions[i - 1].indexB;
    } else {
      const a = anchorIndex(coords, spec.trimStart);
      console.log(
        `[trim] ${spec.key}: ${spec.trimStart} offset ${a.offsetKm.toFixed(2)} km @ km ${a.alongKm.toFixed(1)}`,
      );
      startIndex = a.index;
    }

    let endIndex;
    if (spec.trimEnd === 'junction') {
      endIndex = junctions[i].indexA;
    } else {
      const a = anchorIndex(coords, spec.trimEnd);
      console.log(
        `[trim] ${spec.key}: ${spec.trimEnd} offset ${a.offsetKm.toFixed(2)} km @ km ${a.alongKm.toFixed(1)}`,
      );
      endIndex = a.index;
    }

    if (endIndex <= startIndex) {
      throw new Error(
        `${spec.key}: trim end (index ${endIndex}) is not after trim start (index ${startIndex}) — ` +
          `the source is oriented backwards or the junctions are in the wrong order`,
      );
    }

    const kept = coords.slice(startIndex, endIndex + 1);

    // Hard gaps inside the kept range get straight-bridged and add distance nobody
    // can ride; ones outside it are discarded harmlessly. Count only the survivors.
    const survivingGaps = gaps.filter(
      (g) => g.gapM > GAP_SOFT && g.index > startIndex && g.index <= endIndex,
    );

    // A prepared source was simplified before its junction was derived, so these
    // indices already point into the committed geometry; simplifying again here
    // would move the very shape the junction was measured on.
    const finalCoords = prepared ? kept : simplifyAndRound(kept);

    console.log(
      `[segment] ${spec.key}: ${finalCoords.length} points, ` +
        `${turf.length(turf.lineString(finalCoords), { units: 'kilometers' }).toFixed(2)} km ` +
        `(${spec.from} -> ${spec.to}), ${survivingGaps.length} hard gap(s) inside`,
    );

    return {
      name: spec.key,
      source: spec.source,
      from: spec.from,
      to: spec.to,
      bank: spec.bank,
      side: spec.side,
      relations: spec.relations,
      coords: finalCoords,
      survivingGaps,
    };
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the joined route and print the report that is this pipeline's real
 * acceptance gate. Throws on anything that would ship wrong distances.
 */
function validate(line, joined, segments) {
  const totalKm = turf.length(line, { units: 'kilometers' });
  console.log('\n===== VALIDATION REPORT =====');
  console.log(
    `Total length: ${totalKm.toFixed(2)} km (nominal ${LEN_NOMINAL_MIN}–${LEN_NOMINAL_MAX}, hard ${LEN_HARD_MIN}–${LEN_HARD_MAX})`,
  );

  // joinSegments measured these coordinates with haversine; turf measures the
  // written line. They must agree, or the km recorded in meta describe a different
  // line from the one in route.json.
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
      `  ${`${seg.name} · ${seg.from} -> ${seg.to}`.padEnd(44)}` +
        `km ${seg.startKm.toFixed(1).padStart(7)} – ${seg.endKm.toFixed(1).padStart(7)}` +
        `  (${(seg.endKm - seg.startKm).toFixed(1)} km)`,
    );
  }
  console.log('Bridges:');
  for (const bridge of joined.bridges) {
    console.log(
      `  ${bridge.name.padEnd(38)} @ km ${bridge.km.toFixed(1).padStart(7)}  ${(bridge.lengthKm * 1000).toFixed(0)} m`,
    );
  }

  // Hard gaps that survived trimming: straight-line distance inside a segment.
  const surviving = segments.flatMap((s) => s.survivingGaps.map((g) => ({ ...g, seg: s.name })));
  const survivingKm = surviving.reduce((sum, g) => sum + g.gapM / 1000, 0);
  console.log(
    `\nHard gaps inside segments: ${surviving.length}, totalling ${survivingKm.toFixed(2)} km ` +
      `(budget ${INTERNAL_GAP_BUDGET_KM} km)`,
  );
  for (const g of surviving) {
    console.log(`  ${g.seg}: ${g.gapM.toFixed(0)} m before way ${g.wayId} (stage ${g.stageId})`);
  }
  if (survivingKm > INTERNAL_GAP_BUDGET_KM) {
    throw new Error(
      `${survivingKm.toFixed(2)} km of straight-line bridging survives inside the segments ` +
        `(budget ${INTERNAL_GAP_BUDGET_KM} km) — a new stitching fault is adding distance nobody can ride`,
    );
  }

  // Monotonicity: checkpoint distances along the line must strictly increase.
  const locations = CHECKPOINTS.map((c) => {
    const snap = turf.nearestPointOnLine(line, turf.point(c.pt), { units: 'kilometers' });
    return { name: c.name, loc: snap.properties.location, off: snap.properties.dist };
  });
  console.log('\nMonotonicity checkpoints (km along route, offset km):');
  for (const l of locations) {
    console.log(`  ${l.name.padEnd(16)} @ ${l.loc.toFixed(1).padStart(7)} km (offset ${l.off.toFixed(2)} km)`);
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

// ---------------------------------------------------------------------------
// Towns
// ---------------------------------------------------------------------------

async function buildTowns(trimmed, boxes) {
  const elements = await fetchByChunks(
    boxes,
    (bbox) =>
      `[out:json][timeout:180];` +
      `( node["place"~"^(city|town|village)$"](${bbox}); );` +
      `out body;`,
    'towns',
    (bbox) => join(tmpdir(), `elberadweg-towns.${bbox.replace(/[,.-]/g, '_')}.json`),
  );

  const towns = [];
  for (const el of elements) {
    if (el.type !== 'node' || !el.tags?.name) continue;
    const snap = turf.nearestPointOnLine(trimmed, turf.point([el.lon, el.lat]), {
      units: 'kilometers',
    });
    const offsetKm = snap.properties.dist;
    if (offsetKm > TOWN_MAX_OFFSET_KM) continue;
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

// ---------------------------------------------------------------------------
// POIs (food stops & sights)
// ---------------------------------------------------------------------------

/**
 * Classify a raw OSM element's tags into a POI kind + category, or null if it
 * matches none of our clauses. Food is checked before sights; the first match
 * wins so each element gets exactly one {kind, category}.
 */
function classifyPoi(tags) {
  const foodAmenities = ['cafe', 'restaurant', 'fast_food', 'ice_cream', 'biergarten'];
  if (foodAmenities.includes(tags.amenity)) return { kind: 'food', category: tags.amenity };
  if (tags.shop === 'bakery') return { kind: 'food', category: 'bakery' };

  if (tags.tourism === 'viewpoint') return { kind: 'sight', category: 'viewpoint' };
  if (tags.natural === 'waterfall') return { kind: 'sight', category: 'waterfall' };
  const historic = ['castle', 'monument', 'ruins', 'fort', 'city_gate', 'tower'];
  if (historic.includes(tags.historic)) return { kind: 'sight', category: tags.historic };
  if (tags.man_made === 'lighthouse') return { kind: 'sight', category: 'lighthouse' };
  if (tags.man_made === 'tower' && tags['tower:type'] === 'observation') {
    return { kind: 'sight', category: 'tower' };
  }
  if (tags.man_made === 'bridge') return { kind: 'sight', category: 'bridge' };
  return null;
}

/** [lng,lat] for a POI element: nodes carry lat/lon, ways/relations carry center.* */
function poiCoord(el) {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') return [el.lon, el.lat];
  if (el.center && typeof el.center.lat === 'number' && typeof el.center.lon === 'number') {
    return [el.center.lon, el.center.lat];
  }
  return null;
}

/**
 * Resolve a display name for a classified POI, applying unnamed-entry rules:
 *  - food: kept with a capitalized category fallback ("Café", "Bakery", …)
 *  - unnamed viewpoints: kept as "Viewpoint"
 *  - all other unnamed sights: dropped (return null)
 */
function poiName(tags, kind, category) {
  const raw = tags.name;
  if (raw && raw.trim()) return raw.trim();
  if (kind === 'food') return FOOD_FALLBACK_LABEL[category] ?? 'Food';
  if (category === 'viewpoint') return 'Viewpoint';
  return null;
}

/**
 * Drop near-duplicate POIs: entries with the same normalized (lowercased,
 * trimmed) name lying within POI_DEDUPE_M of each other — e.g. a café tagged
 * both as a node and as its building outline — keeping the one closest to route.
 */
function dedupePois(pois) {
  const kept = [];
  const byName = new Map(); // normalized name -> indices into kept
  for (const p of pois) {
    const norm = p.name.toLowerCase().trim();
    const group = byName.get(norm);
    let duplicate = false;
    if (group) {
      for (const idx of group) {
        const q = kept[idx];
        if (haversineM([p.lng, p.lat], [q.lng, q.lat]) <= POI_DEDUPE_M) {
          duplicate = true;
          if (p.offsetKm < q.offsetKm) kept[idx] = p; // keep closest-to-route
          break;
        }
      }
    }
    if (!duplicate) {
      const idx = kept.length;
      kept.push(p);
      if (group) group.push(idx);
      else byName.set(norm, [idx]);
    }
  }
  return kept;
}

async function buildPois(trimmed, boxes) {
  const elements = await fetchByChunks(
    boxes,
    (b) =>
      `[out:json][timeout:180];` +
      `(` +
      `nwr["amenity"~"^(cafe|restaurant|fast_food|ice_cream|biergarten)$"](${b});` +
      `nwr["shop"="bakery"](${b});` +
      `nwr["tourism"="viewpoint"](${b});` +
      `nwr["natural"="waterfall"](${b});` +
      `nwr["historic"~"^(castle|monument|ruins|fort|city_gate|tower)$"](${b});` +
      `nwr["man_made"="lighthouse"](${b});` +
      `nwr["man_made"="tower"]["tower:type"="observation"](${b});` +
      `nwr["man_made"="bridge"]["name"](${b});` +
      `);` +
      `out center;`,
    'pois',
    (bbox) => join(tmpdir(), `elberadweg-pois.${bbox.replace(/[,.-]/g, '_')}.json`),
  );

  const pois = [];
  for (const el of elements) {
    const tags = el.tags;
    if (!tags) continue;
    const cls = classifyPoi(tags);
    if (!cls) continue;
    const coord = poiCoord(el);
    if (!coord) continue; // ways/relations without a resolvable center
    const name = poiName(tags, cls.kind, cls.category);
    if (!name) continue; // unnamed non-viewpoint sight — dropped

    const [lng, lat] = coord;
    const snap = turf.nearestPointOnLine(trimmed, turf.point([lng, lat]), {
      units: 'kilometers',
    });
    const offsetKm = snap.properties.dist;
    if (offsetKm > POI_MAX_OFFSET[cls.kind]) continue;

    const record = {
      name,
      kind: cls.kind,
      category: cls.category,
      lat: round(lat),
      lng: round(lng),
      routeDistanceKm: round(snap.properties.location, 1),
      offsetKm: round(offsetKm, 2),
    };
    if (tags.opening_hours) record.openingHours = tags.opening_hours;
    pois.push(record);
  }

  const deduped = dedupePois(pois);
  deduped.sort((a, b) => a.routeDistanceKm - b.routeDistanceKm);
  return deduped;
}

/** Print per-kind / per-category counts; throw if the dataset is empty. */
function validatePois(pois) {
  console.log('\n===== POI VALIDATION =====');
  console.log(`Total POIs: ${pois.length}`);

  const perKind = {};
  const perCategory = {};
  for (const p of pois) {
    perKind[p.kind] = (perKind[p.kind] || 0) + 1;
    const key = `${p.kind}/${p.category}`;
    perCategory[key] = (perCategory[key] || 0) + 1;
  }

  console.log('Per kind:');
  for (const [k, n] of Object.entries(perKind).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${k.padEnd(8)} ${n}`);
  }
  console.log('Per category:');
  for (const [c, n] of Object.entries(perCategory).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${c.padEnd(20)} ${n}`);
  }
  console.log('==========================\n');

  if (pois.length === 0) {
    throw new Error('POI dataset is empty — the Overpass query is likely broken.');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `Elberadweg data pipeline — ${ORIGIN_NAME} → ${DESTINATION_NAME} (${ROUTE_ID}), refresh=${REFRESH}`,
  );

  // 1. Fetch and stitch each source independently.
  const stitched = [];
  for (const spec of SOURCES) stitched.push(await stitchSource(spec));

  // 2. Orient each source in route order before junctions are derived: a reversed
  //    line would put its "closest approach" at the wrong end. Each source declares
  //    its own reference (see `orientTowards`), and they are resolved in route order
  //    so every reference is a line already turned the right way round.
  SOURCES.forEach((spec, i) => {
    const towards = orientTarget(spec, i, SOURCES, stitched);
    stitched[i].coords = orient(stitched[i].coords, towards, spec.key);
  });

  // 3. Derive the junctions, trim, simplify, round.
  const segments = trimSources(SOURCES, stitched);

  // 4. Join across the declared bridges.
  const joined = joinSegments(segments, { bridges: BRIDGES });
  const trimmed = turf.lineString(joined.coords);
  const pointCount = joined.coords.length;
  console.log(`\n[join] ${pointCount} points, ${joined.totalKm.toFixed(2)} km`);

  // 5. Validate.
  const { totalKm, doublingBackPercent } = validate(trimmed, joined, segments);
  console.log('=============================\n');

  // 6. Write route + meta.
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
      bank: seg.bank,
      // Whichever identifies the source: a GPX side, or the OSM relation list.
      side: seg.side,
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
  console.log(`[write] ${ROUTE_JSON}`);
  console.log(`[write] ${ROUTE_META_JSON}`);

  // 7. The chunk boxes both place queries are built on. Towns need a wider pad
  //    than POIs, so each gets its own set rather than sharing the wider one.
  assertChunkPadding();
  const coords = trimmed.geometry.coordinates;
  const townBoxes = chunkBboxes(coords, { chunkKm: CHUNK_KM, padKm: TOWN_PAD_KM });
  const poiBoxes = chunkBboxes(coords, { chunkKm: CHUNK_KM, padKm: POI_PAD_KM });
  console.log(`[chunks] ${townBoxes.length} boxes of ~${CHUNK_KM} km`);

  // 8. Towns.
  const towns = await buildTowns(trimmed, townBoxes);
  writeFileSync(TOWNS_JSON, JSON.stringify(towns, null, 2));
  console.log(`[write] ${TOWNS_JSON} (${towns.length} towns)`);

  // 9. POIs (food stops & sights).
  const pois = await buildPois(trimmed, poiBoxes);
  validatePois(pois);
  writeFileSync(POIS_JSON, JSON.stringify(pois, null, 2));
  console.log(`[write] ${POIS_JSON} (${pois.length} POIs)`);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nBUILD FAILED:', err.message);
  process.exit(1);
});
