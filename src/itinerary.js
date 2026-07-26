import { clampBoundaryKm, MIN_DAY_KM } from './boundaries.js';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Boundary edits write user-facing lengths that get persisted, so keep them at
// one decimal — a drag snapping to a town at km 76.2345 must not write 76.2345
// to storage. addDay and hydrate store lengths as given.
function round1(n) {
  return Math.round(n * 10) / 10;
}

function isValidTargetKm(targetKm) {
  return typeof targetKm === 'number' && Number.isFinite(targetKm) && targetKm > 0;
}

/**
 * Stable identity for a plan-level break: its name at a route distance.
 * Module-level (main.js imports it) so callers can match a place against
 * getBreaks() without re-deriving the composition.
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
 * Creates a multi-day itinerary model for a route running Hamburg (km 0) ->
 * Dresden (km totalKm). Days are 0-indexed: days[0] always starts at km 0,
 * and each day's startKm chains from the previous day's endKm. This is pure
 * trip math; persistence lives in src/storage.js and feeds days back in via
 * hydrate().
 *
 * Plan-level breaks (committed waypoints like a lunch stop) live here too,
 * sorted by routeDistanceKm; each day derives its own breaks by km range via
 * breaksInRange, so editing day distances re-buckets breaks automatically.
 *
 * @param {Object} opts
 * @param {number} opts.totalKm - total route length in km; every endKm is
 *   clamped to [0, totalKm].
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
export function createItinerary({ totalKm } = {}) {
  const total = typeof totalKm === 'number' && Number.isFinite(totalKm) ? totalKm : Infinity;

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

  // Recomputes startKm/endKm for days[index..] by chaining off the previous
  // day's endKm (or 0 for index 0). Called after any edit that could shift
  // downstream days.
  function recomputeFrom(index) {
    let prevEnd = index === 0 ? 0 : days[index - 1].endKm;
    for (let i = index; i < days.length; i += 1) {
      const day = days[i];
      day.startKm = prevEnd;
      day.endKm = clamp(prevEnd + day.targetKm, 0, total);
      prevEnd = day.endKm;
    }
  }

  function getDays() {
    return days.map((day, index) => toPublicDay(day, index));
  }

  function addDay(targetKm) {
    assertValidTargetKm(targetKm);
    const startKm = days.length ? days[days.length - 1].endKm : 0;
    const endKm = clamp(startKm + targetKm, 0, total);
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
    const target = clampBoundaryKm(days, index, endKm, { totalKm: total });
    // Position unchanged AND the stored length already matches it: nothing to do.
    // The second term matters — a day clamped at totalKm stores a length longer
    // than its span, and skipping on delta alone would leave that stale value in
    // storage and in the returned day.
    if (round1(target - day.endKm) === 0 && round1(target - day.startKm) === day.targetKm) {
      return toPublicDay(day, index);
    }
    const next = days[index + 1];
    const nextEnd = next ? next.endKm : null;
    // Derive both lengths from the boundary POSITIONS rather than adding a delta
    // to the stored length. A day clamped at totalKm carries a targetKm larger
    // than its real span (addDay and hydrate both permit it), and a delta applied
    // to that inflated length shrinks it without moving the boundary — the drag
    // looks stuck until the overshoot burns off. Positions can't drift that way.
    const length = round1(target - day.startKm);
    // A pair spanning under 2 x MIN_DAY_KM has no legal boundary between them, so
    // boundaryBounds collapses its window to a single position that can sit past
    // the neighbour's end. Deriving a length from that yields a negative number,
    // an inverted day, and — since hydrate rejects a non-positive length — the loss
    // of every day in the plan on the next reload. A boundary with nowhere legal to
    // go simply doesn't move. Refuse rather than floor: flooring the neighbour at
    // MIN_DAY_KM would extend its end and shift every day downstream, breaking
    // locality.
    if (next && round1(nextEnd - (day.startKm + length)) < MIN_DAY_KM) {
      return toPublicDay(day, index);
    }
    day.targetKm = length;
    // The neighbour's length comes off the REALIZED boundary (start + rounded
    // length), not the requested target. Rounding both halves against the raw
    // target lets them both round up at a .x5 step, adding 0.1 km to the pair and
    // shifting every day beyond it — the one thing this function promises not to do.
    if (next) next.targetKm = round1(nextEnd - (day.startKm + length));
    recomputeFrom(index);
    return toPublicDay(days[index], index);
  }

  // The typed-distance path: setting a day's length is moving its boundary to
  // start + length, with the same local semantics and the same clamps. An
  // over-long length clamps rather than throws — assertValidTargetKm only
  // rejects nonsense input, not lengths the boundary window can't fit.
  function editDay(index, targetKm) {
    assertValidIndex(index);
    assertValidTargetKm(targetKm);
    const startKm = index === 0 ? 0 : days[index - 1].endKm;
    return moveBoundary(index, startKm + targetKm);
  }

  // Inserts a boundary at the day's midpoint, turning one day into two that sum
  // to the original — so nothing downstream moves. The length comes from the
  // day's real span, not its stored targetKm, which may be inflated if the day
  // was clamped at totalKm. The SECOND half keeps the overnight town, because its
  // end is where the original day ended (that is still where you sleep); the new
  // first half starts with none. Deriving the second half as `length - first`
  // rather than rounding it independently keeps the two provably summing to the
  // original. Returns null when the day is too short to split.
  function splitDay(index) {
    assertValidIndex(index);
    const day = days[index];
    const length = day.endKm - day.startKm;
    if (length < 2 * MIN_DAY_KM) return null;
    const first = round1(length / 2);
    const second = round1(length - first);
    days.splice(
      index,
      1,
      { targetKm: first, startKm: 0, endKm: 0, townChoice: null },
      { targetKm: second, startKm: 0, endKm: 0, townChoice: day.townChoice ?? null },
    );
    recomputeFrom(index);
    return toPublicDay(days[index], index);
  }

  // Removes the boundary at the END of days[index] by merging the day into the
  // next one, which keeps its own end — so the trip past it is untouched. The
  // merged length is derived from POSITIONS (the survivor's end minus the deleted
  // day's start) rather than by summing two stored lengths, either of which may be
  // inflated by a totalKm clamp. The last day has no next day, so deleting it
  // truncates the plan. Breaks are plan-level and re-bucket themselves from the
  // new ranges.
  function deleteDay(index) {
    assertValidIndex(index);
    if (index === days.length - 1) {
      days.pop();
      return;
    }
    const next = days[index + 1];
    next.targetKm = round1(next.endKm - days[index].startKm);
    days.splice(index, 1);
    recomputeFrom(index);
  }

  function removeLastDay() {
    if (days.length) deleteDay(days.length - 1);
  }

  function setTownChoice(index, town) {
    assertValidIndex(index);
    days[index].townChoice = town ?? null;
    return toPublicDay(days[index], index);
  }

  function reset() {
    days = [];
    breaks = [];
  }

  function totalPlannedKm() {
    return days.length ? days[days.length - 1].endKm : 0;
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

  // Breaks belonging to a day span (startKm, endKm]: a break exactly at the
  // day's start belongs to the previous day, one exactly at the end belongs to
  // this day. The list is small, so a linear filter is fine.
  function breaksInRange(startKm, endKm) {
    return getBreaks().filter((b) => b.routeDistanceKm > startKm && b.routeDistanceKm <= endKm);
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
        return { targetKm: e.targetKm, startKm: 0, endKm: 0, townChoice: e.townChoice ?? null };
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
