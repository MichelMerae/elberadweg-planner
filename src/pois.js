import { lowerBound, upperBound } from './sorted-range.js';

// pois must be sorted ascending by routeDistanceKm.
// Returns POIs of `kind` with routeDistanceKm between startKm and endKm
// (inclusive), **in the order the span was asked in** — so a caller holding a day's
// stretch in TRIP order gets the POIs in RIDE order, the first one the rider meets
// first.
//
// The span is normalised HERE rather than at the call site, because the binary
// search below is only meaningful over ascending data while a caller holding a
// day's stretch holds it in TRIP order — which on a downstream trip (Dresden ->
// Hamburg) descends. Given that span the search used to answer [], so every day
// of such a trip showed an empty Food and Sights section with the POIs sitting
// right on it. Normalising at the one call site would have fixed that one caller;
// normalising here fixes the function, which is the thing that was wrong.
//
// The ORDER is then put back the way it was asked for, and that is load-bearing
// rather than cosmetic: both consumers cap this list to its first 40 (places.js's
// ROW_CAP, map.js's POI_MAP_CAP), so ascending km handed a downstream rider the
// LAST 40 places of their day — the wrong subset, not just a reversed one. Ordering
// here rather than in either consumer is also what keeps their two caps selecting
// the same set: they slice a prefix of one array that already runs the rider's way,
// so the panel's rows and the map's pins cannot disagree about which 40.
//
// The direction comes from the span itself, not from a trip: `endKm < startKm` IS
// the caller saying they are riding downstream, and a function that takes two km
// needs nothing else to know which way they run.
export function poisInRange(pois, startKm, endKm, { kind } = {}) {
  const start = lowerBound(pois, Math.min(startKm, endKm));
  const end = upperBound(pois, Math.max(startKm, endKm));
  // reverse() is safe on the slice: it is a fresh array, and the POI objects in it
  // are the caller's own (untouched) records.
  const slice = pois.slice(start, end);
  const rideOrder = endKm < startKm ? slice.reverse() : slice;
  return kind ? rideOrder.filter((p) => p.kind === kind) : rideOrder;
}

export async function loadPois() {
  const mod = await import('./data/pois.json');
  return mod.default;
}
