// Binary-search bounds over arrays sorted ascending by routeDistanceKm.

// First index i such that arr[i].routeDistanceKm >= target.
export function lowerBound(arr, target) {
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (arr[mid].routeDistanceKm < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

// First index i such that arr[i].routeDistanceKm > target.
export function upperBound(arr, target) {
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (arr[mid].routeDistanceKm <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}
