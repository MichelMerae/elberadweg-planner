// Render helpers shared by the panel modules (strip, day panel, places, plans
// bar). No DOM, no data-module imports — same contract as the render modules
// themselves: main.js owns domain logic.

export function round1(n) {
  return Math.round(n * 10) / 10;
}

// Stable identity for a town across re-renders (townsNear returns fresh
// objects each call, so reference equality can't be used for selection).
export function townKey(town) {
  return town ? `${town.name}@${town.routeDistanceKm}` : null;
}

// Stable identity for a POI, mirroring townKey — used to match a pending pin to
// its row (poisInRange returns fresh objects each render).
//
// Character-identical to itinerary.js's breakKey, and staying that way: this
// module imports no data module and the model imports no render helper, so
// neither side can import the other without inverting a layer. The cross-module
// key contract test in itinerary.test.js is what holds the two together.
export function poiKey(poi) {
  return poi ? `${poi.name}@${poi.routeDistanceKm}` : null;
}

// Glyph per break kind for day-card legs (spec §2: a food break reads as a
// coffee ☕ stop, a sight 📷, a town waypoint 🛏 — matching the day-end marker).
export const BREAK_GLYPH = { food: '☕', sight: '📷', town: '🛏', custom: '📌' };

/**
 * The glyph for a break's kind — shared, so the strip and the day panel can
 * never label the same break two different ways on one screen.
 *
 * `kind` comes from a stored plan a user could have hand-edited, so a bare
 * property lookup reaches Object.prototype: `kind: "toString"` interpolates a
 * function body into the markup. And '☕' as the fallback mislabels an unknown
 * break as a coffee stop; 📌 (custom) is the honest default.
 */
export function glyphFor(b) {
  return Object.hasOwn(BREAK_GLYPH, b.kind) ? BREAK_GLYPH[b.kind] : '📌';
}

// Glyph per kind in the favorites list — here a food place reads literally as a
// fork 🍴 (not the coffee ☕ used for break legs), a sight 📷, a town 🛏.
const FAV_GLYPH = { town: '🛏', food: '🍴', sight: '📷' };

/**
 * The glyph for a favorited place's kind. Guarded exactly as glyphFor is, and
 * for the same reason: `kind` comes from a stored list a user could have
 * hand-edited, so a bare lookup reaches Object.prototype and `kind:
 * "constructor"` interpolates a function body into the row. The table is not
 * exported — the guard is the only way in.
 *
 * ⭐ is the right fallback here (unlike break legs, which fall back to 📌): every
 * row in that section IS a favorite, so a star says nothing untrue about one
 * whose kind we don't recognise.
 */
export function favGlyphFor(place) {
  return Object.hasOwn(FAV_GLYPH, place.kind) ? FAV_GLYPH[place.kind] : '⭐';
}

// Escape user-facing data (OSM town names) before innerHTML interpolation.
// None of the current dataset needs it, but a data rebuild could introduce
// names containing & or < and must not become markup.
export function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Which way along the road the km run. The corridor is a river and its km ascend
// towards the source (elevation.json puts km 0, Cuxhaven, at 5 m and the far end,
// Prague, at 205 m), so an ascending trip rides upstream — the one place that
// assumption is written down. A corridor that is not a river would name its own two
// words in route.meta.json; nothing needs that yet.
const DIRECTION_WORD = { 1: 'upstream', '-1': 'downstream' };

/**
 * The trip in one line: `Hamburg → Dresden · 648.3 km upstream`.
 *
 * The direction is in WORDS because the sign of a subtraction is not something a rider
 * should have to infer (spec §6a) — and the same sentence serves the empty-plan setup
 * step and the confirmation after a pick, so the two cannot describe one trip
 * differently. It is also the one word most Elberadweg literature will not have
 * prepared a reader for: the guidebooks run source-to-sea, and Michel's own trip runs
 * against them, so naming the direction is doing real work rather than decorating.
 *
 * Names are the caller's (main.js resolves them); an unnamed end reads as its role,
 * which is all anything knows about it.
 */
export function tripHeadline(trip, { startName, destinationName } = {}) {
  const from = esc(startName ?? 'your start');
  const to = esc(destinationName ?? 'your finish');
  return `${from} → ${to} · ${round1(trip.lengthKm)} km ${DIRECTION_WORD[trip.direction]}`;
}

// Debounced wrapper with a .flush() escape hatch so commit can synchronously
// deliver the latest pending value before it is read.
export function debounce(fn, ms) {
  let handle = null;
  let lastArgs = null;
  const wrapped = (...args) => {
    lastArgs = args;
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      fn(...lastArgs);
    }, ms);
  };
  wrapped.flush = () => {
    if (handle) {
      clearTimeout(handle);
      handle = null;
      fn(...lastArgs);
    }
  };
  return wrapped;
}
