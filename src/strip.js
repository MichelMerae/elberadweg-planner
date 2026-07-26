// The bottom timeline strip: the whole trip drawn to scale in kilometres. Owns
// its own DOM and interaction; emits intent through callbacks. No Leaflet, no
// data modules — main.js passes plain days/breaks in (same contract as ui.js).

import { esc, round1, BREAK_GLYPH } from './ui-util.js';
import { boundaryBounds } from './boundaries.js';
import { stripLayout, kmToX, xToKm } from './strip-geometry.js';

// jsdom (and a first paint before layout settles) reports clientWidth 0; a
// plausible width keeps the strip renderable and the geometry tests honest.
const FALLBACK_WIDTH = 1000;

/**
 * A block's CSS box from its geometry, the only place px land in the DOM.
 *
 * Two hazards, both owned here rather than in the pure geometry:
 *
 * 1. `width` is deliberately NEGATIVE for an inverted day (endKm before
 *    startKm, which the model can transiently hold on pathological stored
 *    data) so that `x + width` keeps equalling `kmToX(endKm)` and handle
 *    positions stay truthful. CSS `width: -80px` is invalid, gets dropped, and
 *    an absolutely positioned div then falls back to `auto` — visible garbage.
 * 2. Rounding `x` and `width` independently scatters seams: 0.1 km is ~0.2 px,
 *    adjacent edges already agree to ~1e-13, and one edge can round up while
 *    its neighbour rounds down. So round the two EDGES and derive the width
 *    from them — block i's right edge is then the same number as block i+1's
 *    left edge, by construction, at any axis width.
 */
function span(x, width) {
  const left = round1(x);
  const right = round1(x + width);
  return { left, width: Math.max(0, right - left) };
}

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.el - container the strip owns outright.
 * @param {Object} opts.callbacks
 * @param {(index: number) => void} opts.callbacks.onFocusDay
 * @param {(index: number, endKm: number, opts: {commit: boolean}) => void} opts.callbacks.onMoveBoundary
 * @param {(endKm: number|null) => void} opts.callbacks.onAddDay - endKm from a
 *   remainder click, or null to append a default-length day.
 * @param {() => number} [opts.measureWidth] - axis width in px; injectable for tests.
 */
export function createStrip({ el, callbacks = {}, measureWidth } = {}) {
  let state = { days: [], totalKm: 0, focusedIndex: null, breaks: [] };

  el.classList.add('strip');
  el.innerHTML = `
    <div class="strip__summary"></div>
    <div class="strip__axis" data-strip-axis></div>
    <div class="strip__scale"></div>`;

  const summaryEl = el.querySelector('.strip__summary');
  const axisEl = el.querySelector('.strip__axis');
  const scaleEl = el.querySelector('.strip__scale');

  const width = measureWidth || (() => axisEl.clientWidth || FALLBACK_WIDTH);

  function axisOpts() {
    return { totalKm: state.totalKm, width: width() };
  }

  function summary() {
    const { days, totalKm } = state;
    const planned = days.length ? days[days.length - 1].endKm : 0;
    const remaining = Math.max(0, totalKm - planned);
    const avg = days.length ? round1(planned / days.length) : 0;
    const right = days.length
      ? `${days.length} ${days.length === 1 ? 'day' : 'days'} · ⌀ ${avg} km/day`
      : 'no days yet';
    return `
      <span><b>${round1(planned)} / ${round1(totalKm)} km planned</b> · ${round1(remaining)} km to Dresden</span>
      <span>${right}</span>`;
  }

  // Glyphs for the breaks inside [startKm, endKm], positioned by km relative to
  // the container's own left edge (`containerLeft` is that container's rendered
  // px left, so the offsets agree with where the browser actually put it).
  function glyphs(startKm, endKm, containerLeft) {
    const opts = axisOpts();
    return state.breaks
      .filter((b) => b.routeDistanceKm > (startKm === 0 ? -1 : startKm) && b.routeDistanceKm <= endKm)
      .map((b) => {
        const x = kmToX(b.routeDistanceKm, opts) - containerLeft;
        const glyph = BREAK_GLYPH[b.kind] || '☕';
        return `<span class="strip__glyph" style="left:${round1(x)}px" title="${esc(b.name)}">${glyph}</span>`;
      })
      .join('');
  }

  function blockLabel(block, day) {
    const km = `${round1(day.endKm - day.startKm)} km`;
    const town = day.townChoice ? `<span class="strip__block-town">🛏 ${esc(day.townChoice.name)}</span>` : '';
    if (block.tier === 'full') {
      return `<span class="strip__block-label"><b>${block.index + 1}</b> <span class="strip__block-km">${km}</span>${town}</span>`;
    }
    if (block.tier === 'km') {
      return `<span class="strip__block-label"><b>${block.index + 1}</b> <span class="strip__block-km">${km}</span></span>`;
    }
    if (block.tier === 'number') {
      return `<span class="strip__block-label"><b>${block.index + 1}</b></span>`;
    }
    return '';
  }

  function handle(index) {
    const day = state.days[index];
    const { min, max } = boundaryBounds(state.days, index, { totalKm: state.totalKm });
    const x = kmToX(day.endKm, axisOpts());
    const town = day.townChoice ? ` (${day.townChoice.name})` : '';
    const label = `Day ${index + 1} end, km ${round1(day.endKm)}${town}, arrow keys adjust`;
    return `
      <button type="button" class="strip__handle" data-boundary-index="${index}"
              style="left:${round1(x)}px" role="slider" tabindex="0"
              aria-valuenow="${round1(day.endKm)}" aria-valuemin="${round1(min)}" aria-valuemax="${round1(max)}"
              aria-label="${esc(label)}" title="${esc(label)}"></button>`;
  }

  function render(next) {
    state = {
      days: next.days || [],
      totalKm: next.totalKm || 0,
      focusedIndex: next.focusedIndex ?? null,
      breaks: next.breaks || [],
    };
    summaryEl.innerHTML = summary();

    const layout = stripLayout(state.days, axisOpts());
    const blocks = layout.blocks
      .map((block) => {
        const day = state.days[block.index];
        const box = span(block.x, block.width);
        const focused = block.index === state.focusedIndex ? ' strip__block--focused' : '';
        const town = day.townChoice ? ` — ${day.townChoice.name}` : '';
        const title = `Day ${block.index + 1} · ${round1(day.endKm - day.startKm)} km · km ${round1(day.startKm)} → ${round1(day.endKm)}${town}`;
        return `
          <div class="strip__block${focused}" data-day-index="${block.index}" role="button" tabindex="0"
               style="left:${box.left}px;width:${box.width}px" title="${esc(title)}">
            ${blockLabel(block, day)}
            ${block.tier === 'full' ? glyphs(day.startKm, day.endKm, box.left) : ''}
          </div>`;
      })
      .join('');

    const { remainder } = layout;
    const tailBox = span(remainder.x, remainder.width);
    const tail =
      tailBox.width > 0
        ? `<div class="strip__remainder" style="left:${tailBox.left}px;width:${tailBox.width}px">
             ${glyphs(remainder.startKm, remainder.endKm, tailBox.left)}
             <button type="button" class="strip__add" data-action="add-day">+ add a day</button>
             <span class="strip__flag">⚑ Dresden</span>
           </div>`
        : '<span class="strip__finish">⚑ Dresden reached</span>';

    axisEl.innerHTML = blocks + tail + state.days.map((_, i) => handle(i)).join('');
    scaleEl.innerHTML = `<span>km 0 · Hamburg</span><span>km ${round1(state.totalKm)} · Dresden</span>`;
  }

  // --- Interaction -------------------------------------------------------
  axisEl.addEventListener('click', (e) => {
    if (e.target.closest('.strip__handle')) return; // dragging, not focusing
    if (e.target.closest('[data-action="add-day"]')) {
      callbacks.onAddDay?.(null);
      return;
    }
    const block = e.target.closest('[data-day-index]');
    if (block) {
      callbacks.onFocusDay?.(Number(block.dataset.dayIndex));
      return;
    }
    const remainder = e.target.closest('.strip__remainder');
    if (remainder) {
      // Measure against the AXIS, not the remainder, so the km is absolute along
      // the route regardless of where the remainder starts.
      const rect = axisEl.getBoundingClientRect();
      const km = xToKm(e.clientX - rect.left, { totalKm: state.totalKm, width: rect.width || width() });
      callbacks.onAddDay?.(round1(km));
    }
  });

  return { render };
}
