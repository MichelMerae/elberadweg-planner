// The bottom timeline strip: the whole trip drawn to scale in kilometres. Owns
// its own DOM and interaction; emits intent through callbacks. No Leaflet, no
// data modules — main.js passes plain days/breaks in (same contract as ui.js).

import { esc, round1, BREAK_GLYPH } from './ui-util.js';
import { boundaryBounds } from './boundaries.js';
import { stripLayout, kmToX, xToKm, hitTestHandle } from './strip-geometry.js';

// jsdom (and a first paint before layout settles) reports width 0; a plausible
// width keeps the strip renderable and the geometry tests honest.
const FALLBACK_WIDTH = 1000;

// How far the pointer must travel before a press counts as a drag rather than a
// click. Without it a narrow day — which lies entirely inside its own
// boundaries' grab tolerance — could never be focused by clicking it.
const DRAG_THRESHOLD_PX = 3;

const KEY_STEP_KM = 1;
const KEY_STEP_SHIFT_KM = 5;

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

  // Interaction state lives HERE and never in the DOM. render() rebuilds the
  // whole axis with innerHTML, and main.js re-renders on every drag preview, so
  // a gesture's own first move destroys the handle it started on: anything held
  // on that element (a class, a pointer capture, the focus ring) is gone before
  // the second move arrives.
  let dragging = null; // { index, pointerId, startX, lastX, moved }
  // A drag ends with a click on the axis, which must not also focus a day. Also
  // cleared on the next pointerdown, so a gesture that never produced a click
  // (pointercancel) can't swallow a later one.
  let suppressClick = false;

  el.classList.add('strip');
  el.innerHTML = `
    <div class="strip__summary"></div>
    <div class="strip__axis" data-strip-axis></div>
    <div class="strip__scale"></div>
    <div class="strip__live" role="status" aria-live="polite"></div>`;

  const summaryEl = el.querySelector('.strip__summary');
  const axisEl = el.querySelector('[data-strip-axis]');
  const scaleEl = el.querySelector('.strip__scale');
  const liveEl = el.querySelector('.strip__live');

  // rect.width, not clientWidth: clientWidth truncates to an integer while the
  // pointer maths below measures the same axis fractionally, and the two
  // disagreeing put a boundary up to a px away from where it was grabbed.
  const width = measureWidth || (() => axisEl.getBoundingClientRect().width || FALLBACK_WIDTH);

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

  /**
   * The glyph for a break's kind.
   *
   * `kind` comes from a stored plan a user could have hand-edited, so a bare
   * property lookup reaches Object.prototype — `kind: "toString"` interpolates a
   * function body into the markup. And '☕' as the fallback mislabels an unknown
   * break as a coffee stop; 📌 (custom) is the honest default.
   */
  function glyphFor(b) {
    return Object.hasOwn(BREAK_GLYPH, b.kind) ? BREAK_GLYPH[b.kind] : '📌';
  }

  // Breaks inside (startKm, endKm]. Day 1 starts at km 0 and owns a break sitting
  // exactly there, which is why the lower edge opens up for it.
  function breaksIn(startKm, endKm) {
    return state.breaks.filter(
      (b) => b.routeDistanceKm > (startKm === 0 ? -1 : startKm) && b.routeDistanceKm <= endKm,
    );
  }

  /**
   * One glyph layer for the whole axis, each break at its absolute route km.
   *
   * These used to be children of the day they fell in, which cost three things: a
   * block's `overflow: hidden` clipped them, every offset needed the block's own
   * rendered left edge subtracted (a whole class of off-by-a-block bug), and they
   * were gated behind the widest label tier — 88 px, about 39 km at desktop
   * width — so a 20 km day with a café silently showed nothing. At axis level
   * they work at every tier. They are pointer-events: none, so clicks still reach
   * the block underneath.
   */
  function glyphLayer() {
    const opts = axisOpts();
    return state.breaks
      .filter((b) => Number.isFinite(b.routeDistanceKm) && b.routeDistanceKm >= 0 && b.routeDistanceKm <= state.totalKm)
      .map((b) => {
        const x = kmToX(b.routeDistanceKm, opts);
        return `<span class="strip__glyph" style="left:${round1(x)}px" title="${esc(b.name)}">${glyphFor(b)}</span>`;
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
    // Re-derived from `dragging` on every render rather than set on the node:
    // the node this class belongs to is destroyed by the drag's first preview.
    const active = dragging && dragging.index === index ? ' strip__handle--dragging' : '';
    return `
      <button type="button" class="strip__handle${active}" data-boundary-index="${index}"
              style="left:${round1(x)}px" role="slider" tabindex="0"
              aria-valuenow="${round1(day.endKm)}" aria-valuemin="${round1(min)}" aria-valuemax="${round1(max)}"
              aria-label="${esc(label)}" title="${esc(label)}"></button>`;
  }

  // A selector for whatever the axis currently holds focus on, so render() can
  // put it back on the replacement node. Without this the axis rebuild drops
  // focus to <body>: a keyboard user gets exactly one arrow-key nudge per Tab,
  // and Enter on a block loses the block it just focused, because handleFocusDay
  // re-renders too. Keyed on the day/boundary index rather than the node, since
  // the node itself does not survive.
  function focusedSelector() {
    const node = document.activeElement?.closest?.('[data-boundary-index],[data-day-index]');
    if (!node || !axisEl.contains(node)) return null;
    const boundary = node.dataset.boundaryIndex;
    // Number() so the value can only ever be a number in the selector.
    return boundary !== undefined
      ? `[data-boundary-index="${Number(boundary)}"]`
      : `[data-day-index="${Number(node.dataset.dayIndex)}"]`;
  }

  // Called with new state, or with none to re-lay-out the state already held —
  // which is what a width change needs: the km values are unchanged, but every
  // px in the DOM was derived from the old axis width. A ResizeObserver in
  // main.js drives that path.
  function render(next = state) {
    state = {
      days: next.days || [],
      totalKm: next.totalKm || 0,
      focusedIndex: next.focusedIndex ?? null,
      breaks: next.breaks || [],
    };
    summaryEl.innerHTML = summary();

    const layout = stripLayout(state.days, axisOpts());
    // Day then its own boundary, left to right along the trip. Handles are
    // absolutely positioned and lifted by z-index, so source order costs nothing
    // visually and buys the tab order: all blocks and then all handles made a
    // keyboard user cross the whole route twice to reach day 2's end.
    const blocks = layout.blocks
      .map((block) => {
        const day = state.days[block.index];
        const box = span(block.x, block.width);
        const focused = block.index === state.focusedIndex ? ' strip__block--focused' : '';
        const town = day.townChoice ? ` — ${day.townChoice.name}` : '';
        // Name the breaks: on a narrow day their glyphs overlap into one
        // illegible cluster, and a 5 km day is ~11 px wide.
        const marks = breaksIn(day.startKm, day.endKm);
        const marked = marks.length ? ` · ${marks.map((b) => `${glyphFor(b)} ${b.name}`).join(', ')}` : '';
        const title = `Day ${block.index + 1} · ${round1(day.endKm - day.startKm)} km · km ${round1(day.startKm)} → ${round1(day.endKm)}${town}${marked}`;
        return `
          <div class="strip__block${focused}" data-day-index="${block.index}" role="button" tabindex="0"
               style="left:${box.left}px;width:${box.width}px" title="${esc(title)}">
            ${blockLabel(block, day)}
          </div>${handle(block.index)}`;
      })
      .join('');

    const { remainder } = layout;
    const tailBox = span(remainder.x, remainder.width);
    const arrived = state.days.length > 0 && tailBox.width <= 0;
    const tail =
      tailBox.width > 0
        ? `<div class="strip__remainder" style="left:${tailBox.left}px;width:${tailBox.width}px">
             <button type="button" class="strip__add" data-action="add-day">+ add a day</button>
             <span class="strip__flag">⚑ Dresden</span>
           </div>`
        : '';

    const restore = focusedSelector();
    axisEl.innerHTML = blocks + tail + glyphLayer();
    // preventScroll: the strip sits at the bottom of a height:100vh,
    // overflow:hidden body, and scrolling that to "reveal" the handle shoves the
    // whole app off screen.
    if (restore) axisEl.querySelector(restore)?.focus({ preventScroll: true });
    // The finish marker lives here rather than on the axis: at right: 0 over a
    // collapsed remainder it sat on top of the last block and underneath the last
    // handle. The scale line already names Dresden, so it says "reached" instead.
    scaleEl.innerHTML =
      `<span>km 0 · Hamburg</span>` +
      (arrived
        ? `<span class="strip__finish">⚑ km ${round1(state.totalKm)} · Dresden reached</span>`
        : `<span>km ${round1(state.totalKm)} · Dresden</span>`);
  }

  // --- Interaction -------------------------------------------------------

  // The axis as the pointer sees it: one measurement feeding both the km mapping
  // and the hit-test, so a press lands on the boundary it looks like it lands on.
  function pointerAxis() {
    const rect = axisEl.getBoundingClientRect();
    return { left: rect.left, width: rect.width || width() };
  }

  function kmAtClientX(clientX) {
    const axis = pointerAxis();
    return round1(xToKm(clientX - axis.left, { totalKm: state.totalKm, width: axis.width }));
  }

  function layoutForPointer(axis) {
    return stripLayout(state.days, { totalKm: state.totalKm, width: axis.width });
  }

  /**
   * The km boundary `index` may legally take for a requested `km`, or null when
   * it has nowhere to go.
   *
   * Null is not the same as "clamped". boundaryBounds floors max at min, so a
   * pair of days spanning under 2 x MIN_DAY_KM collapses to a single reported
   * position that is itself a move the model refuses. Asking for it would report
   * a change that never happened — and on a plan that squeezed, that is how a
   * drag rewrites days it never actually moved.
   */
  function proposeKm(index, km) {
    const { min, max } = boundaryBounds(state.days, index, { totalKm: state.totalKm });
    if (min >= max) return null;
    return round1(Math.min(Math.max(km, min), max));
  }

  function emitMove(index, clientX, commit) {
    // A latched index can outlive the day it belongs to: switching plans
    // re-renders the strip with a different set of days mid-gesture, and
    // deriving bounds from a stale index then reads endKm of undefined.
    if (!state.days[index]) return;
    const km = proposeKm(index, kmAtClientX(clientX));
    if (km === null) {
      // The window collapsed under the drag. Nothing legal left to ask for, but a
      // release still has to reach main.js once so the moves already applied get
      // persisted; the boundary's own value is a no-op move that does that.
      if (!commit) return;
      callbacks.onMoveBoundary?.(index, round1(state.days[index].endKm), { commit: true });
      return;
    }
    // Previews only: don't spend a full axis rebuild on a pointer that hasn't
    // crossed into a new 0.1 km. A commit is never skipped — it is what persists.
    if (!commit && km === round1(state.days[index].endKm)) return;
    callbacks.onMoveBoundary?.(index, km, { commit });
  }

  function dayIndexAtClientX(clientX) {
    const axis = pointerAxis();
    const x = clientX - axis.left;
    const block = layoutForPointer(axis).blocks.find((b) => x >= b.x && x <= b.x + b.width);
    return block ? block.index : null;
  }

  function startDrag(e) {
    suppressClick = false;
    if (dragging || e.button !== 0) return;
    // The remainder's 8px of padding puts the add button inside the last
    // boundary's grab tolerance, and latching there would preventDefault the
    // press and swallow the button's click.
    if (e.target.closest?.('[data-action="add-day"]')) return;
    const axis = pointerAxis();
    // Hit-test the GEOMETRY, not the DOM. MIN_DAY_KM puts two handles ~11 px
    // apart at desktop width while the CSS gives each a 24 px grab area, so
    // their zones overlap and the DOM would let paint order decide the winner
    // rather than proximity — and on a run of minimum-length days the handles
    // cover the blocks between them completely.
    const index = hitTestHandle(e.clientX - axis.left, layoutForPointer(axis));
    if (index === null) return;
    // A boundary with nowhere legal to go must not swallow the press: leave it to
    // the click handler, which focuses the day instead.
    if (proposeKm(index, state.days[index].endKm) === null) return;

    dragging = { index, pointerId: e.pointerId, startX: e.clientX, lastX: e.clientX, moved: false };
    e.preventDefault(); // no text selection, no native drag of the button
    // Capture on the AXIS, never on the handle. Measured in Chromium: the first
    // preview's re-render destroys the handle, taking any capture held on it with
    // it, after which every remaining move and the pointerup land outside the
    // 46 px axis band and never reach this module — the boundary moves one step,
    // freezes, never commits, and the drag stays latched so the plan afterwards
    // follows a bare hovering cursor. The axis survives the rebuild.
    // (jsdom implements no pointer capture at all, hence the guard.)
    try {
      axisEl.setPointerCapture?.(e.pointerId);
    } catch {
      /* no capture available, or a pointerId that is already gone */
    }
    render(); // paint the dragging state
    axisEl.querySelector(`[data-boundary-index="${index}"]`)?.focus({ preventScroll: true });
  }

  function moveDrag(e) {
    if (!dragging || e.pointerId !== dragging.pointerId) return;
    // A pointerup we never saw — capture lost to a native gesture, a dialog, a
    // window switch. Without this the drag stays latched and the boundary
    // follows the bare cursor across the axis, rewriting the plan on hover until
    // some later click commits it wherever it landed.
    if (e.buttons === 0) {
      endDrag();
      return;
    }
    dragging.lastX = e.clientX;
    if (!dragging.moved && Math.abs(e.clientX - dragging.startX) < DRAG_THRESHOLD_PX) return;
    dragging.moved = true;
    // dragging.index, never a fresh hit-test: hitTestHandle is stateless
    // nearest-wins, so re-running it here would hand the gesture to a crowded
    // neighbour the moment the pointer crossed its midpoint.
    emitMove(dragging.index, e.clientX, false);
  }

  function endDrag() {
    if (!dragging) return;
    const done = dragging;
    dragging = null; // cleared first: everything below re-renders
    try {
      axisEl.releasePointerCapture?.(done.pointerId);
    } catch {
      /* already released, or never captured */
    }
    suppressClick = true;
    if (done.moved) {
      // Recomputed from the last pointer position against the CURRENT days, not
      // replayed from the last previewed km: the model may have refused a preview,
      // and the commit must describe where the pointer is, not where we guessed.
      // (A cancelled gesture commits here too — the previews have already been
      // applied to the model, so leaving them unpersisted would only make the
      // screen and storage disagree.)
      emitMove(done.index, done.lastX, true);
    } else {
      // Below the threshold this was a click, not a drag. Focus the day under the
      // pointer — on a run of near-minimum days the handles cover their blocks
      // entirely, and without this those days could never be selected at all.
      const index = dayIndexAtClientX(done.lastX);
      callbacks.onFocusDay?.(index === null ? done.index : index);
    }
    render(); // drops strip__handle--dragging even if no callback re-rendered
  }

  axisEl.addEventListener('pointerdown', startDrag);
  axisEl.addEventListener('pointermove', moveDrag);
  axisEl.addEventListener('pointerup', endDrag);
  axisEl.addEventListener('pointercancel', endDrag);
  // Fires for our own releasePointerCapture too, which is why endDrag is a no-op
  // once dragging is null.
  axisEl.addEventListener('lostpointercapture', endDrag);

  axisEl.addEventListener('keydown', (e) => {
    const handleEl = e.target.closest?.('[data-boundary-index]');
    if (handleEl) {
      const direction = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!direction) return;
      e.preventDefault();
      const index = Number(handleEl.dataset.boundaryIndex);
      const day = state.days[index];
      if (!day) return;
      const step = e.shiftKey ? KEY_STEP_SHIFT_KM : KEY_STEP_KM;
      const km = proposeKm(index, round1(day.endKm + direction * step));
      if (km === null) return;
      callbacks.onMoveBoundary?.(index, km, { commit: true });
      // Announce where it ACTUALLY ended up, read back after the re-render, so a
      // move the model refused is not reported as having happened.
      const settled = state.days[index]?.endKm;
      if (settled !== undefined) announce(`Day ${index + 1} end, km ${round1(settled)}`);
      return;
    }
    // Task 7 gave blocks role="button" and tabindex="0" with no key handler, so
    // they claimed semantics they did not honour.
    const block = e.target.closest?.('[data-day-index]');
    if (block && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); // Space would scroll the page
      callbacks.onFocusDay?.(Number(block.dataset.dayIndex));
    }
  });

  axisEl.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (e.target.closest('[data-action="add-day"]')) {
      callbacks.onAddDay?.(null);
      return;
    }
    const block = e.target.closest('[data-day-index]');
    if (block) {
      callbacks.onFocusDay?.(Number(block.dataset.dayIndex));
      return;
    }
    // A click that reached a handle with no drag behind it: a keyboard
    // activation of the button, or a press on a boundary that has nowhere to go.
    // Focus its day rather than doing nothing — and take the index from the
    // element, because a keyboard-synthesised click has no clientX to map.
    const handleEl = e.target.closest('[data-boundary-index]');
    if (handleEl) {
      callbacks.onFocusDay?.(Number(handleEl.dataset.boundaryIndex));
      return;
    }
    const remainder = e.target.closest('.strip__remainder');
    if (remainder) {
      // Measure against the AXIS, not the remainder, so the km is absolute along
      // the route regardless of where the remainder starts.
      callbacks.onAddDay?.(kmAtClientX(e.clientX));
    }
  });

  // A role="slider" that is destroyed and recreated on every change never
  // announces its own aria-valuenow, so the value is spoken from a live region
  // that sits outside the axis and survives the rebuild.
  function announce(text) {
    liveEl.textContent = text;
  }

  return { render };
}
