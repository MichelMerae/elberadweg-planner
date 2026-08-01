import { lowerBound, upperBound } from './sorted-range.js';

// pois must be sorted ascending by routeDistanceKm.
// Returns POIs of `kind` with routeDistanceKm between startKm and endKm
// (inclusive), in stored (ascending km) order.
//
// The span is normalised HERE rather than at the call site, because the binary
// search below is only meaningful over ascending data while a caller holding a
// day's stretch holds it in TRIP order — which on a downstream trip (Dresden ->
// Hamburg) descends. Given that span the search used to answer [], so every day
// of such a trip showed an empty Food and Sights section with the POIs sitting
// right on it. Normalising at the one call site would have fixed that one caller;
// normalising here fixes the function, which is the thing that was wrong.
export function poisInRange(pois, startKm, endKm, { kind } = {}) {
  const start = lowerBound(pois, Math.min(startKm, endKm));
  const end = upperBound(pois, Math.max(startKm, endKm));
  const slice = pois.slice(start, end);
  return kind ? slice.filter((p) => p.kind === kind) : slice;
}

export async function loadPois() {
  const mod = await import('./data/pois.json');
  return mod.default;
}
