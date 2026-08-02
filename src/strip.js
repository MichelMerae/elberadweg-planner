// The bottom timeline strip: the whole trip drawn to scale in kilometres. Owns
// its own DOM and interaction; emits intent through callbacks. No Leaflet and no
// data of its own — main.js passes plain days/breaks in. The one model import is
// boundaries.js's boundary math: pure functions, no store and no storage, the same
// trade places.js makes for the favorites key builder.

import { round1 } from './ui-util.js';
import { boundaryWindow, clampBoundaryKm } from './boundaries.js';
import { stripLayout, xToKm, hitTestHandle } from './strip-geometry.js';
import { summaryMarkup, axisMarkup, scaleMarkup } from './strip-markup.js';
import { profilePoints } from './elevation.js';

// jsdom (and a first paint before layout settles) reports width 0; a plausible
// width keeps the strip renderable and the geometry tests honest.
const FALLBACK_WIDTH = 1000;
// Matches .strip__axis's height in style.css. Read from the rect when layout has
// settled; this is the value used before then, and in jsdom.
const FALLBACK_HEIGHT = 46;

// One profile sample every 2 px. At a pixel per sample the path string runs ~17 KB
// and gets rebuilt on every pointermove of a boundary drag; at 2 px it halves, and
// terrain at 0.73 km per pixel has nothing finer to say.
const ELEVATION_PX_PER_COLUMN = 2;

// How far the pointer must travel before a press counts as a drag rather than a
// click. Without it a narrow day — which lies entirely inside its own
// boundaries' grab tolerance — could never be focused by clicking it.
const DRAG_THRESHOLD_PX = 3;

const KEY_STEP_KM = 1;
const KEY_STEP_SHIFT_KM = 5;

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.el - container the strip owns outright.
 * @param {Object} opts.callbacks
 * @param {(index: number) => void} opts.callbacks.onFocusDay
 * @param {(index: number, endKm: number, opts: {commit: boolean}) => void} opts.callbacks.onMoveBoundary
 * @param {(endKm: number|null) => void} opts.callbacks.onAddDay - endKm from a
 *   remainder click, or null to append a default-length day.
 * @param {(tripEnd: 'start'|'destination') => void} [opts.callbacks.onPickEnd] - one of
 *   the scale line's two end controls was pressed. A TOGGLE: main.js decides whether
 *   that arms a pick or cancels the one already armed, and re-renders with `picking`.
 * @param {() => number} [opts.measureWidth] - axis width in px; injectable for tests.
 * @param {() => number} [opts.measureHeight] - axis height in px; injectable for tests.
 */
export function createStrip({ el, callbacks = {}, measureWidth, measureHeight } = {}) {
  // originName/destinationName are undefined until main.js supplies them from
  // route.meta.json; strip-markup.js substitutes neutral words meanwhile. `trip` is
  // undefined until the first render brings one, and render() refuses without it —
  // there is no road-shaped fallback, because the axis maps the TRIP.
  let state = { days: [], focusedIndex: null, breaks: [] };

  // Interaction state lives HERE and never in the DOM. render() rebuilds the
  // whole axis with innerHTML, and main.js re-renders on every drag preview, so
  // a gesture's own first move destroys the handle it started on: anything held
  // on that element (a class, a pointer capture, the focus ring) is gone before
  // the second move arrives.
  let dragging = null; // { index, pointerId, startX, lastX, moved }
  // A drag ends with a click on the axis, which must not also focus a day.
  //
  // Two gestures arm this and then never produce that click: pointercancel, and
  // the buttons===0 exit. So it is also cleared by the next pointerdown AND the
  // next keydown — otherwise the stale latch eats the click a browser synthesises
  // when Enter lands on a real <button> in the axis, and "+ add a day" silently
  // does nothing.
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
  const axisWidth = measureWidth || (() => axisEl.getBoundingClientRect().width || FALLBACK_WIDTH);
  const axisHeight = measureHeight || (() => axisEl.getBoundingClientRect().height || FALLBACK_HEIGHT);

  // The elevation profile depends only on the axis box, the WINDOW it spans and the
  // profile itself — never on the days. Without this memo every pointermove of a
  // boundary drag would re-interpolate ~700 samples to redraw an identical path.
  let elevationMemo = null;

  // Sampled over the trip's own window, in trip order: the profile has to describe the
  // stretch the axis draws, and profilePoints mirrors itself for a descending window so
  // a downstream ride reads left to right like everything else here.
  //
  // The memo key carries BOTH ends. On the road's length alone it served the first
  // window's samples to every later window on the same road — switching plans would
  // redraw the days and leave the terrain behind.
  function elevationPointsFor(width, height, { startKm, endKm }) {
    if (!state.elevation) return null;
    if (
      elevationMemo &&
      elevationMemo.width === width &&
      elevationMemo.height === height &&
      elevationMemo.startKm === startKm &&
      elevationMemo.endKm === endKm &&
      elevationMemo.profile === state.elevation
    ) {
      return elevationMemo.points;
    }
    const points = profilePoints(state.elevation, {
      startKm,
      endKm,
      width,
      height,
      columns: Math.max(2, Math.round(width / ELEVATION_PX_PER_COLUMN)),
    });
    elevationMemo = { width, height, startKm, endKm, profile: state.elevation, points };
    return points;
  }

  // The window the axis maps, in the two names strip-geometry asks for. One place, so
  // the render path and the pointer path can never disagree about which km an x is —
  // a click mapped through a different window than the block under it was drawn in
  // would move a boundary to somewhere the user did not point.
  function windowFor(width) {
    return { startKm: state.trip.startKm, endKm: state.trip.destinationKm, width };
  }

  // The axis: the TRIP's window drawn across the width, in trip order. Every px derived
  // from it — blocks, handles, glyphs, the profile — is window geometry, and the km
  // feeding it stay ABSOLUTE (kmToX takes the road's own numbers and maps them in).
  //
  // The trip rides along so the markup has one source for the window: the two ends
  // strip-geometry needs and the value object every km on screen is converted through
  // are built here, together, from the same trip.
  function axisOpts() {
    const width = axisWidth();
    const height = axisHeight();
    const window = windowFor(width);
    return {
      ...window,
      trip: state.trip,
      height,
      elevationPoints: elevationPointsFor(width, height, window),
    };
  }

  // A role="slider" that is destroyed and recreated on every change never
  // announces its own aria-valuenow, so the value is spoken from a live region
  // that sits outside the axis and survives the rebuild.
  function announce(text) {
    liveEl.textContent = text;
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
    const trip = next.trip;
    // No fallback. The axis maps the trip's window, so a road-shaped stand-in would be
    // a second, silent window with every km on screen counted from the wrong origin —
    // which is what the fallback this replaces actually did. day-panel and places
    // refuse for the same reason, in the same voice.
    if (!trip || typeof trip.tripKm !== 'function') {
      throw new Error('strip render needs a trip (see createTrip in src/trip.js)');
    }
    state = {
      days: next.days || [],
      focusedIndex: next.focusedIndex ?? null,
      breaks: next.breaks || [],
      // No `?? state.x` on any field here, and none is missing. What carries the
      // width-change render (main.js drives it from a ResizeObserver, with no
      // argument) is the DEFAULT PARAMETER above: `next` IS `state` there, so a
      // field-level fallback could never reach its right-hand side anyway. Every
      // production render states every field. And a partial render is not an API this
      // has: `render({ days })` would still reset `focusedIndex` to null and `breaks`
      // to [], dropping the focus ring and every glyph — so a fallback on the four
      // fields below would promise a safety it does not deliver.
      originName: next.originName,
      destinationName: next.destinationName,
      elevation: next.elevation,
      endNames: next.endNames,
      // null is MEANINGFUL here, so the fallback is `?? null` and not `?? state.picking`:
      // main.js cancels a pick by rendering with picking: null, and `null ?? state.picking`
      // would keep the control pressed for ever. An argument-less render still preserves
      // it, because `next` defaults to `state` — the same shape focusedIndex uses.
      picking: next.picking ?? null,
      trip,
    };
    const axis = axisOpts();
    const layout = stripLayout(state.days, axis);

    summaryEl.innerHTML = summaryMarkup(state);
    const restore = focusedSelector();
    axisEl.innerHTML = axisMarkup(state, layout, axis, dragging ? dragging.index : null);
    // preventScroll: the strip sits at the bottom of a height:100vh,
    // overflow:hidden body, and scrolling that to "reveal" the handle shoves the
    // whole app off screen.
    if (restore) axisEl.querySelector(restore)?.focus({ preventScroll: true });
    scaleEl.innerHTML = scaleMarkup(state, layout);
  }

  // --- Interaction -------------------------------------------------------

  // The axis as the pointer sees it: one measurement feeding both the km mapping
  // and the hit-test, so a press lands on the boundary it looks like it lands on.
  // The width comes from the same seam render() measures, not from this rect: in
  // production the two are the same number, and in a test the injected
  // measureWidth is then authoritative on its own rather than only when the
  // stubbed rect happens to agree with it.
  function pointerAxis() {
    const rect = axisEl.getBoundingClientRect();
    return { left: rect.left, width: axisWidth() };
  }

  // ABSOLUTE route km, which is the contract for every km this module emits — the
  // window only decides which stretch of road the axis covers, never how a km is
  // named. A pointer past either end reads as that end: kmToX clamps, so xToKm does.
  function kmAtClientX(clientX) {
    const axis = pointerAxis();
    return round1(xToKm(clientX - axis.left, windowFor(axis.width)));
  }

  function layoutForPointer(axis) {
    return stripLayout(state.days, windowFor(axis.width));
  }

  /**
   * The km boundary `index` may legally take for a requested `km`, or null when
   * it has nowhere to go.
   *
   * Null is not the same as "clamped": on a pair of days too squeezed to hold a
   * boundary between them, asking for the one position the window reports would
   * report a change that never happened — and on a plan that squeezed, that is
   * how a drag rewrites days it never actually moved. boundaryWindow owns that
   * distinction (the model refuses the same moves for the same reason).
   */
  function proposeKm(index, km) {
    // A drag is bounded by the trip the plan was measured along, not by the road.
    const trip = state.trip;
    if (!boundaryWindow(state.days, index, { trip })) return null;
    // Clamped by boundaries.js rather than here: its bounds come back in TRIP order,
    // so a numeric Math.min/Math.max would pull the km towards the road's origin
    // instead of the rider's once the strip draws a downstream window. Same value as
    // the window's own bounds — a non-null window is never inverted — so this is one
    // answer, asked for in the direction-safe way.
    return round1(clampBoundaryKm(state.days, index, km, { trip }));
  }

  // `commit` travels in the same `{ commit }` shape it is emitted in, so the
  // call sites below read the way onMoveBoundary's contract does.
  function emitMove(index, clientX, { commit }) {
    // A latched index can outlive the day it belongs to: switching plans
    // re-renders the strip with a different set of days mid-gesture, and
    // deriving bounds from a stale index then reads endKm of undefined.
    //
    // There is nothing to preview for a day that is gone, but a COMMIT still has
    // to travel. main.js keeps gesture state between calls — the plan generation
    // the gesture opened in, cleared by whichever commit ends it — and refuses
    // every boundary move that arrives with a stale one. Swallowing this commit
    // therefore does not just lose the move: it leaves that latch closed, and the
    // NEXT drag on either surface is refused end to end, in silence. main.js
    // refuses this one too (the day does not exist), so the km is a formality —
    // 0 says plainly that there is no position left to report — but the refusal
    // clears the latch and re-renders, which is the whole point of sending it.
    // map.js's dragend path never had this hole: it has no early return.
    if (!state.days[index]) {
      if (commit) callbacks.onMoveBoundary?.(index, 0, { commit: true });
      return;
    }
    const km = proposeKm(index, kmAtClientX(clientX));
    if (km === null) {
      // The window collapsed under the drag. Nothing legal left to ask for, but a
      // release still has to reach main.js once so the moves already applied get
      // persisted; the boundary's own value is a no-op move that does that.
      //
      // Untested insurance, and known to be: reaching it needs the day list
      // swapped mid-gesture for one where this boundary has nowhere to go. Left in
      // rather than removed — the alternative is a drag whose moves are on screen
      // and not in storage — but noted so the silence is not read as coverage.
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
    // Same shape of problem at the axis's own edges: an edge stub sits 2px outside it,
    // which is well inside HANDLE_TOLERANCE_PX of a boundary standing on that edge —
    // and a finished plan always leaves its last boundary standing on the right one.
    // The caps are not a drag surface; nothing outside the axis may move a boundary.
    if (e.target.closest?.('.strip__stub')) return;
    const axis = pointerAxis();
    // Hit-test the GEOMETRY, not the DOM: nearest boundary within
    // HANDLE_TOLERANCE_PX wins. MIN_DAY_KM puts two handles ~11 px apart at
    // desktop width, so any grab zone wide enough to be usable overlaps its
    // neighbour's, and letting the DOM answer means paint order picks the winner
    // rather than proximity. The handles are plain 10 px buttons with nothing
    // extending their hit area for exactly this reason (see .strip__handle in
    // style.css) — and on a run of minimum-length days they cover the blocks
    // between them completely, so the blocks cannot answer either.
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
      endDrag(e);
      return;
    }
    dragging.lastX = e.clientX;
    if (!dragging.moved && Math.abs(e.clientX - dragging.startX) < DRAG_THRESHOLD_PX) return;
    dragging.moved = true;
    // dragging.index, never a fresh hit-test: hitTestHandle is stateless
    // nearest-wins, so re-running it here would hand the gesture to a crowded
    // neighbour the moment the pointer crossed its midpoint.
    emitMove(dragging.index, e.clientX, { commit: false });
  }

  // `e` is absent only for internal calls, which are already known to belong to
  // the dragging pointer. On a touch screen a second finger or a resting palm
  // fires its own pointerup: ending the drag on that commits the boundary early
  // and then discards the rest of the gesture, leaving it wherever the second
  // contact happened to land. (lostpointercapture for the captured pointer
  // carries that pointer's id, so the legitimate exits still match.)
  function endDrag(e) {
    if (!dragging) return;
    if (e && e.pointerId !== undefined && e.pointerId !== dragging.pointerId) return;
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
      emitMove(done.index, done.lastX, { commit: true });
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
    // A keypress means any pointer gesture is over, whether or not it ever
    // delivered the click this latch was waiting to absorb.
    suppressClick = false;
    const handleEl = e.target.closest?.('[data-boundary-index]');
    if (handleEl) {
      const direction = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!direction) return;
      e.preventDefault();
      const index = Number(handleEl.dataset.boundaryIndex);
      const day = state.days[index];
      if (!day) return;
      const step = e.shiftKey ? KEY_STEP_SHIFT_KM : KEY_STEP_KM;
      const trip = state.trip;
      // Stepped in RIDER km: an arrow moves the boundary along the TRIP, so
      // ArrowRight is always "further from the rider's start". Added to the absolute
      // km instead it ran backwards downstream — a press the user reads as forward
      // took the slider from 80 to 79. The km SENT stays absolute (the callback's
      // contract), and downstream that number decreases.
      const requested = trip.absoluteKm(trip.tripKm(day.endKm) + direction * step);
      const km = proposeKm(index, round1(requested));
      if (km === null) return;
      callbacks.onMoveBoundary?.(index, km, { commit: true });
      // Announce where it ACTUALLY ended up, read back after the re-render, so a
      // move the model refused is not reported as having happened. In rider km, like
      // the aria-valuenow on the very handle this describes: the two are one boundary
      // and speaking it two ways ("km 230.3" against a slider reading 81) is worse
      // than either way alone.
      const settled = state.days[index]?.endKm;
      if (settled !== undefined) announce(`Day ${index + 1} end, km ${round1(trip.tripKm(settled))}`);
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

  // The scale line is not a drag surface, so it gets its own plain click listener and
  // none of the axis's suppressClick machinery. Which end was pressed comes from the
  // control's own action and never from its position on the line: the two are the same
  // today only because the axis always runs start-then-destination.
  scaleEl.addEventListener('click', (e) => {
    const control = e.target.closest('[data-action^="set-"]');
    if (!control) return;
    callbacks.onPickEnd?.(control.dataset.action === 'set-start' ? 'start' : 'destination');
  });

  return { render };
}
