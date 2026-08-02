import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPlanStore } from './storage.js';

const PLANS_KEY = 'elberadweg-plans';
const LEGACY_KEY = 'elberadweg-itinerary';
const FAVORITES_KEY = 'elberadweg-favorites';

function createFakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
    removeItem: (key) => {
      delete store[key];
    },
  };
}

// A storage whose setItem always throws (quota exceeded / access denied), to
// prove writes are best-effort and never crash the store.
function createThrowingStorage() {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

// Reads back what it was seeded with, but every write throws - the shape of
// private-mode/quota-exceeded storage. Used to prove an archive that cannot be
// written still boots.
function createUnwritableStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

const CURRENT_ROUTE_ID = 'cuxhaven-prague-ev7-v1';
const OLD_ROUTE_ID = 'hamburg-dresden-elberadweg-v1';
// The road's length, as main.js reads it off the route meta.
const TOTAL_KM = 1026.5;

// A stored plans blob whose 114 km day boundary was measured from a different
// origin. Defaults to the current schema so the corridor tests exercise the read
// path in use; pass an older `schemaVersion` to read one as it stands, with
// `routeId: null` for a schema 2 blob, which predates routeId being recorded at
// all. The stored plan carries no trip window unless `tripWindow` says otherwise.
function storedBlob({ schemaVersion = 4, routeId = OLD_ROUTE_ID, tripWindow = null } = {}) {
  const blob = {
    schemaVersion,
    activePlanId: 'p-old',
    plans: [
      {
        id: 'p-old',
        name: 'Old corridor plan',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        routeVersion: 'r-old',
        days: [{ targetKm: 114, townChoice: { name: 'Lauenburg' } }],
        breaks: [],
        ...(tripWindow ?? {}),
      },
    ],
  };
  if (routeId !== null) blob.routeId = routeId;
  return blob;
}

const OLD_FAVORITES = JSON.stringify({
  schemaVersion: 1,
  favorites: [{ name: 'Café X', kind: 'food', routeDistanceKm: 42 }],
});

const LEGACY_V1 = {
  schemaVersion: 1,
  routeVersion: 'v0',
  days: [
    {
      targetKm: 80,
      townChoice: { name: 'Lauenburg' },
      poiPins: [{ name: 'Café X', kind: 'food', routeDistanceKm: 42, offsetKm: 0.2, lat: 53, lng: 10 }],
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('createPlanStore - fresh start', () => {
  it('with no keys, load() yields one empty plan "My plan" that is active', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
    expect(result.activePlanId).toBe(result.plans[0].id);
  });

  it('the fresh active plan has empty days/breaks and the current routeVersion', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();

    const active = store.getActivePlan();
    expect(active).toMatchObject({ name: 'My plan', days: [], breaks: [], routeVersion: 'r1' });
    expect(typeof active.id).toBe('string');
    expect(active.id.length).toBeGreaterThan(0);
  });

  it('persists the fresh plan under the plans key on load()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();

    const parsed = JSON.parse(storage.store[PLANS_KEY]);
    expect(parsed.schemaVersion).toBe(5);
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.activePlanId).toBe(parsed.plans[0].id);
  });

  it('getActivePlan() returns null before load()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    expect(store.getActivePlan()).toBeNull();
  });
});

describe('createPlanStore - v1 legacy migration', () => {
  it('wraps the legacy days (minus poiPins) as one plan "My plan"', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(LEGACY_V1) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');

    const active = store.getActivePlan();
    expect(active.days).toEqual([{ targetKm: 80, townChoice: { name: 'Lauenburg' } }]);
    // No poiPins leak into the plan's day records.
    expect(active.days[0]).not.toHaveProperty('poiPins');
    expect(active.breaks).toEqual([]);
  });

  it('carries the legacy routeVersion onto the migrated plan', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(LEGACY_V1) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });
    store.load();

    expect(store.getActivePlan().routeVersion).toBe('v0');
  });

  it('writes collected pins to the favorites key as {schemaVersion:1, favorites:[...]}', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(LEGACY_V1) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });
    store.load();

    const favorites = JSON.parse(storage.store[FAVORITES_KEY]);
    expect(favorites.schemaVersion).toBe(1);
    expect(favorites.favorites).toEqual([
      { name: 'Café X', kind: 'food', routeDistanceKm: 42, offsetKm: 0.2, lat: 53, lng: 10 },
    ]);
  });

  it('dedupes pins by `${kind}:${name}@${routeDistanceKm}` across days', () => {
    const seed = {
      schemaVersion: 1,
      routeVersion: 'v0',
      days: [
        {
          targetKm: 80,
          townChoice: null,
          poiPins: [
            { name: 'Café X', kind: 'food', routeDistanceKm: 42 },
            { name: 'View', kind: 'sight', routeDistanceKm: 50 },
          ],
        },
        {
          targetKm: 60,
          townChoice: null,
          poiPins: [
            { name: 'Café X', kind: 'food', routeDistanceKm: 42 }, // duplicate identity
            { name: 'Café X', kind: 'food', routeDistanceKm: 90 }, // same name/kind, different km -> distinct
          ],
        },
      ],
    };
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(seed) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });
    store.load();

    const favorites = JSON.parse(storage.store[FAVORITES_KEY]).favorites;
    expect(favorites).toEqual([
      { name: 'Café X', kind: 'food', routeDistanceKm: 42 },
      { name: 'View', kind: 'sight', routeDistanceKm: 50 },
      { name: 'Café X', kind: 'food', routeDistanceKm: 90 },
    ]);
  });

  it('skips null/garbage poiPins entries without throwing, migrating the valid ones', () => {
    const validPin = { name: 'Café X', kind: 'food', routeDistanceKm: 42 };
    const seed = {
      schemaVersion: 1,
      routeVersion: 'v0',
      days: [{ targetKm: 80, townChoice: null, poiPins: [null, validPin, 'garbage', 7] }],
    };
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(seed) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });

    let result;
    expect(() => {
      result = store.load();
    }).not.toThrow();

    // Migration still succeeded (not a fresh fallback).
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
    expect(store.getActivePlan().routeVersion).toBe('v0');
    expect(JSON.parse(storage.store[FAVORITES_KEY]).favorites).toEqual([validPin]);
  });

  it('leaves the legacy v1 key untouched (kept as backup)', () => {
    const rawLegacy = JSON.stringify(LEGACY_V1);
    const storage = createFakeStorage({ [LEGACY_KEY]: rawLegacy });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });
    store.load();

    expect(storage.store[LEGACY_KEY]).toBe(rawLegacy);
  });

  it('does not re-migrate on a second load(): the plans key already exists', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(LEGACY_V1) });

    const first = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });
    first.load();

    const second = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });
    const result = second.load();

    // Still exactly one plan; migration did not run again and duplicate it.
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
  });

  it('does not overwrite an existing favorites key during migration', () => {
    const existingFavorites = JSON.stringify({ schemaVersion: 1, favorites: [{ name: 'Kept', kind: 'food', routeDistanceKm: 5 }] });
    const storage = createFakeStorage({
      [LEGACY_KEY]: JSON.stringify(LEGACY_V1),
      [FAVORITES_KEY]: existingFavorites,
    });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });
    store.load();

    expect(storage.store[FAVORITES_KEY]).toBe(existingFavorites);
  });

  it('ignores an invalid legacy payload and starts fresh instead', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify({ schemaVersion: 99, days: [] }) });
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
    // Fresh plan uses the current routeVersion, not a carried-over one.
    expect(store.getActivePlan().routeVersion).toBe('r1');
    // No favorites written when there was nothing valid to migrate.
    expect(storage.store[FAVORITES_KEY]).toBeUndefined();
  });
});

describe('createPlanStore - createPlan', () => {
  it('auto-names the new plan "Plan 2" and activates it', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();

    const created = store.createPlan();

    expect(created.name).toBe('Plan 2');
    expect(store.getActivePlan().id).toBe(created.id);
    expect(created.days).toEqual([]);
    expect(created.breaks).toEqual([]);
  });

  it('uses an explicit name when provided', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();

    const created = store.createPlan('8 days sporty');
    expect(created.name).toBe('8 days sporty');
  });

  it('appears in the plans list after creation', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();
    store.createPlan();

    const result = store.load();
    expect(result.plans).toHaveLength(2);
  });
});

describe('createPlanStore - renamePlan', () => {
  it('renames a plan and reflects it in getActivePlan()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId } = store.load();

    store.renamePlan(activePlanId, 'Renamed');

    expect(store.getActivePlan().name).toBe('Renamed');
    expect(store.load().plans[0].name).toBe('Renamed');
  });

  it('returns null and changes nothing for an unknown id', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();

    expect(store.renamePlan('does-not-exist', 'X')).toBeNull();
    expect(store.getActivePlan().name).toBe('My plan');
  });
});

describe('createPlanStore - setActivePlan', () => {
  it('switches the active plan and persists it', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId: first } = store.load();
    const second = store.createPlan();

    store.setActivePlan(first);

    expect(store.getActivePlan().id).toBe(first);
    expect(JSON.parse(storage.store[PLANS_KEY]).activePlanId).toBe(first);
    expect(second.id).not.toBe(first);
  });

  it('returns null for an unknown id and leaves the active plan alone', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId } = store.load();

    expect(store.setActivePlan('nope')).toBeNull();
    expect(store.getActivePlan().id).toBe(activePlanId);
  });
});

describe('createPlanStore - duplicatePlan', () => {
  it('deep-copies the source; editing the copy leaves the original intact', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId: originalId } = store.load();
    store.saveActivePlan({ days: [{ targetKm: 80, townChoice: { name: 'Lauenburg' } }], breaks: [] });

    const copy = store.duplicatePlan(originalId);
    // The copy is now active; mutate its days through the store.
    store.saveActivePlan({ days: [{ targetKm: 40, townChoice: null }], breaks: [] });

    store.setActivePlan(originalId);
    expect(store.getActivePlan().days).toEqual([{ targetKm: 80, townChoice: { name: 'Lauenburg' } }]);

    store.setActivePlan(copy.id);
    expect(store.getActivePlan().days).toEqual([{ targetKm: 40, townChoice: null }]);
  });

  it('defaults the copy name to "<original> (copy)" and activates it', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId } = store.load(); // "My plan"

    const copy = store.duplicatePlan(activePlanId);

    expect(copy.name).toBe('My plan (copy)');
    expect(copy.id).not.toBe(activePlanId);
    expect(store.getActivePlan().id).toBe(copy.id);
  });

  it('honors an explicit copy name', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId } = store.load();

    const copy = store.duplicatePlan(activePlanId, 'Backup');
    expect(copy.name).toBe('Backup');
  });

  it('returns null for an unknown id', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();
    expect(store.duplicatePlan('missing')).toBeNull();
  });
});

describe('createPlanStore - deletePlan', () => {
  it('deletes a non-active plan without changing the active one', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId: firstId } = store.load();
    const second = store.createPlan(); // second is now active
    store.setActivePlan(firstId); // make first active again

    store.deletePlan(second.id);

    const result = store.load();
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].id).toBe(firstId);
    expect(result.activePlanId).toBe(firstId);
  });

  it('returns null and changes nothing for an unknown id', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId } = store.load();

    expect(store.deletePlan('ghost')).toBeNull();
    expect(store.load().plans).toHaveLength(1);
    expect(store.getActivePlan().id).toBe(activePlanId);
  });

  it('deleting the ACTIVE plan activates the most-recently-updated remaining plan', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId: p0 } = store.load(); // updated at :01

    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    const p1 = store.createPlan(); // updated at :02

    vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));
    const p2 = store.createPlan(); // updated at :03, now active

    // Delete the active plan (p2). Remaining: p0(:01), p1(:02) -> p1 wins.
    store.deletePlan(p2.id);

    expect(store.getActivePlan().id).toBe(p1.id);
    expect(p0).not.toBe(p1.id);
  });

  it('deleting the LAST plan creates a fresh empty "My plan"', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId } = store.load();

    store.deletePlan(activePlanId);

    const result = store.load();
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
    expect(result.plans[0].id).not.toBe(activePlanId);

    const active = store.getActivePlan();
    expect(active.days).toEqual([]);
    expect(active.id).toBe(result.activePlanId);
  });
});

describe('createPlanStore - saveActivePlan', () => {
  it('updates days, breaks, updatedAt and routeVersion of the active plan', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r-current', totalKm: TOTAL_KM });
    store.load();
    const before = store.getActivePlan().updatedAt;

    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
    store.saveActivePlan({ days: [{ targetKm: 90, townChoice: { name: 'Meissen' } }], breaks: [{ km: 20 }] });

    const active = store.getActivePlan();
    expect(active.days).toEqual([{ targetKm: 90, townChoice: { name: 'Meissen' } }]);
    expect(active.breaks).toEqual([{ km: 20 }]);
    expect(active.routeVersion).toBe('r-current');
    expect(active.updatedAt).not.toBe(before);
  });

  it('normalizes day records to {targetKm, townChoice}, dropping derived fields', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();

    // Pass full public day records (as itinerary.getDays() would return).
    store.saveActivePlan({
      days: [{ index: 0, targetKm: 80, startKm: 0, endKm: 80, townChoice: null }],
      breaks: [],
    });

    const stored = JSON.parse(storage.store[PLANS_KEY]).plans[0].days[0];
    expect(Object.keys(stored).sort()).toEqual(['targetKm', 'townChoice']);
    expect(stored).toEqual({ targetKm: 80, townChoice: null });
  });

  it('round-trips the saved payload through a fresh store on the same storage', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();
    store.saveActivePlan({ days: [{ targetKm: 100, townChoice: { name: 'Wittenberge' } }], breaks: [] });

    const reloaded = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    reloaded.load();

    expect(reloaded.getActivePlan().days).toEqual([{ targetKm: 100, townChoice: { name: 'Wittenberge' } }]);
  });

  it('returns null before load()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    expect(store.saveActivePlan({ days: [], breaks: [] })).toBeNull();
  });
});

describe('createPlanStore - id-taking methods before load()', () => {
  it('setActivePlan/renamePlan/duplicatePlan return null before load()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });

    expect(store.setActivePlan('any')).toBeNull();
    expect(store.renamePlan('any', 'X')).toBeNull();
    expect(store.duplicatePlan('any')).toBeNull();
  });
});

describe('createPlanStore - defensive copies', () => {
  it('mutating the record returned by getActivePlan() does not affect internal state', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();
    store.saveActivePlan({ days: [{ targetKm: 80, townChoice: null }], breaks: [] });

    const active = store.getActivePlan();
    active.name = 'Hacked';
    active.days.push({ targetKm: 999, townChoice: null });

    const fresh = store.getActivePlan();
    expect(fresh.name).toBe('My plan');
    expect(fresh.days).toHaveLength(1);
  });
});

describe('createPlanStore - corruption and error handling', () => {
  it('treats a corrupted plans blob as a fresh store (one "My plan"), without throwing', () => {
    const storage = createFakeStorage({ [PLANS_KEY]: '{not valid json' });
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });

    let result;
    expect(() => {
      result = store.load();
    }).not.toThrow();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
  });

  it('treats a wrong-schemaVersion blob as a fresh store', () => {
    const storage = createFakeStorage({
      [PLANS_KEY]: JSON.stringify({ schemaVersion: 99, activePlanId: 'x', plans: [{ id: 'x', name: 'Old' }] }),
    });
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });

    const result = store.load();
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
  });

  it('does not crash when setItem throws (best-effort persistence)', () => {
    const storage = createThrowingStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });

    let result;
    expect(() => {
      result = store.load();
    }).not.toThrow();
    expect(result.plans).toHaveLength(1);

    // Mutations that persist must also swallow the throw and keep working in memory.
    expect(() => store.saveActivePlan({ days: [{ targetKm: 50, townChoice: null }], breaks: [] })).not.toThrow();
    expect(store.getActivePlan().days).toEqual([{ targetKm: 50, townChoice: null }]);
  });

  it('falls through to migration when the plans key is corrupt but a valid legacy v1 key exists', () => {
    const storage = createFakeStorage({
      [PLANS_KEY]: '{not valid json',
      [LEGACY_KEY]: JSON.stringify(LEGACY_V1),
    });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });

    store.load();

    // Migrated (legacy routeVersion carried, days from v1), not a bare fresh plan.
    const active = store.getActivePlan();
    expect(active.name).toBe('My plan');
    expect(active.routeVersion).toBe('v0');
    expect(active.days).toEqual([{ targetKm: 80, townChoice: { name: 'Lauenburg' } }]);
    expect(JSON.parse(storage.store[FAVORITES_KEY]).favorites).toHaveLength(1);
  });

  it('falls back to the most-recently-updated plan when the stored activePlanId is stale', () => {
    const stored = {
      schemaVersion: 2,
      activePlanId: 'no-longer-here',
      plans: [
        { id: 'older', name: 'Older', createdAt: 'a', updatedAt: '2026-01-01T00:00:01Z', routeVersion: 'r1', days: [], breaks: [] },
        { id: 'newer', name: 'Newer', createdAt: 'a', updatedAt: '2026-01-01T00:00:09Z', routeVersion: 'r1', days: [], breaks: [] },
      ],
    };
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(stored) });
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans).toHaveLength(2);
    expect(result.activePlanId).toBe('newer');
    expect(store.getActivePlan().id).toBe('newer');
  });
});

describe('createPlanStore - activePlanId persistence', () => {
  it('persists the active plan id across a second load() on the same storage', () => {
    const storage = createFakeStorage();
    const first = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId: originalId } = first.load();
    first.createPlan(); // switches active away from the original
    first.setActivePlan(originalId); // switch back

    const second = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const result = second.load();

    expect(result.activePlanId).toBe(originalId);
    expect(second.getActivePlan().id).toBe(originalId);
  });
});

describe('createPlanStore - snapped fractional lengths', () => {
  it('round-trips a fractional targetKm through a save and reload', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'v1', totalKm: TOTAL_KM });
    store.load();
    store.saveActivePlan({
      days: [
        { targetKm: 76.2, townChoice: { name: 'Boizenburg/Elbe', routeDistanceKm: 76.2 } },
        { targetKm: 83.8, townChoice: null },
      ],
      breaks: [],
    });

    const reloaded = createPlanStore({ storage, routeVersion: 'v1', totalKm: TOTAL_KM });
    reloaded.load();
    const days = reloaded.getActivePlan().days;
    expect(days[0].targetKm).toBe(76.2);
    expect(days[1].targetKm).toBe(83.8);
  });

  it('writes the current schema version alongside the fractional lengths', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'v1', totalKm: TOTAL_KM });
    store.load();
    store.saveActivePlan({ days: [{ targetKm: 76.2, townChoice: null }], breaks: [] });

    expect(JSON.parse(storage.getItem(PLANS_KEY)).schemaVersion).toBe(5);
  });
});

describe('createPlanStore - corridor change (routeId)', () => {
  it('reads the stored plans normally when the stored routeId matches', () => {
    const blob = storedBlob({ routeId: CURRENT_ROUTE_ID });
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(blob) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('Old corridor plan');
    expect(store.getActivePlan().days).toEqual([{ targetKm: 114, townChoice: { name: 'Lauenburg' } }]);
    expect(storage.store[`${PLANS_KEY}-backup-${CURRENT_ROUTE_ID}`]).toBeUndefined();
  });

  it('does not archive on a mere data rebuild of the same corridor (routeVersion differs)', () => {
    // A refreshed dataset keeps the routeId and only moves builtAt; main.js
    // answers that with its route-changed banner, not with an archive.
    const blob = storedBlob({ routeId: CURRENT_ROUTE_ID });
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(blob), [FAVORITES_KEY]: OLD_FAVORITES });
    const store = createPlanStore({ storage, routeVersion: 'r-rebuilt', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans[0].name).toBe('Old corridor plan');
    expect(store.getActivePlan().routeVersion).toBe('r-old');
    expect(storage.store[FAVORITES_KEY]).toBe(OLD_FAVORITES);
    expect(Object.keys(storage.store).filter((key) => key.includes('-backup-'))).toEqual([]);
  });

  it('archives the plans blob under the stored routeId when the corridor changed', () => {
    const raw = JSON.stringify(storedBlob());
    const storage = createFakeStorage({ [PLANS_KEY]: raw });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    store.load();

    expect(storage.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}`]).toBe(raw);
  });

  it('starts fresh after archiving: one empty "My plan" on the current corridor', () => {
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(storedBlob()) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
    expect(result.plans[0].id).not.toBe('p-old');

    const active = store.getActivePlan();
    expect(active.days).toEqual([]);
    expect(active.breaks).toEqual([]);
    expect(active.routeVersion).toBe('r-new');

    // The live key now holds the fresh plan on the current corridor.
    const persisted = JSON.parse(storage.store[PLANS_KEY]);
    expect(persisted.routeId).toBe(CURRENT_ROUTE_ID);
    expect(persisted.plans).toHaveLength(1);
    expect(persisted.plans[0].name).toBe('My plan');
  });

  it('archives the favorites key alongside and clears the live one', () => {
    const storage = createFakeStorage({
      [PLANS_KEY]: JSON.stringify(storedBlob()),
      [FAVORITES_KEY]: OLD_FAVORITES,
    });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    store.load();

    expect(storage.store[`${FAVORITES_KEY}-backup-${OLD_ROUTE_ID}`]).toBe(OLD_FAVORITES);
    expect(storage.store[FAVORITES_KEY]).toBeUndefined();
  });

  it('archives a schema 2 blob (no routeId recorded) under the literal `v2` suffix', () => {
    const raw = JSON.stringify(storedBlob({ schemaVersion: 2, routeId: null }));
    const storage = createFakeStorage({ [PLANS_KEY]: raw, [FAVORITES_KEY]: OLD_FAVORITES });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    const result = store.load();

    expect(storage.store[`${PLANS_KEY}-backup-v2`]).toBe(raw);
    expect(storage.store[`${FAVORITES_KEY}-backup-v2`]).toBe(OLD_FAVORITES);
    expect(result.plans[0].name).toBe('My plan');
  });

  it('never overwrites an occupied backup key: appends -2, numbering each key separately', () => {
    const raw = JSON.stringify(storedBlob());
    const storage = createFakeStorage({
      [PLANS_KEY]: raw,
      [FAVORITES_KEY]: OLD_FAVORITES,
      [`${PLANS_KEY}-backup-${OLD_ROUTE_ID}`]: 'first backup',
    });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    store.load();

    expect(storage.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}`]).toBe('first backup');
    expect(storage.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}-2`]).toBe(raw);
    // The favorites key has its own numbering - an occupied plans backup must
    // not push the favorites backup to -2.
    expect(storage.store[`${FAVORITES_KEY}-backup-${OLD_ROUTE_ID}`]).toBe(OLD_FAVORITES);
  });

  it('appends -3 when both the backup key and its -2 are taken', () => {
    const raw = JSON.stringify(storedBlob());
    const storage = createFakeStorage({
      [PLANS_KEY]: raw,
      [`${PLANS_KEY}-backup-${OLD_ROUTE_ID}`]: 'first backup',
      [`${PLANS_KEY}-backup-${OLD_ROUTE_ID}-2`]: 'second backup',
    });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    store.load();

    expect(storage.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}`]).toBe('first backup');
    expect(storage.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}-2`]).toBe('second backup');
    expect(storage.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}-3`]).toBe(raw);
  });

  it('does not resurrect the legacy v1 payload after archiving a foreign corridor', () => {
    const storage = createFakeStorage({
      [PLANS_KEY]: JSON.stringify(storedBlob()),
      [LEGACY_KEY]: JSON.stringify(LEGACY_V1),
    });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans).toHaveLength(1);
    const active = store.getActivePlan();
    // A v1 payload is from the old corridor too: no days, no carried-over
    // routeVersion, and none of its pins land in favorites.
    expect(active.days).toEqual([]);
    expect(active.routeVersion).toBe('r-new');
    expect(storage.store[FAVORITES_KEY]).toBeUndefined();
    expect(storage.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}`]).toBeDefined();
  });

  it('stamps the configured routeId into the persisted blob', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });
    store.load();

    expect(JSON.parse(storage.store[PLANS_KEY]).routeId).toBe(CURRENT_ROUTE_ID);

    store.saveActivePlan({ days: [{ targetKm: 90, townChoice: null }], breaks: [] });
    const persisted = JSON.parse(storage.store[PLANS_KEY]);
    expect(persisted.routeId).toBe(CURRENT_ROUTE_ID);
    expect(persisted.schemaVersion).toBe(5);
  });

  it('records no corridor when none is configured', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });
    store.load();

    expect(JSON.parse(storage.store[PLANS_KEY]).routeId ?? null).toBeNull();
  });

  it('with no configured routeId, a foreign-corridor blob is still read (check disabled)', () => {
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(storedBlob()) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans[0].name).toBe('Old corridor plan');
    expect(store.getActivePlan().days).toEqual([{ targetKm: 114, townChoice: { name: 'Lauenburg' } }]);
    expect(Object.keys(storage.store).filter((key) => key.includes('-backup-'))).toEqual([]);
  });

  it('with no configured routeId, a schema 2 blob is read as-is', () => {
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(storedBlob({ schemaVersion: 2, routeId: null })) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans[0].name).toBe('Old corridor plan');
    expect(storage.store[`${PLANS_KEY}-backup-v2`]).toBeUndefined();
  });

  it('boots to a fresh plan when the archive writes throw (quota/private mode)', () => {
    const storage = createUnwritableStorage({
      [PLANS_KEY]: JSON.stringify(storedBlob()),
      [FAVORITES_KEY]: OLD_FAVORITES,
    });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    let result;
    expect(() => {
      result = store.load();
    }).not.toThrow();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
    expect(store.getActivePlan().days).toEqual([]);
  });

  it('archives without throwing when the injected storage has no removeItem', () => {
    const raw = JSON.stringify(storedBlob());
    const withoutRemove = createFakeStorage({ [PLANS_KEY]: raw });
    delete withoutRemove.removeItem;
    const store = createPlanStore({ storage: withoutRemove, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    let result;
    expect(() => {
      result = store.load();
    }).not.toThrow();

    expect(result.plans[0].name).toBe('My plan');
    expect(withoutRemove.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}`]).toBe(raw);
  });

  it('does not archive twice: a second load() on the archived storage is a no-op', () => {
    const raw = JSON.stringify(storedBlob());
    const storage = createFakeStorage({ [PLANS_KEY]: raw });

    const first = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });
    const firstId = first.load().activePlanId;

    const second = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });
    const result = second.load();

    expect(result.activePlanId).toBe(firstId);
    expect(storage.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}`]).toBe(raw);
    expect(storage.store[`${PLANS_KEY}-backup-${OLD_ROUTE_ID}-2`]).toBeUndefined();
  });
});

describe('createPlanStore - totalKm is required', () => {
  it('throws rather than inventing a road length', () => {
    const storage = createFakeStorage();

    // A 0 fallback would hand every window-less plan a destination at km 0, one
    // its start already sits on: a zero-length trip that createTrip accepts
    // happily and that leaves every day in the plan stranded at km 0.
    expect(() => createPlanStore({ storage, routeVersion: 'r1' })).toThrow(/totalKm/);
    expect(() => createPlanStore({ storage, routeVersion: 'r1', totalKm: NaN })).toThrow(/totalKm/);
    expect(() => createPlanStore({ storage, routeVersion: 'r1', totalKm: '1026.5' })).toThrow(/totalKm/);
    expect(() => createPlanStore({ storage, routeVersion: 'r1', totalKm: Infinity })).toThrow(/totalKm/);
  });
});

describe('storage v4 - trip window', () => {
  it('defaults a v3 plan to the whole road', () => {
    const blob = storedBlob({ schemaVersion: 3, routeId: CURRENT_ROUTE_ID });
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(blob) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });
    store.load();

    const plan = store.getActivePlan();
    expect(plan.startKm).toBe(0);
    expect(plan.destinationKm).toBe(TOTAL_KM);
  });

  it('upgrades a v3 blob in place: nothing archived, plans intact', () => {
    // A window is not a corridor. v3 -> v4 must read the plans, not move them aside.
    const storage = createFakeStorage({
      [PLANS_KEY]: JSON.stringify(storedBlob({ schemaVersion: 3, routeId: CURRENT_ROUTE_ID })),
      [FAVORITES_KEY]: OLD_FAVORITES,
    });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('Old corridor plan');
    expect(store.getActivePlan().days).toEqual([{ targetKm: 114, townChoice: { name: 'Lauenburg' } }]);
    expect(Object.keys(storage.store).filter((key) => key.includes('-backup-'))).toEqual([]);
    expect(storage.store[FAVORITES_KEY]).toBe(OLD_FAVORITES);

    // The live key is now v5, with the whole-road window and an empty
    // crossings list written into it.
    const persisted = JSON.parse(storage.store[PLANS_KEY]);
    expect(persisted.schemaVersion).toBe(5);
    expect(persisted.plans[0]).toMatchObject({ id: 'p-old', startKm: 0, destinationKm: TOTAL_KM, crossings: [] });
  });

  it('round-trips a window through save and load', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], startKm: 797.6, destinationKm: 149.3 });

    const reloaded = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    reloaded.load();

    // A downstream window: the order is the rider's heading, so it must survive
    // exactly as given - no sorting into low/high on the way through storage.
    const active = reloaded.getActivePlan();
    expect(active.startKm).toBe(797.6);
    expect(active.destinationKm).toBe(149.3);
    expect(JSON.parse(storage.store[PLANS_KEY]).plans[0]).toMatchObject({ startKm: 797.6, destinationKm: 149.3 });
  });

  it('gives a fresh plan the whole road', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();

    expect(store.getActivePlan()).toMatchObject({ startKm: 0, destinationKm: TOTAL_KM });

    const created = store.createPlan('Second');
    expect(created.startKm).toBe(0);
    expect(created.destinationKm).toBe(TOTAL_KM);
  });

  it('carries the window through a duplicate', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    const { activePlanId } = store.load();
    store.saveActivePlan({ days: [], breaks: [], startKm: 200, destinationKm: 400 });

    const copy = store.duplicatePlan(activePlanId);

    expect(copy.startKm).toBe(200);
    expect(copy.destinationKm).toBe(400);
  });

  it('repairs a stored window that is not finite', () => {
    const blob = storedBlob({ routeId: CURRENT_ROUTE_ID, tripWindow: { startKm: null, destinationKm: 'x' } });
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(blob) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });
    store.load();

    const plan = store.getActivePlan();
    expect(plan.startKm).toBe(0);
    expect(plan.destinationKm).toBe(TOTAL_KM);
  });

  it('leaves a stored window that runs off the road alone', () => {
    // Pulling both ends onto the road is createTrip's job, and doing it here too
    // would mean two places deciding what the road's edges are.
    const blob = storedBlob({ routeId: CURRENT_ROUTE_ID, tripWindow: { startKm: -50, destinationKm: 9999 } });
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(blob) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });
    store.load();

    expect(store.getActivePlan()).toMatchObject({ startKm: -50, destinationKm: 9999 });
  });

  it('cannot have a stored window moved by a save that names none', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], startKm: 797.6, destinationKm: 149.3 });

    // A caller thinking only about days must not be able to destroy the rider's
    // window on its way past - a loss they would discover after a reload, with
    // nothing left to restore it from.
    const saved = store.saveActivePlan({ days: [{ targetKm: 80, townChoice: null }], breaks: [] });

    expect(saved).toMatchObject({ startKm: 797.6, destinationKm: 149.3 });
    expect(store.getActivePlan()).toMatchObject({ startKm: 797.6, destinationKm: 149.3 });
    expect(JSON.parse(storage.store[PLANS_KEY]).plans[0]).toMatchObject({ startKm: 797.6, destinationKm: 149.3 });
  });

  it('lets a window named in the payload win', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], startKm: 797.6, destinationKm: 149.3 });

    const saved = store.saveActivePlan({ days: [], breaks: [], startKm: 200, destinationKm: 400 });

    expect(saved).toMatchObject({ startKm: 200, destinationKm: 400 });
    expect(JSON.parse(storage.store[PLANS_KEY]).plans[0]).toMatchObject({ startKm: 200, destinationKm: 400 });
  });

  it('ignores a non-finite end in the payload instead of widening the window', () => {
    // Garbage from a caller is that caller's bug; answering it by resetting to the
    // whole road would spend the rider's trip on someone else's mistake.
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], startKm: 797.6, destinationKm: 149.3 });

    const saved = store.saveActivePlan({ days: [], breaks: [], startKm: NaN, destinationKm: 'x' });

    expect(saved).toMatchObject({ startKm: 797.6, destinationKm: 149.3 });
  });

  it('keeps a destination at km 0 - a ride down to Cuxhaven', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], startKm: 500, destinationKm: 0 });

    const reloaded = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    reloaded.load();

    // km 0 is a real destination, not a missing one. A `??` or `||` on either the
    // save or the read path would widen this ride to the far end of the road.
    expect(reloaded.getActivePlan()).toMatchObject({ startKm: 500, destinationKm: 0 });
  });

  it('does not widen a stored narrow window when load() re-persists it', () => {
    const blob = storedBlob({ routeId: CURRENT_ROUTE_ID, tripWindow: { startKm: 797.6, destinationKm: 149.3 } });
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(blob) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', routeId: CURRENT_ROUTE_ID, totalKm: TOTAL_KM });

    store.load();

    // load() re-persists whatever it read. What it writes back has to still be the
    // rider's window rather than the whole-road default.
    expect(JSON.parse(storage.store[PLANS_KEY]).plans[0]).toMatchObject({ startKm: 797.6, destinationKm: 149.3 });
    expect(store.getActivePlan()).toMatchObject({ startKm: 797.6, destinationKm: 149.3 });
  });

  it('gives a migrated v1 plan the whole road', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(LEGACY_V1) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });
    store.load();

    expect(store.getActivePlan()).toMatchObject({ routeVersion: 'v0', startKm: 0, destinationKm: TOTAL_KM });
  });

  it('gives a v2 plan the whole road', () => {
    const storage = createFakeStorage({ [PLANS_KEY]: JSON.stringify(storedBlob({ schemaVersion: 2, routeId: null })) });
    // No configured routeId, so the corridor check is off and the v2 blob is read.
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: TOTAL_KM });

    const result = store.load();

    expect(result.plans[0].name).toBe('Old corridor plan');
    expect(store.getActivePlan()).toMatchObject({ startKm: 0, destinationKm: TOTAL_KM });
  });
});

describe('createPlanStore - break notes & custom stops', () => {
  it('round-trips note and custom-kind break fields through save and reload', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    store.load();

    const breaks = [
      { name: 'Café X', kind: 'food', routeDistanceKm: 42, lat: 53, lng: 10, note: '15 min coffee' },
      { name: 'lunch, 2h at the top', kind: 'custom', routeDistanceKm: 55.5, lat: 53.1, lng: 10.2 },
    ];
    store.saveActivePlan({ days: [{ targetKm: 80, townChoice: null }], breaks });

    const reloaded = createPlanStore({ storage, routeVersion: 'r1', totalKm: TOTAL_KM });
    reloaded.load();
    expect(reloaded.getActivePlan().breaks).toEqual(breaks);
  });
});

describe('crossings on the plan (schema 5)', () => {
  it('a fresh plan has an empty crossings list', () => {
    const store = createPlanStore({ storage: createFakeStorage(), routeId: 'r1', totalKm: 1000 });
    store.load();
    expect(store.getActivePlan().crossings).toEqual([]);
  });

  it('saveActivePlan round-trips crossing ids', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], crossings: ['magdeburg-sternbruecke-479'] });
    const again = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    again.load();
    expect(again.getActivePlan().crossings).toEqual(['magdeburg-sternbruecke-479']);
  });

  it('non-string entries are dropped on read, silently', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], crossings: ['ok-1', 42, null, 'ok-2'] });
    const again = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    again.load();
    expect(again.getActivePlan().crossings).toEqual(['ok-1', 'ok-2']);
  });

  it('a v4 blob (no crossings field) reads as an empty list', () => {
    // craft a v4 blob through a store, then strip the field the way an old build left it
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    store.load();
    const blob = JSON.parse(storage.getItem('elberadweg-plans'));
    blob.schemaVersion = 4;
    for (const p of blob.plans) delete p.crossings;
    storage.setItem('elberadweg-plans', JSON.stringify(blob));
    const again = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    again.load();
    expect(again.getActivePlan().crossings).toEqual([]);
  });

  // A duplicated id composes as two crossings at the same km: a zero-length
  // stretch on the far bank, charged twice. Unreachable from the toggle UI
  // today, but the persistence layer is the right place to rule it out rather
  // than trusting every future caller to de-dupe on its own - so both the
  // write path (saveActivePlan) and the read path (a blob written before this
  // rule existed, or edited by hand) are covered separately below.
  it('drops a duplicate crossing id on save, preserving order', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    store.load();
    store.saveActivePlan({ days: [], breaks: [], crossings: ['a', 'b', 'a'] });
    const again = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    again.load();
    expect(again.getActivePlan().crossings).toEqual(['a', 'b']);
  });

  it('drops a duplicate crossing id already sitting in a stored blob, preserving order', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    store.load();
    const blob = JSON.parse(storage.getItem('elberadweg-plans'));
    for (const p of blob.plans) p.crossings = ['a', 'b', 'a'];
    storage.setItem('elberadweg-plans', JSON.stringify(blob));
    const again = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    again.load();
    expect(again.getActivePlan().crossings).toEqual(['a', 'b']);
  });

  // migrateV1() and duplicatePlan() each build a plan record by hand rather
  // than through normalizePlan; both need their own `crossings: []` /
  // `crossings: clone(...)` line, or the plan they hand back would be missing
  // the key entirely - not merely empty - and `plan.crossings.length` would
  // throw the first time the UI looked at it.
  it('gives a plan migrated from v1 an empty crossings list', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(LEGACY_V1) });
    const store = createPlanStore({ storage, routeVersion: 'r-new', totalKm: 1000 });
    store.load();

    expect(store.getActivePlan().crossings).toEqual([]);
  });

  it('carries the source crossings through duplicatePlan', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeId: 'r1', totalKm: 1000 });
    const { activePlanId } = store.load();
    store.saveActivePlan({ days: [], breaks: [], crossings: ['x-1'] });

    const copy = store.duplicatePlan(activePlanId);

    expect(copy.crossings).toEqual(['x-1']);
    expect(store.getActivePlan().crossings).toEqual(['x-1']);
  });
});
