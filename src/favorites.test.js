import { describe, it, expect } from 'vitest';
import { createFavorites, favKey } from './favorites.js';

const FAVORITES_KEY = 'elberadweg-favorites';

function createFakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
  };
}

// A storage whose setItem always throws (quota exceeded / access denied), to
// prove writes are best-effort and never crash the in-memory list.
function createThrowingStorage() {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

// A place in exactly the migration-written shape (sub-project 1).
const CAFE = { kind: 'food', name: 'Café X', routeDistanceKm: 42, offsetKm: 0.2, lat: 53, lng: 10 };
const TOWN = { kind: 'town', name: 'Lauenburg', routeDistanceKm: 50, offsetKm: 0, lat: 53.4, lng: 10.5 };
const SIGHT = { kind: 'sight', name: 'Burg', routeDistanceKm: 20, offsetKm: 1, lat: 51, lng: 13 };

describe('favKey', () => {
  it('kind-prefixes so a town and a café sharing name+km get distinct keys', () => {
    const town = { kind: 'town', name: 'X', routeDistanceKm: 50 };
    const food = { kind: 'food', name: 'X', routeDistanceKm: 50 };
    expect(favKey(town)).toBe('town:X@50');
    expect(favKey(food)).toBe('food:X@50');
    expect(favKey(town)).not.toBe(favKey(food));
  });

  it('returns null for a missing place', () => {
    expect(favKey(null)).toBeNull();
    expect(favKey(undefined)).toBeNull();
  });
});

describe('createFavorites - toggle add/remove + persistence', () => {
  it('adds on first toggle (returns true) and the add persists to a fresh instance', () => {
    const storage = createFakeStorage();
    const favs = createFavorites({ storage });

    expect(favs.toggle(CAFE)).toBe(true);
    expect(favs.has(favKey(CAFE))).toBe(true);

    const reloaded = createFavorites({ storage });
    expect(reloaded.has(favKey(CAFE))).toBe(true);
    expect(reloaded.list()).toEqual([CAFE]);
  });

  it('removes on second toggle (returns false) and the removal persists', () => {
    const storage = createFakeStorage();
    createFavorites({ storage }).toggle(CAFE);

    const b = createFavorites({ storage });
    expect(b.toggle(CAFE)).toBe(false);
    expect(b.has(favKey(CAFE))).toBe(false);

    const c = createFavorites({ storage });
    expect(c.list()).toEqual([]);
  });

  it('persists under the favorites key in {schemaVersion:1, favorites:[...]} shape', () => {
    const storage = createFakeStorage();
    createFavorites({ storage }).toggle(CAFE);

    const parsed = JSON.parse(storage.store[FAVORITES_KEY]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.favorites).toEqual([CAFE]);
  });

  it('distinguishes a town from a food with the same name+km when toggling', () => {
    const storage = createFakeStorage();
    const favs = createFavorites({ storage });
    const town = { kind: 'town', name: 'X', routeDistanceKm: 50, lat: 1, lng: 2, offsetKm: 0 };
    const food = { kind: 'food', name: 'X', routeDistanceKm: 50, lat: 1, lng: 2, offsetKm: 0 };

    favs.toggle(town);

    expect(favs.has(favKey(town))).toBe(true);
    expect(favs.has(favKey(food))).toBe(false);
  });
});

describe('createFavorites - list', () => {
  it('returns favorites sorted ascending by routeDistanceKm', () => {
    const storage = createFakeStorage();
    const favs = createFavorites({ storage });
    favs.toggle(TOWN); // 50
    favs.toggle(SIGHT); // 20
    favs.toggle(CAFE); // 42

    expect(favs.list().map((f) => f.routeDistanceKm)).toEqual([20, 42, 50]);
  });

  it('returns a defensive copy: mutating the result does not affect the store', () => {
    const storage = createFakeStorage();
    const favs = createFavorites({ storage });
    favs.toggle(CAFE);

    const listed = favs.list();
    listed[0].name = 'Mutated';
    listed.push({ ...TOWN });

    const fresh = favs.list();
    expect(fresh).toHaveLength(1);
    expect(fresh[0].name).toBe('Café X');
  });
});

describe('createFavorites - has', () => {
  it('reports membership by key', () => {
    const storage = createFakeStorage();
    const favs = createFavorites({ storage });
    favs.toggle(CAFE);

    expect(favs.has(favKey(CAFE))).toBe(true);
    expect(favs.has('food:Nope@1')).toBe(false);
  });
});

describe('createFavorites - load robustness', () => {
  it('treats corrupted JSON as an empty list, without throwing', () => {
    const storage = createFakeStorage({ [FAVORITES_KEY]: '{not valid json' });

    let favs;
    expect(() => {
      favs = createFavorites({ storage });
    }).not.toThrow();
    expect(favs.list()).toEqual([]);
  });

  it('treats a wrong-schemaVersion blob as empty', () => {
    const storage = createFakeStorage({ [FAVORITES_KEY]: JSON.stringify({ schemaVersion: 2, favorites: [CAFE] }) });
    const favs = createFavorites({ storage });
    expect(favs.list()).toEqual([]);
  });

  it('treats an absent key as empty', () => {
    const favs = createFavorites({ storage: createFakeStorage() });
    expect(favs.list()).toEqual([]);
  });

  it('works in memory when storage is omitted, without crashing', () => {
    let favs;
    expect(() => {
      favs = createFavorites();
    }).not.toThrow();

    expect(favs.toggle(CAFE)).toBe(true);
    expect(favs.list()).toEqual([CAFE]);
    expect(favs.toggle(CAFE)).toBe(false);
    expect(favs.list()).toEqual([]);
  });

  it('loads a blob in exactly the migration-written shape', () => {
    const blob = {
      schemaVersion: 1,
      favorites: [{ kind: 'food', name: 'Café X', routeDistanceKm: 42, offsetKm: 0.2, lat: 53, lng: 10 }],
    };
    const storage = createFakeStorage({ [FAVORITES_KEY]: JSON.stringify(blob) });
    const favs = createFavorites({ storage });

    expect(favs.list()).toEqual(blob.favorites);
    expect(favs.has('food:Café X@42')).toBe(true);
  });

  it('drops malformed entries on read (missing name/lat/lng or non-numeric km)', () => {
    const blob = {
      schemaVersion: 1,
      favorites: [
        CAFE,
        { kind: 'food', name: 'No coords', routeDistanceKm: 5 }, // missing lat/lng
        { kind: 'town', routeDistanceKm: 8, lat: 1, lng: 2 }, // missing name
        { kind: 'sight', name: 'Bad km', routeDistanceKm: 'x', lat: 1, lng: 2 }, // non-numeric km
        null,
      ],
    };
    const storage = createFakeStorage({ [FAVORITES_KEY]: JSON.stringify(blob) });
    const favs = createFavorites({ storage });

    expect(favs.list()).toEqual([CAFE]);
  });
});

describe('createFavorites - best-effort persistence', () => {
  it('keeps the toggle in memory when setItem throws', () => {
    const storage = createThrowingStorage();
    const favs = createFavorites({ storage });

    expect(() => favs.toggle(CAFE)).not.toThrow();
    expect(favs.has(favKey(CAFE))).toBe(true);
    expect(favs.list()).toEqual([CAFE]);
  });
});
