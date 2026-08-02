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
// rather than cosmetic: everything downstream of here keeps a PREFIX of this list —
// thinAlongRoute below counts its 5 km buckets from the head, and both consumers cap
// what they render (places.js's ROW_CAP, map.js's POI_MAP_CAP) — so ascending km handed
// a downstream rider the far end of their day, the wrong subset rather than merely a
// reversed one. Ordering here rather than in either consumer is also what keeps their
// two caps selecting the same set: they slice a prefix of one array that already runs
// the rider's way, so the panel's rows and the map's pins cannot disagree.
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

// Thins a day's places SPATIALLY: at most `perBucket` in every `bucketKm` of riding,
// spread across categories. Takes what poisInRange returned — one kind, already in ride
// order — and gives back the same objects in the same order, minus the ones it dropped.
//
// This exists because both consumers used to keep a PREFIX of that list and nothing
// else. On day 1 out of Hamburg (155.8 -> 235.8) the day holds 771 food POIs, 540 of
// them inside the first 5 km, and all 40 of the prefix's slots landed on the single km
// 155.8: every café, bakery and restaurant sat on the rider's doorstep and the remaining
// 75 km of the day had not one. Sights were the same shape — the first 40 of 138 spanned
// km 155.8 to 157.8. Thinning is what makes a cap along the route rather than at the
// start of it, so the caps that remain (places.js's ROW_CAP, map.js's POI_MAP_CAP) only
// ever see a list this has already bounded.
//
// The bucket index is |routeDistanceKm − fromKm| / bucketKm, and the absolute value is
// what makes it direction-safe. A day's stretch is monotonic, so the offset from the
// ride's own origin counts 5 km steps ALONG THE RIDE whichever way the trip runs. Signed,
// a downstream day (Dresden -> Hamburg, where the km descend) would put the origin's own
// places alone in bucket 0 and the 5 km behind them in bucket −1: a different grouping
// with a different answer, on the half of this app's trips that ride the road backwards.
//
// Rarest category first is the point of the exercise, not a refinement of it. That
// Hamburg bucket holds 228 restaurants, 139 fast food, 108 cafés, 57 bakeries and 8 ice
// cream shops; the day's sights hold 85 bridges and exactly one castle. Ranked by detour
// alone the five slots go to five restaurants and the rider never hears about the castle.
// So the bucket's categories are served rarest-first (ties alphabetical, because Map
// insertion order is the data's accident and would move under a rebuild), one each in
// turn, then a second each, until the slots run out — and within a category the least
// detour goes first, which is the only ranking a rider asked to walk it would accept.
export function thinAlongRoute(pois, fromKm, { bucketKm = 5, perBucket = 5 } = {}) {
  // Indices, not the POI objects: a list holding the same record twice would collapse
  // into one keep through a Set of objects, and the answer must be a subset of the input
  // as given.
  const buckets = new Map();
  pois.forEach((poi, i) => {
    const b = Math.floor(Math.abs(poi.routeDistanceKm - fromKm) / bucketKm);
    let byCategory = buckets.get(b);
    if (!byCategory) buckets.set(b, (byCategory = new Map()));
    const group = byCategory.get(poi.category);
    if (group) group.push(i);
    else byCategory.set(poi.category, [i]);
  });

  const kept = new Set();
  for (const byCategory of buckets.values()) {
    const groups = [...byCategory.entries()]
      .map(([category, indices]) => ({
        category,
        // Least detour first. The index tie-break says what happens to two places the
        // same distance off route: the one the rider reaches first. Array.sort is stable
        // and these arrive in ride order, so it is documentation as much as code — but a
        // comparator that answers 0 for a real difference is the kind of thing a later
        // reader "simplifies" into a bug, and this one is cheap.
        indices: indices.slice().sort((a, b) => pois[a].offsetKm - pois[b].offsetKm || a - b),
      }))
      // Rarest first, counted WITHIN THIS BUCKET — the day's totals are the wrong
      // measure, because what is rare in the city centre is not what is rare in the marsh
      // 40 km later.
      .sort((a, b) => a.indices.length - b.indices.length || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));

    let taken = 0;
    for (let round = 0; taken < perBucket; round += 1) {
      let any = false;
      for (const group of groups) {
        if (round >= group.indices.length) continue;
        any = true;
        kept.add(group.indices[round]);
        taken += 1;
        if (taken >= perBucket) break;
      }
      // Every category is spent: this bucket holds fewer than perBucket places and keeps
      // all of them.
      if (!any) break;
    }
  }

  return pois.filter((_, i) => kept.has(i));
}

export async function loadPois() {
  const mod = await import('./data/pois.json');
  return mod.default;
}
