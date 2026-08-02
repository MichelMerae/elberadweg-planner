// scripts/lib/crossings.mjs — derive bank crossings from OSM candidates.
//
// Pure: takes prepared ways (with inline geometry from Overpass `out geom`),
// two coordinate arrays, options. No fetching, no file I/O, no console — same
// contract as route-assembly.mjs, which build-data.mjs wires up in a later
// task.
//
// The geometric test here is the entire filter: a wide Overpass probe of one
// bank returned ~9,500 bridge/ferry candidates, of which only a few dozen
// actually cross the Elbe. A candidate qualifies when one of its ends
// projects within `maxSnapM` of the canonical line AND the other end
// projects within `maxSnapM` of the alt line — that is what tells a real
// crossing apart from, say, a cycleway bridge over a side road that happens
// to run near the river.
//
// Coordinates are [lng, lat] throughout, matching route-assembly.mjs.

import * as turf from '@turf/turf';

const UMLAUT = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' };

/**
 * A stable, human-legible id: `<slug>-<km>`. The km suffix disambiguates
 * same-named crossings (ferries called "Fähre" recur along the whole route)
 * and keeps ids stable across reruns even if OSM's own ids change.
 *
 * Names with no ASCII-mappable characters (no Latin letters or digits after
 * transliteration — a bare punctuation string, or a script this table
 * doesn't cover) would flatten to an empty slug and collide on the km alone.
 * Falling back to `crossing` keeps the id a real compound key instead of
 * silently degrading to one component.
 */
export function slugifyCrossingId(name, kmCanonical) {
  const flat = name
    .replace(/[äöüßÄÖÜ]/g, (ch) => UMLAUT[ch])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${flat || 'crossing'}-${Math.round(kmCanonical)}`;
}

/**
 * Whether an OSM `name` tag is actually a name, not a bare ref that happens
 * to sit in the `name` field. Two crossings found in real data carry
 * numbers-only names: the HADAG Hamburg ferry is tagged `name=62` (its line
 * number) and the Darchau ferry `name=5170` (an OSM ref). Rendered as-is a
 * rider sees "Cross at 5170", so those must fall through to
 * `nearestTownName` exactly like a missing tag would — while a name such as
 * `F6 Königstein–Halbestadt`, which mixes a route code with real place
 * names, must keep it.
 *
 * `\p{L}` (Unicode letter) rather than `[a-zA-Z]`, so a name that is *only*
 * non-Latin letters (e.g. `Ústí`) still counts as named; only digits,
 * punctuation and whitespace fail the test.
 */
function hasName(tagName) {
  return typeof tagName === 'string' && /\p{L}/u.test(tagName);
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
 * @returns {Array<{id: string, name: string, kind: 'bridge'|'ferry',
 *   kmCanonical: number, kmAlt: number, lengthKm: number, coord: number[]}>}
 *   sorted by kmCanonical.
 */
export function deriveCrossings(ways, canonicalCoords, altCoords, { maxSnapM = 250, maxLengthKm = 3, towns = [] } = {}) {
  const canonical = turf.lineString(canonicalCoords);
  const alt = turf.lineString(altCoords);
  const out = [];
  for (const way of ways) {
    if (!Array.isArray(way.geometry) || way.geometry.length < 2) continue;
    const ends = [way.geometry[0], way.geometry[way.geometry.length - 1]].map((p) => [p.lon, p.lat]);
    // Each end is snapped to both lines. A real crossing has ONE end near the
    // canonical line and the OTHER end near the alt line — never the same
    // end serving both. Restricting the two pairings to opposite ends (index
    // 0 with 1, and 1 with 0) rules out the degenerate case where a short
    // bridge sits where the banks nearly touch and a single end lands within
    // maxSnapM of both lines: that end could otherwise pair with itself and
    // report kmCanonical and kmAlt for the same physical point, describing a
    // crossing with ~zero width instead of a real one.
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
    const name = hasName(way.tags?.name) ? way.tags.name : nearestTownName(towns, best.c.km, kind);
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

/**
 * Fallback name for an unnamed way: the closest town by along-route distance,
 * plus the crossing kind. `towns[].routeDistanceKm` is measured against the
 * same canonical line this module snaps to (build-data.mjs projects towns
 * onto the trimmed route with `turf.nearestPointOnLine` too — see
 * `buildTowns`), so comparing it to `km` (a canonical-line km) is an
 * apples-to-apples comparison.
 */
function nearestTownName(towns, km, kind) {
  let bestTown = null;
  let bestD = Infinity;
  for (const t of towns) {
    const d = Math.abs(t.routeDistanceKm - km);
    if (d < bestD) { bestD = d; bestTown = t; }
  }
  return bestTown ? `${bestTown.name} ${kind}` : `${kind} at km ${Math.round(km)}`;
}

/**
 * Merge candidates that describe the same physical crossing: within
 * `withinKm` on BOTH axes (canonical and alt), not just one — two distinct
 * neighbouring bridges can share a canonical km while sitting at very
 * different alt km (or vice versa), and requiring both axes to agree is what
 * keeps Magdeburg's several close-together bridges apart. The shorter
 * (usually the more direct / better-surveyed) survivor wins.
 */
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
