// Finds the towns near one endpoint of a day's ride, using a binary search
// over the route-distance-sorted towns array to avoid scanning the whole list.

// First index i such that towns[i].routeDistanceKm >= target.
function lowerBound(towns, target) {
  let low = 0;
  let high = towns.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (towns[mid].routeDistanceKm < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

// First index i such that towns[i].routeDistanceKm > target.
function upperBound(towns, target) {
  let low = 0;
  let high = towns.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (towns[mid].routeDistanceKm <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

// towns must be sorted ascending by routeDistanceKm.
export function townsNear(towns, endpointKm, { windowKm = 12, max = 8 } = {}) {
  const start = lowerBound(towns, endpointKm - windowKm);
  const end = upperBound(towns, endpointKm + windowKm);

  return towns
    .slice(start, end)
    .map((town) => ({ town, score: Math.abs(town.routeDistanceKm - endpointKm) + 1.5 * town.offsetKm }))
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map((entry) => entry.town);
}

export function townLabel(town) {
  return `${town.name} — ${town.routeDistanceKm} km along, ${town.offsetKm} km off route`;
}

export async function loadTowns() {
  const mod = await import('./data/towns.json');
  return mod.default;
}
