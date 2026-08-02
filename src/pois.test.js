import { describe, expect, test } from 'vitest';
import { poisInRange, thinAlongRoute } from './pois.js';

// Sorted ascending by routeDistanceKm, mixed food/sight kinds, as the real
// pois.json will be.
const POIS = [
  { name: 'Riverside Cafe', kind: 'food', category: 'cafe', lat: 53.5, lng: 10.1, routeDistanceKm: 10, offsetKm: 0.2 },
  { name: 'Old Watchtower', kind: 'sight', category: 'tower', lat: 53.49, lng: 10.11, routeDistanceKm: 10, offsetKm: 1.5 }, // duplicate km, different kind
  { name: 'Village Bakery', kind: 'food', category: 'bakery', lat: 53.48, lng: 10.12, routeDistanceKm: 20, offsetKm: 0.5 },
  { name: 'Hilltop Viewpoint', kind: 'sight', category: 'viewpoint', lat: 53.47, lng: 10.13, routeDistanceKm: 30, offsetKm: 2.1 },
  { name: 'Quiet Ice Cream', kind: 'food', category: 'ice_cream', lat: 53.46, lng: 10.14, routeDistanceKm: 40, offsetKm: 1.0 },
  { name: 'Ruined Castle', kind: 'sight', category: 'castle', lat: 53.45, lng: 10.15, routeDistanceKm: 50, offsetKm: 2.9 },
  { name: 'Bridge of Sighs', kind: 'sight', category: 'bridge', lat: 53.44, lng: 10.16, routeDistanceKm: 50, offsetKm: 0.1 }, // duplicate km, same kind
  { name: 'Roadside Snack Bar', kind: 'food', category: 'fast_food', lat: 53.43, lng: 10.17, routeDistanceKm: 60, offsetKm: 1.8 },
  { name: 'Waterfall Lookout', kind: 'sight', category: 'waterfall', lat: 53.42, lng: 10.18, routeDistanceKm: 70, offsetKm: 2.4 },
  { name: 'Farmhouse Restaurant', kind: 'food', category: 'restaurant', lat: 53.41, lng: 10.19, routeDistanceKm: 80, offsetKm: 0.9 },
  { name: 'Old Lighthouse', kind: 'sight', category: 'lighthouse', lat: 53.4, lng: 10.2, routeDistanceKm: 90, offsetKm: 1.2 },
  { name: 'Beer Garden', kind: 'food', category: 'biergarten', lat: 53.39, lng: 10.21, routeDistanceKm: 100, offsetKm: 0.3 },
];

describe('poisInRange', () => {
  test('includes POIs exactly at both inclusive bounds', () => {
    const names = poisInRange(POIS, 20, 50).map((p) => p.name);
    expect(names).toContain('Village Bakery'); // routeDistanceKm 20 == startKm
    expect(names).toContain('Ruined Castle'); // routeDistanceKm 50 == endKm
    expect(names).toContain('Bridge of Sighs'); // also 50 == endKm
  });

  test('excludes POIs just outside the range', () => {
    const names = poisInRange(POIS, 20, 50).map((p) => p.name);
    expect(names).not.toContain('Riverside Cafe'); // 10, just below
    expect(names).not.toContain('Old Watchtower'); // 10, just below
    expect(names).not.toContain('Roadside Snack Bar'); // 60, just above
    expect(names).not.toContain('Waterfall Lookout'); // 70, just above
  });

  test('returns an ascending span in ascending-km order', () => {
    const kms = poisInRange(POIS, 0, 1000).map((p) => p.routeDistanceKm);
    const sorted = [...kms].sort((a, b) => a - b);
    expect(kms).toEqual(sorted);
  });

  test('filters by kind', () => {
    const foodNames = poisInRange(POIS, 0, 1000, { kind: 'food' }).map((p) => p.name);
    expect(foodNames).toEqual([
      'Riverside Cafe',
      'Village Bakery',
      'Quiet Ice Cream',
      'Roadside Snack Bar',
      'Farmhouse Restaurant',
      'Beer Garden',
    ]);

    const sightNames = poisInRange(POIS, 0, 1000, { kind: 'sight' }).map((p) => p.name);
    expect(sightNames).toEqual([
      'Old Watchtower',
      'Hilltop Viewpoint',
      'Ruined Castle',
      'Bridge of Sighs',
      'Waterfall Lookout',
      'Old Lighthouse',
    ]);
  });

  test('kind filter respects the range bounds, not just the whole array', () => {
    const names = poisInRange(POIS, 20, 50, { kind: 'food' }).map((p) => p.name);
    expect(names).toEqual(['Village Bakery', 'Quiet Ice Cream']);
  });

  test('returns all kinds when kind is omitted', () => {
    const result = poisInRange(POIS, 50, 50);
    expect(result.map((p) => p.name)).toEqual(['Ruined Castle', 'Bridge of Sighs']);
  });

  test('returns an empty array when the range excludes everything', () => {
    expect(poisInRange(POIS, 45, 45)).toEqual([]);
  });

  test('returns an empty array when startKm is after the last POI', () => {
    expect(poisInRange(POIS, 1000, 2000)).toEqual([]);
  });

  test('returns an empty array when endKm is before the first POI', () => {
    expect(poisInRange(POIS, -2000, -1000)).toEqual([]);
  });

  test('returns the whole array when the range covers it entirely', () => {
    expect(poisInRange(POIS, 0, 1000)).toHaveLength(POIS.length);
  });

  test('returns an empty array for an empty POI list', () => {
    expect(poisInRange([], 0, 100)).toEqual([]);
  });

  // A day's stretch arrives in TRIP order, so on a downstream trip (Dresden ->
  // Hamburg) startKm is the greater number. Two things have been wrong there in turn.
  // First the span was not normalised at all and the search returned nothing: every
  // day of such a trip showed an empty Food and Sights section while the POIs sat
  // right on the stretch. Then it returned the right stretch in the wrong ORDER —
  // ascending km, which downstream runs back-to-front against the ride.
  test('reads a descending span as the same stretch, mirrored into ride order', () => {
    const ascending = poisInRange(POIS, 20, 50);
    const descending = poisInRange(POIS, 50, 20);

    // The same places...
    expect(new Set(descending)).toEqual(new Set(ascending));
    expect(ascending).not.toEqual([]);
    // ...in the opposite order. Asserted as the exact mirror rather than as "not the
    // ascending order": this stretch holds five POIs and is not palindromic, so the
    // reversal is observable and leaving the order alone cannot pass.
    expect(descending).toEqual([...ascending].reverse());
  });

  // The claim every capped caller leans on. places.js's ROW_CAP and map.js's
  // POI_MAP_CAP both keep a PREFIX of this list, so the head has to be the end of the
  // stretch the rider reaches FIRST. In ascending km a downstream rider looking for
  // lunch was shown the far end of their day, and once capped it was the wrong 40
  // places rather than merely a reversed 40.
  test('puts the POI met first at the head of the list, both directions', () => {
    const kmsFrom = (from, to) => poisInRange(POIS, from, to).map((p) => p.routeDistanceKm);

    expect(kmsFrom(20, 60).slice(0, 2)).toEqual([20, 30]);
    expect(kmsFrom(60, 20).slice(0, 2)).toEqual([60, 50]);
  });

  test('filters a descending span by kind, in ride order too', () => {
    const names = poisInRange(POIS, 50, 20, { kind: 'food' }).map((p) => p.name);
    expect(names).toEqual(['Quiet Ice Cream', 'Village Bakery']);
  });

  test('does not mutate the input array or its POI objects', () => {
    const snapshot = JSON.stringify(POIS);
    const result = poisInRange(POIS, 20, 50, { kind: 'food' });
    expect(JSON.stringify(POIS)).toBe(snapshot);
    // returned entries are the same objects, not copies
    const bakery = POIS.find((p) => p.name === 'Village Bakery');
    expect(result.find((p) => p.name === 'Village Bakery')).toBe(bakery);
  });
});

// Rows written as (name, km, category, detour): what every test below turns on is that
// triple, and spelling kind/lat/lng on each row buried it. kind is 'food' throughout
// because thinAlongRoute is handed ONE kind at a time — main.js thins food and sights
// separately, so a mixed list is not a case that exists.
const at = (name, routeDistanceKm, category, offsetKm) => ({
  name,
  kind: 'food',
  category,
  lat: 53.5,
  lng: 10.1,
  routeDistanceKm,
  offsetKm,
});
const namesOf = (list) => list.map((p) => p.name);

// Three consecutive 5 km stretches of eight places each, four categories twice over per
// stretch — the shape of a real day at city density, small enough to count by hand.
// Detours rise with i, so "the five nearest the route" and "five spread by category"
// are different answers here too.
const THREE_BUCKETS = [];
for (let b = 0; b < 3; b += 1) {
  for (let i = 0; i < 8; i += 1) {
    THREE_BUCKETS.push(
      at(`B${b} #${i}`, 100 + b * 5 + i * 0.5, ['restaurant', 'cafe', 'bakery', 'fast_food'][i % 4], 0.1 * (i + 1)),
    );
  }
}
const bucketOf = (poi, fromKm = 100, bucketKm = 5) => Math.floor(Math.abs(poi.routeDistanceKm - fromKm) / bucketKm);
const perBucketCounts = (list, fromKm = 100, bucketKm = 5) => {
  const counts = new Map();
  for (const p of list) {
    const b = bucketOf(p, fromKm, bucketKm);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
};

// The bug this exists for: day 1 out of Hamburg holds 771 food POIs, 540 of them in the
// first 5 km, so a 40-row PREFIX of the day put every café, bakery and restaurant on the
// rider's doorstep and left the other 75 km with none. Thinning replaces truncation:
// at most five per 5 km ridden, spread across categories rather than taken by detour,
// because that first bucket holds 228 restaurants against 8 ice cream shops and 85
// bridges stand against 1 castle over the day.
describe('thinAlongRoute', () => {
  test('returns an empty list unchanged', () => {
    expect(thinAlongRoute([], 100)).toEqual([]);
  });

  test('keeps a list shorter than one bucketful whole, as the very objects given', () => {
    const few = THREE_BUCKETS.slice(0, 3);
    const kept = thinAlongRoute(few, 100);
    expect(kept).toEqual(few);
    expect(kept[0]).toBe(few[0]);
  });

  test('keeps a bucket holding exactly perBucket', () => {
    const exactly = THREE_BUCKETS.slice(0, 5);
    expect(namesOf(thinAlongRoute(exactly, 100))).toEqual(namesOf(exactly));
  });

  // The spread claim itself. Without bucketing — anything that ranks the day as one
  // list — the answer is either all 24 or the first five, and both are the bug.
  test('spreads the keeps along the ride, five per 5 km rather than five per day', () => {
    const kept = thinAlongRoute(THREE_BUCKETS, 100);

    expect(kept).toHaveLength(15);
    expect(perBucketCounts(kept)).toEqual([[0, 5], [1, 5], [2, 5]]);
    // Named explicitly: a cap that kept a prefix would satisfy "15 rows" and still
    // leave the last two thirds of the ride empty.
    expect(namesOf(kept).some((n) => n.startsWith('B2'))).toBe(true);
  });

  test('honours perBucket', () => {
    const kept = thinAlongRoute(THREE_BUCKETS, 100, { perBucket: 2 });

    expect(kept).toHaveLength(6);
    expect(perBucketCounts(kept)).toEqual([[0, 2], [1, 2], [2, 2]]);
  });

  test('honours bucketKm', () => {
    // 10 km buckets over the same 15 km: the first two 5 km stretches become one bucket
    // and share five slots, so 10 survive where the default keeps 15.
    const kept = thinAlongRoute(THREE_BUCKETS, 100, { bucketKm: 10 });

    expect(kept).toHaveLength(10);
    expect(perBucketCounts(kept, 100, 10)).toEqual([[0, 5], [1, 5]]);
  });

  // The user's chosen behaviour, and the reason for the round-robin: rank a Hamburg
  // bucket by detour alone and it answers with five restaurants, burying the bakery and
  // the one castle of the day. Rarest category first, then the next rarest, and only
  // then a second helping of anything.
  test('spends the slots across categories instead of on the nearest five', () => {
    const dominated = [
      at('Grill 1', 100.1, 'restaurant', 0.1),
      at('Grill 2', 100.2, 'restaurant', 0.2),
      at('Grill 3', 100.3, 'restaurant', 0.3),
      at('Grill 4', 100.4, 'restaurant', 0.4),
      at('Grill 5', 100.5, 'restaurant', 0.5),
      at('Grill 6', 100.6, 'restaurant', 0.6),
      at('Backhaus', 100.7, 'bakery', 2.0),
      at('Milchbar', 100.8, 'cafe', 3.0),
    ];

    const kept = namesOf(thinAlongRoute(dominated, 100));

    expect(kept).toHaveLength(5);
    // The two rare ones are in, though they are the two longest detours in the bucket —
    // "the five nearest" is exactly the five Grills and cannot pass this.
    expect(kept).toContain('Backhaus');
    expect(kept).toContain('Milchbar');
    expect(kept.filter((n) => n.startsWith('Grill'))).toEqual(['Grill 1', 'Grill 2', 'Grill 3']);
  });

  // Three category orderings are plausible and only one is right, so this fixture is
  // built to answer differently under each: two slots, and bakery(1)/cafe(2)/
  // restaurant(3) arriving bakery-first. Rarest-first keeps Backhaus + Hafen Cafe;
  // most-common-first keeps Grill Haus + Hafen Cafe; the order they arrive in keeps
  // Backhaus + Grill Haus.
  const THREE_ORDERINGS = [
    at('Backhaus', 100.1, 'bakery', 2.5),
    at('Grill Haus', 100.2, 'restaurant', 0.2),
    at('Zur Post', 100.3, 'restaurant', 0.3),
    at('Alt Cafe', 100.4, 'cafe', 1.1),
    at('Hafen Cafe', 100.5, 'cafe', 0.9),
    at('Steak House', 100.6, 'restaurant', 0.4),
  ];

  test('serves the rarest category in the bucket first, not the commonest', () => {
    expect(namesOf(thinAlongRoute(THREE_ORDERINGS, 100, { perBucket: 2 }))).toEqual(['Backhaus', 'Hafen Cafe']);
  });

  // Hafen Cafe rather than Alt Cafe above is this same rule: least detour wins its
  // category's turn. Asserted on its own so the ordering test above is not the only
  // thing standing between the rider and a 1.1 km walk they did not need.
  test('takes the least detour first within a category', () => {
    const scattered = [
      at('Far Cafe', 100.1, 'cafe', 2.4),
      at('Mid Cafe', 100.2, 'cafe', 1.2),
      at('Near Cafe', 100.3, 'cafe', 0.3),
      at('Middling Cafe', 100.4, 'cafe', 1.9),
    ];

    expect(namesOf(thinAlongRoute(scattered, 100, { perBucket: 2 }))).toEqual(['Mid Cafe', 'Near Cafe']);
  });

  // Kept in the order they were HANDED IN, which is ride order — the order both
  // consumers then read as "the next place you will reach". The fixture above is chosen
  // so selection order (Near Cafe, then Mid Cafe) is not ride order (Mid, then Near):
  // returning the selection would reverse these two.
  test('returns the keeps in ride order, not in the order they were chosen', () => {
    const scattered = [
      at('Far Cafe', 100.1, 'cafe', 2.4),
      at('Mid Cafe', 100.2, 'cafe', 1.2),
      at('Near Cafe', 100.3, 'cafe', 0.3),
    ];

    const kept = thinAlongRoute(scattered, 100, { perBucket: 2 });
    expect(namesOf(kept)).toEqual(['Mid Cafe', 'Near Cafe']);
    expect(kept.map((p) => p.routeDistanceKm)).toEqual([100.2, 100.3]);
  });

  // Equal counts have to break somewhere, and "wherever the Map happened to be built"
  // is a coin toss that changes with the data. Alphabetical: bakery before restaurant
  // even though a restaurant arrives first.
  test('breaks a tie between equally rare categories alphabetically', () => {
    const tied = [
      at('Zum Anker', 100.1, 'restaurant', 0.1),
      at('Zur Linde', 100.2, 'restaurant', 0.2),
      at('Backerei Ost', 100.3, 'bakery', 0.5),
      at('Backerei West', 100.4, 'bakery', 0.6),
    ];

    expect(namesOf(thinAlongRoute(tied, 100, { perBucket: 1 }))).toEqual(['Backerei Ost']);
  });

  test('breaks a tie between equal detours by ride order', () => {
    const tied = [
      at('First Cafe', 100.1, 'cafe', 1.0),
      at('Second Cafe', 100.2, 'cafe', 1.0),
    ];

    expect(namesOf(thinAlongRoute(tied, 100, { perBucket: 1 }))).toEqual(['First Cafe']);
  });

  // Half of this app's reason for existing: Dresden -> Hamburg rides the same road
  // backwards, and poisInRange hands that day's stretch back DESCENDING by absolute km.
  // The bucket index is therefore taken from |km − the ride's origin|, which counts 5 km
  // steps ALONG THE RIDE either way. Signed, the origin's own POIs (offset 0) sit alone
  // in bucket 0 and everything within 5 km behind them shares bucket −1 — a different
  // grouping with a different answer, which is what this fixture pins.
  const DOWNSTREAM = [
    at('Rathaus Cafe', 200, 'cafe', 0.9), // exactly on the ride's origin
    at('Bahnhof Imbiss', 199, 'fast_food', 0.2),
    at('Markt Bakery', 198, 'bakery', 0.4),
    at('Alte Muhle', 197, 'restaurant', 0.3),
    at('Eis am Deich', 196, 'ice_cream', 0.8),
    at('Dorfkrug', 195, 'restaurant', 0.1), // exactly 5 km ridden: the next bucket starts here
    at('Fahrhaus', 194, 'restaurant', 0.5),
  ];

  test('counts 5 km steps along a downstream ride, not signed km', () => {
    const kept = namesOf(thinAlongRoute(DOWNSTREAM, 200, { perBucket: 3 }));

    // First 5 km of the ride (km 200 down to 196): five places, one slot each for the
    // three alphabetically-first of five equally rare categories.
    // Last 5 km (km 195, 194): two places, both under the cap, both kept.
    expect(kept).toEqual(['Rathaus Cafe', 'Bahnhof Imbiss', 'Markt Bakery', 'Dorfkrug', 'Fahrhaus']);
    // Signed bucketing keeps Eis am Deich and drops Dorfkrug, and the count alone
    // cannot see it: both answers are five long.
    expect(kept).not.toContain('Eis am Deich');
  });

  test('keeps a downstream list descending, the way the rider rides it', () => {
    const kms = thinAlongRoute(DOWNSTREAM, 200, { perBucket: 3 }).map((p) => p.routeDistanceKm);
    expect(kms).toEqual([...kms].sort((a, b) => b - a));
    expect(kms[0]).toBe(200);
  });

  test('does not mutate the input array or its POI objects', () => {
    const snapshot = JSON.stringify(THREE_BUCKETS);
    const before = [...THREE_BUCKETS];
    thinAlongRoute(THREE_BUCKETS, 100);
    expect(JSON.stringify(THREE_BUCKETS)).toBe(snapshot);
    expect(THREE_BUCKETS).toEqual(before);
  });
});

describe('loadPois', () => {
  test('is exported as an async loader (not invoked here; data file may not exist yet)', async () => {
    const { loadPois } = await import('./pois.js');
    expect(typeof loadPois).toBe('function');
  });
});
