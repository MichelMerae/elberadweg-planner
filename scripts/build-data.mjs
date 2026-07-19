#!/usr/bin/env node
/**
 * build-data.mjs — Build-time data pipeline for the Elberadweg Day Planner.
 *
 * Produces:
 *   src/data/route.json       — Feature<LineString>, Hamburg -> Dresden, [lng,lat]
 *   src/data/route.meta.json  — metadata about the built route
 *   src/data/towns.json       — array of towns near the route, sorted by distance along it
 *
 * Source: the Elberadweg OSM superroute, RIGHT bank (rechtselbisch, relation 22327).
 * We fetch the 12 consecutive stage relations that cover Hamburg -> Dresden, stitch
 * their ways into one ordered LineString (respecting relation-member order + roles),
 * trim to the Hamburg/Dresden anchors, simplify, validate, and write out.
 *
 * Run:  node scripts/build-data.mjs [--refresh]
 *   --refresh  force re-fetch from Overpass instead of using the cached raw OSM.
 *
 * Overpass is flaky, so fetching uses retry + exponential backoff, honours
 * 429/Retry-After, falls back across mirrors, and caches the raw response.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as turf from '@turf/turf';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'src', 'data');
const ROUTE_RAW_CACHE = join(DATA_DIR, 'route.raw.osm.json'); // gitignored
const TOWNS_RAW_CACHE = join(tmpdir(), 'elberadweg-towns.raw.osm.json'); // not committed
const POIS_RAW_CACHE = join(tmpdir(), 'elberadweg-pois.raw.osm.json'); // not committed

const ROUTE_JSON = join(DATA_DIR, 'route.json');
const ROUTE_META_JSON = join(DATA_DIR, 'route.meta.json');
const TOWNS_JSON = join(DATA_DIR, 'towns.json');
const POIS_JSON = join(DATA_DIR, 'pois.json');

// Elberadweg right-bank Hamburg -> Dresden stage relations, in north->south order.
// The first (2599011) starts north of Hamburg and the last (2599032) ends south of
// Dresden; both get trimmed to the anchors below.
const STAGE_RELATIONS = [
  2599011, // Wedel -> Kirchwerder (Hamburg is mid-stage)
  2599013, // Ochsenwerder -> Lauenburg
  2599015, // Lauenburg -> Hitzacker
  2599016, // -> Wittenberge
  2599018, // Wittenberge -> Havelberg
  2599020, // Havelberg -> Tangermünde
  2599024, // Tangermünde -> Magdeburg
  2599025, // Magdeburg -> Dessau-Roßlau
  2599026, // Dessau-Roßlau -> Elster
  7758087, // Elster -> Belgern
  2599030, // Belgern -> Meißen
  2599032, // Meißen -> Heidenau (Dresden is mid-stage)
];

const BANK = 'right';

// Trim anchors ([lng,lat]).
const HAMBURG = [9.9686, 53.5457];
const DRESDEN = [13.7373, 51.0504];

// Monotonicity checkpoints ([lng,lat]) — lie strictly north->south along the route.
const CHECKPOINTS = [
  { name: 'Wittenberge', pt: [11.75, 52.995] },
  { name: 'Magdeburg', pt: [11.629, 52.126] },
  { name: 'Meißen', pt: [13.472, 51.162] },
];

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

/** Great-circle distance in metres between two [lng,lat] points. */
function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

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
 * Flatten the 12 stage relations into an ordered list of ways, preserving
 * relation-member order and dropping members with role "backward".
 * @returns {{stageId:number, wayId:number}[]}
 */
function orderedWayList(relations) {
  const list = [];
  for (const relId of STAGE_RELATIONS) {
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
 * @returns {{coords:number[][], softGaps:number, hardGaps:number}}
 */
function stitch(orderedWays, ways, nodes) {
  const route = [];
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
      console.warn(
        `[stitch] soft gap ${gap.toFixed(0)}m before way ${wayId} (stage ${stageId}) — straight-bridging`
      );
      toAppend = coords;
    } else {
      hardGaps++;
      console.warn(
        `[stitch] ‼ HARD GAP ${gap.toFixed(0)}m before way ${wayId} (stage ${stageId}) — straight-bridging`
      );
      toAppend = coords;
    }
    route.push(...toAppend);
  }

  if (missing) console.warn(`[stitch] ${missing} way(s) skipped for missing coords`);
  return { coords: route, softGaps, hardGaps };
}

// ---------------------------------------------------------------------------
// Trim / simplify / round
// ---------------------------------------------------------------------------

function trimToAnchors(line) {
  const startSnap = turf.nearestPointOnLine(line, turf.point(HAMBURG), { units: 'kilometers' });
  const stopSnap = turf.nearestPointOnLine(line, turf.point(DRESDEN), { units: 'kilometers' });
  let trimmed = turf.lineSlice(startSnap, stopSnap, line);

  // Ensure Hamburg -> Dresden orientation regardless of lineSlice direction.
  const coords = trimmed.geometry.coordinates;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (haversineM(last, HAMBURG) < haversineM(first, HAMBURG)) {
    trimmed.geometry.coordinates = coords.slice().reverse();
    console.log('[trim] reversed slice to enforce Hamburg -> Dresden order');
  }
  return trimmed;
}

function roundCoords(feature) {
  feature.geometry.coordinates = feature.geometry.coordinates.map(([lng, lat]) => [
    round(lng),
    round(lat),
  ]);
  return feature;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Length bounds (km). NOTE: these deviate from the task brief's "expect 350–430,
// fail if >600". Empirically the right-bank (rechtselbisch) Elberadweg Hamburg→Dresden
// stitched from the 12 OSM stage relations is ~665–670 km. This was verified to be the
// genuine route length, not a stitching artifact: coarsening the raw line to ~200 m
// still measures ~648 km, and the sum of the 12 stage-endpoint chords alone is ~477 km
// — a hard lower bound that already exceeds 430 km, so the brief's range is
// geometrically impossible for this route. Bounds below are set to catch real
// regressions while accepting the true length. Monotonicity (below) remains the strict
// correctness guard.
const LEN_HARD_MIN = 450;
const LEN_HARD_MAX = 800;
const LEN_NOMINAL_MIN = 620;
const LEN_NOMINAL_MAX = 700;

function validate(trimmed) {
  const totalKm = turf.length(trimmed, { units: 'kilometers' });
  console.log('\n===== VALIDATION REPORT =====');
  console.log(`Total length: ${totalKm.toFixed(2)} km (expected ~${LEN_NOMINAL_MIN}–${LEN_NOMINAL_MAX} km for right bank; see note in source re: brief's 350–430)`);

  if (totalKm < LEN_HARD_MIN || totalKm > LEN_HARD_MAX) {
    throw new Error(
      `Total length ${totalKm.toFixed(1)} km is wildly out of range (${LEN_HARD_MIN}–${LEN_HARD_MAX}).`
    );
  }
  if (totalKm < LEN_NOMINAL_MIN || totalKm > LEN_NOMINAL_MAX) {
    console.warn(
      `[validate] length ${totalKm.toFixed(1)} km outside nominal ${LEN_NOMINAL_MIN}–${LEN_NOMINAL_MAX} (still within hard bounds)`
    );
  }

  // Monotonicity: checkpoint distances-along-line must strictly increase N->S.
  const locations = CHECKPOINTS.map((c) => {
    const snap = turf.nearestPointOnLine(trimmed, turf.point(c.pt), { units: 'kilometers' });
    return { name: c.name, loc: snap.properties.location, off: snap.properties.dist };
  });
  console.log('Monotonicity checkpoints (km along route, offset km):');
  for (const l of locations) {
    console.log(`  ${l.name.padEnd(12)} @ ${l.loc.toFixed(1)} km (offset ${l.off.toFixed(2)} km)`);
  }
  const strictlyIncreasing =
    locations[0].loc < locations[1].loc && locations[1].loc < locations[2].loc;
  console.log(`Monotonicity: ${strictlyIncreasing ? 'PASS (strictly increasing)' : 'FAIL'}`);
  if (!strictlyIncreasing) {
    throw new Error(
      `Monotonicity assertion failed: expected ${locations.map((l) => l.name).join(' < ')}, got ` +
        locations.map((l) => `${l.name}=${l.loc.toFixed(1)}`).join(', ')
    );
  }

  return { totalKm };
}

// ---------------------------------------------------------------------------
// Towns
// ---------------------------------------------------------------------------

async function buildTowns(trimmed) {
  const [minX, minY, maxX, maxY] = turf.bbox(trimmed);
  const pad = 0.1;
  const S = (minY - pad).toFixed(4);
  const W = (minX - pad).toFixed(4);
  const N = (maxY + pad).toFixed(4);
  const E = (maxX + pad).toFixed(4);

  const query =
    `[out:json][timeout:180];` +
    `( node["place"~"^(city|town|village)$"](${S},${W},${N},${E}); );` +
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

async function buildPois(trimmed) {
  const [minX, minY, maxX, maxY] = turf.bbox(trimmed);
  const pad = 0.1;
  const S = (minY - pad).toFixed(4);
  const W = (minX - pad).toFixed(4);
  const N = (maxY + pad).toFixed(4);
  const E = (maxX + pad).toFixed(4);

  const query =
    `[out:json][timeout:180];` +
    `(` +
    `nwr["amenity"~"^(cafe|restaurant|fast_food|ice_cream|biergarten)$"](${S},${W},${N},${E});` +
    `nwr["shop"="bakery"](${S},${W},${N},${E});` +
    `nwr["tourism"="viewpoint"](${S},${W},${N},${E});` +
    `nwr["natural"="waterfall"](${S},${W},${N},${E});` +
    `nwr["historic"~"^(castle|monument|ruins|fort|city_gate|tower)$"](${S},${W},${N},${E});` +
    `nwr["man_made"="lighthouse"](${S},${W},${N},${E});` +
    `nwr["man_made"="tower"]["tower:type"="observation"](${S},${W},${N},${E});` +
    `nwr["man_made"="bridge"]["name"](${S},${W},${N},${E});` +
    `);` +
    `out center;`;

  const osm = await fetchCached(query, POIS_RAW_CACHE, 'pois');

  const pois = [];
  for (const el of osm.elements) {
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
  console.log(`Elberadweg data pipeline — bank=${BANK}, refresh=${REFRESH}`);

  // 1. Fetch the 12 stage relations (bodies + recursed ways/nodes).
  const routeQuery =
    `[out:json][timeout:300]; ` +
    `rel(id:${STAGE_RELATIONS.join(',')}); ` +
    `out body; >; out skel qt;`;
  const rawOsm = await fetchCached(routeQuery, ROUTE_RAW_CACHE, 'route');

  const { nodes, ways, relations } = indexOsm(rawOsm);
  console.log(`[index] ${nodes.size} nodes, ${ways.size} ways, ${relations.size} relations`);

  // 2. Stitch into one ordered LineString.
  const orderedWays = orderedWayList(relations);
  console.log(`[stitch] ${orderedWays.length} ordered ways (backward roles dropped)`);
  const { coords, softGaps, hardGaps } = stitch(orderedWays, ways, nodes);
  console.log(`[stitch] stitched raw route: ${coords.length} points`);

  let line = turf.lineString(coords);
  line = turf.cleanCoords(line);

  // 3. Trim to Hamburg -> Dresden.
  let trimmed = trimToAnchors(line);
  console.log(`[trim] trimmed to ${trimmed.geometry.coordinates.length} points`);

  // 4. Simplify + round.
  turf.simplify(trimmed, { tolerance: SIMPLIFY_TOLERANCE, highQuality: true, mutate: true });
  trimmed = roundCoords(trimmed);
  const pointCount = trimmed.geometry.coordinates.length;
  console.log(`[simplify] simplified to ${pointCount} points (tolerance ${SIMPLIFY_TOLERANCE})`);

  // 5. Validate.
  const { totalKm } = validate(trimmed);
  console.log(`Gaps: ${softGaps} soft, ${hardGaps} hard`);
  console.log('=============================\n');

  // 6. Write route + meta.
  trimmed.properties = { name: 'Elberadweg (right bank): Hamburg → Dresden', bank: BANK };
  writeFileSync(ROUTE_JSON, JSON.stringify(trimmed));
  const meta = {
    bank: BANK,
    totalKm: round(totalKm, 2),
    builtAt: new Date().toISOString(),
    osmRelations: STAGE_RELATIONS,
    simplifyTolerance: SIMPLIFY_TOLERANCE,
    pointCount,
  };
  writeFileSync(ROUTE_META_JSON, JSON.stringify(meta, null, 2));
  console.log(`[write] ${ROUTE_JSON}`);
  console.log(`[write] ${ROUTE_META_JSON}`);

  // 7. Towns.
  const towns = await buildTowns(trimmed);
  writeFileSync(TOWNS_JSON, JSON.stringify(towns, null, 2));
  console.log(`[write] ${TOWNS_JSON} (${towns.length} towns)`);

  // 8. POIs (food stops & sights).
  const pois = await buildPois(trimmed);
  validatePois(pois);
  writeFileSync(POIS_JSON, JSON.stringify(pois, null, 2));
  console.log(`[write] ${POIS_JSON} (${pois.length} POIs)`);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nBUILD FAILED:', err.message);
  process.exit(1);
});
