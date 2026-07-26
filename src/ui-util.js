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
export function poiKey(poi) {
  return poi ? `${poi.name}@${poi.routeDistanceKm}` : null;
}

// Glyph per break kind for day-card legs (spec §2: a food break reads as a
// coffee ☕ stop, a sight 📷, a town waypoint 🛏 — matching the day-end marker).
export const BREAK_GLYPH = { food: '☕', sight: '📷', town: '🛏', custom: '📌' };

// Glyph per kind in the favorites list — here a food place reads literally as a
// fork 🍴 (not the coffee ☕ used for break legs), a sight 📷, a town 🛏.
export const FAV_GLYPH = { town: '🛏', food: '🍴', sight: '📷' };

// Escape user-facing data (OSM town names) before innerHTML interpolation.
// None of the current dataset needs it, but a data rebuild could introduce
// names containing & or < and must not become markup.
export function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
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
