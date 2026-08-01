import { describe, it, expect } from 'vitest';
import { createItinerary, breakKey } from './itinerary.js';
import { createTrip } from './trip.js';
import { MIN_DAY_KM } from './boundaries.js';

const TOTAL_KM = 380; // Hamburg -> Dresden, approx

// The whole road, ridden forwards from km 0 — the trip every plan had before a plan
// could have a window at all. The cases below are about chaining, clamping and
// rounding rather than orientation, so they all run on it and their numbers are
// unchanged. Orientation is proved separately, in 'oriented trips': on this trip
// `startKm 0` could come from the trip OR from a hardcoded zero, so nothing here
// can tell the two apart.
const WHOLE = createTrip({ startKm: 0, destinationKm: TOTAL_KM });

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

describe('createItinerary - construction', () => {
  // Without this the model would build days at NaN km and persist them: there is no
  // whole-road fallback to degrade to any more, because the origin every day chains
  // from now comes from the trip.
  it('throws without a trip rather than defaulting to some road', () => {
    expect(() => createItinerary()).toThrow(/trip/);
    expect(() => createItinerary({})).toThrow(/trip/);
  });

  // All three pieces of the trip's arithmetic are load-bearing here: advance chains
  // the days, tripKm measures every length, absoluteKm turns a length back into a
  // position (and boundaries.js converts every window with it). Something missing any
  // one of them would construct cleanly and then produce NaN km at the first edit —
  // the failure this guard exists to move to construction time.
  it('throws on a trip-shaped object missing the arithmetic it uses', () => {
    expect(() => createItinerary({ trip: { startKm: 0, advance: () => 0 } })).toThrow(/trip/);
    expect(() => createItinerary({ trip: { startKm: 0, tripKm: () => 0 } })).toThrow(/trip/);
    expect(() => createItinerary({ trip: { startKm: 0, absoluteKm: () => 0 } })).toThrow(/trip/);
    // Two of the three is still a stub that NaNs at the first edit.
    expect(
      () => createItinerary({ trip: { startKm: 0, advance: () => 0, tripKm: () => 0 } }),
    ).toThrow(/trip/);
  });
});

describe('createItinerary - chaining', () => {
  it('chains startKm/endKm across added days', () => {
    const itinerary = createItinerary({ trip: WHOLE });
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
    const itinerary = createItinerary({ trip: WHOLE });
    const day = itinerary.addDay(50);
    expect(day.startKm).toBe(0);
    expect(day.endKm).toBe(50);
  });
});

describe('createItinerary - clamping', () => {
  it('clamps endKm to the destination when a day overshoots Dresden', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(300);
    const day = itinerary.addDay(200); // 300 + 200 = 500, clamp to 380
    expect(day.endKm).toBe(TOTAL_KM);
  });
});

// The direction cases. Everything above rides the whole road forwards from km 0,
// where a day chained off the trip's start is indistinguishable from one chained off
// a hardcoded zero — these are the cases that can tell them apart.
describe('createItinerary - oriented trips', () => {
  const DOWN = createTrip({ startKm: 300, destinationKm: 100 }); // 200 km downstream

  it('starts day 1 at the trip start, not at km 0', () => {
    const up = createTrip({ startKm: 149.3, destinationKm: 797.6 }); // Hamburg -> Dresden
    const itinerary = createItinerary({ trip: up });
    itinerary.addDay(80);
    expect(itinerary.getDays()[0].startKm).toBeCloseTo(149.3, 6);
    expect(itinerary.getDays()[0].endKm).toBeCloseTo(229.3, 6);
  });

  it('walks DOWN in absolute km on a downstream trip', () => {
    const itinerary = createItinerary({ trip: DOWN });
    itinerary.addDay(80);
    itinerary.addDay(80);

    const days = itinerary.getDays();
    // targetKm stays the positive distance ridden; only the absolute km descend.
    expect(days[0]).toMatchObject({ startKm: 300, endKm: 220, targetKm: 80 });
    expect(days[1]).toMatchObject({ startKm: 220, endKm: 140, targetKm: 80 });
  });

  it('clamps the last day at the destination, downstream', () => {
    const itinerary = createItinerary({ trip: DOWN });
    itinerary.addDay(500);
    // Clamped at the DESTINATION, not at km 0: the road runs on past Hamburg, the
    // trip does not.
    expect(itinerary.getDays()[0].endKm).toBe(100);
  });

  it('reports planned distance as a positive number downstream', () => {
    const itinerary = createItinerary({ trip: DOWN });
    itinerary.addDay(80);
    // Naively `last.endKm` would read 220 km planned — the absolute km of the first
    // night — rather than the 80 km actually ridden.
    expect(itinerary.totalPlannedKm()).toBeCloseTo(80, 6);
  });

  it('buckets breaks by absolute km on a downstream trip', () => {
    const itinerary = createItinerary({ trip: DOWN });
    itinerary.addDay(80); // 300 -> 220
    itinerary.addBreak(makeBreak({ name: 'Café', routeDistanceKm: 260 }));

    const day = itinerary.getDays()[0];
    // The span arrives in trip order, so breaksInRange gets (300, 220) — a `from`
    // above its `to`.
    expect(itinerary.breaksInRange(day.startKm, day.endKm)).toHaveLength(1);
  });

  // The half-open rule is about which of two ADJACENT days owns the km they share,
  // so it has to keep its meaning in trip order: the km a day starts on belongs to
  // the day before, the km it ends on belongs to the day itself. Downstream that
  // exclusive end is the numerically LARGER km — normalising the span with a plain
  // min/max in absolute km would silently flip the rule over.
  it('keeps (start, end] pointing the same way in trip order, downstream', () => {
    const itinerary = createItinerary({ trip: DOWN });
    itinerary.addDay(80);
    itinerary.addDay(80); // day0 = (300, 220], day1 = (220, 140]
    itinerary.addBreak(makeBreak({ name: 'AtStart', routeDistanceKm: 300 }));
    itinerary.addBreak(makeBreak({ name: 'Inside', routeDistanceKm: 260 }));
    itinerary.addBreak(makeBreak({ name: 'AtEnd', routeDistanceKm: 220 }));

    const [day0, day1] = itinerary.getDays();
    // In trip order, so 'Inside' at km 260 comes first: getBreaks() is sorted by
    // ABSOLUTE km, which downstream is the order the rider meets them reversed.
    expect(itinerary.breaksInRange(day0.startKm, day0.endKm).map((b) => b.name)).toEqual([
      'Inside',
      'AtEnd',
    ]);
    // The shared km at 220 went to day 0, so day 1 does not claim it too.
    expect(itinerary.breaksInRange(day1.startKm, day1.endKm)).toHaveLength(0);
  });

  it('splits and merges days in trip order downstream', () => {
    const itinerary = createItinerary({ trip: DOWN });
    itinerary.addDay(100);
    itinerary.addDay(50);

    // splitDay works off the day's real span, which is a distance either way round.
    expect(itinerary.splitDay(0)).toMatchObject({ startKm: 300, endKm: 250, targetKm: 50 });
    expect(itinerary.getDays()[1]).toMatchObject({ startKm: 250, endKm: 200, targetKm: 50 });

    // deleteDay derives the merged length from positions, so it must not come out
    // negative — hydrate would then drop the whole plan on the next reload.
    itinerary.deleteDay(0);
    const days = itinerary.getDays();
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ startKm: 300, endKm: 200, targetKm: 100 });
    expect(days[1]).toMatchObject({ startKm: 200, endKm: 150, targetKm: 50 });
  });

  it('replays a stored plan along the trip on hydrate', () => {
    const itinerary = createItinerary({ trip: DOWN });

    itinerary.hydrate([{ targetKm: 80 }, { targetKm: 500 }]);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 300, endKm: 220 });
    expect(days[1]).toMatchObject({ startKm: 220, endKm: 100 }); // clamped at the destination
  });
});

// The three public boundary-editing entry points — moveBoundary, editDay and
// setTownChoice, which all funnel through moveBoundary — on trips that do not begin
// at km 0. boundaries.js measures a boundary window from a HARDCODED km-0 origin, so
// handing it absolute km puts its MIN_DAY_KM floor 149.3 km behind an offset rider
// and on the wrong side of a downstream one entirely. What comes back then is not
// merely a wrong position: the length derived from it is NEGATIVE, hydrate rejects a
// non-positive targetKm, and the next reload drops every day in the plan. So these
// cases are about a stored plan surviving, not about pixel-accurate drags.
describe('createItinerary - boundary edits on an offset or downstream trip', () => {
  const DOWN = createTrip({ startKm: 300, destinationKm: 100 }); // 200 km downstream
  const UP = createTrip({ startKm: 149.3, destinationKm: 797.6 }); // offset forward

  function twoDays(trip) {
    const itinerary = createItinerary({ trip });
    itinerary.addDay(80);
    itinerary.addDay(80);
    return itinerary;
  }

  it('moves the last boundary downstream instead of storing a negative length', () => {
    const itinerary = twoDays(DOWN); // (300, 220], (220, 140]

    itinerary.moveBoundary(1, 120); // 20 km further along, so day 1 becomes 100 km

    expect(itinerary.getDays()[1]).toMatchObject({ startKm: 220, endKm: 120, targetKm: 100 });
  });

  it('sets a downstream day length by typed distance', () => {
    const itinerary = twoDays(DOWN);

    itinerary.editDay(1, 100);

    expect(itinerary.getDays()[1]).toMatchObject({ startKm: 220, endKm: 120, targetKm: 100 });
  });

  it('snaps a downstream boundary to a chosen town', () => {
    const itinerary = twoDays(DOWN);

    itinerary.setTownChoice(1, { name: 'Lauenburg', routeDistanceKm: 150 });

    expect(itinerary.getDays()[1]).toMatchObject({ startKm: 220, endKm: 150, targetKm: 70 });
  });

  it('keeps the MIN_DAY_KM floor a floor on an offset trip', () => {
    const itinerary = twoDays(UP); // (149.3, 229.3], (229.3, 309.3]

    // Measured from a km-0 origin this 0.5 km day sits 148.8 km ABOVE the floor, so
    // it sails through; measured from the rider's own start it is what the floor is
    // there to refuse.
    itinerary.editDay(0, 0.5);

    expect(itinerary.getDays()[0].targetKm).toBe(MIN_DAY_KM);
    expect(itinerary.getDays()[0].endKm).toBeCloseTo(149.3 + MIN_DAY_KM, 6);
  });

  it('clamps a boundary dragged behind an offset trip start', () => {
    const itinerary = twoDays(UP);

    itinerary.moveBoundary(0, 100); // km 100 is 49.3 km BEHIND the rider's start

    const days = itinerary.getDays();
    expect(days[0].targetKm).toBeGreaterThan(0); // was -49.3
    expect(days[0].targetKm).toBe(MIN_DAY_KM);
    expect(days[0].endKm).toBeCloseTo(149.3 + MIN_DAY_KM, 6);
  });

  it('stores a positive length even on a zero-length trip', () => {
    const nowhere = createTrip({ startKm: 300, destinationKm: 300 });
    const itinerary = createItinerary({ trip: nowhere });
    itinerary.addDay(80); // nowhere to go, so the day spans 0 km at km 300

    itinerary.moveBoundary(0, 305);

    // A zero targetKm is as fatal to hydrate as a negative one: isValidTargetKm wants
    // a POSITIVE number, and one bad day drops the whole plan.
    expect(itinerary.getDays()[0]).toMatchObject({
      startKm: 300,
      endKm: 300,
      targetKm: MIN_DAY_KM,
    });
  });

  // The property, rather than the cases we happen to have thought of: whatever the
  // public API is asked to do, no day may be left with a length hydrate would reject.
  // The same shape as 'every emitted plan survives a reload' below, run on trips that
  // do not start at km 0.
  describe('no sequence of edits can store a day hydrate would reject', () => {
    function expectLoadable(itinerary, trip, label) {
      const days = itinerary.getDays();
      for (const day of days) {
        expect(day.targetKm, `${label}: targetKm must stay positive`).toBeGreaterThan(0);
      }
      const fresh = createItinerary({ trip });
      fresh.hydrate(days.map((d) => ({ targetKm: d.targetKm, townChoice: d.townChoice })));
      expect(fresh.getDays().length, `${label}: plan must survive a reload`).toBe(days.length);
    }

    for (const [name, trip] of [
      ['downstream', DOWN],
      ['offset forward', UP],
    ]) {
      it(`holds across a battery of edits, ${name}`, () => {
        const itinerary = createItinerary({ trip });
        [80, 80, 80].forEach((km) => itinerary.addDay(km));
        expectLoadable(itinerary, trip, `${name}: addDay`);

        // Each of these asks for something the trip cannot give, which is where an
        // unconverted boundary window produces its inverted days.
        itinerary.moveBoundary(0, trip.absoluteKm(-50)); // 50 km behind the start
        expectLoadable(itinerary, trip, `${name}: moveBoundary behind the start`);

        itinerary.editDay(1, 0.5); // under the minimum
        expectLoadable(itinerary, trip, `${name}: editDay under the minimum`);

        itinerary.setTownChoice(0, { name: 'Too Early', routeDistanceKm: trip.absoluteKm(1) });
        expectLoadable(itinerary, trip, `${name}: setTownChoice before the floor`);

        itinerary.splitDay(2);
        expectLoadable(itinerary, trip, `${name}: splitDay`);

        itinerary.deleteDay(0);
        expectLoadable(itinerary, trip, `${name}: deleteDay`);

        const last = itinerary.getDays().length - 1;
        itinerary.moveBoundary(last, trip.absoluteKm(trip.lengthKm + 100)); // past the end
        expectLoadable(itinerary, trip, `${name}: moveBoundary past the destination`);
      });
    }
  });
});

describe('createItinerary - moveBoundary', () => {
  it('moves one boundary and lets the next day absorb the delta', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addDay(80); // boundaries at 80 / 160 / 240 / 320

    itinerary.moveBoundary(2, 265);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });
    expect(days[1]).toMatchObject({ startKm: 80, endKm: 160 });
    expect(days[2]).toMatchObject({ startKm: 160, endKm: 265, targetKm: 105 });
    expect(days[3]).toMatchObject({ startKm: 265, endKm: 320, targetKm: 55 });
  });

  it('leaves days beyond the neighbour completely untouched', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    [80, 80, 80, 80, 80].forEach((km) => itinerary.addDay(km));
    // TOTAL_KM is 380, so day 4 is clamped from the start: {320, 380}.

    itinerary.moveBoundary(1, 130);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });    // before the boundary: still
    expect(days[2]).toMatchObject({ startKm: 130, endKm: 240 }); // the neighbour: absorbs the 30 km
    expect(days[3]).toMatchObject({ startKm: 240, endKm: 320 }); // beyond: untouched
    expect(days[4]).toMatchObject({ startKm: 320, endKm: 380 }); // beyond: untouched, still clamped
  });

  it('clamps so the edited day keeps MIN_DAY_KM', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.moveBoundary(0, 1);

    expect(itinerary.getDays()[0].endKm).toBe(5);
  });

  it('clamps so the neighbour keeps MIN_DAY_KM', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.moveBoundary(0, 300);

    const days = itinerary.getDays();
    expect(days[0].endKm).toBe(155);
    expect(days[1]).toMatchObject({ startKm: 155, endKm: 160, targetKm: 5 });
  });

  it('extends the plan when the last boundary moves out', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);

    itinerary.moveBoundary(0, 120);

    expect(itinerary.getDays()[0]).toMatchObject({ endKm: 120, targetKm: 120 });
    expect(itinerary.totalPlannedKm()).toBe(120);
  });

  it('clamps the last boundary to the destination', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);

    itinerary.moveBoundary(0, TOTAL_KM + 100);

    expect(itinerary.getDays()[0].endKm).toBe(TOTAL_KM);
  });

  it('rounds to one decimal so stored lengths stay tidy', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80.1); // fractional, so the assignment-site rounding actually matters
    itinerary.addDay(80);

    itinerary.moveBoundary(0, 76.2345);

    const days = itinerary.getDays();
    expect(days[0].targetKm).toBe(76.2);
    expect(days[1].targetKm).toBe(83.9);
  });

  it('keeps days beyond the neighbour put even when the target lands between rounding steps', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    [80, 80, 80, 80].forEach((km) => itinerary.addDay(km));

    itinerary.moveBoundary(1, 156.25); // both halves would round up, adding 0.1 km to the pair

    const days = itinerary.getDays();
    expect(days[1].targetKm + days[2].targetKm).toBeCloseTo(160, 9); // the pair's span
    expect(days[2].endKm).toBeCloseTo(240, 9);
    expect(days[3]).toMatchObject({ targetKm: 80 });
    expect(days[3].startKm).toBeCloseTo(240, 9);
  });

  it('ignores a sub-0.05 km jitter drag on a day whose length already matches', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.moveBoundary(0, 80.03);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ endKm: 80, targetKm: 80 });
    expect(days[1]).toMatchObject({ startKm: 80, endKm: 160, targetKm: 80 });
  });

  it('still normalises an inflated length when the boundary cannot move', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(300);
    itinerary.addDay(200); // clamped to {300, 380} while targetKm stays 200

    const day = itinerary.editDay(1, 90); // clamps back to the boundary it already sits on

    // Asserting the RETURN value: callers detect clamping by comparing it to what
    // they asked for, so it has to reflect reality.
    expect(day).toMatchObject({ startKm: 300, endKm: TOTAL_KM, targetKm: 80 });
    expect(itinerary.getDays()[1].targetKm).toBe(80);
  });

  it('moves the boundary on the first drag even when the stored length overshot the route', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(300);
    itinerary.addDay(200); // endKm clamps to 380 while targetKm stays 200

    itinerary.moveBoundary(1, 350);

    expect(itinerary.getDays()[1]).toMatchObject({ startKm: 300, endKm: 350, targetKm: 50 });
  });

  it("preserves the neighbour's end and normalises its inflated length", () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.hydrate([{ targetKm: 100 }, { targetKm: 400 }]); // day 1 clamped to {100, 380}, targetKm 400

    itinerary.moveBoundary(0, 150);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ endKm: 150 });
    // 230 is day 1's real span. Normalising an inflated neighbour is intended, not
    // incidental: a drag is explicit intent on this boundary pair, unlike hydrate,
    // where the stored plan must survive intact for the route-changed banner.
    expect(days[1]).toMatchObject({ startKm: 150, endKm: TOTAL_KM, targetKm: 230 });
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    expect(() => itinerary.moveBoundary(5, 50)).toThrow();
  });

  it('throws on a non-finite endKm', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    expect(() => itinerary.moveBoundary(0, Number.NaN)).toThrow();
  });
});

describe('createItinerary - editDay (local, typed distance)', () => {
  it('sets the edited day length and lets the neighbour absorb it', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.editDay(0, 100);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 100, targetKm: 100 });
    expect(days[1]).toMatchObject({ startKm: 100, endKm: 160, targetKm: 60 });
    expect(days[2]).toMatchObject({ startKm: 160, endKm: 240, targetKm: 80 });
  });

  it('clamps a length that would starve the neighbour', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.editDay(0, 350);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 155 });
    expect(days[1]).toMatchObject({ startKm: 155, endKm: 160 });
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    expect(() => itinerary.editDay(5, 50)).toThrow();
  });

  it('throws on an invalid targetKm', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    expect(() => itinerary.editDay(0, -10)).toThrow();
  });
});

describe('createItinerary - setTownChoice', () => {
  it('attaches a town choice to a day', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    const town = { name: 'Lauenburg' };

    itinerary.setTownChoice(0, town);

    expect(itinerary.getDays()[0].townChoice).toEqual(town);
  });

  it('replaces an existing town choice', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);

    itinerary.setTownChoice(0, { name: 'A' });
    itinerary.setTownChoice(0, { name: 'B' });

    expect(itinerary.getDays()[0].townChoice).toEqual({ name: 'B' });
  });

  it('defaults townChoice to null on a fresh day', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    expect(itinerary.getDays()[0].townChoice).toBeNull();
  });

  it('snaps the boundary to the chosen town and lets the neighbour absorb it', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.setTownChoice(0, { name: 'Boizenburg/Elbe', routeDistanceKm: 76.2, offsetKm: 0.33 });

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ endKm: 76.2, targetKm: 76.2 });
    expect(days[1]).toMatchObject({ startKm: 76.2, endKm: 160, targetKm: 83.8 });
  });

  it('clamps a snap that would starve the neighbour, keeping the town', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(8); // next boundary at km 88, so the upper clamp is 83

    itinerary.setTownChoice(0, { name: 'Too Close', routeDistanceKm: 86 });

    const days = itinerary.getDays();
    expect(days[0].endKm).toBe(83);
    // The panel derives its "stopped at" note from this mismatch.
    expect(days[0].townChoice.routeDistanceKm).toBe(86);
  });

  it('leaves the boundary alone for a town with no route position', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);

    itinerary.setTownChoice(0, { name: 'Nowhere' });

    expect(itinerary.getDays()[0].endKm).toBe(80);
  });

  it('resizes the plan when the last day gets a town', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80); // plan ends at km 160

    itinerary.setTownChoice(1, { name: 'Dömitz', routeDistanceKm: 150 });

    const days = itinerary.getDays();
    // The last boundary has no neighbour to absorb the change, so the plan's own
    // end moves: sleeping at km 150 on your last planned night means the plan ends
    // there, and the distance still to ride to Dresden grows to match.
    expect(days[1]).toMatchObject({ startKm: 80, endKm: 150, targetKm: 70 });
    expect(itinerary.totalPlannedKm()).toBe(150);
    expect(days).toHaveLength(2);
  });

  it('clamps a town that sits before the day can legally end', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.setTownChoice(0, { name: 'Too Early', routeDistanceKm: 2 });

    const days = itinerary.getDays();
    // The lower clamp, the mirror of the starve case above.
    expect(days[0].endKm).toBe(MIN_DAY_KM);
    expect(days[1]).toMatchObject({ startKm: MIN_DAY_KM, endKm: 160, targetKm: 155 });
    expect(days[0].townChoice.routeDistanceKm).toBe(2);
  });

  it('records a town even when the boundary has nowhere legal to move', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(6);
    itinerary.addDay(3); // the pair spans 9 km, under 2 x MIN_DAY_KM

    itinerary.setTownChoice(0, { name: 'Wedged', routeDistanceKm: 8 });

    const days = itinerary.getDays();
    // moveBoundary refuses outright — no position leaves both days their minimum.
    // The town is still recorded, so the panel can show it alongside the note that
    // the boundary could not reach it.
    expect(days[0]).toMatchObject({ endKm: 6, targetKm: 6 });
    expect(days[1]).toMatchObject({ startKm: 6, endKm: 9 });
    expect(days[0].townChoice.routeDistanceKm).toBe(8);
  });

  it('ignores a town whose route position is not a real number', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);

    // Pins the Number.isFinite half of the guard specifically. A `typeof === 'number'`
    // check alone would pass NaN through to moveBoundary, which throws on a
    // non-finite endKm — so one malformed town record would break the click handler
    // rather than being ignored.
    expect(() => itinerary.setTownChoice(0, { name: 'Corrupt', routeDistanceKm: Number.NaN })).not.toThrow();
    expect(itinerary.getDays()[0].endKm).toBe(80);
  });

  it('leaves the boundary alone when the town choice is cleared', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.setTownChoice(0, { name: 'Boizenburg/Elbe', routeDistanceKm: 76.2 });

    itinerary.setTownChoice(0, null);

    const day = itinerary.getDays()[0];
    expect(day.townChoice).toBeNull();
    expect(day.endKm).toBe(76.2);
  });
});

describe('createItinerary - removeLastDay / reset', () => {
  it('drops the last day', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(60);

    itinerary.removeLastDay();

    const days = itinerary.getDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });
  });

  it('is a no-op when there are no days', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    expect(() => itinerary.removeLastDay()).not.toThrow();
    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('reset clears all days', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);

    itinerary.reset();

    expect(itinerary.getDays()).toHaveLength(0);
    expect(itinerary.totalPlannedKm()).toBe(0);
  });

  it('reset clears breaks too', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addBreak(makeBreak());

    itinerary.reset();

    expect(itinerary.getBreaks()).toHaveLength(0);
  });
});

describe('createItinerary - totalPlannedKm', () => {
  it('is 0 with no days', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    expect(itinerary.totalPlannedKm()).toBe(0);
  });

  it('is the distance ridden across all days', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);
    expect(itinerary.totalPlannedKm()).toBe(160);
  });
});

describe('createItinerary - addDay validation', () => {
  it('throws on a zero targetKm', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    expect(() => itinerary.addDay(0)).toThrow();
  });

  it('throws on a negative targetKm', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    expect(() => itinerary.addDay(-10)).toThrow();
  });

  it('throws on a NaN targetKm', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    expect(() => itinerary.addDay(NaN)).toThrow();
  });

  it('does not add a day when validation fails', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    expect(() => itinerary.addDay(-10)).toThrow();
    expect(itinerary.getDays()).toHaveLength(0);
  });
});

describe('createItinerary - getDays defensive copy', () => {
  it('mutating the returned array/objects does not affect internal state', () => {
    const itinerary = createItinerary({ trip: WHOLE });
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
    const itinerary = createItinerary({ trip: WHOLE });

    itinerary.hydrate([
      { targetKm: 80, townChoice: { name: 'A' } },
      { targetKm: 80, townChoice: null },
    ]);

    const days = itinerary.getDays();
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80, townChoice: { name: 'A' } });
    expect(days[1]).toMatchObject({ startKm: 80, endKm: 160, townChoice: null });
  });

  it('replays clamp against the current destination', () => {
    const itinerary = createItinerary({ trip: WHOLE });

    itinerary.hydrate([
      { targetKm: 300, townChoice: null },
      { targetKm: 200, townChoice: { name: 'Meissen' } }, // 300 + 200 = 500, clamp to 380
    ]);

    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 300 });
    expect(days[1]).toMatchObject({ startKm: 300, endKm: TOTAL_KM, townChoice: { name: 'Meissen' } });
  });

  it('hydrates to empty on a malformed entry (negative targetKm), without throwing', () => {
    const itinerary = createItinerary({ trip: WHOLE });

    expect(() =>
      itinerary.hydrate([
        { targetKm: 80, townChoice: null },
        { targetKm: -5, townChoice: null },
      ]),
    ).not.toThrow();

    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('hydrates to empty when passed a non-array, without throwing', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);

    expect(() => itinerary.hydrate(null)).not.toThrow();

    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('replaces any existing days', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(50);
    itinerary.addDay(50);
    itinerary.addDay(50);

    itinerary.hydrate([{ targetKm: 120, townChoice: null }]);

    const days = itinerary.getDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 120 });
  });

  it('defaults townChoice to null when an entry omits it', () => {
    const itinerary = createItinerary({ trip: WHOLE });

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
    const itinerary = createItinerary({ trip: WHOLE });

    itinerary.addBreak(makeBreak({ name: 'Third', routeDistanceKm: 120 }));
    itinerary.addBreak(makeBreak({ name: 'First', routeDistanceKm: 10 }));
    itinerary.addBreak(makeBreak({ name: 'Second', routeDistanceKm: 70 }));

    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['First', 'Second', 'Third']);
  });

  it('throws when routeDistanceKm is missing', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    const bad = makeBreak();
    delete bad.routeDistanceKm;
    expect(() => itinerary.addBreak(bad)).toThrow();
  });

  it('throws when routeDistanceKm is negative', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    expect(() => itinerary.addBreak(makeBreak({ routeDistanceKm: -5 }))).toThrow();
  });

  it('throws when lat is missing', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    const bad = makeBreak();
    delete bad.lat;
    expect(() => itinerary.addBreak(bad)).toThrow();
  });

  it('throws when lng is missing', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    const bad = makeBreak();
    delete bad.lng;
    expect(() => itinerary.addBreak(bad)).toThrow();
  });

  it('is a no-op when adding an existing key (name@routeDistanceKm), no duplicate', () => {
    const itinerary = createItinerary({ trip: WHOLE });

    itinerary.addBreak(makeBreak({ name: 'Café X', routeDistanceKm: 42 }));
    itinerary.addBreak(makeBreak({ name: 'Café X', routeDistanceKm: 42, offsetKm: 9.9 }));

    const breaks = itinerary.getBreaks();
    expect(breaks).toHaveLength(1);
    expect(breaks[0].offsetKm).toBe(0.3); // first write wins; the duplicate add did nothing
  });

  it('treats the same name at a different km as a distinct break', () => {
    const itinerary = createItinerary({ trip: WHOLE });

    itinerary.addBreak(makeBreak({ name: 'Bäckerei', routeDistanceKm: 10 }));
    itinerary.addBreak(makeBreak({ name: 'Bäckerei', routeDistanceKm: 20 }));

    expect(itinerary.getBreaks()).toHaveLength(2);
  });
});

describe('createItinerary - removeBreak', () => {
  it('removes the break matching the key', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ name: 'Café X', routeDistanceKm: 42 }));
    itinerary.addBreak(makeBreak({ name: 'Café Y', routeDistanceKm: 70 }));

    itinerary.removeBreak('Café X@42');

    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['Café Y']);
  });

  it('is a no-op for an unknown key', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ name: 'Café X', routeDistanceKm: 42 }));

    expect(() => itinerary.removeBreak('Nope@999')).not.toThrow();
    expect(itinerary.getBreaks()).toHaveLength(1);
  });
});

describe('createItinerary - getBreaks defensive copy', () => {
  it('mutating the returned array/objects does not affect internal state', () => {
    const itinerary = createItinerary({ trip: WHOLE });
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
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ name: 'AtStart', routeDistanceKm: 80 }));
    itinerary.addBreak(makeBreak({ name: 'Inside', routeDistanceKm: 120 }));
    itinerary.addBreak(makeBreak({ name: 'AtEnd', routeDistanceKm: 160 }));

    const names = itinerary.breaksInRange(80, 160).map((b) => b.name);
    expect(names).toEqual(['Inside', 'AtEnd']);
  });

  it('returns [] for equal bounds: a zero-length span owns nothing', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ name: 'A', routeDistanceKm: 100 }));
    itinerary.addBreak(makeBreak({ name: 'B', routeDistanceKm: 120 }));

    expect(itinerary.breaksInRange(100, 100)).toEqual([]);
  });

  // The one assertion in this file whose EXPECTATION changed rather than its
  // construction, and deliberately: `breaksInRange(160, 80)` used to return [],
  // because on an ascending trip only a caller bug produced a span given high to
  // low. A downstream day's span arrives high to low legitimately — day 0 of a
  // Dresden -> Hamburg trip is (300, 220] — so the span is normalised into trip
  // order now instead of read as empty. Downstream is proved in 'oriented trips';
  // this pins the ascending side of the same normalisation.
  it('normalises a span handed over the wrong way round rather than emptying it', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ name: 'A', routeDistanceKm: 100 }));
    itinerary.addBreak(makeBreak({ name: 'B', routeDistanceKm: 120 }));

    expect(itinerary.breaksInRange(160, 80).map((b) => b.name)).toEqual(['A', 'B']);
  });
});

// Which day a km belongs to has exactly one owner, `dayOwnsKm`, because before it the
// rule was spelled three times across two files — in absolute km, where every
// comparison reads backwards downstream. breaksForDay filters through the same
// predicate, so a day card and the stop the rider just dropped can never disagree
// about whose leg it is on.
describe('createItinerary - dayOwnsKm', () => {
  it('gives a shared boundary km to the day that ENDS on it', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80); // day 0 = (0, 80], day 1 = (80, 160]

    expect(itinerary.dayOwnsKm(0, 80)).toBe(true);
    expect(itinerary.dayOwnsKm(1, 80)).toBe(false);
    expect(itinerary.dayOwnsKm(1, 80.1)).toBe(true);
    expect(itinerary.dayOwnsKm(0, 80.1)).toBe(false);
  });

  // Day 0's start is the one boundary with no previous day to hand the shared km to,
  // so it keeps it: a stop dropped exactly on the rider's start line has to be on some
  // day's leg, or the day card never lists it and there is no × to remove it with.
  it('gives day 0 its own start line', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);

    expect(itinerary.dayOwnsKm(0, 0)).toBe(true);
  });

  // The comparison happens in rider km, which is what makes one spelling work both
  // ways round. In absolute km the `>`/`<=` pair reads backwards downstream: it would
  // accept 301 (behind the rider) and refuse 260 (squarely inside the day).
  it('reads the same way round on a downstream trip', () => {
    const down = createTrip({ startKm: 300, destinationKm: 100 });
    const itinerary = createItinerary({ trip: down });
    itinerary.addDay(80); // day 0 = (300, 220]
    itinerary.addDay(80); // day 1 = (220, 140]

    expect(itinerary.dayOwnsKm(0, 300)).toBe(true); // its own start line
    expect(itinerary.dayOwnsKm(0, 301)).toBe(false); // behind the rider, not on any day
    expect(itinerary.dayOwnsKm(0, 260)).toBe(true);
    expect(itinerary.dayOwnsKm(0, 220)).toBe(true); // the km it ends on
    // The far end is never widened — only day 0's START line is, and only because
    // nothing else can own it.
    expect(itinerary.dayOwnsKm(0, 219.9)).toBe(false);
    expect(itinerary.dayOwnsKm(1, 220)).toBe(false);
    expect(itinerary.dayOwnsKm(1, 219.9)).toBe(true);
  });

  it('throws on a day that is not there rather than answering false', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);

    expect(() => itinerary.dayOwnsKm(1, 40)).toThrow(/index/);
  });
});

describe('createItinerary - breaksForDay', () => {
  it('buckets the plan breaks by day, day 0 keeping the one on its start line', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addBreak(makeBreak({ name: 'OnTheStartLine', routeDistanceKm: 0 }));
    itinerary.addBreak(makeBreak({ name: 'Inside', routeDistanceKm: 40 }));
    itinerary.addBreak(makeBreak({ name: 'OnTheBoundary', routeDistanceKm: 80 }));
    itinerary.addBreak(makeBreak({ name: 'NextDay', routeDistanceKm: 120 }));

    expect(itinerary.breaksForDay(0).map((b) => b.name)).toEqual([
      'OnTheStartLine',
      'Inside',
      'OnTheBoundary',
    ]);
    expect(itinerary.breaksForDay(1).map((b) => b.name)).toEqual(['NextDay']);
  });

  // Both halves of the same claim: the near end opens for day 0 and the far end stays
  // shut. Asserted through the day-keyed form AND through the span primitive, which is
  // the other way an app could ask the same question.
  it("lists a downstream day's breaks in trip order without widening the far end", () => {
    const down = createTrip({ startKm: 300, destinationKm: 100 });
    const itinerary = createItinerary({ trip: down });
    itinerary.addDay(80); // day 0 = (300, 220]
    itinerary.addBreak(makeBreak({ name: 'BehindTheRider', routeDistanceKm: 301 }));
    itinerary.addBreak(makeBreak({ name: 'OnTheStartLine', routeDistanceKm: 300 }));
    itinerary.addBreak(makeBreak({ name: 'JustInside', routeDistanceKm: 299.5 }));
    itinerary.addBreak(makeBreak({ name: 'PastTheEnd', routeDistanceKm: 219.9 }));

    // getBreaks() is sorted by ABSOLUTE km, which downstream is the order the rider
    // meets them reversed — so this also pins the re-sort.
    expect(itinerary.breaksForDay(0).map((b) => b.name)).toEqual([
      'OnTheStartLine',
      'JustInside',
    ]);
    const day = itinerary.getDays()[0];
    expect(itinerary.breaksInRange(day.startKm, day.endKm).map((b) => b.name)).toEqual([
      'JustInside',
    ]);
  });

  // A day CAN be zero-length: a stored plan replayed against a shorter window piles its
  // trailing days at the destination, and with one day in the plan that day is day 0.
  // It still owns the break on its own start line — nothing else can — even though the
  // span primitive reads a zero-length span as owning nothing.
  it('lets a zero-length day 0 own the break on its start line', () => {
    const itinerary = createItinerary({ trip: createTrip({ startKm: 0, destinationKm: 100 }) });
    itinerary.addDay(100); // ends at the destination
    itinerary.addDay(50); // nowhere left to go: (100, 100]
    itinerary.addBreak(makeBreak({ name: 'Stop', routeDistanceKm: 100 }));

    expect(itinerary.breaksForDay(1).map((b) => b.name)).toEqual([]);
    expect(itinerary.breaksInRange(100, 100)).toEqual([]);

    const first = createItinerary({ trip: createTrip({ startKm: 100, destinationKm: 100 }) });
    first.addDay(50); // a zero-length day 0 on a zero-length window
    first.addBreak(makeBreak({ name: 'Stop', routeDistanceKm: 100 }));
    expect(first.breaksForDay(0).map((b) => b.name)).toEqual(['Stop']);
  });
});

describe('createItinerary - hydrate with breaks', () => {
  it('object form restores both days and breaks', () => {
    const itinerary = createItinerary({ trip: WHOLE });

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
    const itinerary = createItinerary({ trip: WHOLE });

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
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ name: 'Kept', routeDistanceKm: 40 }));

    itinerary.hydrate([{ targetKm: 80, townChoice: null }]);

    expect(itinerary.getDays()).toHaveLength(1);
    // The array form manages days only; breaks seeded beforehand survive.
    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['Kept']);
  });

  it('object form with an omitted breaks field restores days and clears existing breaks', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ name: 'Wiped', routeDistanceKm: 40 }));

    itinerary.hydrate({ days: [{ targetKm: 80, townChoice: null }] });

    expect(itinerary.getDays()).toHaveLength(1);
    // The object form restores breaks wholesale; an omitted field means none.
    expect(itinerary.getBreaks()).toHaveLength(0);
  });

  it('collapses malformed days to empty yet still restores valid breaks (breaks independent of days)', () => {
    const itinerary = createItinerary({ trip: WHOLE });

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
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80); // day0 = (0,80], day1 = (80,160]
    itinerary.addBreak(makeBreak({ name: 'Stop', routeDistanceKm: 70 }));

    // Initially the break at km 70 falls in day 0's range.
    expect(itinerary.breaksInRange(0, 80).map((b) => b.name)).toEqual(['Stop']);
    expect(itinerary.breaksInRange(80, 160)).toHaveLength(0);

    // Shorten day 0 to 60: day0 = (0,60], day1 = (60,160]; the break moves to day 1.
    itinerary.editDay(0, 60);
    const days = itinerary.getDays();
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 60 });
    expect(days[1]).toMatchObject({ startKm: 60, endKm: 160 });
    expect(itinerary.breaksInRange(days[0].startKm, days[0].endKm)).toHaveLength(0);
    expect(
      itinerary.breaksInRange(days[1].startKm, days[1].endKm).map((b) => b.name),
    ).toEqual(['Stop']);
  });
});

// Break removal in the UI matches the render modules' row keys (name@km, from
// ui-util.js, re-exported by ui.js) against itinerary's breakKey. The two are
// character-identical implementations of one format, and deliberately stay that
// way: ui-util.js imports no data module and the model imports no render helper,
// so neither can import the other without inverting a layer. This test is the
// mechanism that keeps them from drifting — the whole reason it can be left as a
// duplication.
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
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ note: '15 min coffee' }));
    itinerary.addBreak({ kind: 'custom', name: 'lunch, 2h at the top', routeDistanceKm: 55.5, lat: 53.1, lng: 10.2 });

    const breaks = itinerary.getBreaks();
    expect(breaks[0].note).toBe('15 min coffee');
    expect(breaks[1]).toMatchObject({ kind: 'custom', name: 'lunch, 2h at the top' });
  });

  it('keeps note through a hydrate round-trip', () => {
    const a = createItinerary({ trip: WHOLE });
    a.addDay(80);
    a.addBreak(makeBreak({ note: 'try the cake' }));

    const b = createItinerary({ trip: WHOLE });
    b.hydrate({ days: a.getDays().map((d) => ({ targetKm: d.targetKm })), breaks: a.getBreaks() });

    expect(b.getBreaks()[0].note).toBe('try the cake');
  });
});

describe('createItinerary - updateBreak', () => {
  it('sets a note without changing the key or order', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ name: 'A', routeDistanceKm: 10 }));
    itinerary.addBreak(makeBreak({ name: 'B', routeDistanceKm: 20 }));

    const newKey = itinerary.updateBreak('A@10', { note: 'coffee' });

    expect(newKey).toBe('A@10');
    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['A', 'B']);
    expect(itinerary.getBreaks()[0].note).toBe('coffee');
  });

  it('clears the note when given an empty string', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ note: 'old' }));
    const key = breakKey(itinerary.getBreaks()[0]);

    itinerary.updateBreak(key, { note: '' });

    expect('note' in itinerary.getBreaks()[0]).toBe(false);
  });

  it('renames a break and returns the new key', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    const newKey = itinerary.updateBreak('lunch@30', { name: 'lunch, 2h' });

    expect(newKey).toBe('lunch, 2h@30');
    expect(itinerary.getBreaks()[0].name).toBe('lunch, 2h');
  });

  it('returns null and changes nothing for an unknown key', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak(makeBreak({ name: 'A', routeDistanceKm: 10 }));

    expect(itinerary.updateBreak('nope@99', { note: 'x' })).toBeNull();
    expect(itinerary.getBreaks()).toHaveLength(1);
    expect('note' in itinerary.getBreaks()[0]).toBe(false);
  });

  it('returns null for an empty or whitespace-only name', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    expect(itinerary.updateBreak('lunch@30', { name: '   ' })).toBeNull();
    expect(itinerary.getBreaks()[0].name).toBe('lunch');
  });

  it('returns null when a rename collides with an existing break', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak({ kind: 'custom', name: 'X', routeDistanceKm: 30, lat: 53, lng: 10 });
    itinerary.addBreak({ kind: 'custom', name: 'Y', routeDistanceKm: 30, lat: 53, lng: 10 });

    expect(itinerary.updateBreak('X@30', { name: 'Y' })).toBeNull();
    expect(itinerary.getBreaks().map((b) => b.name).sort()).toEqual(['X', 'Y']);
  });

  it('trims the new name before applying it', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    expect(itinerary.updateBreak('lunch@30', { name: '  picnic  ' })).toBe('picnic@30');
  });

  it('applies a combined name+note patch in one call', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    const newKey = itinerary.updateBreak('lunch@30', { name: 'lunch, 2h', note: 'bring sandwiches' });

    expect(newKey).toBe('lunch, 2h@30');
    expect(itinerary.getBreaks()[0]).toMatchObject({ name: 'lunch, 2h', note: 'bring sandwiches' });
  });
});

describe('createItinerary - splitDay', () => {
  it('splits a day in half, preserving the total', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(100);
    itinerary.addDay(80);

    // The return value is the FIRST half — the day still at `index`, matching
    // what moveBoundary/editDay/setTownChoice return. Asserted so the choice is
    // pinned rather than incidental.
    expect(itinerary.splitDay(0)).toMatchObject({ index: 0, startKm: 0, endKm: 50 });

    const days = itinerary.getDays();
    expect(days).toHaveLength(3);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 50 });
    expect(days[1]).toMatchObject({ startKm: 50, endKm: 100 });
    expect(days[2]).toMatchObject({ startKm: 100, endKm: 180 });
  });

  it('gives the overnight town to the second half and none to the first', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(100);
    itinerary.setTownChoice(0, { name: 'Lenzen' });

    itinerary.splitDay(0);

    const days = itinerary.getDays();
    expect(days[0].townChoice).toBeNull();
    expect(days[1].townChoice).toEqual({ name: 'Lenzen' });
  });

  it('refuses to split a day shorter than two minimum days', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(9);

    expect(itinerary.splitDay(0)).toBeNull();
    expect(itinerary.getDays()).toHaveLength(1);
  });

  // Pins the threshold itself: exactly 2 x MIN_DAY_KM must SUCCEED, yielding two
  // minimum-length days. Without this, `<` could drift to `<=` unnoticed, and the
  // day panel's Split button (enabled on `length >= 2 * MIN_DAY_KM`) would then
  // offer a split the model refuses.
  it('splits a day of exactly two minimum days into two minimum days', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(2 * MIN_DAY_KM);

    expect(itinerary.splitDay(0)).not.toBeNull();

    const days = itinerary.getDays();
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: MIN_DAY_KM, targetKm: MIN_DAY_KM });
    expect(days[1]).toMatchObject({ startKm: MIN_DAY_KM, endKm: 2 * MIN_DAY_KM, targetKm: MIN_DAY_KM });
  });

  it('handles an odd length without losing a tenth of a km', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(75.5);

    itinerary.splitDay(0);

    const days = itinerary.getDays();
    expect(days[0].targetKm + days[1].targetKm).toBe(75.5);
    expect(days[1].endKm).toBe(75.5);
  });

  it('splits by real span, not by an inflated stored length', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(300);
    itinerary.addDay(200); // clamped to {300, 380}: span 80, stored targetKm 200

    itinerary.splitDay(1);

    const days = itinerary.getDays();
    expect(days).toHaveLength(3);
    expect(days[1]).toMatchObject({ startKm: 300, endKm: 340, targetKm: 40 });
    expect(days[2]).toMatchObject({ startKm: 340, endKm: TOTAL_KM, targetKm: 40 });
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    expect(() => itinerary.splitDay(0)).toThrow();
  });
});

describe('createItinerary - deleteDay', () => {
  it('merges a middle day into the next one and leaves the rest put', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    [80, 80, 80, 80].forEach((km) => itinerary.addDay(km));

    itinerary.deleteDay(1);

    const days = itinerary.getDays();
    expect(days).toHaveLength(3);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });
    expect(days[1]).toMatchObject({ startKm: 80, endKm: 240, targetKm: 160 });
    expect(days[2]).toMatchObject({ startKm: 240, endKm: 320 });
  });

  it('keeps the surviving day its overnight town', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.setTownChoice(1, { name: 'Lenzen' });

    itinerary.deleteDay(0);

    expect(itinerary.getDays()[0].townChoice).toEqual({ name: 'Lenzen' });
  });

  it('truncates the plan when the last day is deleted', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(60);

    itinerary.deleteDay(1);

    const days = itinerary.getDays();
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 80 });
  });

  it('empties the plan when the only day is deleted', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);

    itinerary.deleteDay(0);

    expect(itinerary.getDays()).toHaveLength(0);
  });

  it('is the inverse of splitDay', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(100);
    itinerary.addDay(80);

    itinerary.splitDay(0);
    itinerary.deleteDay(0);

    const days = itinerary.getDays();
    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 100, targetKm: 100 });
    expect(days[1]).toMatchObject({ startKm: 100, endKm: 180 });
  });

  it('keeps every break, re-bucketed across the merge', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    itinerary.addDay(80);
    itinerary.addBreak(makeBreak({ name: 'Stop', routeDistanceKm: 70 }));

    itinerary.deleteDay(0);

    const day = itinerary.getDays()[0];
    expect(itinerary.getBreaks()).toHaveLength(1);
    expect(itinerary.breaksInRange(day.startKm, day.endKm).map((b) => b.name)).toEqual(['Stop']);
  });

  it("preserves the surviving day's end when its stored length was inflated", () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.hydrate([{ targetKm: 100 }, { targetKm: 400 }]); // day 1 clamped to {100, 380}

    itinerary.deleteDay(0);

    const days = itinerary.getDays();
    expect(days).toHaveLength(1);
    // 380 is the real span of the merged day. Summing the two stored lengths would
    // give 500 — end still clamped to 380, but the length inflated further.
    expect(days[0]).toMatchObject({ startKm: 0, endKm: TOTAL_KM, targetKm: 380 });
  });

  it('does not move later days when merging a pair shorter than a minimum day', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(2);
    itinerary.addDay(2);
    itinerary.addDay(50);

    itinerary.deleteDay(0);

    const days = itinerary.getDays();
    // The merged span is 4 km — short, but a loadable length, so it must NOT be
    // inflated to MIN_DAY_KM: that would push the boundary to km 5 and drag every
    // later day with it.
    expect(days[0]).toMatchObject({ startKm: 0, endKm: 4, targetKm: 4 });
    expect(days[1]).toMatchObject({ startKm: 4, endKm: 54 });
  });

  it('throws on an out-of-range index', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(80);
    expect(() => itinerary.deleteDay(3)).toThrow();
  });
});

// Both data-loss bugs found in review had the same shape: the in-memory plan
// looked fine and persisted fine, then hydrate rejected it and dropped every day.
// Assert the property directly rather than enumerating the cases we happen to know.
describe('createItinerary - every emitted plan survives a reload', () => {
  function reloadCount(itinerary) {
    const stored = itinerary.getDays().map((d) => ({ targetKm: d.targetKm, townChoice: d.townChoice }));
    const fresh = createItinerary({ trip: WHOLE });
    fresh.hydrate(stored);
    return fresh.getDays().length;
  }

  function expectLoadable(itinerary, label) {
    const days = itinerary.getDays();
    for (const day of days) {
      expect(day.targetKm, `${label}: targetKm must stay positive`).toBeGreaterThan(0);
      expect(day.endKm, `${label}: day must not invert`).toBeGreaterThanOrEqual(day.startKm);
    }
    expect(reloadCount(itinerary), `${label}: plan must survive a reload`).toBe(days.length);
  }

  it('survives a distance edit on a sub-minimum pair', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.addDay(2);
    itinerary.addDay(2);
    itinerary.addDay(50);

    itinerary.editDay(0, 30);

    expectLoadable(itinerary, 'editDay on a sub-minimum pair');
  });

  it('survives deleting a vestigial day left past a shrunk route', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    itinerary.hydrate([{ targetKm: 400 }, { targetKm: 10 }, { targetKm: 10 }]);

    itinerary.deleteDay(1);

    expectLoadable(itinerary, 'deleteDay merging vestigial days');
  });

  it('survives split, delete and boundary moves across a normal plan', () => {
    const itinerary = createItinerary({ trip: WHOLE });
    [80, 80, 80].forEach((km) => itinerary.addDay(km));

    itinerary.moveBoundary(0, 76.25);
    expectLoadable(itinerary, 'after moveBoundary');
    itinerary.splitDay(1);
    expectLoadable(itinerary, 'after splitDay');
    itinerary.deleteDay(0);
    expectLoadable(itinerary, 'after deleteDay');
    itinerary.editDay(0, 12.34);
    expectLoadable(itinerary, 'after editDay');
  });
});
