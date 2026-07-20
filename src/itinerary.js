function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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
 * returned by getDays()/addDay()/editDay()/setTownChoice().
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

  function editDay(index, targetKm) {
    assertValidIndex(index);
    assertValidTargetKm(targetKm);
    days[index].targetKm = targetKm;
    recomputeFrom(index);
    return toPublicDay(days[index], index);
  }

  function setTownChoice(index, town) {
    assertValidIndex(index);
    days[index].townChoice = town ?? null;
    return toPublicDay(days[index], index);
  }

  function removeLastDay() {
    days.pop();
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
