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
 * and each day's startKm chains from the previous day's endKm. This is pure
 * trip math; persistence lives in src/storage.js and feeds days back in via
 * hydrate().
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
 *   hydrate: (entries: Array<{targetKm: number, townChoice?: any}>) => void,
 * }}
 */
export function createItinerary({ totalKm } = {}) {
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

  // Replaces all days by replaying persisted entries through the same
  // chain/clamp math (recomputeFrom) that editDay() uses, rather than
  // duplicating that derivation here. Validation matches addDay/editDay so
  // hydrate can never build a day those couldn't. Malformed input (not an
  // array, or any bad targetKm) hydrates to an empty itinerary, never throws.
  function hydrate(entries) {
    try {
      if (!Array.isArray(entries)) throw new Error('not an array');
      const restored = entries.map((e) => {
        assertValidTargetKm(e.targetKm);
        return { targetKm: e.targetKm, startKm: 0, endKm: 0, townChoice: e.townChoice ?? null };
      });
      days = restored;
      recomputeFrom(0);
    } catch {
      days = [];
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
    hydrate,
  };
}
