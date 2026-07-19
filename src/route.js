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
 * Sub-segment of the line between two distances along it, clamped to the
 * line's extent with start <= end enforced.
 * @param {Feature<LineString>|LineString} line
 * @param {number} startKm
 * @param {number} endKm
 * @returns {Feature<LineString>}
 */
export function sliceDay(line, startKm, endKm) {
  const total = totalLength(line);
  const clampedStart = Math.min(Math.max(startKm, 0), total);
  const clampedEnd = Math.min(Math.max(endKm, 0), total);
  const lo = Math.min(clampedStart, clampedEnd);
  const hi = Math.max(clampedStart, clampedEnd);

  const startPoint = turf.point(pointAtDistance(line, lo));
  const endPoint = turf.point(pointAtDistance(line, hi));

  return turf.lineSlice(startPoint, endPoint, line);
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
