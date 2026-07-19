const FAVORITES_KEY = 'elberadweg-favorites';
const SCHEMA_VERSION = 1;

/**
 * Stable identity for a favorited place. Kind-prefixed so a town and a café
 * that share a name at the same route distance never collide.
 *
 * @param {{kind: string, name: string, routeDistanceKm: number}|null|undefined} place
 * @returns {string|null} `${kind}:${name}@${routeDistanceKm}`, or null for a missing place.
 */
export function favKey(place) {
  return place ? `${place.kind}:${place.name}@${place.routeDistanceKm}` : null;
}

// A stored favorite must carry enough to render and re-locate itself without
// re-resolving against pois.json. Entries missing any of these are dropped on
// read (offsetKm/category/openingHours are optional and not required here).
function isValidPlace(place) {
  return (
    !!place &&
    typeof place === 'object' &&
    !!place.kind &&
    !!place.name &&
    Number.isFinite(place.routeDistanceKm) &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lng)
  );
}

/**
 * Creates the global favorites store: a single user-curated list of starred
 * places, shared across plans and persisted independently under
 * `elberadweg-favorites` (the exact key/shape sub-project 1's migration
 * writes). Each place is a snapshot `{ kind: 'town'|'food'|'sight', name,
 * category?, lat, lng, routeDistanceKm, offsetKm, openingHours? }`; favorites
 * survive data rebuilds and are never re-resolved against pois.json.
 *
 * All storage access is guarded: a corrupted, wrong-schema, or missing blob
 * yields an empty list (never throws), malformed entries are dropped on read,
 * and a failing setItem (quota/denied) is swallowed so the in-memory list and
 * the render that follows a toggle are never broken.
 *
 * @param {Object} [opts]
 * @param {{getItem(key: string): string|null, setItem(key: string, value: string): void}} [opts.storage]
 *   - injected storage (e.g. `localStorage`). If omitted, the list lives in
 *   memory only and persistence is a no-op.
 * @returns {{
 *   list: () => Array<object>,
 *   has: (key: string|null) => boolean,
 *   toggle: (place: object) => boolean,
 * }}
 */
export function createFavorites({ storage } = {}) {
  let favorites = load();

  // Reads the persisted list. Any failure (missing key, invalid JSON, wrong
  // schema, no storage) is swallowed and treated as an empty list; individual
  // malformed entries are filtered out.
  function load() {
    if (!storage) return [];
    try {
      const raw = storage.getItem(FAVORITES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.favorites)) {
        return [];
      }
      return parsed.favorites.filter(isValidPlace);
    } catch {
      return [];
    }
  }

  // Persisting is best-effort: a throwing setItem (private mode, quota, storage
  // disabled by policy) must never break the in-memory list.
  function persist() {
    try {
      storage?.setItem(FAVORITES_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, favorites }));
    } catch {
      // Swallow - the list lives in memory; persistence just won't survive reload.
    }
  }

  // Defensive copy, sorted ascending by route distance for display.
  function list() {
    return favorites.map((f) => ({ ...f })).sort((a, b) => a.routeDistanceKm - b.routeDistanceKm);
  }

  function has(key) {
    return favorites.some((f) => favKey(f) === key);
  }

  // Adds the place if absent, removes it if present, persists, and returns the
  // NEW membership state (true = now favorited, false = now removed).
  function toggle(place) {
    const key = favKey(place);
    if (has(key)) favorites = favorites.filter((f) => favKey(f) !== key);
    else favorites.push({ ...place });
    persist();
    return has(key);
  }

  return { list, has, toggle };
}
