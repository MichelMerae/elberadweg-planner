// src/path.js — the composed path: two bank lines, one km axis.
//
// THE INVARIANT, inherited from trip.js and preserved here: stored and computed
// km are absolute CANONICAL km; only displayed km are ridden km, and tripKm()
// is the one-way conversion. What this module adds is that "ridden" is now
// measured on the bank the rider chose, through the crossing table.

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
