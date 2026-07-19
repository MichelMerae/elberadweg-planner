import { describe, it, expect } from 'vitest';
import { createItinerary } from './itinerary.js';

const STORAGE_KEY = 'elberadweg-itinerary';
const TOTAL_KM = 380; // Hamburg -> Dresden, approx

function createFakeStorage() {
  const store = {};
  return {
    store,
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
  };
}

describe('createItinerary - chaining', () => {
  it('chains startKm/endKm across added days', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addDay(80);

    const days = itinerary.getDays();
    expect(days).toHaveLength(3);
    expect(days[0]).toMatchObject({ index: 0, startKm: 0, endKm: 80 });
    expect(days[1]).toMatchObject({ index: 1, startKm: 80, endKm: 160 });
    expect(days[2]).toMatchObject({ index: 2, startKm: 160, endKm: 240 });
  });

  it('the first day starts at km 0', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    const day = itinerary.addDay(50);
    expect(day.startKm).toBe(0);
    expect(day.endKm).toBe(50);
  });
});

describe('createItinerary - clamping', () => {
  it('clamps endKm to totalKm when a day overshoots Dresden', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(300);
    const day = itinerary.addDay(200); // 300 + 200 = 500, clamp to 380
    expect(day.endKm).toBe(TOTAL_KM);
  });
});

describe('createItinerary - editDay', () => {
  it('recomputes the chain for the edited day and all downstream days', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.editDay(0, 100);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 100 });
    expect(days[1]).toMatchObject({ startKm: 100, endKm: 180 });
    expect(days[2]).toMatchObject({ startKm: 180, endKm: 260 });
  });

  it('clamps a downstream day pushed past totalKm by an edit', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.editDay(0, 350);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 350 });
    expect(days[1]).toMatchObject({ startKm: 350, endKm: TOTAL_KM });
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(() => itinerary.editDay(5, 50)).toThrow();
  });

  it('throws on an invalid targetKm', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(() => itinerary.editDay(0, -10)).toThrow();
  });
});

describe('createItinerary - setTownChoice', () => {
  it('attaches a town choice to a day', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    const town = { name: 'Lauenburg' };

    itinerary.setTownChoice(0, town);

    expect(itinerary.getDays()[0].townChoice).toEqual(town);
  });

  it('replaces an existing town choice', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);

    itinerary.setTownChoice(0, { name: 'A' });
    itinerary.setTownChoice(0, { name: 'B' });

    expect(itinerary.getDays()[0].townChoice).toEqual({ name: 'B' });
  });

  it('defaults townChoice to null on a fresh day', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(itinerary.getDays()[0].townChoice).toBeNull();
  });
});

describe('createItinerary - togglePoiPin', () => {
  it('defaults poiPins to an empty array on a fresh day', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(itinerary.getDays()[0].poiPins).toEqual([]);
  });

  it('adds a pin to a day', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    const poi = { name: 'Café Elbblick', routeDistanceKm: 42 };

    itinerary.togglePoiPin(0, poi);

    expect(itinerary.getDays()[0].poiPins).toEqual([poi]);
  });

  it('toggling the same identity again removes it', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    const poi = { name: 'Café Elbblick', routeDistanceKm: 42 };

    itinerary.togglePoiPin(0, poi);
    itinerary.togglePoiPin(0, poi);

    expect(itinerary.getDays()[0].poiPins).toEqual([]);
  });

  it('keeps different POIs coexisting as separate pins', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    const cafe = { name: 'Café Elbblick', routeDistanceKm: 42 };
    const viewpoint = { name: 'Aussichtspunkt', routeDistanceKm: 55 };

    itinerary.togglePoiPin(0, cafe);
    itinerary.togglePoiPin(0, viewpoint);

    expect(itinerary.getDays()[0].poiPins).toEqual([cafe, viewpoint]);
  });

  it('treats POIs with the same name at different km as distinct', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    const a = { name: 'Bäckerei', routeDistanceKm: 10 };
    const b = { name: 'Bäckerei', routeDistanceKm: 20 };

    itinerary.togglePoiPin(0, a);
    itinerary.togglePoiPin(0, b);

    expect(itinerary.getDays()[0].poiPins).toEqual([a, b]);
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    expect(() => itinerary.togglePoiPin(5, { name: 'X', routeDistanceKm: 1 })).toThrow();
  });
});

describe('createItinerary - removeLastDay / reset', () => {
  it('drops the last day', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(60);

    itinerary.removeLastDay();

    const days = itinerary.getDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });
  });

  it('is a no-op when there are no days', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    expect(() => itinerary.removeLastDay()).not.toThrow();
    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('reset clears all days', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.reset();

    expect(itinerary.getDays()).toHaveLength(0);
    expect(itinerary.totalPlannedKm()).toBe(0);
  });
});

describe('createItinerary - totalPlannedKm', () => {
  it('is 0 with no days', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    expect(itinerary.totalPlannedKm()).toBe(0);
  });

  it('is the last day endKm', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80);
    expect(itinerary.totalPlannedKm()).toBe(160);
  });
});

describe('createItinerary - addDay validation', () => {
  it('throws on a zero targetKm', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    expect(() => itinerary.addDay(0)).toThrow();
  });

  it('throws on a negative targetKm', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    expect(() => itinerary.addDay(-10)).toThrow();
  });

  it('throws on a NaN targetKm', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    expect(() => itinerary.addDay(NaN)).toThrow();
  });

  it('does not add a day when validation fails', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    expect(() => itinerary.addDay(-10)).toThrow();
    expect(itinerary.getDays()).toHaveLength(0);
  });
});

describe('createItinerary - getDays defensive copy', () => {
  it('mutating the returned array/objects does not affect internal state', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);

    const days = itinerary.getDays();
    days.push({ index: 99, targetKm: 1, startKm: 0, endKm: 1, townChoice: null });
    days[0].targetKm = 9999;

    const freshDays = itinerary.getDays();
    expect(freshDays).toHaveLength(1);
    expect(freshDays[0].targetKm).toBe(80);
  });

  it('mutating the returned poiPins array does not affect internal state', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.togglePoiPin(0, { name: 'Café Elbblick', routeDistanceKm: 42 });

    const days = itinerary.getDays();
    days[0].poiPins.push({ name: 'Intruder', routeDistanceKm: 1 });

    const freshDays = itinerary.getDays();
    expect(freshDays[0].poiPins).toHaveLength(1);
  });
});

describe('createItinerary - persistence', () => {
  it('writes the exact payload shape to storage: no startKm/endKm leakage', () => {
    const storage = createFakeStorage();
    const itinerary = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });
    itinerary.addDay(80);
    itinerary.addDay(100);
    itinerary.setTownChoice(1, { name: 'Wittenberge' });

    itinerary.save();

    const raw = storage.store[STORAGE_KEY];
    const parsed = JSON.parse(raw);

    expect(Object.keys(parsed).sort()).toEqual(['days', 'routeVersion', 'schemaVersion'].sort());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.routeVersion).toBe('v1');
    expect(parsed.days).toHaveLength(2);
    for (const dayEntry of parsed.days) {
      expect(Object.keys(dayEntry).sort()).toEqual(['poiPins', 'targetKm', 'townChoice'].sort());
    }
    expect(parsed.days[0]).toEqual({ targetKm: 80, townChoice: null, poiPins: [] });
    expect(parsed.days[1]).toEqual({ targetKm: 100, townChoice: { name: 'Wittenberge' }, poiPins: [] });
  });

  it('persists poiPins alongside targetKm/townChoice', () => {
    const storage = createFakeStorage();
    const itinerary = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });
    itinerary.addDay(80);
    const poi = { name: 'Café Elbblick', routeDistanceKm: 42 };
    itinerary.togglePoiPin(0, poi);

    itinerary.save();

    const parsed = JSON.parse(storage.store[STORAGE_KEY]);
    expect(parsed.days[0].poiPins).toEqual([poi]);
  });

  it('round-trips through save() and a fresh load()', () => {
    const storage = createFakeStorage();
    const original = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });
    original.addDay(80);
    original.addDay(100);
    original.setTownChoice(1, { name: 'Wittenberge' });
    original.save();

    const reloaded = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });
    const result = reloaded.load();

    expect(result).toEqual({ loaded: true, routeChanged: false });
    expect(reloaded.getDays()).toEqual(original.getDays());
  });

  it('round-trips poiPins through save() and a fresh load()', () => {
    const storage = createFakeStorage();
    const original = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });
    original.addDay(80);
    original.togglePoiPin(0, { name: 'Café Elbblick', routeDistanceKm: 42 });
    original.togglePoiPin(0, { name: 'Aussichtspunkt', routeDistanceKm: 55 });
    original.save();

    const reloaded = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });
    reloaded.load();

    expect(reloaded.getDays()[0].poiPins).toEqual([
      { name: 'Café Elbblick', routeDistanceKm: 42 },
      { name: 'Aussichtspunkt', routeDistanceKm: 55 },
    ]);
  });

  it('loads an old payload without poiPins with poiPins defaulting to []', () => {
    const storage = createFakeStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        routeVersion: 'v1',
        days: [{ targetKm: 80, townChoice: null }],
      }),
    );
    const itinerary = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });

    const result = itinerary.load();

    expect(result).toEqual({ loaded: true, routeChanged: false });
    expect(itinerary.getDays()[0].poiPins).toEqual([]);
  });

  it('treats an absent key as empty', () => {
    const storage = createFakeStorage();
    const itinerary = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });

    const result = itinerary.load();

    expect(result).toEqual({ loaded: false, routeChanged: false });
    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('treats invalid JSON as empty, without throwing', () => {
    const storage = createFakeStorage();
    storage.setItem(STORAGE_KEY, '{not valid json');
    const itinerary = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });

    let result;
    expect(() => {
      result = itinerary.load();
    }).not.toThrow();

    expect(result).toEqual({ loaded: false, routeChanged: false });
    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('treats valid JSON with a malformed day (negative targetKm) as empty, without throwing', () => {
    const storage = createFakeStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        routeVersion: 'v1',
        days: [{ targetKm: 80, townChoice: null }, { targetKm: -5, townChoice: null }],
      }),
    );
    const itinerary = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });

    let result;
    expect(() => {
      result = itinerary.load();
    }).not.toThrow();

    expect(result).toEqual({ loaded: false, routeChanged: false });
    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('treats a schemaVersion mismatch as empty', () => {
    const storage = createFakeStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 2,
        routeVersion: 'v1',
        days: [{ targetKm: 80, townChoice: null }],
      }),
    );
    const itinerary = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'v1', storage });

    const result = itinerary.load();

    expect(result).toEqual({ loaded: false, routeChanged: false });
    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('replays stored days and flags routeChanged when routeVersion differs', () => {
    const storage = createFakeStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        routeVersion: 'old-version',
        days: [
          { targetKm: 300, townChoice: null },
          { targetKm: 200, townChoice: { name: 'Meissen' } },
        ],
      }),
    );
    const itinerary = createItinerary({ totalKm: TOTAL_KM, routeVersion: 'new-version', storage });

    const result = itinerary.load();

    expect(result).toEqual({ loaded: true, routeChanged: true });
    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 300 });
    // second day's target (200) overshoots the new totalKm (380) from 300 -> clamp
    expect(days[1]).toMatchObject({ startKm: 300, endKm: TOTAL_KM, townChoice: { name: 'Meissen' } });
  });

  it('does not throw on save()/load() when storage is omitted, and leaves days untouched', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);

    expect(() => itinerary.save()).not.toThrow();

    let result;
    expect(() => {
      result = itinerary.load();
    }).not.toThrow();

    expect(result).toEqual({ loaded: false, routeChanged: false });
    expect(itinerary.getDays()).toHaveLength(1);
  });
});
