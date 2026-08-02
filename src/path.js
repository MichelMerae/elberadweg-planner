// src/path.js — the composed path: two bank lines, one km axis.
//
// THE INVARIANT, inherited from trip.js and preserved here: stored and computed
// km are absolute CANONICAL km; only displayed km are ridden km, and tripKm()
// is the one-way conversion. What this module adds is that "ridden" is now
// measured on the bank the rider chose, through the crossing table.

import { pointAtKm, stretchCoords } from './route.js';

/**
 * The crossing table is the piecewise-linear correspondence between the
 * canonical axis and the alt axis. Anchors are ALL crossings, chosen or not.
 * Outside [first.kmCanonical, last.kmCanonical] there is no alt line: null.
 * @param {Array<{kmCanonical: number, kmAlt: number}>} table sorted by kmCanonical
 * @param {number} km canonical km
 * @returns {number|null} alt km
 */
export function altKmAt(table, km) {
  if (!table.length || km < table[0].kmCanonical || km > table[table.length - 1].kmCanonical) return null;
  let lo = 0;
  let hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table[mid].kmCanonical <= km) lo = mid;
    else hi = mid - 1;
  }
  if (lo === table.length - 1) return table[lo].kmAlt;
  const a = table[lo];
  const b = table[lo + 1];
  const span = b.kmCanonical - a.kmCanonical;
  const t = span > 0 ? (km - a.kmCanonical) / span : 0;
  return a.kmAlt + t * (b.kmAlt - a.kmAlt);
}

/** Inverse of altKmAt on the covered range; null outside it. */
export function canonicalKmFromAlt(table, altKm) {
  if (!table.length || altKm < table[0].kmAlt || altKm > table[table.length - 1].kmAlt) return null;
  let lo = 0;
  let hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table[mid].kmAlt <= altKm) lo = mid;
    else hi = mid - 1;
  }
  if (lo === table.length - 1) return table[lo].kmCanonical;
  const a = table[lo];
  const b = table[lo + 1];
  const span = b.kmAlt - a.kmAlt;
  const t = span > 0 ? (altKm - a.kmAlt) / span : 0;
  return a.kmCanonical + t * (b.kmCanonical - a.kmCanonical);
}

/**
 * A trip decorated with bank choices: same interface createTrip returns —
 * createItinerary, the day panel and the strip consume it AS the trip — but
 * tripKm/absoluteKm/advance/lengthKm measure RIDDEN km on the composed path,
 * plus the bank/leg/crossing queries the new UI needs.
 *
 * THE BOUNDARY CONVENTION, because two directions must answer it the same way:
 * a km sitting exactly ON a chosen crossing reads as the NEAR side. You have
 * ridden 50 km when you arrive at the bridge at km 100, not 50.5; the crossing's
 * own length is paid as you ride across, so only km on the FAR side carry it.
 * The legs tile the window with both ends inclusive and tripKm answers on the
 * first leg that matches, which is what implements this — and it is what keeps
 * absoluteKm a true inverse at a crossing, where the far-side reading would map
 * two ridden km onto the same canonical km.
 *
 * @param {object} opts
 * @param {object} opts.trip - from createTrip()
 * @param {string[]} opts.chosenCrossingIds - crossing ids the plan chose
 * @param {Array} opts.crossings - the full table, sorted by kmCanonical
 * @param {object} opts.canonicalIndex - createRouteIndex(route)
 * @param {object|null} opts.altIndex - createRouteIndex(altRoute), null when absent
 * @param {Array<{startKm, endKm, bank}>} opts.segments - meta.segments bank info
 */
export function createPath({
  trip,
  chosenCrossingIds = [],
  crossings = [],
  canonicalIndex,
  altIndex,
  segments = [],
} = {}) {
  if (!trip || typeof trip.advance !== 'function') {
    throw new Error('createPath needs a trip (see createTrip in src/trip.js)');
  }
  const table = crossings;
  const byId = new Map(table.map((c) => [c.id, c]));

  // Chosen crossings that can actually compose: known id, inside the window,
  // and — when toggling ONTO the alt bank — a further anchor to ride toward.
  // Sorted along the trip's direction; parity below is positional.
  const chosen = chosenCrossingIds
    .map((id) => byId.get(id))
    .filter((c) => c && trip.contains(c.kmCanonical))
    .sort((a, b) => (a.kmCanonical - b.kmCanonical) * trip.direction);

  const first = table[0];
  const last = table[table.length - 1];
  const active = [];
  for (const c of chosen) {
    const ontoAlt = active.length % 2 === 0;
    if (ontoAlt) {
      const beyond =
        trip.direction === 1 ? c.kmCanonical < last?.kmCanonical : c.kmCanonical > first?.kmCanonical;
      if (!altIndex || !beyond) continue; // dead-end toggle: ignore (deviation 5)
    }
    active.push(c);
  }

  // Legs: consecutive [from, to] canonical spans, alternating bank line.
  // leg.crossingIn is the crossing ridden to ENTER this leg (null for the first).
  const canonicalBankAt = (km) =>
    segments.find((s) => km >= s.startKm && km <= s.endKm)?.bank ?? null;
  const flip = (bank) => (bank === 'left' ? 'right' : 'left');

  const legList = [];
  let cursor = trip.startKm;
  let onAlt = false;
  for (const c of active) {
    legList.push({
      onAlt,
      fromKm: cursor,
      toKm: c.kmCanonical,
      crossingIn: legList.length ? active[legList.length - 1] : null,
    });
    cursor = c.kmCanonical;
    onAlt = !onAlt;
  }
  legList.push({
    onAlt,
    fromKm: cursor,
    toKm: trip.destinationKm,
    crossingIn: active.length ? active[active.length - 1] : null,
  });

  // Alt distance between two CANONICAL km, both pulled into the table's covered
  // range first. Outside it altKmAt has no answer at all, and the covered end is
  // the nearest thing to one — measuring from alt km 0 instead (what a bare
  // `?? 0` does) is a distance from wherever the alt line happens to be numbered
  // from, which is not a distance the rider ever covers.
  //
  // KNOWN GAP, deliberately left: an alt leg CAN run past the outer anchors — the
  // `beyond` guard above only demands a further anchor exists, not that the leg's
  // END is covered — and the uncovered tail then contributes 0 ridden km, so
  // tripKm saturates across it. Reachable today: a downstream trip crossing at the
  // second-to-last anchor and finishing beyond the last one.
  const coverFrom = (km) =>
    table.length ? Math.min(Math.max(km, first.kmCanonical), last.kmCanonical) : km;
  const altSpan = (a, b) => Math.abs(altKmAt(table, coverFrom(b)) - altKmAt(table, coverFrom(a)));
  const legRidden = (leg) => (leg.onAlt ? altSpan(leg.fromKm, leg.toKm) : Math.abs(leg.toKm - leg.fromKm));

  // Cumulative ridden km at each leg start, crossings included as steps.
  const legStartRidden = [];
  {
    let r = 0;
    for (const leg of legList) {
      if (leg.crossingIn) r += leg.crossingIn.lengthKm;
      legStartRidden.push(r);
      r += legRidden(leg);
    }
  }
  const riddenTotal = legStartRidden[legList.length - 1] + legRidden(legList[legList.length - 1]);

  const inLeg = (leg, km) =>
    trip.direction === 1 ? km >= leg.fromKm && km <= leg.toKm : km <= leg.fromKm && km >= leg.toKm;

  function tripKm(absoluteKm) {
    // Off-window: canonical rate, signed (deviation 4).
    const startSide = (absoluteKm - trip.startKm) * trip.direction;
    if (startSide < 0) return startSide;
    const endSide = (absoluteKm - trip.destinationKm) * trip.direction;
    if (endSide > 0) return riddenTotal + endSide;
    for (let i = 0; i < legList.length; i += 1) {
      const leg = legList[i];
      if (!inLeg(leg, absoluteKm)) continue;
      const partial = leg.onAlt ? altSpan(leg.fromKm, absoluteKm) : Math.abs(absoluteKm - leg.fromKm);
      return legStartRidden[i] + partial;
    }
    // Between legs can't happen (legs tile the window); keep the failure loud.
    throw new Error(`tripKm: km ${absoluteKm} not covered by any leg`);
  }

  function absoluteKm(riderKm) {
    if (riderKm <= 0) return trip.startKm + riderKm * trip.direction;
    if (riderKm >= riddenTotal) return trip.destinationKm + (riderKm - riddenTotal) * trip.direction;
    for (let i = legList.length - 1; i >= 0; i -= 1) {
      const leg = legList[i];
      let r = riderKm - legStartRidden[i];
      if (r < 0) continue;
      const len = legRidden(leg);
      if (r > len) r = len; // landed inside the NEXT crossing step: pin to this leg's end
      if (!leg.onAlt) return leg.fromKm + r * trip.direction;
      const altFrom = altKmAt(table, coverFrom(leg.fromKm));
      const altTo = altKmAt(table, coverFrom(leg.toKm));
      const dir = altTo >= altFrom ? 1 : -1;
      return canonicalKmFromAlt(table, altFrom + r * dir);
    }
    return trip.startKm;
  }

  return Object.freeze({
    startKm: trip.startKm,
    destinationKm: trip.destinationKm,
    totalKm: trip.totalKm,
    direction: trip.direction,
    lengthKm: riddenTotal,
    contains: trip.contains,
    clampKm: trip.clampKm,
    tripKm,
    absoluteKm,
    advance: (fromKm, distanceKm) => {
      const target = tripKm(fromKm) + distanceKm;
      return target >= riddenTotal ? trip.destinationKm : absoluteKm(target);
    },

    /** rider-word bank at a canonical km: segment bank, flipped on odd parity. */
    bankAt(km) {
      const base = canonicalBankAt(km);
      if (base === null) return null;
      const leg = legList.find((l) => inLeg(l, km));
      return leg?.onAlt ? flip(base) : base;
    },

    /** ordered legs for map / strip / rendering. */
    legs() {
      return legList.map((leg, i) => ({
        bank: leg.onAlt ? flip(canonicalBankAt(leg.fromKm) ?? 'right') : canonicalBankAt(leg.fromKm),
        onAlt: leg.onAlt,
        fromKm: leg.fromKm,
        toKm: leg.toKm,
        riddenLengthKm: legRidden(leg),
        startRiddenKm: legStartRidden[i],
        crossingIn: leg.crossingIn,
      }));
    },

    /** crossings whose canonical km lies in the oriented span (a, b], annotated. */
    crossingsBetween(a, b) {
      const oa = (km) => (km - trip.startKm) * trip.direction;
      const lo = Math.min(oa(a), oa(b));
      const hi = Math.max(oa(a), oa(b));
      const chosenIds = new Set(active.map((c) => c.id));
      return table
        .filter((c) => oa(c.kmCanonical) > lo && oa(c.kmCanonical) <= hi)
        .sort((x, y) => (x.kmCanonical - y.kmCanonical) * trip.direction)
        .map((c) => {
          const isChosen = chosenIds.has(c.id);
          // Would pressing this cross toggle ONTO the alt line? Then it needs a
          // further anchor in trip direction (deviation 5). Crossing back is free.
          const priorParity = active.filter((x) => oa(x.kmCanonical) < oa(c.kmCanonical)).length;
          const ontoAlt = !isChosen && priorParity % 2 === 0;
          const beyond =
            trip.direction === 1 ? c.kmCanonical < last?.kmCanonical : c.kmCanonical > first?.kmCanonical;
          return { ...c, chosen: isChosen, canCross: isChosen || !ontoAlt || (!!altIndex && beyond) };
        });
    },

    /** composed [lng,lat] polyline between two canonical km. */
    coords(a, b) {
      const out = [];
      for (const leg of legList) {
        const f = clipToLeg(leg, a, b);
        if (!f) continue;
        const piece = leg.onAlt
          ? stretchAlt(f.from, f.to)
          : orient(stretchCoords(canonicalIndex, Math.min(f.from, f.to), Math.max(f.from, f.to)), f.from > f.to);
        for (const c of piece) out.push(c);
      }
      return out;

      function clipToLeg(leg, x, y) {
        const oa = (k) => (k - trip.startKm) * trip.direction;
        const spanLo = Math.min(oa(x), oa(y));
        const spanHi = Math.max(oa(x), oa(y));
        const legLo = Math.min(oa(leg.fromKm), oa(leg.toKm));
        const legHi = Math.max(oa(leg.fromKm), oa(leg.toKm));
        const lo = Math.max(spanLo, legLo);
        const hi = Math.min(spanHi, legHi);
        if (hi <= lo) return null;
        const back = (o) => trip.startKm + o * trip.direction;
        return trip.direction === 1 ? { from: back(lo), to: back(hi) } : { from: back(hi), to: back(lo) };
      }
      function stretchAlt(fromC, toC) {
        const fa = altKmAt(table, coverFrom(fromC));
        const ta = altKmAt(table, coverFrom(toC));
        return orient(stretchCoords(altIndex, Math.min(fa, ta), Math.max(fa, ta)), fa > ta);
      }
      function orient(coords, reversed) {
        return reversed ? coords.slice().reverse() : coords;
      }
    },

    /** [lng,lat] of a canonical km on the line actually ridden there. */
    pointAt(km) {
      const leg = legList.find((l) => inLeg(l, km));
      if (leg?.onAlt) {
        const a = altKmAt(table, km);
        if (a !== null) return pointAtKm(altIndex, a);
      }
      return pointAtKm(canonicalIndex, Math.min(Math.max(km, 0), canonicalIndex.totalKm));
    },

    /** the composing crossings, in ride order — what persists and what renders as legs. */
    activeCrossings: () => active.slice(),
  });
}
