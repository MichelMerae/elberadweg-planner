const STORAGE_KEY = 'elberadweg-itinerary';
const SCHEMA_VERSION = 1;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isValidTargetKm(targetKm) {
  return typeof targetKm === 'number' && Number.isFinite(targetKm) && targetKm > 0;
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
 * and each day's startKm chains from the previous day's endKm.
 *
 * @param {Object} opts
 * @param {number} opts.totalKm - total route length in km; every endKm is
 *   clamped to [0, totalKm].
 * @param {string} [opts.routeVersion] - opaque route version/hash (e.g. from
 *   route.meta.json), used by load() to detect a stale persisted plan.
 * @param {{getItem(key: string): string|null, setItem(key: string, value: string): void}} [opts.storage]
 *   - injected storage (e.g. `localStorage`). If omitted, save() is a no-op
 *   and load() always reports nothing loaded, without throwing.
 * @returns {{
 *   getDays: () => Array<{index: number, targetKm: number, startKm: number, endKm: number, townChoice: any|null}>,
 *   addDay: (targetKm: number) => object,
 *   editDay: (index: number, targetKm: number) => object,
 *   setTownChoice: (index: number, town: any) => object,
 *   removeLastDay: () => void,
 *   reset: () => void,
 *   totalPlannedKm: () => number,
 *   save: () => void,
 *   load: () => {loaded: boolean, routeChanged: boolean},
 * }}
 */
export function createItinerary({ totalKm, routeVersion, storage } = {}) {
  const total = typeof totalKm === 'number' && Number.isFinite(totalKm) ? totalKm : Infinity;

  /** @type {Array<{targetKm: number, startKm: number, endKm: number, townChoice: any|null}>} */
  let days = [];

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
  }

  function totalPlannedKm() {
    return days.length ? days[days.length - 1].endKm : 0;
  }

  // Persisting is best-effort: a throwing setItem (private mode, quota,
  // storage disabled by policy) must never break the in-memory plan or the
  // render that follows a mutation.
  function save() {
    if (!storage) return;
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      routeVersion,
      days: days.map((day) => ({ targetKm: day.targetKm, townChoice: day.townChoice ?? null })),
    };
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Swallow - the plan lives in memory; persistence just won't survive reload.
    }
  }

  // Reads the persisted plan and replays it against the *current* totalKm.
  // Any failure (missing key, invalid JSON, wrong schema, malformed entries)
  // is swallowed and treated as "nothing to load" - it never throws.
  function load() {
    if (!storage) {
      return { loaded: false, routeChanged: false };
    }

    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) {
        days = [];
        return { loaded: false, routeChanged: false };
      }

      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.days)) {
        days = [];
        return { loaded: false, routeChanged: false };
      }

      // Build bare records (targetKm + townChoice only) and let recomputeFrom()
      // - the same chain/clamp logic editDay() uses - derive startKm/endKm,
      // rather than duplicating that math here.
      const restored = parsed.days.map((entry) => {
        assertValidTargetKm(entry.targetKm);
        return { targetKm: entry.targetKm, startKm: 0, endKm: 0, townChoice: entry.townChoice ?? null };
      });

      days = restored;
      recomputeFrom(0);
      return { loaded: true, routeChanged: parsed.routeVersion !== routeVersion };
    } catch {
      days = [];
      return { loaded: false, routeChanged: false };
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
    save,
    load,
  };
}
