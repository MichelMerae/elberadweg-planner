import { describe, it, expect } from 'vitest';
import { createItinerary } from './itinerary.js';

const TOTAL_KM = 380; // Hamburg -> Dresden, approx

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
