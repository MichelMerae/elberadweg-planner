// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStrip } from './strip.js';
import { MIN_DAY_KM, clampBoundaryKm } from './boundaries.js';
import { round1 } from './ui-util.js';

const TOTAL_KM = 650;
const WIDTH = 1300;

function days(...ends) {
  let prev = 0;
  return ends.map((endKm, index) => {
    const day = { index, startKm: prev, endKm, targetKm: endKm - prev, townChoice: null };
    prev = endKm;
    return day;
  });
}

let el;
let callbacks;

function mount(width = WIDTH) {
  el = document.createElement('div');
  document.body.appendChild(el);
  callbacks = {
    onFocusDay: vi.fn(),
    onMoveBoundary: vi.fn(),
    onAddDay: vi.fn(),
  };
  return createStrip({ el, callbacks, measureWidth: () => width });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

// --- Interaction harness ---------------------------------------------------
//
// A strip mounted with callbacks that behave like main.js's: they mutate a plan
// and then RE-RENDER. That re-render is the whole point. strip.js rebuilds the
// axis with innerHTML, and handleMoveBoundary calls renderAll() for commit:false
// too, so a drag's first preview destroys the very handle it started on. Tests
// that hand createStrip a bare vi.fn() leave the DOM standing and so certify a
// drag that cannot work in a browser — the failure Task 7's review measured in
// Chromium. Every pointer and keyboard test below goes through here.
//
// The move callback also mirrors itinerary.moveBoundary's REFUSAL: a pair of
// days spanning under 2 x MIN_DAY_KM has no legal boundary between them, so the
// model returns the day unchanged. The strip must never assume the km it sent
// was accepted.
function mountLive(ends, { totalKm = TOTAL_KM, width = WIDTH, focusedIndex = 0, breaks = [] } = {}) {
  const strip = mount(width);
  const axis = el.querySelector('[data-strip-axis]');
  // jsdom has no layout engine, so the axis rect the pointer maths reads is all
  // zeros unless we say otherwise.
  axis.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: 46, width, height: 46 });

  const plan = [...ends];
  let focused = focusedIndex;
  const moves = [];
  const render = () => strip.render({ days: days(...plan), totalKm, focusedIndex: focused, breaks });

  callbacks.onMoveBoundary.mockImplementation((index, endKm, opts = {}) => {
    moves.push({ index, endKm, commit: !!opts.commit });
    const target = clampBoundaryKm(days(...plan), index, endKm, { totalKm });
    const nextEnd = index + 1 < plan.length ? plan[index + 1] : null;
    if (nextEnd === null || round1(nextEnd - target) >= MIN_DAY_KM) plan[index] = target;
    render();
  });
  callbacks.onFocusDay.mockImplementation((index) => {
    focused = index;
    render();
  });

  render();
  return { strip, axis, moves, plan: () => [...plan], handle: (i) => axis.querySelector(`[data-boundary-index="${i}"]`), block: (i) => axis.querySelector(`[data-day-index="${i}"]`) };
}

// jsdom implements the PointerEvent constructor but NOT setPointerCapture, so a
// drag here is a sequence of events aimed by hand at the elements the browser
// would aim them at: the press at whatever is under the pointer, everything
// after it at the capture target, which is the axis.
function fire(target, type, { x = 0, buttons = 1, button = 0, pointerId = 1 } = {}) {
  target.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: 20,
      buttons,
      button,
      pointerId,
    }),
  );
}

function press(target, key, { shiftKey = false } = {}) {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey }));
}

// What a browser really does when Enter lands on a real <button>: keydown, and
// then — unless the handler prevented the default — the click it synthesises. jsdom
// does neither for the other, and the gap between them is where two review
// findings lived: a keydown-only test certifies a button that does nothing when a
// user actually presses it, and the synthesised click is exactly what a stale drag
// latch eats. The strip's day blocks are role="button" DIVS, which get no
// synthesised click at all, so this only clicks real buttons — same as the browser.
function activate(target, key = 'Enter') {
  const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key });
  target.dispatchEvent(event);
  if (!event.defaultPrevented && target.matches('button')) target.click();
}

describe('createStrip - keyboard boundary nudges', () => {
  it('nudges a boundary 1 km per arrow press, committing each one', () => {
    const { handle } = mountLive([80, 160]);

    press(handle(0), 'ArrowRight');

    expect(callbacks.onMoveBoundary).toHaveBeenCalledWith(0, 81, { commit: true });
  });

  it('takes a 5 km step with shift held', () => {
    const { handle } = mountLive([80, 160]);

    press(handle(0), 'ArrowLeft', { shiftKey: true });

    expect(callbacks.onMoveBoundary).toHaveBeenCalledWith(0, 75, { commit: true });
  });

  it('clamps a nudge at the neighbouring day floor', () => {
    // Boundary 0 may run to 155 - MIN_DAY_KM = 150, which is where it already is.
    // It still commits: the value is legal, and a commit is what persists the plan.
    const { handle } = mountLive([150, 155]);

    press(handle(0), 'ArrowRight');

    expect(callbacks.onMoveBoundary).toHaveBeenCalledWith(0, 150, { commit: true });
  });

  it('asks for nothing when the boundary has nowhere legal to go', () => {
    // days(6, 9): boundary 0's window is min 5, max max(5, 9 - 5) = 5 — collapsed.
    // boundaryBounds floors max at min, so the single position it reports (5) is
    // itself a move the model refuses. Sending it would report a change that
    // never happened, and on a plan this squeezed that is how a drag used to
    // rewrite days that never moved.
    const { handle } = mountLive([6, 9]);

    press(handle(0), 'ArrowLeft');
    press(handle(0), 'ArrowRight');

    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
  });

  it('ignores keys that are not arrows', () => {
    const { handle } = mountLive([80, 160]);

    ['a', 'Tab', 'ArrowUp', 'ArrowDown', 'Escape'].forEach((key) => press(handle(0), key));

    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
  });

  // The measured symptom of the bug this guards: document.activeElement is BODY
  // after a render, so a keyboard user got exactly one nudge per Tab.
  it('keeps focus on the handle across the re-render, so the next press lands', () => {
    const { handle, moves } = mountLive([80, 160]);
    const first = handle(0);
    first.focus();

    press(first, 'ArrowRight');

    expect(document.activeElement).not.toBe(first); // the node itself is gone
    expect(document.activeElement.dataset.boundaryIndex).toBe('0');

    press(document.activeElement, 'ArrowRight');
    press(document.activeElement, 'ArrowRight');

    expect(moves.map((m) => m.endKm)).toEqual([81, 82, 83]);
  });

  it('leaves focus alone when it was not in the strip', () => {
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    const { strip } = mountLive([80, 160]);
    outside.focus();

    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 1, breaks: [] });

    expect(document.activeElement).toBe(outside);
  });

  // A role="slider" whose element is destroyed and recreated never announces its
  // own value change, so the value is spoken from a live region that survives
  // the rebuild.
  it('announces the value the boundary settled on', () => {
    const { handle } = mountLive([80, 160]);

    press(handle(0), 'ArrowRight');

    const live = el.querySelector('[role="status"]');
    expect(live.textContent).toContain('81');
    expect(live.textContent).toContain('Day 1');
  });
});

describe('createStrip - keyboard on a day block', () => {
  it('focuses the day on Enter and keeps DOM focus on the block', () => {
    const { block } = mountLive([80, 160]);
    const first = block(1);
    first.focus();

    press(first, 'Enter');

    expect(callbacks.onFocusDay).toHaveBeenCalledWith(1);
    // handleFocusDay re-renders too, so the block that was just focused is
    // replaced — focus has to be re-emitted for blocks, not only handles.
    expect(document.activeElement).not.toBe(first);
    expect(document.activeElement.dataset.dayIndex).toBe('1');
  });

  it('focuses the day on Space', () => {
    const { block } = mountLive([80, 160]);

    press(block(1), ' ');

    expect(callbacks.onFocusDay).toHaveBeenCalledWith(1);
  });

  it('does not move the boundary underneath the block', () => {
    const { block } = mountLive([80, 160]);

    press(block(0), 'Enter');
    press(block(0), 'ArrowRight');

    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
  });

  // A handle is a real <button>, so Enter on one produces a click nothing else
  // would: the arrow-key branch declines the key without preventing the default,
  // and the click handler answers by focusing the day. Only reachable through the
  // browser's synthesised click, which is why this needs `activate`.
  it('focuses a day when Enter lands on its boundary handle', () => {
    const { handle } = mountLive([80, 160], { focusedIndex: 1 });

    activate(handle(0));

    expect(callbacks.onFocusDay).toHaveBeenCalledWith(0);
    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
  });

  // The same press must not ALSO nudge the boundary: the keydown branch has to
  // decline Enter outright rather than falling through to a direction of 0.
  it('does not move a boundary on Enter', () => {
    const { handle } = mountLive([80, 160]);

    activate(handle(0));

    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
  });
});

describe('createStrip - boundary drag', () => {
  // WIDTH 1300 over TOTAL_KM 650 is 2 px/km, so x 160 is km 80 and x 240 km 120.
  it('previews with commit:false and commits exactly once on release', () => {
    const { axis, moves, handle, plan } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 160 });
    fire(axis, 'pointermove', { x: 200 });
    fire(axis, 'pointermove', { x: 240 });
    fire(axis, 'pointerup', { x: 240, buttons: 0 });

    expect(moves.filter((m) => !m.commit)).toEqual([
      { index: 0, endKm: 100, commit: false },
      { index: 0, endKm: 120, commit: false },
    ]);
    expect(moves.filter((m) => m.commit)).toEqual([{ index: 0, endKm: 120, commit: true }]);
    expect(plan()).toEqual([120, 160]);
  });

  // The bug in one test: every preview rebuilds the axis, so the handle the press
  // landed on is detached before the second move arrives. The gesture has to
  // survive on state that lives outside the DOM.
  it('survives the re-render that destroys the handle it started on', () => {
    const { axis, moves, handle } = mountLive([80, 160]);
    const pressed = handle(0);

    fire(pressed, 'pointerdown', { x: 160 });
    fire(axis, 'pointermove', { x: 200 });

    expect(axis.contains(pressed)).toBe(false);

    fire(axis, 'pointermove', { x: 240 });
    fire(axis, 'pointerup', { x: 240, buttons: 0 });

    expect(moves.at(-1)).toEqual({ index: 0, endKm: 120, commit: true });
  });

  it('marks the dragged handle for as long as the drag is live', () => {
    const { axis, handle } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 160 });
    expect(axis.querySelector('.strip__handle--dragging').dataset.boundaryIndex).toBe('0');

    fire(axis, 'pointermove', { x: 200 });
    expect(axis.querySelector('.strip__handle--dragging').dataset.boundaryIndex).toBe('0');

    fire(axis, 'pointerup', { x: 200, buttons: 0 });
    expect(axis.querySelector('.strip__handle--dragging')).toBeNull();
  });

  it('does not focus a day on the click that ends a drag', () => {
    const { axis, handle, block } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 160 });
    fire(axis, 'pointermove', { x: 240 });
    fire(axis, 'pointerup', { x: 240, buttons: 0 });
    // Dispatched on the BLOCK, which is what a browser targets with the click
    // that follows a release over one. Aiming it at the axis instead matches
    // neither [data-day-index] nor [data-boundary-index], so onFocusDay could
    // not fire whether or not the gesture suppressed the click — the assertion
    // below would hold with the suppression deleted.
    fire(block(0), 'click', { x: 240, buttons: 0 });

    expect(callbacks.onFocusDay).not.toHaveBeenCalled();
  });

  it('latches the nearest boundary where two grab zones overlap', () => {
    // days(80, 85) puts handles 10 px apart at x 160 and 170, closer than the
    // grab tolerance — so the DOM would let paint order pick the winner. x 163 is
    // 3 px from boundary 0 and 7 from boundary 1, and the press is aimed at
    // boundary 1's element: nearest-wins has to answer 0 against a target that
    // says 1, or the fixture would pass on an implementation that just read
    // e.target.
    const { axis, moves, handle } = mountLive([80, 85]);

    fire(handle(1), 'pointerdown', { x: 163 });
    fire(axis, 'pointermove', { x: 100 });
    fire(axis, 'pointerup', { x: 100, buttons: 0 });

    expect(moves.map((m) => m.index)).toEqual([0, 0]);
    expect(moves.at(-1).endKm).toBe(50);
  });

  it('does not hand the gesture to a neighbouring boundary mid-drag', () => {
    // Boundary 0 clamps at 195 km (x 390) while boundary 1 sits at x 400, so a
    // pointer at 398 is nearer boundary 1 than to the boundary being dragged.
    // hitTestHandle is stateless nearest-wins, so re-running it on pointermove
    // would switch handles mid-gesture.
    const { axis, moves, handle, plan } = mountLive([80, 200, 400]);

    fire(handle(0), 'pointerdown', { x: 160 });
    fire(axis, 'pointermove', { x: 396 });
    fire(axis, 'pointermove', { x: 398 });
    fire(axis, 'pointerup', { x: 398, buttons: 0 });

    expect(moves.every((m) => m.index === 0)).toBe(true);
    expect(plan()).toEqual([195, 200, 400]);
  });

  it('focuses the day under a press that never moved', () => {
    // Below the drag threshold this is a click, not a drag. It has to fall
    // through to focusing the day, or a plan of near-minimum days — whose blocks
    // are narrower than the handles covering them — could never be selected.
    const { axis, handle, block } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 158 });
    fire(axis, 'pointerup', { x: 159, buttons: 0 });

    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
    expect(callbacks.onFocusDay).toHaveBeenCalledWith(0);
    expect(callbacks.onFocusDay).toHaveBeenCalledTimes(1);

    // The click the browser sends next, on the block it was released over: the
    // gesture has already focused the day, so this must not focus it again.
    fire(block(0), 'click', { x: 159, buttons: 0 });
    expect(callbacks.onFocusDay).toHaveBeenCalledTimes(1);
  });

  // A press that never moved counts as one interaction, not two. Suppressing its
  // trailing click must not leave the suppression armed for the NEXT click.
  it('still focuses a block clicked after a gesture', () => {
    const { axis, handle, block } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 158 });
    fire(axis, 'pointerup', { x: 159, buttons: 0 });
    fire(block(0), 'click', { x: 159, buttons: 0 });
    block(1).click();

    expect(callbacks.onFocusDay).toHaveBeenLastCalledWith(1);
    expect(callbacks.onFocusDay).toHaveBeenCalledTimes(2);
  });

  it('focuses the day the pointer is over, not the one the boundary belongs to', () => {
    // x 162 is 2 px past boundary 0, so the press latches boundary 0 — whose day
    // is day 1 — while the pointer is actually over day 2. Falling back to the
    // latched boundary's own index would select the day next door, which on a run
    // of narrow days means clicking one day and highlighting its neighbour.
    const { axis, handle } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 162 });
    fire(axis, 'pointerup', { x: 162, buttons: 0 });

    expect(callbacks.onFocusDay).toHaveBeenCalledWith(1);
  });

  it('treats a move below the drag threshold as a click, not a drag', () => {
    // A press wobbles by a pixel or two before it releases. Without a threshold
    // that wobble starts a drag, which both moves the boundary and suppresses the
    // click — so a day narrow enough to sit inside its own boundaries' grab
    // tolerance could never be focused by clicking it.
    const { axis, handle } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 155 }); // 5 px from the boundary, inside day 1
    fire(axis, 'pointermove', { x: 157 }); // 2 px of travel
    fire(axis, 'pointerup', { x: 157, buttons: 0 });

    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
    expect(callbacks.onFocusDay).toHaveBeenCalledWith(0);
  });

  // Everything below is the anti-latch guarantee. A drag that stays latched is
  // the destructive failure: the boundary then follows a bare hovering cursor,
  // rewriting the plan until some later click commits wherever it landed.
  it('stops dragging when the pointer capture is lost', () => {
    const { axis, moves, handle } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 160 });
    fire(axis, 'pointermove', { x: 200 });
    fire(axis, 'lostpointercapture', { x: 200 });

    expect(moves.at(-1)).toEqual({ index: 0, endKm: 100, commit: true });
    const settled = moves.length;

    fire(axis, 'pointermove', { x: 400 }); // a bare hover
    expect(moves).toHaveLength(settled);
    expect(axis.querySelector('.strip__handle--dragging')).toBeNull();
  });

  it('stops dragging on a move that arrives with no button held', () => {
    const { axis, moves, handle } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 160 });
    fire(axis, 'pointermove', { x: 200 });
    fire(axis, 'pointermove', { x: 240, buttons: 0 }); // the pointerup we never saw

    expect(moves.at(-1)).toEqual({ index: 0, endKm: 100, commit: true });
    const settled = moves.length;

    fire(axis, 'pointermove', { x: 400 });
    expect(moves).toHaveLength(settled);
  });

  it('stops dragging when the gesture is cancelled', () => {
    const { axis, moves, handle } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 160 });
    fire(axis, 'pointermove', { x: 200 });
    fire(axis, 'pointercancel', { x: 200, buttons: 0 });
    const settled = moves.length;

    fire(axis, 'pointermove', { x: 400 });
    expect(moves).toHaveLength(settled);
    expect(axis.querySelector('.strip__handle--dragging')).toBeNull();
  });

  it('ignores moves belonging to a second pointer', () => {
    const { axis, moves, handle } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 160, pointerId: 1 });
    fire(axis, 'pointermove', { x: 400, pointerId: 2 });

    expect(moves).toHaveLength(0);

    fire(axis, 'pointermove', { x: 200, pointerId: 1 });
    expect(moves.map((m) => m.endKm)).toEqual([100]);
  });

  it('ignores a release belonging to a second pointer', () => {
    // On a touch screen a second finger, or a palm, produces its own pointerup.
    // Ending the drag on it commits early and then discards the rest of the
    // gesture, so the boundary stops where the second contact happened to land.
    const { axis, moves, handle } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 160, pointerId: 1 });
    fire(axis, 'pointermove', { x: 200, pointerId: 1 });
    fire(axis, 'pointerup', { x: 240, buttons: 0, pointerId: 2 });

    expect(moves.filter((m) => m.commit)).toEqual([]);

    fire(axis, 'pointermove', { x: 240, pointerId: 1 });
    fire(axis, 'pointerup', { x: 240, buttons: 0, pointerId: 1 });

    expect(moves.filter((m) => !m.commit).map((m) => m.endKm)).toEqual([100, 120]);
    expect(moves.filter((m) => m.commit)).toEqual([{ index: 0, endKm: 120, commit: true }]);
  });

  it('ignores a non-primary button', () => {
    const { axis, moves, handle } = mountLive([80, 160]);

    fire(handle(0), 'pointerdown', { x: 160, button: 2, buttons: 2 });
    fire(axis, 'pointermove', { x: 240 });

    expect(moves).toHaveLength(0);
  });

  it('leaves the add button usable even though it sits on the last boundary', () => {
    // The remainder starts AT the last boundary and pads 8 px, so the button's box
    // begins at x 168 — still inside that handle's grab tolerance. Latching a drag
    // there would preventDefault the press and swallow the click. x 170 is a
    // press on the button itself rather than on the padding beside it.
    const { axis } = mountLive([80]);
    const add = axis.querySelector('[data-action="add-day"]');

    fire(add, 'pointerdown', { x: 170 });
    fire(axis, 'pointerup', { x: 170, buttons: 0 });
    add.click();

    expect(callbacks.onAddDay).toHaveBeenCalledWith(null);
    expect(callbacks.onMoveBoundary).not.toHaveBeenCalled();
  });

  it('does not let a cancelled gesture swallow a later keyboard activation', () => {
    // pointercancel and the buttons===0 exit end a drag with no trailing click
    // ever arriving, so the click suppression stays armed. The next thing it eats
    // is whatever click comes next — including the one a browser synthesises when
    // Enter is pressed on a real <button> inside the axis.
    const { axis, handle } = mountLive([80]);

    fire(handle(0), 'pointerdown', { x: 160 });
    fire(axis, 'pointermove', { x: 200 });
    fire(axis, 'pointercancel', { x: 200, buttons: 0 });

    // Tab to the add button and press Enter, keydown and synthesised click both.
    const add = axis.querySelector('[data-action="add-day"]');
    add.focus();
    activate(add);

    expect(callbacks.onAddDay).toHaveBeenCalledWith(null);
  });

  it('survives the day list shrinking under a live drag', () => {
    // Switching plans re-renders the strip with a different set of days, so a
    // latched boundary index can end up with no day behind it. Deriving bounds
    // from that index then reads days[index + 1].endKm of undefined.
    const errors = [];
    const onError = (e) => errors.push(e.message || String(e.error));
    window.addEventListener('error', onError);
    const { axis, strip, handle } = mountLive([80, 160, 240]);

    fire(handle(2), 'pointerdown', { x: 480 });
    callbacks.onMoveBoundary.mockImplementation(() => {
      strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });
    });
    fire(axis, 'pointermove', { x: 520 });
    fire(axis, 'pointermove', { x: 560 });
    fire(axis, 'pointerup', { x: 560, buttons: 0 });
    window.removeEventListener('error', onError);

    expect(errors).toEqual([]);
    expect(axis.querySelector('.strip__handle--dragging')).toBeNull();
  });

  it('still commits a gesture whose day vanished under it', () => {
    // Losing the move is the harmless half. main.js keeps gesture state BETWEEN
    // calls — the plan generation the gesture opened in, cleared by its commit —
    // so a commit that never arrives leaves that latch closed and the NEXT
    // boundary drag, on the strip or on a map pin, is refused end to end and in
    // silence. map.js's dragend path has no early return of its own and so never
    // had this hole.
    const { axis, strip, handle } = mountLive([80, 160, 240]);
    const seen = [];

    fire(handle(2), 'pointerdown', { x: 480 });
    callbacks.onMoveBoundary.mockImplementation((index, endKm, opts = {}) => {
      seen.push({ index, endKm, commit: !!opts.commit });
      strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });
    });
    fire(axis, 'pointermove', { x: 520 }); // the preview that swaps the plan out
    fire(axis, 'pointermove', { x: 560 }); // boundary 2 has no day behind it now
    fire(axis, 'pointerup', { x: 560, buttons: 0 });

    // The km is a formality — main.js refuses a move onto a day that is gone —
    // but the commit itself is what ends the gesture.
    expect(seen.at(-1)).toEqual({ index: 2, endKm: expect.any(Number), commit: true });
    expect(seen.filter((m) => m.commit)).toHaveLength(1);
  });

  it('does not drag a boundary that has nowhere legal to go', () => {
    const { axis, moves, handle } = mountLive([6, 9]);

    fire(handle(0), 'pointerdown', { x: 12 });
    fire(axis, 'pointermove', { x: 60 });
    fire(axis, 'pointerup', { x: 60, buttons: 0 });

    expect(moves).toHaveLength(0);
  });
});

describe('createStrip - summary', () => {
  it('reports planned, remaining, day count and average', () => {
    const strip = mount();
    strip.render({ days: days(80, 160, 265, 320), totalKm: TOTAL_KM, focusedIndex: 2, breaks: [] });

    const summary = el.querySelector('.strip__summary').textContent;
    expect(summary).toContain('320 / 650 km planned');
    expect(summary).toContain('330 km to finish');
    expect(summary).toContain('4 days');
    expect(summary).toContain('80 km/day');
  });

  it('invites a first day when the plan is empty', () => {
    const strip = mount();
    strip.render({ days: [], totalKm: TOTAL_KM, focusedIndex: null, breaks: [] });

    expect(el.querySelector('.strip__summary').textContent).toContain('0 / 650 km planned');
    expect(el.querySelector('[data-action="add-day"]')).not.toBeNull();
  });
});

describe('createStrip - blocks', () => {
  it('draws one block per day, to scale and contiguous', () => {
    const strip = mount();
    strip.render({ days: days(80, 160, 265, 320), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const blocks = [...el.querySelectorAll('.strip__block')];
    expect(blocks).toHaveLength(4);
    expect(blocks[0].style.left).toBe('0px');
    expect(blocks[0].style.width).toBe('160px');
    expect(blocks[2].style.left).toBe('320px');
    expect(blocks[2].style.width).toBe('210px');
  });

  it('marks the focused block', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 1, breaks: [] });

    const focused = el.querySelectorAll('.strip__block--focused');
    expect(focused).toHaveLength(1);
    expect(focused[0].dataset.dayIndex).toBe('1');
  });

  it('shows km and the overnight town at full tier', () => {
    const strip = mount();
    const list = days(80);
    list[0].townChoice = { name: 'Brackede' };
    strip.render({ days: list, totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const block = el.querySelector('.strip__block');
    expect(block.textContent).toContain('80 km');
    expect(block.textContent).toContain('Brackede');
  });

  it('drops the label on a block too narrow for one, keeping a tooltip', () => {
    const strip = mount();
    strip.render({ days: days(80, 85), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const narrow = el.querySelectorAll('.strip__block')[1];
    expect(narrow.querySelector('.strip__block-label')).toBeNull();
    expect(narrow.getAttribute('title')).toContain('5 km');
  });

  it('escapes an overnight town name', () => {
    const strip = mount();
    const list = days(80);
    list[0].townChoice = { name: '<script>x</script>' };
    strip.render({ days: list, totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    expect(el.querySelector('.strip__block').innerHTML).not.toContain('<script>');
  });

  it('places break glyphs at their km inside the day', () => {
    const strip = mount();
    strip.render({
      days: days(100),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      breaks: [{ name: 'Café', kind: 'food', routeDistanceKm: 50 }],
    });

    const glyph = el.querySelector('.strip__glyph');
    expect(glyph.textContent).toBe('☕');
    expect(glyph.style.left).toBe('100px'); // km 50 at 2 px/km
  });

  it('shows a break past the last planned day', () => {
    const strip = mount();
    strip.render({
      days: days(80),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      breaks: [{ name: 'Later', kind: 'sight', routeDistanceKm: 300 }],
    });

    const glyph = el.querySelector('.strip__glyph');
    expect(glyph).not.toBeNull();
    expect(glyph.textContent).toBe('📷');
    expect(glyph.style.left).toBe('600px'); // km 300 at 2 px/km
  });

  // Glyphs are one axis-level layer at absolute route km, not children of the day
  // they fall in. Inside a block they were clipped by its overflow: hidden, had
  // to have the block's own left edge subtracted, and — the reason this moved —
  // could only be drawn at the widest label tier.
  it('draws a glyph on the axis at its absolute km, not inside a block', () => {
    const strip = mount();
    strip.render({
      days: days(80, 160),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      breaks: [{ name: 'Café', kind: 'food', routeDistanceKm: 100 }],
    });

    const glyph = el.querySelector('.strip__glyph');
    expect(glyph.parentElement.dataset.stripAxis).toBeDefined();
    expect(glyph.style.left).toBe('200px'); // km 100 at 2 px/km
    expect(el.querySelector('.strip__block .strip__glyph')).toBeNull();
  });

  // The bug: glyphs used to render only at the 'full' label tier, whose threshold
  // is 88 px — about 39 km at desktop width. A 20 km day with a café showed
  // nothing at all, and the tooltip did not mention it either.
  it('shows a break on a day too narrow to carry a label', () => {
    const strip = mount();
    strip.render({
      days: days(20, 200),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      breaks: [{ name: 'Café', kind: 'food', routeDistanceKm: 10 }],
    });

    // 20 km is 40 px here: the day number fits, its km does not, and the 'full'
    // tier that used to gate glyphs starts at 88 px.
    const narrow = el.querySelectorAll('.strip__block')[0];
    expect(narrow.querySelector('.strip__block-km')).toBeNull();
    expect(el.querySelector('.strip__glyph').style.left).toBe('20px');
  });

  // A cluster of glyphs on a narrow day is one illegible smudge, so the day's
  // tooltip has to name what is in it.
  it('names a day’s breaks in its tooltip', () => {
    const strip = mount();
    strip.render({
      days: days(100, 200),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      breaks: [
        { name: 'Café', kind: 'food', routeDistanceKm: 50 },
        { name: 'Schloss', kind: 'sight', routeDistanceKm: 60 },
        { name: 'Elsewhere', kind: 'food', routeDistanceKm: 150 },
      ],
    });

    const title = el.querySelectorAll('.strip__block')[0].getAttribute('title');
    expect(title).toContain('☕ Café');
    expect(title).toContain('📷 Schloss');
    expect(title).not.toContain('Elsewhere'); // that one is day 2's
  });

  it('falls back to a pin for an unrecognised break kind', () => {
    const strip = mount();
    strip.render({
      days: days(100),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      // A hand-edited plan can carry any string here. A bare property lookup on
      // the glyph map interpolates Object.prototype members — 'toString' puts a
      // function body in the markup — and '☕' as the fallback would also
      // mislabel an unknown break as a coffee stop.
      breaks: [{ name: 'Odd', kind: 'toString', routeDistanceKm: 50 }],
    });

    const glyph = el.querySelector('.strip__glyph');
    expect(glyph.textContent).toBe('📌');
    expect(el.querySelector('[data-strip-axis]').innerHTML).not.toContain('function');
  });
});

describe('createStrip - focus and add', () => {
  it('focuses the day whose block is clicked', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    el.querySelectorAll('.strip__block')[1].click();

    expect(callbacks.onFocusDay).toHaveBeenCalledWith(1);
  });

  it('appends a day from the add button', () => {
    const strip = mount();
    strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    el.querySelector('[data-action="add-day"]').click();

    expect(callbacks.onAddDay).toHaveBeenCalledWith(null);
    // Exactly once: the button sits INSIDE the remainder, so the add-day branch
    // must return before the remainder branch runs. toHaveBeenCalledWith passes if
    // any call matches, so without this a double-fire — append a default day AND
    // add one ending at the click position — would go unnoticed.
    expect(callbacks.onAddDay).toHaveBeenCalledTimes(1);
  });

  it('adds a day ending at the clicked km on the remainder', () => {
    const strip = mount();
    strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    // The km comes from the pointer's position on the AXIS, so stub that rect.
    el.querySelector('.strip__axis').getBoundingClientRect = () => ({ left: 0, width: WIDTH, top: 0, height: 46 });
    el.querySelector('.strip__remainder').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, clientX: 560 }),
    );

    // x = 560 on a 1300 px axis over 650 km -> km 280
    expect(callbacks.onAddDay).toHaveBeenCalledWith(280);
  });

  it('hides the remainder once the plan reaches the destination', () => {
    const strip = mount();
    strip.render({ days: days(TOTAL_KM), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    expect(el.querySelector('.strip__remainder')).toBeNull();
    expect(el.querySelector('.strip__finish')).not.toBeNull();
  });

  // At right: 0 on the axis the finish marker landed on top of the last block and
  // underneath the last handle. The scale line already names the destination, so
  // it says "reached" there instead and collides with nothing.
  it('puts the finish marker in the scale line, not on the axis', () => {
    const strip = mount();
    strip.render({ days: days(TOTAL_KM), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const finish = el.querySelector('.strip__finish');
    expect(finish.parentElement.classList.contains('strip__scale')).toBe(true);
    expect(el.querySelector('[data-strip-axis] .strip__finish')).toBeNull();
    expect(finish.textContent).toContain('650');
  });

  it('keeps the plain scale line while the trip is unfinished', () => {
    const strip = mount();
    strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    expect(el.querySelector('.strip__finish')).toBeNull();
    expect(el.querySelector('.strip__scale').textContent).toContain('km 650 · finish');
  });
});

// The corridor outgrew Hamburg -> Dresden, so the endpoints are data now. The
// strip must never hold a place name of its own: it is mounted standalone in these
// tests and would otherwise render a destination the route does not have.
describe('createStrip - endpoint names', () => {
  const named = { originName: 'Cuxhaven', destinationName: 'Prague' };

  it('counts down to the destination it was given', () => {
    const strip = mount();
    strip.render({ days: days(100), totalKm: 400, focusedIndex: 0, breaks: [], ...named });

    expect(el.querySelector('.strip__summary').textContent).toContain('300 km to Prague');
  });

  it('names both endpoints on the scale line', () => {
    const strip = mount();
    strip.render({ days: days(100), totalKm: 400, focusedIndex: 0, breaks: [], ...named });

    const scale = el.querySelector('.strip__scale').textContent;
    expect(scale).toContain('km 0 · Cuxhaven');
    expect(scale).toContain('km 400 · Prague');
  });

  it('flags the destination on the remainder', () => {
    const strip = mount();
    strip.render({ days: days(100), totalKm: 400, focusedIndex: 0, breaks: [], ...named });

    expect(el.querySelector('.strip__flag').textContent).toContain('Prague');
  });

  it('says the destination is reached once the plan arrives', () => {
    const strip = mount();
    strip.render({ days: days(400), totalKm: 400, focusedIndex: 0, breaks: [], ...named });

    expect(el.querySelector('.strip__finish').textContent).toContain('Prague reached');
  });

  it('falls back to neutral words when no names are given', () => {
    const strip = mount();
    strip.render({ days: days(100), totalKm: 400, focusedIndex: 0, breaks: [] });

    expect(el.textContent).toContain('km to finish');
    expect(el.querySelector('.strip__scale').textContent).toContain('km 0 · start');
  });

  // render() is called with no argument on a width change (main.js drives that from
  // a ResizeObserver). Rebuilding from a bare state would drop the names and the
  // strip would silently start calling Prague "finish" after any resize.
  it('keeps the names through an argument-less re-render', () => {
    const strip = mount();
    strip.render({ days: days(100), totalKm: 400, focusedIndex: 0, breaks: [], ...named });
    strip.render();

    expect(el.querySelector('.strip__scale').textContent).toContain('km 0 · Cuxhaven');
    expect(el.querySelector('.strip__summary').textContent).toContain('to Prague');
  });

  it('escapes a name rather than injecting it as markup', () => {
    const strip = mount();
    strip.render({
      days: days(100),
      totalKm: 400,
      focusedIndex: 0,
      breaks: [],
      destinationName: '<img src=x onerror=alert(1)>',
    });

    expect(el.querySelector('.strip__summary img')).toBeNull();
    expect(el.querySelector('.strip__summary').textContent).toContain('<img');
  });
});

describe('createStrip - handles', () => {
  it('gives every boundary an accessible slider handle', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const handles = [...el.querySelectorAll('.strip__handle')];
    expect(handles).toHaveLength(2);
    expect(handles[0].getAttribute('role')).toBe('slider');
    expect(handles[0].getAttribute('aria-valuenow')).toBe('80');
    expect(handles[0].getAttribute('aria-valuemin')).toBe('5');
    expect(handles[0].getAttribute('aria-valuemax')).toBe('155');
    expect(handles[0].getAttribute('aria-label')).toContain('Day 1 end');
  });

  // A slider must report a value inside its own range. On hand-edited storage it
  // did not: 10 km then 2 km puts boundary 0 at km 10 with a legal window of
  // [5, 7], and an out-of-range aria-valuenow is undefined behaviour for a screen
  // reader. The range widens to contain the value; the move is still refused.
  it('keeps aria-valuenow inside the range it reports on squeezed data', () => {
    const strip = mount();
    strip.render({ days: days(10, 12), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const handle = el.querySelector('.strip__handle');
    const now = Number(handle.getAttribute('aria-valuenow'));
    expect(now).toBe(10);
    expect(now).toBeGreaterThanOrEqual(Number(handle.getAttribute('aria-valuemin')));
    expect(now).toBeLessThanOrEqual(Number(handle.getAttribute('aria-valuemax')));
  });

  it('lets the last handle run to the end of the route', () => {
    const strip = mount();
    strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    expect(el.querySelector('.strip__handle').getAttribute('aria-valuemax')).toBe('650');
  });

  // Handles are absolutely positioned, so source order buys nothing visually
  // (z-index keeps them above the blocks) — it is the tab order. Rendering all
  // blocks and then all handles made a keyboard user cross the whole trip twice.
  it('tabs left to right along the trip: day, its boundary, next day', () => {
    const strip = mount();
    strip.render({ days: days(80, 160), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const order = [...el.querySelectorAll('.strip__block, .strip__handle, .strip__add')].map((node) =>
      node.dataset.dayIndex !== undefined
        ? `day${node.dataset.dayIndex}`
        : node.dataset.boundaryIndex !== undefined
          ? `boundary${node.dataset.boundaryIndex}`
          : 'add',
    );

    expect(order).toEqual(['day0', 'boundary0', 'day1', 'boundary1', 'add']);
  });
});

// stripLayout deliberately returns a NEGATIVE width for an inverted day so that
// x + width keeps equalling kmToX(endKm) for hit-testing. CSS width: -80px is
// invalid, is dropped, and the positioned div then renders at auto — visible
// garbage. The renderer owns the clamp; the geometry must not.
describe('createStrip - degenerate geometry', () => {
  it('renders an inverted day at zero width rather than a negative one', () => {
    const strip = mount();
    const list = [
      { index: 0, startKm: 0, endKm: 80, targetKm: 80, townChoice: null },
      { index: 1, startKm: 80, endKm: 60, targetKm: -20, townChoice: null },
    ];
    strip.render({ days: list, totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const inverted = el.querySelectorAll('.strip__block')[1];
    expect(inverted.style.width).toBe('0px');
    expect(parseFloat(inverted.style.width)).toBeGreaterThanOrEqual(0);
  });

  it('leaves no seam between adjacent blocks on a fractional scale', () => {
    // 999 px over 650 km puts day 1's edge at 122.954 px and day 2's at 245.908.
    // Rounding x and width independently gives left 123 + width 123 = 246, a
    // 0.1 px seam against day 2's left of 245.9. Rounding the two EDGES and
    // deriving the width from them cannot drift.
    const strip = mount(999);
    strip.render({ days: days(80, 160, 265, 320), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    const edges = [...el.querySelectorAll('.strip__block'), el.querySelector('.strip__remainder')].map(
      (node) => ({ left: parseFloat(node.style.left), width: parseFloat(node.style.width) }),
    );
    for (let i = 0; i < edges.length - 1; i += 1) {
      // Tolerance is float noise only: the seam this guards against is 0.1 px.
      expect(edges[i].left + edges[i].width).toBeCloseTo(edges[i + 1].left, 9);
    }
  });
});

describe('createStrip - re-layout on a width change', () => {
  // Every px in the DOM derives from the axis width at render time, so a resized
  // window leaves blocks drawn at the old scale until something re-renders. This
  // is the path a ResizeObserver drives: render() with no argument must redraw the
  // state it already holds against the current width.
  it('redraws retained state at the new width when called with no argument', () => {
    let axisWidth = WIDTH;
    el = document.createElement('div');
    document.body.appendChild(el);
    const strip = createStrip({ el, callbacks: {}, measureWidth: () => axisWidth });

    strip.render({ days: days(325), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });
    expect(el.querySelector('.strip__block').style.width).toBe('650px'); // half of 1300

    axisWidth = 700;
    strip.render();

    expect(el.querySelector('.strip__block').style.width).toBe('350px'); // half of 700
  });
});
