// Finds the towns near one endpoint of a day's ride, using a binary search
// over the route-distance-sorted towns array to avoid scanning the whole list.

import { lowerBound, upperBound } from './sorted-range.js';

// Ranking weight for a town's perpendicular offset from the route: a km of
// detour off the path costs 1.5x a km of being early/late along it, so
// on-route towns are preferred but a much-closer off-route town can still win.
const OFFSET_WEIGHT = 1.5;

// towns must be sorted ascending by routeDistanceKm.
export function townsNear(towns, endpointKm, { windowKm = 12, max = 8 } = {}) {
  const start = lowerBound(towns, endpointKm - windowKm);
  const end = upperBound(towns, endpointKm + windowKm);

  return towns
    .slice(start, end)
    .map((town) => ({
      town,
      score: Math.abs(town.routeDistanceKm - endpointKm) + OFFSET_WEIGHT * town.offsetKm,
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map((entry) => entry.town);
}

export async function loadTowns() {
  const mod = await import('./data/towns.json');
  return mod.default;
}

// Towns whose routeDistanceKm falls inside [startKm, endKm] — the browse
// window for a committed day in day mode. `towns` is sorted ascending by
// routeDistanceKm, so the result stays in route order.
export function townsInRange(towns, startKm, endKm) {
  return towns.filter((t) => t.routeDistanceKm >= startKm && t.routeDistanceKm <= endKm);
}
