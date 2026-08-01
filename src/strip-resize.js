// The strip's drag-to-resize gesture: a grab band along the TOP edge of the
// timeline strip that trades map height for axis height. At the fixed 46 px the
// axis has always had, one pixel of the elevation profile is ~6 m of climb, so a
// 30 m river terrace is five pixels of nothing; dragging up buys the profile the
// room to say something (spec §6b).
//
// Self-contained by design. The module owns exactly one element — the handle it
// creates inside `el` — and one number, the axis height in px. It never touches
// the axis, the profile or the map: it reports the new height through `onResize`
// and the CALLER re-renders. Storage is the injected localStorage-shaped object,
// and the viewport is measured through a seam, so nothing here needs a layout
// engine and every bound is drivable from a test.
//
// WIRING (Task 15), because two of these are ordering traps:
//   1. Mount this AFTER createStrip. createStrip assigns `el.innerHTML`, so a
//      handle added first is silently wiped. Afterwards it only ever replaces the
//      innerHTML of the three rows it owns, and the handle sits outside them.
//   2. `onResize(px)` must apply the height AND re-render: the axis is a plain
//      element with a CSS height, and strip.js reads that height back through its
//      measureHeight seam to scale the profile. Setting a custom property on the
//      strip container (`el.style.setProperty('--strip-axis-height', px + 'px')`,
//      with `.strip__axis { height: var(--strip-axis-height, 46px) }`) keeps
//      main.js out of strip.js's DOM; then call `strip.render()`.
//   3. main.js's ResizeObserver watches width today. A viewport that shrinks
//      lowers the 45% ceiling, which nothing here notices on its own — call
//      `remeasure()` from that observer (or from a window resize) and a stored
//      height taller than the new maximum repairs itself.
//
// CSS (Task 15) for `.strip__resize`: a full-width band along the strip's top
// edge, ~8 px of grabbable height (it is the strip's first child, and #strip's
// `10px 24px 9px` padding is what a negative margin would have to reach back over),
// `cursor: ns-resize`, and `touch-action: none` — without which a touch drag
// scrolls the page instead of resizing, the same reason .strip__axis carries it.
// A hover/`:focus-visible` affordance and a `.strip__resize--dragging` state
// (this module adds and removes that class) should follow .strip__handle's
// treatment. #strip already sets user-select: none, so a drag selects nothing.

const STRIP_HEIGHT_KEY = 'elberadweg-strip-height';

// The floor, and the height the strip has had until now: .strip__axis's height in
// style.css and strip.js's FALLBACK_HEIGHT. It is a floor and not just a default
// because the boundary handles are 10 px buttons that span the axis and overhang
// it by 3 px top and bottom: their grab target shrinks with the axis, and a strip
// too short to aim a boundary drag at leaves a user no way to drag it back open
// (spec §6b puts the floor here for that reason).
const MIN_HEIGHT_PX = 46;

// Above ~45% of the viewport the map stops being useful (spec §6b), and the map is
// the surface the strip is trading against.
const MAX_VIEWPORT_FRACTION = 0.45;

// jsdom reports a real innerHeight, but a 0 from a frame before layout settles
// would put the ceiling at the floor and freeze the gesture. Same reasoning as
// strip.js's FALLBACK_WIDTH.
const FALLBACK_VIEWPORT_PX = 800;

// Keyboard steps. Coarser than the boundary handles' 1 km nudge on purpose: a
// pixel per press would need 300 presses to cross the range, and unlike a km
// there is no exact height anyone is aiming for.
const ARROW_STEP_PX = 8;
const ARROW_STEP_SHIFT_PX = 24;

/**
 * Mounts the strip's resize handle and owns the height it drags.
 *
 * The height is the AXIS height, not the strip's: the summary and scale lines are
 * text and keep their own heights (spec §6b), so a pixel of drag is a pixel of
 * axis and the container grows by the same amount.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.el - the strip container. The handle is prepended to
 *   it, and it is also the pointer-capture target (see startDrag).
 * @param {{getItem(key: string): string|null, setItem(key: string, value: string): void}} [opts.storage]
 *   - injected storage (e.g. `localStorage`). Omitted, the height lives in memory
 *   for the session and persistence is a no-op.
 * @param {(heightPx: number) => void} [opts.onResize] - called with every new
 *   height, including once during construction with the height on load, so the
 *   caller's first render is already at the right size.
 * @param {() => number} [opts.measureViewport] - viewport height in px;
 *   injectable so the 45% ceiling is testable without a layout engine.
 * @returns {{height: () => number, remeasure: () => void}}
 */
export function createStripResize({ el, storage, onResize, measureViewport } = {}) {
  const viewportHeight = measureViewport || (() => window.innerHeight);

  // Interaction state lives here and never in the DOM, and so does the height
  // itself. The caller re-renders the strip on every reported height, and the
  // height it renders at is a CSS value we do not own the shape of — reading it
  // back from a rect would make the gesture depend on the caller having already
  // applied the previous move, and on jsdom having a layout engine, which it has
  // not. One number, one owner.
  let height = MIN_HEIGHT_PX;
  let dragging = null; // { pointerId, startY, startHeight }

  const handleEl = document.createElement('div');
  handleEl.className = 'strip__resize';
  // A focusable separator is the window-splitter pattern, and it comes with
  // aria-value*. The plan's own review caught Task 7 handing day blocks
  // role="button" with no key handler; claiming splitter semantics obliges the
  // arrow keys below, which is why they are here rather than left as a follow-up.
  handleEl.setAttribute('role', 'separator');
  handleEl.setAttribute('aria-orientation', 'horizontal');
  handleEl.setAttribute('aria-label', 'Resize the timeline');
  handleEl.tabIndex = 0;
  // First child, so the handle is on the top edge in reading order as well as on
  // screen: a keyboard user Tabs into it before the axis it resizes.
  el.insertBefore(handleEl, el.firstChild);

  // --- The height and its bounds -----------------------------------------

  function bounds() {
    const viewport = viewportHeight();
    const usable = Number.isFinite(viewport) && viewport > 0 ? viewport : FALLBACK_VIEWPORT_PX;
    // The floor wins a collision. On a viewport under ~102 px the fraction falls
    // below 46 px, and a strip that cannot be dragged back open is a worse
    // outcome than a strip that is briefly most of a tiny window.
    return { min: MIN_HEIGHT_PX, max: Math.max(MIN_HEIGHT_PX, Math.round(usable * MAX_VIEWPORT_FRACTION)) };
  }

  // Whole pixels: the profile is re-interpolated from this height, and a stored
  // 119.5 buys nothing that 120 does not. Non-finite lands on the floor, which is
  // what garbage in storage should read as.
  function clampHeight(px) {
    const { min, max } = bounds();
    if (!Number.isFinite(px)) return min;
    return Math.min(max, Math.max(min, Math.round(px)));
  }

  function syncAria() {
    const { min, max } = bounds();
    handleEl.setAttribute('aria-valuenow', String(height));
    handleEl.setAttribute('aria-valuemin', String(min));
    handleEl.setAttribute('aria-valuemax', String(max));
    // A bare "120" reads as a position on a scale nobody stated. This handle is
    // created once and never rebuilt, so unlike strip.js's boundary sliders — which
    // are destroyed by the render that follows every change and need a live region
    // to speak at all — what it says here is actually announced.
    handleEl.setAttribute('aria-valuetext', `${height} pixels`);
  }

  /**
   * Clamps, adopts and reports a height. Returns whether anything changed, so
   * each caller can decide whether the change is worth a write.
   *
   * Reporting only on a real change is the point: onResize rebuilds the axis and
   * re-interpolates ~700 elevation samples, and a pointer that has not crossed
   * into a new whole pixel has nothing new to say. strip.js skips its no-op
   * boundary previews for the same reason.
   */
  function setHeight(px) {
    const next = clampHeight(px);
    if (next === height) return false;
    height = next;
    syncAria();
    onResize?.(height);
    return true;
  }

  // Best-effort, matching favorites.js: private mode, a denied storage or a full
  // quota must never break a gesture that is already on screen.
  function persist() {
    try {
      storage?.setItem(STRIP_HEIGHT_KEY, String(height));
    } catch {
      // Swallowed — the height lives in memory; it just won't survive a reload.
    }
  }

  // --- Load, and repair ---------------------------------------------------

  function storedRaw() {
    try {
      return storage?.getItem(STRIP_HEIGHT_KEY) ?? null;
    } catch {
      // A storage that throws on read (SecurityError behind a policy) is a
      // storage with nothing in it.
      return null;
    }
  }

  const raw = storedRaw();
  // Number('') is 0, which clamps to the floor — the same repair garbage gets, so
  // an empty value needs no case of its own.
  height = clampHeight(raw === null ? MIN_HEIGHT_PX : Number(raw));
  syncAria();
  // Repair, rather than tolerate: a height left behind by a bigger window, or
  // hand-edited, would otherwise be re-read and re-clamped on every boot while
  // storage kept saying something we would never honour. Comparing the raw string
  // to the canonical one covers every case at once — out of bounds, garbage,
  // fractional, padded.
  //
  // An ABSENT key is not a repair and is not written: 46 px is what the strip does
  // by default, and writing it on first boot would record a preference nobody
  // expressed (and change nothing about the next read).
  if (raw !== null && raw !== String(height)) persist();
  onResize?.(height);

  // --- The drag -----------------------------------------------------------

  function startDrag(e) {
    if (dragging) {
      // A second pointer — a resting palm, a second finger — must not take over a
      // drag in flight; strip.js keeps its boundary drags to the pointer that
      // started them for the same reason.
      if (e.pointerId !== dragging.pointerId) return;
      // The SAME pointer pressing again is proof the previous gesture is over: its
      // release went missing (capture lost to a native gesture, a dialog, a window
      // switch). Ending the stale drag rather than ignoring the press means the new
      // one anchors on the CURRENT height, instead of resuming from a startY the
      // user let go of a minute ago and jumping the strip on the first move.
      endDrag();
    }
    if (e.button !== 0) return;
    dragging = { pointerId: e.pointerId, startY: e.clientY, startHeight: height };
    // No native drag of the element, no focus scroll. #strip already carries
    // user-select: none, so this is not what stops a selection.
    //
    // Note for the browser pass: cancelling pointerdown suppresses the
    // compatibility MOUSE events, but per Pointer Events click/dblclick are
    // dispatched regardless — which is what the double-click reset below depends
    // on. Worth an eyeball at a real pointer, since jsdom synthesises dblclick
    // for us either way.
    e.preventDefault();
    // Capture on `el`, never on the handle — strip.js's reasoning, one layer out.
    // There the first preview's re-render destroyed the handle and took the
    // capture with it; here the handle is ours and survives, but every move still
    // travels through the caller's re-render of the strip, and `el` is the element
    // that cannot be rebuilt underneath the gesture. A capture that dies mid-drag
    // leaves the remaining moves and the pointerup landing on whatever is under
    // the cursor — the map — and the strip frozen at its first step, still latched.
    // (jsdom implements no pointer capture at all, hence the guard.)
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      /* no capture available, or a pointerId that is already gone */
    }
    handleEl.classList.add('strip__resize--dragging');
    // The preventDefault above suppresses the compatibility mousedown, and with it
    // the click-focus a press would normally have given this element — so without
    // this the arrow keys and the reset below are unreachable after a mouse drag
    // until the user Tabs back to a handle they are already holding. strip.js
    // focuses its boundary handle at the end of startDrag for the same reason.
    // preventScroll: the strip sits at the bottom of a height:100vh,
    // overflow:hidden body, and scrolling that to "reveal" the handle shoves the
    // whole app off screen.
    handleEl.focus({ preventScroll: true });
  }

  function moveDrag(e) {
    if (!dragging || e.pointerId !== dragging.pointerId) return;
    // A pointerup we never saw — capture lost to a native gesture, a dialog, a
    // window switch. Without this the strip keeps resizing under a bare hovering
    // cursor until some later click ends it.
    if (e.buttons === 0) {
      endDrag(e);
      return;
    }
    // From the START of the drag every time, never from the last move: clientY
    // grows downwards, so up is taller, and accumulating per-move deltas would
    // drift — a drag that ran past a bound and came back would return to the wrong
    // height, because the moves outside the bounds were clamped and the deltas
    // were not.
    setHeight(dragging.startHeight + (dragging.startY - e.clientY));
  }

  // `e` is absent only for internal calls. pointerup, pointercancel and the
  // buttons===0 exit all land here, and all of them persist: a drag lost to a
  // context menu has already moved the strip on screen, and leaving it unwritten
  // would undo, on the next reload, a resize the user watched happen.
  function endDrag(e) {
    if (!dragging) return;
    if (e && e.pointerId !== undefined && e.pointerId !== dragging.pointerId) return;
    const done = dragging;
    dragging = null;
    try {
      el.releasePointerCapture?.(done.pointerId);
    } catch {
      /* already released, or never captured */
    }
    handleEl.classList.remove('strip__resize--dragging');
    // Once per gesture, not once per move — a drag across 300 px is one preference
    // change, and the moves in between are not worth a write each. Nothing moved,
    // nothing written: that covers a plain click on the handle and both halves of
    // the double-click below.
    if (height !== done.startHeight) persist();
  }

  handleEl.addEventListener('pointerdown', startDrag);
  // On `el` rather than on the handle, because that is where the capture is and so
  // where a browser retargets the rest of the gesture. The handle is outside the
  // axis, so none of this meets strip.js's own axis listeners; the guards above
  // are what make the axis's boundary-drag moves, which bubble through here, free.
  el.addEventListener('pointermove', moveDrag);
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  // Fires for our own releasePointerCapture too, which is why endDrag is a no-op
  // once dragging is null.
  el.addEventListener('lostpointercapture', endDrag);

  // Back to the height the strip has always had. Persisted, so the reset survives
  // a reload as deliberately as the resize did.
  handleEl.addEventListener('dblclick', () => {
    if (setHeight(MIN_HEIGHT_PX)) persist();
  });

  /**
   * The height a keypress asks for, or null for a key this handle has no business
   * taking. The arrows nudge; Enter is the double-click's keyboard equivalent, and
   * Home/End are what a splitter user reaches for (ARIA APG's window-splitter
   * pattern, the same pattern role="separator" claims).
   *
   * Enter and Home land on the same 46 px, because the floor is also the default.
   * Both are kept: a user pressing either means it, and collapsing them to one key
   * would only make the other silently do nothing. PageUp/PageDown are NOT here —
   * the pattern lists them, and a key that swallows the press without moving
   * anything is worse than a key the page still handles.
   */
  function keyTargetHeight(e) {
    const direction = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
    if (direction) return height + direction * (e.shiftKey ? ARROW_STEP_SHIFT_PX : ARROW_STEP_PX);
    if (e.key === 'Enter' || e.key === 'Home') return MIN_HEIGHT_PX;
    if (e.key === 'End') return bounds().max;
    return null;
  }

  handleEl.addEventListener('keydown', (e) => {
    const target = keyTargetHeight(e);
    if (target === null) return;
    e.preventDefault(); // the arrows, Home and End would all scroll the page
    // Persisted per press: a keypress is a whole gesture, with no release to wait
    // for. Held-down repeats write once per repeat, which is a handful of
    // localStorage writes of a five-character string — cheaper than the axis
    // rebuild each one already pays for.
    if (setHeight(target)) persist();
  });

  // No destroy: nothing in this codebase has one (createStrip, createMap and
  // createDayPanel all return behaviour only), because every one of them is
  // mounted once onto an element that lives as long as the page. Adding one here
  // alone would be a seam nobody holds the other end of.
  return {
    // No production caller yet: onResize is how the height travels, and this is here
    // for the caller that needs to ask rather than be told (map sizing, a debug
    // readout). Not a live seam — don't read the strip's height through it on the
    // assumption something keeps it warm.
    height: () => height,
    /**
     * Re-clamps the current height against the CURRENT bounds, reporting and
     * persisting only if it had to move. The ceiling is 45% of the viewport, and
     * this module measures the viewport only when the pointer moves — so a window
     * that shrinks, a rotated phone or a split screen can leave the strip taller
     * than the map can afford until someone asks.
     *
     * The repair is PERMANENT, because it is persisted: shrinking the window once
     * discards a taller preference for good, and growing it back leaves the strip
     * where the shrink put it. Deliberate, and the same trade the load-time repair
     * makes — a stored height the current viewport cannot honour is a height this
     * module would rather forget than keep re-clamping behind the user's back.
     */
    remeasure: () => {
      if (setHeight(height)) persist();
      // Unconditionally, and not only on setHeight's changed path: what moved is
      // the CEILING — that is the reason anyone calls this — and a height that
      // still fits returns early, leaving the handle announcing a maximum the
      // viewport no longer offers.
      syncAria();
    },
  };
}
