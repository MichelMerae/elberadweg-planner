import { lowerBound, upperBound } from './sorted-range.js';

// pois must be sorted ascending by routeDistanceKm.
// Returns POIs of `kind` with routeDistanceKm in [startKm, endKm] (inclusive),
// in stored (ascending km) order.
export function poisInRange(pois, startKm, endKm, { kind } = {}) {
  const start = lowerBound(pois, startKm);
  const end = upperBound(pois, endKm);
  const slice = pois.slice(start, end);
  return kind ? slice.filter((p) => p.kind === kind) : slice;
}

export async function loadPois() {
  const mod = await import('./data/pois.json');
  return mod.default;
}
