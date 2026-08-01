import { clampBoundaryKm, MIN_DAY_KM } from './boundaries.js';

// Boundary edits write user-facing lengths that get persisted, so keep them at
// one decimal — a drag snapping to a town at km 76.2345 must not write 76.2345
// to storage. addDay and hydrate store lengths as given.
function round1(n) {
  return Math.round(n * 10) / 10;
}

// The smallest length that survives storage. hydrate rejects a non-positive
// targetKm and drops the whole plan, so a merge whose real span rounds to zero
// stores this instead. Deliberately NOT MIN_DAY_KM: a merged span of 4 km is
// short but perfectly loadable, and inflating it to 5 would push the survivor's
// end out and drag every later day with it.
const MIN_STORED_KM = 0.1;

function isValidTargetKm(targetKm) {
  return typeof targetKm === 'number' && Number.isFinite(targetKm) && targetKm > 0;
}

/**
 * Stable identity for a plan-level break: its name at a route distance.
 * Module-level (main.js imports it) so callers can match a place against
 * getBreaks() without re-deriving the composition.
 *
 * Character-identical to ui-util.js's `poiKey`/`townKey`, and staying that way:
 * the render helpers import no data module and this model imports no render
 * helper, so neither side can import the other without inverting a layer. The
 * cross-module key contract test in itinerary.test.js is what holds the two
 * together — if this format changes, that test is the thing that will say so.
 */
export function breakKey(b) {
  return `${b.name}@${b.routeDistanceKm}`;
}

function isValidBreak(place) {
  return (
    !!place &&
    typeof place.routeDistanceKm === 'number' &&
    Number.isFinite(place.routeDistanceKm) &&
    place.routeDistanceKm >= 0 &&
    typeof place.lat === 'number' &&
    typeof place.lng === 'number'
  );
}

/**
 * Shapes an internal day record into the public, defensive-copy form
 * returned by getDays()/addDay()/editDay()/moveBoundary()/splitDay()/setTownChoice().
 */
function toPublicDay(day, index) {
  return {
    index,
    targetKm: day.targetKm,
    startKm: day.startKm,
    endKm: day.endKm,
    townChoice: day.townChoice ?? null,
  };
}

/**
 * Creates a multi-day itinerary model for one TRIP: an oriented window on the
 * route, from the rider's startKm to their destinationKm, either way round (see
 * src/trip.js). The corridor itself is data, named in route.meta.json.
 *
 * Days are 0-indexed: days[0] starts at the trip's startKm, and each day chains
 * from the previous day's endKm toward the destination in the trip's direction.
 * On a downstream trip — Dresden -> Hamburg — that means the absolute km DECREASE
 * day by day, while targetKm stays the positive distance ridden. No day can run
 * past the destination.
 *
 * Every km stored or returned here is an ABSOLUTE route km; only DISPLAYED km are
 * relative to the rider's start, and trip.tripKm() is the one conversion. This is
 * pure trip math; persistence lives in src/storage.js and feeds days back in via
 * hydrate().
 *
 * Plan-level breaks (committed waypoints like a lunch stop) live here too,
 * sorted by routeDistanceKm; each day derives its own breaks by km range via
 * breaksInRange, so editing day distances re-buckets breaks automatically.
 *
 * @param {Object} opts
 * @param {object} opts.trip - the oriented window this plan rides, from
 *   createTrip(); it supplies the origin every day chains from, the direction they
 *   run in and the end they clamp at.
 * @returns {{
 *   getDays: () => Array<{index: number, targetKm: number, startKm: number, endKm: number, townChoice: any|null}>,
 *   addDay: (targetKm: number) => object,
 *   editDay: (index: number, targetKm: number) => object,
 *   moveBoundary: (index: number, endKm: number) => object,
 *   splitDay: (index: number) => object|null,
 *   deleteDay: (index: number) => void,
 *   setTownChoice: (index: number, town: any) => object,
 *   removeLastDay: () => void,
 *   reset: () => void,
 *   totalPlannedKm: () => number,
 *   addBreak: (place: object) => void,
 *   removeBreak: (key: string) => void,
 *   updateBreak: (key: string, patch: {name?: string, note?: string}) => string|null,
 *   getBreaks: () => Array<object>,
 *   breaksInRange: (startKm: number, endKm: number) => Array<object>,
 *   hydrate: (input: Array<{targetKm: number, townChoice?: any}> | {days: Array<object>, breaks?: Array<object>}) => void,
 * }}
 */
export function createItinerary({ trip } = {}) {
  // The trip is not optional and there is no sensible fallback for a missing one:
  // every km below is measured from its start and clamped at its destination, so a
  // caller that forgot it would not get the old whole-road behaviour — it would get
  // NaN days, and persist them. Fail at construction rather than at the first
  // addDay, the same posture boundaries.js takes with its own missing totalKm.
  if (!trip || typeof trip.advance !== 'function') {
    throw new Error('createItinerary needs a trip (see createTrip in src/trip.js)');
  }

  // The two conversions every position calculation below goes through. The
  // arithmetic itself stays in RIDER km — 0 at the trip's start, always ascending —
  // so the existing ordering and rounding logic is untouched and the direction lives
  // in these two lines only; sprinkling `* trip.direction` through the comparisons
  // instead is what makes sign bugs.
  //
  // rideKm is SIGNED on purpose: moveBoundary recognises a boundary that has been
  // pushed past its neighbour by the resulting length coming out NEGATIVE, which a
  // Math.abs distance would hide.
  const rideKm = (fromKm, toKm) => trip.tripKm(toKm) - trip.tripKm(fromKm);
  // Unclamped, unlike trip.advance: callers here need to see a position overshoot
  // its neighbour in order to refuse it.
  const alongKm = (fromKm, distanceKm) => trip.absoluteKm(trip.tripKm(fromKm) + distanceKm);

  /** @type {Array<{targetKm: number, startKm: number, endKm: number, townChoice: any|null}>} */
  let days = [];

  /** @type {Array<object>} plan-level breaks, kept sorted asc by routeDistanceKm */
  let breaks = [];

  function assertValidIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= days.length) {
      throw new Error(`Day index out of range: ${index}`);
    }
  }

  function assertValidTargetKm(targetKm) {
    if (!isValidTargetKm(targetKm)) {
      throw new Error(`targetKm must be a positive number, got: ${targetKm}`);
    }
  }

  function assertValidBreak(place) {
    if (!isValidBreak(place)) {
      throw new Error('break needs numeric routeDistanceKm >= 0 and lat/lng');
    }
  }

  // Recomputes startKm/endKm for days[index..] by chaining off the previous day's
  // endKm — or the TRIP's start for index 0 — and advancing each day's own length
  // along the trip. The trip may run downstream, in which case the absolute km
  // decrease day by day; targetKm is always the positive distance ridden, and
  // trip.advance is what stops the last day at the destination instead of riding
  // off the end of the plan. Called after any edit that could shift downstream days.
  function recomputeFrom(index) {
    let prevEnd = index === 0 ? trip.startKm : days[index - 1].endKm;
    for (let i = index; i < days.length; i += 1) {
      const day = days[i];
      day.startKm = prevEnd;
      day.endKm = trip.advance(prevEnd, day.targetKm);
      prevEnd = day.endKm;
    }
  }

  function getDays() {
    return days.map((day, index) => toPublicDay(day, index));
  }

  function addDay(targetKm) {
    assertValidTargetKm(targetKm);
    const startKm = days.length ? days[days.length - 1].endKm : trip.startKm;
    const endKm = trip.advance(startKm, targetKm);
    days.push({ targetKm, startKm, endKm, townChoice: null });
    return toPublicDay(days[days.length - 1], days.length - 1);
  }

  // Moves the boundary at the END of days[index] to endKm. Local: the delta is
  // handed to the next day, so days beyond the neighbour never move. The last
  // boundary has no neighbour, so moving it extends or shrinks the plan — that
  // is the append/trim gesture.
  function moveBoundary(index, endKm) {
    assertValidIndex(index);
    if (typeof endKm !== 'number' || !Number.isFinite(endKm)) {
      throw new Error(`endKm must be a finite number, got: ${endKm}`);
    }
    const day = days[index];
    // boundaries.js still does its arithmetic in ascending absolute km, so it is
    // handed the trip's far end as its totalKm — on a forward trip from km 0 that is
    // literally the old value, and it is the argument that becomes `{ trip }` when
    // boundary maths turns signed (plan Task 3). Until then a boundary DRAG on a
    // downstream trip is not yet right; day CHAINING, which is this task, is.
    const target = clampBoundaryKm(days, index, endKm, { totalKm: trip.destinationKm });
    // Position unchanged AND the stored length already matches it: nothing to do.
    // The second term matters — a day clamped at the destination stores a length
    // longer than its span, and skipping on delta alone would leave that stale value
    // in storage and in the returned day.
    if (
      round1(rideKm(day.endKm, target)) === 0 &&
      round1(rideKm(day.startKm, target)) === day.targetKm
    ) {
      return toPublicDay(day, index);
    }
    const next = days[index + 1];
    const nextEnd = next ? next.endKm : null;
    // Derive both lengths from the boundary POSITIONS rather than adding a delta
    // to the stored length. A day clamped at the destination carries a targetKm
    // larger than its real span (addDay and hydrate both permit it), and a delta
    // applied to that inflated length shrinks it without moving the boundary — the
    // drag looks stuck until the overshoot burns off. Positions can't drift that way.
    const length = round1(rideKm(day.startKm, target));
    // The neighbour's length comes off the REALIZED boundary — start plus the rounded
    // length — not off the requested target. Rounding both halves against the raw
    // target lets them both round up at a .x5 step, adding 0.1 km to the pair and
    // shifting every day beyond it, the one thing this function promises not to do.
    const nextLength = next ? round1(rideKm(alongKm(day.startKm, length), nextEnd)) : null;
    // A pair spanning under 2 x MIN_DAY_KM has no legal boundary between them, so
    // boundaryBounds collapses its window to a single position that can sit past
    // the neighbour's end. Deriving a length from that yields a negative number,
    // an inverted day, and — since hydrate rejects a non-positive length — the loss
    // of every day in the plan on the next reload. A boundary with nowhere legal to
    // go simply doesn't move. Refuse rather than floor: flooring the neighbour at
    // MIN_DAY_KM would extend its end and shift every day downstream, breaking
    // locality.
    //
    // Deliberately NOT boundaries.js's boundaryWindow, which asks whether the
    // REQUEST was legal. This asks whether the OUTPUT is well-formed, after the
    // rounding just above — the last thing standing between a squeezed plan and
    // a stored inverted day, so it stays an assertion about what is about to be
    // written. Callers deciding whether to ask at all (strip.js's proposeKm) use
    // the shared predicate instead.
    if (next && nextLength < MIN_DAY_KM) {
      return toPublicDay(day, index);
    }
    day.targetKm = length;
    if (next) next.targetKm = nextLength;
    recomputeFrom(index);
    return toPublicDay(days[index], index);
  }

  // The typed-distance path: setting a day's length is moving its boundary to the
  // position that length reaches along the trip, with the same local semantics and
  // the same clamps. An over-long length clamps rather than throws —
  // assertValidTargetKm only rejects nonsense input, not lengths the boundary window
  // can't fit — so the position handed to moveBoundary is deliberately unclamped.
  function editDay(index, targetKm) {
    assertValidIndex(index);
    assertValidTargetKm(targetKm);
    const startKm = index === 0 ? trip.startKm : days[index - 1].endKm;
    return moveBoundary(index, alongKm(startKm, targetKm));
  }

  // Inserts a boundary at the day's midpoint, turning one day into two that sum
  // to the original — so nothing downstream moves. The length comes from the
  // day's real span, not its stored targetKm, which may be inflated if the day was
  // clamped at the destination — and read as a DISTANCE along the trip, so a
  // downstream day splits into two positive halves rather than two negative ones.
  // The SECOND half keeps the overnight town, because its end is where the original
  // day ended (that is still where you sleep); the new first half starts with none.
  // Deriving the second half as `length - first` rather than rounding it
  // independently keeps the two provably summing to the original — assuming the span
  // is already at 0.1 km precision, which every write path guarantees (round1 or
  // integer input); a raw x.x5 span would gain 0.05 km here. Returns null when the
  // day is too short to split.
  function splitDay(index) {
    assertValidIndex(index);
    const day = days[index];
    const length = rideKm(day.startKm, day.endKm);
    if (length < 2 * MIN_DAY_KM) return null;
    const first = round1(length / 2);
    const second = round1(length - first);
    // The two positions are placeholders that recomputeFrom fills in a line below.
    // Seeded from the day being split rather than from km 0, which need not be on
    // this trip at all.
    days.splice(
      index,
      1,
      { targetKm: first, startKm: day.startKm, endKm: day.startKm, townChoice: null },
      {
        targetKm: second,
        startKm: day.startKm,
        endKm: day.startKm,
        townChoice: day.townChoice ?? null,
      },
    );
    recomputeFrom(index);
    return toPublicDay(days[index], index);
  }

  // Removes the boundary at the END of days[index] by merging the day into the
  // next one, which keeps its own end — so the trip past it is untouched. The
  // merged length is derived from POSITIONS (how far the survivor's end lies along
  // the trip from the deleted day's start) rather than by summing two stored
  // lengths, either of which may be inflated by a destination clamp. The last day
  // has no next day, so deleting it truncates the plan. Breaks are plan-level and
  // re-bucket themselves from the new ranges.
  //
  // The merged length is floored at MIN_STORED_KM: two vestigial days stranded
  // past a shrunk route span zero km, and hydrate rejects a non-positive length
  // by dropping the whole plan on the next reload. Floor rather than refuse — the
  // opposite of moveBoundary's guard — because the delete has already been asked
  // for and only needs its stored length to be representable; refusing a boundary
  // move preserves locality, but a button that silently does nothing is worse.
  // A stored length longer than the real span is already a permitted state; the
  // end stays clamped at the destination, so nothing moves.
  function deleteDay(index) {
    assertValidIndex(index);
    if (index === days.length - 1) {
      days.pop();
      return;
    }
    const next = days[index + 1];
    next.targetKm = Math.max(round1(rideKm(days[index].startKm, next.endKm)), MIN_STORED_KM);
    days.splice(index, 1);
    recomputeFrom(index);
  }

  function removeLastDay() {
    if (days.length) deleteDay(days.length - 1);
  }

  // Choosing where you sleep is choosing where the day ends, so a town choice
  // snaps the boundary to the town's position along the route — a day's km then
  // means the distance you actually ride. The town's perpendicular offsetKm is
  // never folded in; the UI shows it separately. Snapping clamps — or refuses,
  // for a wedged pair with no legal boundary between them — like any
  // boundary move, and the day panel derives its "stopped at" note by comparing
  // townChoice.routeDistanceKm against endKm. Clearing a choice leaves the
  // boundary where it is.
  function setTownChoice(index, town) {
    assertValidIndex(index);
    days[index].townChoice = town ?? null;
    const km = town?.routeDistanceKm;
    if (typeof km === 'number' && Number.isFinite(km)) moveBoundary(index, km);
    return toPublicDay(days[index], index);
  }

  function reset() {
    days = [];
    breaks = [];
  }

  // How far the plan reaches ALONG the trip: a positive distance ridden from the
  // rider's own start, not an absolute route km. They coincide on the whole road
  // ridden forwards, which is why this used to be the last day's endKm — but on a
  // Dresden -> Hamburg trip that raw endKm would report a first 80 km day as a plan
  // of 220 km.
  function totalPlannedKm() {
    return days.length ? trip.tripKm(days[days.length - 1].endKm) : 0;
  }

  function addBreak(place) {
    assertValidBreak(place);
    const key = breakKey(place);
    if (breaks.some((b) => breakKey(b) === key)) return; // no duplicates
    breaks.push({ ...place });
    breaks.sort((a, b) => a.routeDistanceKm - b.routeDistanceKm);
  }

  function removeBreak(key) {
    breaks = breaks.filter((b) => breakKey(b) !== key);
  }

  // Edits a break in place: `note` (optional free text; empty string clears
  // it) and/or `name` (a custom stop's label — its identity, so the key can
  // change). An explicit `note: undefined` also clears the note (the `'note'
  // in patch` check sees the key); omit the field to leave a note untouched.
  // Returns the updated break's key, or null for an unknown key, an
  // empty name, or a rename that would collide with another break (no-op).
  // routeDistanceKm is never patched, so order is preserved and no re-sort is
  // needed.
  function updateBreak(key, patch = {}) {
    const target = breaks.find((b) => breakKey(b) === key);
    if (!target) return null;
    const next = { ...target };
    if ('name' in patch) {
      const name = typeof patch.name === 'string' ? patch.name.trim() : '';
      if (!name) return null;
      next.name = name;
    }
    if ('note' in patch) {
      const note = typeof patch.note === 'string' ? patch.note.trim() : '';
      if (note) next.note = note;
      else delete next.note;
    }
    const nextKey = breakKey(next);
    if (nextKey !== key && breaks.some((b) => breakKey(b) === nextKey)) return null;
    breaks = breaks.map((b) => (breakKey(b) === key ? next : b));
    return nextKey;
  }

  function getBreaks() {
    return breaks.map((b) => ({ ...b }));
  }

  /**
   * Breaks belonging to a day span (startKm, endKm], in absolute route km: a break
   * exactly at the day's start belongs to the previous day, one exactly at the end
   * belongs to this day.
   *
   * That half-open rule exists so two ADJACENT days cannot both claim the km they
   * share, so it has to keep pointing the same way in TRIP order — the km a day
   * starts on goes to the day before, the km it ends on to the day itself. Hence the
   * comparison in rider km, where a day's start is the lower number whichever way the
   * trip runs. A min/max in absolute km would keep the (lo, hi] shape and hand the
   * shared km to the wrong neighbour on a downstream trip.
   *
   * The span arrives in trip order, so downstream `startKm` is the greater absolute
   * number; a span handed over the other way round is normalised here rather than at
   * each of the call sites. The list is small, so a linear filter is fine.
   *
   * Returned in the order the rider MEETS them, which is the plan-level sort order
   * only on a forward trip: `breaks` is kept sorted by absolute km, and downstream
   * that is exactly backwards. Re-sorted here so no display site has to know.
   */
  function breaksInRange(startKm, endKm) {
    const from = trip.tripKm(startKm);
    const to = trip.tripKm(endKm);
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    return getBreaks()
      .filter((b) => {
        const km = trip.tripKm(b.routeDistanceKm);
        return km > lo && km <= hi;
      })
      .sort((a, b) => trip.tripKm(a.routeDistanceKm) - trip.tripKm(b.routeDistanceKm));
  }

  // Replaces the plan by replaying persisted state. Accepts two forms:
  //   - an array of day entries (sub-project 1 call sites; breaks untouched)
  //   - { days, breaks } (breaks restored; an absent breaks field clears them)
  // Days replay through the same chain/clamp math (recomputeFrom) editDay()
  // uses, with the same targetKm validation, so hydrate can never build a day
  // addDay/editDay couldn't; malformed days collapse the whole itinerary to
  // empty (never throws). Break entries are validated with the shared
  // predicate and individually dropped when invalid (data-corruption
  // tolerance), then deduped by key and sorted.
  function hydrate(input) {
    const objectForm = !Array.isArray(input) && !!input && typeof input === 'object';
    const dayEntries = objectForm ? input.days : input;

    try {
      if (!Array.isArray(dayEntries)) throw new Error('not an array');
      const restored = dayEntries.map((e) => {
        assertValidTargetKm(e.targetKm);
        // Positions are placeholders; recomputeFrom chains them along the trip below.
        return {
          targetKm: e.targetKm,
          startKm: trip.startKm,
          endKm: trip.startKm,
          townChoice: e.townChoice ?? null,
        };
      });
      days = restored;
      recomputeFrom(0);
    } catch {
      days = [];
    }

    if (objectForm) {
      const rawBreaks = Array.isArray(input.breaks) ? input.breaks : [];
      breaks = [];
      for (const b of rawBreaks) {
        if (!isValidBreak(b)) continue; // drop malformed silently
        if (breaks.some((existing) => breakKey(existing) === breakKey(b))) continue;
        breaks.push({ ...b });
      }
      breaks.sort((a, b) => a.routeDistanceKm - b.routeDistanceKm);
    }
  }

  return {
    getDays,
    addDay,
    editDay,
    moveBoundary,
    splitDay,
    deleteDay,
    setTownChoice,
    removeLastDay,
    reset,
    totalPlannedKm,
    addBreak,
    removeBreak,
    updateBreak,
    getBreaks,
    breaksInRange,
    hydrate,
  };
}
