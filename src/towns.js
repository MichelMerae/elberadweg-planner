// Town lookups over the route-distance-sorted towns array: townsNear ranks
// towns around a day's endpoint (binary search + offset-weighted scoring),
// nearestTown answers what a single km is CALLED, townsInRange lists a
// committed day's stretch for day mode, and loadTowns lazy-loads the dataset.

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

/**
 * The town sitting closest to `km` along the route, within `withinKm`, or null.
 *
 * Two callers, two tolerances, one rule: main.js offers a 3 km snap after a pick (spec
 * §6.3) and NAMES a trip end with the same lookup at 0.05 km — "the town this end IS"
 * is "the town near enough to be the same place", and 0.05 is the half-step of the
 * 0.1 km grid every stored km sits on.
 *
 * Ranked by distance ALONG the route, tie-broken by the perpendicular offset, and
 * deliberately not by townsNear's offset-weighted score: that ranking answers "where
 * could I sleep near the end of this day", where a detour is worth trading against
 * being early; this one answers "what is this point called", where the closest name
 * wins outright.
 *
 * Symmetric in km, so it needs no trip and no direction — the same reason townsNear
 * needs none (places.js's header names that exception). `townsInRange` is NOT used
 * here: it is ascending-only and would need poisInRange's direction treatment first.
 *
 * No `Number.isFinite(km)` guard above the search, deliberately, and the plan asked for
 * one. It would be a branch no test can reach: every comparison against a non-finite
 * target is false, so lowerBound and upperBound both walk to the same index and the
 * window is empty — NaN, +Infinity and -Infinity already answer null through the code
 * below. climbFor in strip-markup.js records the same trap from the other side (a guard
 * that made the check under it unreachable, and a mutation duly survived it). The three
 * non-finite cases are pinned as BEHAVIOUR in towns.test.js instead, so a future linear
 * scan cannot quietly start answering them.
 */
export function nearestTown(towns, km, { withinKm = 3 } = {}) {
  const start = lowerBound(towns, km - withinKm);
  const end = upperBound(towns, km + withinKm);
  let best = null;
  let bestAlong = Infinity;
  for (let i = start; i < end; i += 1) {
    const town = towns[i];
    const along = Math.abs(town.routeDistanceKm - km);
    // Strictly closer along the route wins; an exact tie goes to the smaller offset.
    // Neither `<=` here nor a bare `<` with no tie-break would do: the first lets the
    // LAST town at a km win and the second lets the FIRST win, and either way the name
    // of a place would be decided by the order the data build happened to emit.
    if (along < bestAlong || (along === bestAlong && town.offsetKm < best.offsetKm)) {
      best = town;
      bestAlong = along;
    }
  }
  return best;
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
