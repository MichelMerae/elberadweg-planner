import * as turf from '@turf/turf';

/**
 * Total length of the route in kilometers.
 * @param {Feature<LineString>|LineString} line
 * @returns {number} km
 */
export function totalLength(line) {
  return turf.length(line, { units: 'kilometers' });
}

/**
 * Coordinate along the line at the given distance, clamped to the line's
 * extent (km < 0 -> start, km > total -> end).
 * @param {Feature<LineString>|LineString} line
 * @param {number} km
 * @returns {[number, number]} [lng, lat]
 */
export function pointAtDistance(line, km) {
  const total = totalLength(line);
  const clampedKm = Math.min(Math.max(km, 0), total);
  const point = turf.along(line, clampedKm, { units: 'kilometers' });
  return point.geometry.coordinates;
}

/**
 * Snap a [lng, lat] point onto the line, returning how far along the line
 * the snapped point sits and the snapped coordinate itself.
 * @param {Feature<LineString>|LineString} line
 * @param {[number, number]} lngLat
 * @returns {{ distanceKm: number, coord: [number, number] }}
 */
export function snap(line, lngLat) {
  const point = turf.point(lngLat);
  const snapped = turf.nearestPointOnLine(line, point, { units: 'kilometers' });
  return {
    distanceKm: snapped.properties.location,
    coord: snapped.geometry.coordinates,
  };
}

/**
 * Cumulative-distance index over the line's own vertices: `coords[i]` sits at
 * `cumKm[i]` along the route.
 *
 * pointAtDistance and snap each walk the whole line on every call — 3.5 ms and
 * 19 ms respectively on the real 3,486-point Elberadweg. That is nothing per
 * click and ruinous per pointermove: dragging a day boundary asks for the
 * focused stretch on every move, and 60 samples of it cost a quarter of a
 * second. Build this once at boot and read stretches out of it instead.
 *
 * @param {Feature<LineString>|LineString} line
 * @returns {{coords: Array<[number, number]>, cumKm: Float64Array, totalKm: number}}
 */
export function createRouteIndex(line) {
  const coords = (line.geometry ?? line).coordinates;
  const cumKm = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i += 1) {
    cumKm[i] = cumKm[i - 1] + turf.distance(coords[i - 1], coords[i], { units: 'kilometers' });
  }
  return { coords, cumKm, totalKm: coords.length ? cumKm[coords.length - 1] : 0 };
}

// Index of the last vertex at or before `km`, by binary search. `km` is expected
// pre-clamped to the line, so the answer is always a real vertex.
function vertexBefore(cumKm, km) {
  let lo = 0;
  let hi = cumKm.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumKm[mid] <= km) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Coordinate at `km` along an indexed route, clamped to the line's extent — the
 * cheap twin of pointAtDistance. Interpolates linearly in degrees within the
 * segment rather than along a great circle; on route vertices a few hundred
 * metres apart the two agree to well under a metre.
 *
 * @param {ReturnType<typeof createRouteIndex>} index
 * @param {number} km
 * @returns {[number, number]} [lng, lat]
 */
export function pointAtKm(index, km) {
  const { coords, cumKm, totalKm } = index;
  const clamped = Math.min(Math.max(km, 0), totalKm);
  const i = vertexBefore(cumKm, clamped);
  if (i >= coords.length - 1) return coords[coords.length - 1];
  const segKm = cumKm[i + 1] - cumKm[i];
  const t = segKm > 0 ? (clamped - cumKm[i]) / segKm : 0;
  const [lng0, lat0] = coords[i];
  const [lng1, lat1] = coords[i + 1];
  return [lng0 + (lng1 - lng0) * t, lat0 + (lat1 - lat0) * t];
}

/**
 * The shape of a stretch: the route's own vertices between startKm and endKm,
 * with both ends interpolated exactly. Traces every bend the route makes, which
 * a fixed number of samples along it cannot, and costs two binary searches.
 * Returns [] for an empty or inverted range.
 *
 * @param {ReturnType<typeof createRouteIndex>} index
 * @param {number} startKm
 * @param {number} endKm
 * @returns {Array<[number, number]>}
 */
export function stretchCoords(index, startKm, endKm) {
  const { coords, cumKm, totalKm } = index;
  const from = Math.min(Math.max(startKm, 0), totalKm);
  const to = Math.min(Math.max(endKm, 0), totalKm);
  if (!coords.length || to <= from) return [];
  const out = [pointAtKm(index, from)];
  // Strictly inside: a vertex sitting exactly on either end is covered by the
  // interpolated endpoint, and pushing both would duplicate the position.
  for (let i = vertexBefore(cumKm, from) + 1; i < coords.length && cumKm[i] < to; i += 1) {
    out.push(coords[i]);
  }
  out.push(pointAtKm(index, to));
  return out;
}

/**
 * Loads the route GeoJSON feature. Dynamically imported so this module can
 * be used (and tested) before src/data/route.json exists.
 * @returns {Promise<Feature<LineString>>}
 */
export async function loadRoute() {
  const mod = await import('./data/route.json');
  return mod.default;
}
