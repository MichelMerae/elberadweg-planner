import { describe, it, expect } from 'vitest';
import { createItinerary, breakKey } from './itinerary.js';

const TOTAL_KM = 380; // Hamburg -> Dresden, approx

// A well-formed break place snapshot, per the spec's break record shape.
function makeBreak(overrides = {}) {
  return {
    name: 'Café Deichblick',
    kind: 'food',
    category: 'cafe',
    lat: 53.38,
    lng: 10.41,
    routeDistanceKm: 35,
    offsetKm: 0.3,
    ...overrides,
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

  it('reset clears breaks too', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addBreak(makeBreak());

    itinerary.reset();

    expect(itinerary.getBreaks()).toHaveLength(0);
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
});

describe('createItinerary - hydrate', () => {
  it('replays entries into a chained itinerary with town choices', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    itinerary.hydrate([
      { targetKm: 80, townChoice: { name: 'A' } },
      { targetKm: 80, townChoice: null },
    ]);

    const days = itinerary.getDays();
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80, townChoice: { name: 'A' } });
    expect(days[1]).toMatchObject({ startKm: 80, endKm: 160, townChoice: null });
  });

  it('replays clamp against the current totalKm', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    itinerary.hydrate([
      { targetKm: 300, townChoice: null },
      { targetKm: 200, townChoice: { name: 'Meissen' } }, // 300 + 200 = 500, clamp to 380
    ]);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 300 });
    expect(days[1]).toMatchObject({ startKm: 300, endKm: TOTAL_KM, townChoice: { name: 'Meissen' } });
  });

  it('hydrates to empty on a malformed entry (negative targetKm), without throwing', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    expect(() =>
      itinerary.hydrate([
        { targetKm: 80, townChoice: null },
        { targetKm: -5, townChoice: null },
      ]),
    ).not.toThrow();

    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('hydrates to empty when passed a non-array, without throwing', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);

    expect(() => itinerary.hydrate(null)).not.toThrow();

    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('replaces any existing days', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(50);
    itinerary.addDay(50);
    itinerary.addDay(50);

    itinerary.hydrate([{ targetKm: 120, townChoice: null }]);

    const days = itinerary.getDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 120 });
  });

  it('defaults townChoice to null when an entry omits it', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    itinerary.hydrate([{ targetKm: 80 }]);

    expect(itinerary.getDays()[0].townChoice).toBeNull();
  });
});

describe('breakKey', () => {
  it('composes name@routeDistanceKm', () => {
    expect(breakKey({ name: 'Café X', routeDistanceKm: 42 })).toBe('Café X@42');
  });
});

describe('createItinerary - addBreak', () => {
  it('inserts breaks sorted by routeDistanceKm regardless of add order', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    itinerary.addBreak(makeBreak({ name: 'Third', routeDistanceKm: 120 }));
    itinerary.addBreak(makeBreak({ name: 'First', routeDistanceKm: 10 }));
    itinerary.addBreak(makeBreak({ name: 'Second', routeDistanceKm: 70 }));

    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('throws when routeDistanceKm is missing', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    const bad = makeBreak();
    delete bad.routeDistanceKm;
    expect(() => itinerary.addBreak(bad)).toThrow();
  });

  it('throws when routeDistanceKm is negative', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    expect(() => itinerary.addBreak(makeBreak({ routeDistanceKm: -5 }))).toThrow();
  });

  it('throws when lat is missing', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    const bad = makeBreak();
    delete bad.lat;
    expect(() => itinerary.addBreak(bad)).toThrow();
  });

  it('throws when lng is missing', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    const bad = makeBreak();
    delete bad.lng;
    expect(() => itinerary.addBreak(bad)).toThrow();
  });

  it('is a no-op when adding an existing key (name@routeDistanceKm), no duplicate', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    itinerary.addBreak(makeBreak({ name: 'Café X', routeDistanceKm: 42 }));
    itinerary.addBreak(makeBreak({ name: 'Café X', routeDistanceKm: 42, offsetKm: 9.9 }));

    const breaks = itinerary.getBreaks();
    expect(breaks).toHaveLength(1);
    expect(breaks[0].offsetKm).toBe(0.3); // first write wins; the duplicate add did nothing
  });

  it('treats the same name at a different km as a distinct break', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    itinerary.addBreak(makeBreak({ name: 'Bäckerei', routeDistanceKm: 10 }));
    itinerary.addBreak(makeBreak({ name: 'Bäckerei', routeDistanceKm: 20 }));

    expect(itinerary.getBreaks()).toHaveLength(2);
  });
});

describe('createItinerary - removeBreak', () => {
  it('removes the break matching the key', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'Café X', routeDistanceKm: 42 }));
    itinerary.addBreak(makeBreak({ name: 'Café Y', routeDistanceKm: 70 }));

    itinerary.removeBreak('Café X@42');

    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['Café Y']);
  });

  it('is a no-op for an unknown key', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'Café X', routeDistanceKm: 42 }));

    expect(() => itinerary.removeBreak('Nope@999')).not.toThrow();
    expect(itinerary.getBreaks()).toHaveLength(1);
  });
});

describe('createItinerary - getBreaks defensive copy', () => {
  it('mutating the returned array/objects does not affect internal state', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'Café X', routeDistanceKm: 42 }));

    const breaks = itinerary.getBreaks();
    breaks.push(makeBreak({ name: 'Intruder', routeDistanceKm: 1 }));
    breaks[0].name = 'Mutated';

    const fresh = itinerary.getBreaks();
    expect(fresh).toHaveLength(1);
    expect(fresh[0].name).toBe('Café X');
  });
});

describe('createItinerary - breaksInRange', () => {
  it('uses (start, end] semantics: excludes a break exactly at start, includes one exactly at end', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'AtStart', routeDistanceKm: 80 }));
    itinerary.addBreak(makeBreak({ name: 'Inside', routeDistanceKm: 120 }));
    itinerary.addBreak(makeBreak({ name: 'AtEnd', routeDistanceKm: 160 }));

    const names = itinerary.breaksInRange(80, 160).map((b) => b.name);
    expect(names).toEqual(['Inside', 'AtEnd']);
  });

  it('returns [] for equal or reversed bounds (empty range)', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'A', routeDistanceKm: 100 }));
    itinerary.addBreak(makeBreak({ name: 'B', routeDistanceKm: 120 }));

    expect(itinerary.breaksInRange(100, 100)).toEqual([]);
    expect(itinerary.breaksInRange(160, 80)).toEqual([]);
  });
});

describe('createItinerary - hydrate with breaks', () => {
  it('object form restores both days and breaks', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    itinerary.hydrate({
      days: [{ targetKm: 80, townChoice: { name: 'A' } }],
      breaks: [
        makeBreak({ name: 'Later', routeDistanceKm: 70 }),
        makeBreak({ name: 'Earlier', routeDistanceKm: 30 }),
      ],
    });

    expect(itinerary.getDays()).toHaveLength(1);
    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['Earlier', 'Later']);
  });

  it('drops malformed break entries silently while keeping valid ones', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    itinerary.hydrate({
      days: [{ targetKm: 80, townChoice: null }],
      breaks: [
        makeBreak({ name: 'Good', routeDistanceKm: 40 }),
        { name: 'NoCoords', routeDistanceKm: 50 }, // missing lat/lng
        makeBreak({ name: 'NegativeKm', routeDistanceKm: -1 }), // invalid km
        null,
      ],
    });

    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['Good']);
    expect(itinerary.getDays()).toHaveLength(1);
  });

  it('plain-array form hydrates days only (back-compat), leaving existing breaks intact', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'Kept', routeDistanceKm: 40 }));

    itinerary.hydrate([{ targetKm: 80, townChoice: null }]);

    expect(itinerary.getDays()).toHaveLength(1);
    // The array form manages days only; breaks seeded beforehand survive.
    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['Kept']);
  });

  it('object form with an omitted breaks field restores days and clears existing breaks', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'Wiped', routeDistanceKm: 40 }));

    itinerary.hydrate({ days: [{ targetKm: 80, townChoice: null }] });

    expect(itinerary.getDays()).toHaveLength(1);
    // The object form restores breaks wholesale; an omitted field means none.
    expect(itinerary.getBreaks()).toHaveLength(0);
  });

  it('collapses malformed days to empty yet still restores valid breaks (breaks independent of days)', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });

    itinerary.hydrate({
      days: [{ targetKm: 80, townChoice: null }, { targetKm: -5, townChoice: null }],
      breaks: [makeBreak({ name: 'Survivor', routeDistanceKm: 40 })],
    });

    expect(itinerary.getDays()).toHaveLength(0);
    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['Survivor']);
  });
});

describe('createItinerary - break re-bucketing across day edits', () => {
  it('re-derives which day a break falls in when a day distance changes', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addDay(80);
    itinerary.addDay(80); // day0 = (0,80], day1 = (80,160]
    itinerary.addBreak(makeBreak({ name: 'Stop', routeDistanceKm: 70 }));

    // Initially the break at km 70 falls in day 0's range.
    expect(itinerary.breaksInRange(0, 80).map((b) => b.name)).toEqual(['Stop']);
    expect(itinerary.breaksInRange(80, 160)).toHaveLength(0);

    // Shorten day 0 to 60: day0 = (0,60], day1 = (60,140]; the break moves to day 1.
    itinerary.editDay(0, 60);
    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 60 });
    expect(days[1]).toMatchObject({ startKm: 60, endKm: 140 });
    expect(itinerary.breaksInRange(days[0].startKm, days[0].endKm)).toHaveLength(0);
    expect(
      itinerary.breaksInRange(days[1].startKm, days[1].endKm).map((b) => b.name),
    ).toEqual(['Stop']);
  });
});

// Break removal in the UI matches ui.js row keys (name@km) against
// itinerary's breakKey. ui.js can't import itinerary.js (zero-imports rule),
// so this test is the only thing pinning the two conventions together.
describe('cross-module key contract', () => {
  it('ui townKey/poiKey and itinerary breakKey produce identical keys', async () => {
    const { townKey, poiKey } = await import('./ui.js');
    const place = makeBreak({ name: 'Fähre "Elbe" & Co', routeDistanceKm: 70.55 });
    expect(townKey(place)).toBe(breakKey(place));
    expect(poiKey(place)).toBe(breakKey(place));
  });
});

describe('createItinerary - break notes & custom stops', () => {
  it('keeps note and custom kind through addBreak/getBreaks', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ note: '15 min coffee' }));
    itinerary.addBreak({ kind: 'custom', name: 'lunch, 2h at the top', routeDistanceKm: 55.5, lat: 53.1, lng: 10.2 });

    const breaks = itinerary.getBreaks();
    expect(breaks[0].note).toBe('15 min coffee');
    expect(breaks[1]).toMatchObject({ kind: 'custom', name: 'lunch, 2h at the top' });
  });

  it('keeps note through a hydrate round-trip', () => {
    const a = createItinerary({ totalKm: TOTAL_KM });
    a.addDay(80);
    a.addBreak(makeBreak({ note: 'try the cake' }));

    const b = createItinerary({ totalKm: TOTAL_KM });
    b.hydrate({ days: a.getDays().map((d) => ({ targetKm: d.targetKm })), breaks: a.getBreaks() });

    expect(b.getBreaks()[0].note).toBe('try the cake');
  });
});

describe('createItinerary - updateBreak', () => {
  it('sets a note without changing the key or order', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'A', routeDistanceKm: 10 }));
    itinerary.addBreak(makeBreak({ name: 'B', routeDistanceKm: 20 }));

    const newKey = itinerary.updateBreak('A@10', { note: 'coffee' });

    expect(newKey).toBe('A@10');
    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['A', 'B']);
    expect(itinerary.getBreaks()[0].note).toBe('coffee');
  });

  it('clears the note when given an empty string', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ note: 'old' }));
    const key = breakKey(itinerary.getBreaks()[0]);

    itinerary.updateBreak(key, { note: '' });

    expect('note' in itinerary.getBreaks()[0]).toBe(false);
  });

  it('renames a break and returns the new key', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    const newKey = itinerary.updateBreak('lunch@30', { name: 'lunch, 2h' });

    expect(newKey).toBe('lunch, 2h@30');
    expect(itinerary.getBreaks()[0].name).toBe('lunch, 2h');
  });

  it('returns null and changes nothing for an unknown key', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'A', routeDistanceKm: 10 }));

    expect(itinerary.updateBreak('nope@99', { note: 'x' })).toBeNull();
    expect(itinerary.getBreaks()).toHaveLength(1);
    expect('note' in itinerary.getBreaks()[0]).toBe(false);
  });

  it('returns null for an empty or whitespace-only name', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    expect(itinerary.updateBreak('lunch@30', { name: '   ' })).toBeNull();
    expect(itinerary.getBreaks()[0].name).toBe('lunch');
  });

  it('returns null when a rename collides with an existing break', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak({ kind: 'custom', name: 'X', routeDistanceKm: 30, lat: 53, lng: 10 });
    itinerary.addBreak({ kind: 'custom', name: 'Y', routeDistanceKm: 30, lat: 53, lng: 10 });

    expect(itinerary.updateBreak('X@30', { name: 'Y' })).toBeNull();
    expect(itinerary.getBreaks().map((b) => b.name).sort()).toEqual(['X', 'Y']);
  });

  it('trims the new name before applying it', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    expect(itinerary.updateBreak('lunch@30', { name: '  picnic  ' })).toBe('picnic@30');
  });

  it('applies a combined name+note patch in one call', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    const newKey = itinerary.updateBreak('lunch@30', { name: 'lunch, 2h', note: 'bring sandwiches' });

    expect(newKey).toBe('lunch, 2h@30');
    expect(itinerary.getBreaks()[0]).toMatchObject({ name: 'lunch, 2h', note: 'bring sandwiches' });
  });
});
