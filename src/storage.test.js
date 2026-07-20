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
  };
}

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
    const store = createPlanStore({ storage, routeVersion: 'r1' });

    const result = store.load();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
    expect(result.activePlanId).toBe(result.plans[0].id);
  });

  it('the fresh active plan has empty days/breaks and the current routeVersion', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();

    const active = store.getActivePlan();
    expect(active).toMatchObject({ name: 'My plan', days: [], breaks: [], routeVersion: 'r1' });
    expect(typeof active.id).toBe('string');
    expect(active.id.length).toBeGreaterThan(0);
  });

  it('persists the fresh plan under the v2 key on load()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();

    const parsed = JSON.parse(storage.store[PLANS_KEY]);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.activePlanId).toBe(parsed.plans[0].id);
  });

  it('getActivePlan() returns null before load()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    expect(store.getActivePlan()).toBeNull();
  });
});

describe('createPlanStore - v1 -> v2 migration', () => {
  it('wraps the legacy days (minus poiPins) as one plan "My plan"', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(LEGACY_V1) });
    const store = createPlanStore({ storage, routeVersion: 'r-new' });

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
    const store = createPlanStore({ storage, routeVersion: 'r-new' });
    store.load();

    expect(store.getActivePlan().routeVersion).toBe('v0');
  });

  it('writes collected pins to the favorites key as {schemaVersion:1, favorites:[...]}', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(LEGACY_V1) });
    const store = createPlanStore({ storage, routeVersion: 'r-new' });
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
    const store = createPlanStore({ storage, routeVersion: 'r-new' });
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
    const store = createPlanStore({ storage, routeVersion: 'r-new' });

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
    const store = createPlanStore({ storage, routeVersion: 'r-new' });
    store.load();

    expect(storage.store[LEGACY_KEY]).toBe(rawLegacy);
  });

  it('does not re-migrate on a second load(): the v2 key already exists', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify(LEGACY_V1) });

    const first = createPlanStore({ storage, routeVersion: 'r-new' });
    first.load();

    const second = createPlanStore({ storage, routeVersion: 'r-new' });
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
    const store = createPlanStore({ storage, routeVersion: 'r-new' });
    store.load();

    expect(storage.store[FAVORITES_KEY]).toBe(existingFavorites);
  });

  it('ignores an invalid legacy payload and starts fresh instead', () => {
    const storage = createFakeStorage({ [LEGACY_KEY]: JSON.stringify({ schemaVersion: 99, days: [] }) });
    const store = createPlanStore({ storage, routeVersion: 'r1' });

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
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();

    const created = store.createPlan();

    expect(created.name).toBe('Plan 2');
    expect(store.getActivePlan().id).toBe(created.id);
    expect(created.days).toEqual([]);
    expect(created.breaks).toEqual([]);
  });

  it('uses an explicit name when provided', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();

    const created = store.createPlan('8 days sporty');
    expect(created.name).toBe('8 days sporty');
  });

  it('appears in the plans list after creation', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();
    store.createPlan();

    const result = store.load();
    expect(result.plans).toHaveLength(2);
  });
});

describe('createPlanStore - renamePlan', () => {
  it('renames a plan and reflects it in getActivePlan()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    const { activePlanId } = store.load();

    store.renamePlan(activePlanId, 'Renamed');

    expect(store.getActivePlan().name).toBe('Renamed');
    expect(store.load().plans[0].name).toBe('Renamed');
  });

  it('returns null and changes nothing for an unknown id', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();

    expect(store.renamePlan('does-not-exist', 'X')).toBeNull();
    expect(store.getActivePlan().name).toBe('My plan');
  });
});

describe('createPlanStore - setActivePlan', () => {
  it('switches the active plan and persists it', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    const { activePlanId: first } = store.load();
    const second = store.createPlan();

    store.setActivePlan(first);

    expect(store.getActivePlan().id).toBe(first);
    expect(JSON.parse(storage.store[PLANS_KEY]).activePlanId).toBe(first);
    expect(second.id).not.toBe(first);
  });

  it('returns null for an unknown id and leaves the active plan alone', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    const { activePlanId } = store.load();

    expect(store.setActivePlan('nope')).toBeNull();
    expect(store.getActivePlan().id).toBe(activePlanId);
  });
});

describe('createPlanStore - duplicatePlan', () => {
  it('deep-copies the source; editing the copy leaves the original intact', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
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
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    const { activePlanId } = store.load(); // "My plan"

    const copy = store.duplicatePlan(activePlanId);

    expect(copy.name).toBe('My plan (copy)');
    expect(copy.id).not.toBe(activePlanId);
    expect(store.getActivePlan().id).toBe(copy.id);
  });

  it('honors an explicit copy name', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    const { activePlanId } = store.load();

    const copy = store.duplicatePlan(activePlanId, 'Backup');
    expect(copy.name).toBe('Backup');
  });

  it('returns null for an unknown id', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();
    expect(store.duplicatePlan('missing')).toBeNull();
  });
});

describe('createPlanStore - deletePlan', () => {
  it('deletes a non-active plan without changing the active one', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
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
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    const { activePlanId } = store.load();

    expect(store.deletePlan('ghost')).toBeNull();
    expect(store.load().plans).toHaveLength(1);
    expect(store.getActivePlan().id).toBe(activePlanId);
  });

  it('deleting the ACTIVE plan activates the most-recently-updated remaining plan', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
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
    const store = createPlanStore({ storage, routeVersion: 'r1' });
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
    const store = createPlanStore({ storage, routeVersion: 'r-current' });
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
    const store = createPlanStore({ storage, routeVersion: 'r1' });
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
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();
    store.saveActivePlan({ days: [{ targetKm: 100, townChoice: { name: 'Wittenberge' } }], breaks: [] });

    const reloaded = createPlanStore({ storage, routeVersion: 'r1' });
    reloaded.load();

    expect(reloaded.getActivePlan().days).toEqual([{ targetKm: 100, townChoice: { name: 'Wittenberge' } }]);
  });

  it('returns null before load()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    expect(store.saveActivePlan({ days: [], breaks: [] })).toBeNull();
  });
});

describe('createPlanStore - id-taking methods before load()', () => {
  it('setActivePlan/renamePlan/duplicatePlan return null before load()', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });

    expect(store.setActivePlan('any')).toBeNull();
    expect(store.renamePlan('any', 'X')).toBeNull();
    expect(store.duplicatePlan('any')).toBeNull();
  });
});

describe('createPlanStore - defensive copies', () => {
  it('mutating the record returned by getActivePlan() does not affect internal state', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
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
  it('treats a corrupted v2 blob as a fresh store (one "My plan"), without throwing', () => {
    const storage = createFakeStorage({ [PLANS_KEY]: '{not valid json' });
    const store = createPlanStore({ storage, routeVersion: 'r1' });

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
    const store = createPlanStore({ storage, routeVersion: 'r1' });

    const result = store.load();
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].name).toBe('My plan');
  });

  it('does not crash when setItem throws (best-effort persistence)', () => {
    const storage = createThrowingStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });

    let result;
    expect(() => {
      result = store.load();
    }).not.toThrow();
    expect(result.plans).toHaveLength(1);

    // Mutations that persist must also swallow the throw and keep working in memory.
    expect(() => store.saveActivePlan({ days: [{ targetKm: 50, townChoice: null }], breaks: [] })).not.toThrow();
    expect(store.getActivePlan().days).toEqual([{ targetKm: 50, townChoice: null }]);
  });

  it('falls through to migration when the v2 key is corrupt but a valid legacy v1 key exists', () => {
    const storage = createFakeStorage({
      [PLANS_KEY]: '{not valid json',
      [LEGACY_KEY]: JSON.stringify(LEGACY_V1),
    });
    const store = createPlanStore({ storage, routeVersion: 'r-new' });

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
    const store = createPlanStore({ storage, routeVersion: 'r1' });

    const result = store.load();

    expect(result.plans).toHaveLength(2);
    expect(result.activePlanId).toBe('newer');
    expect(store.getActivePlan().id).toBe('newer');
  });
});

describe('createPlanStore - activePlanId persistence', () => {
  it('persists the active plan id across a second load() on the same storage', () => {
    const storage = createFakeStorage();
    const first = createPlanStore({ storage, routeVersion: 'r1' });
    const { activePlanId: originalId } = first.load();
    first.createPlan(); // switches active away from the original
    first.setActivePlan(originalId); // switch back

    const second = createPlanStore({ storage, routeVersion: 'r1' });
    const result = second.load();

    expect(result.activePlanId).toBe(originalId);
    expect(second.getActivePlan().id).toBe(originalId);
  });
});

describe('createPlanStore - break notes & custom stops', () => {
  it('round-trips note and custom-kind break fields through save and reload', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();

    const breaks = [
      { name: 'Café X', kind: 'food', routeDistanceKm: 42, lat: 53, lng: 10, note: '15 min coffee' },
      { name: 'lunch, 2h at the top', kind: 'custom', routeDistanceKm: 55.5, lat: 53.1, lng: 10.2 },
    ];
    store.saveActivePlan({ days: [{ targetKm: 80, townChoice: null }], breaks });

    const reloaded = createPlanStore({ storage, routeVersion: 'r1' });
    reloaded.load();
    expect(reloaded.getActivePlan().breaks).toEqual(breaks);
  });
});
