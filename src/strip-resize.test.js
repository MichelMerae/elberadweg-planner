// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStripResize } from './strip-resize.js';
// The other half of the seam, for the live block at the end of this file: the two
// modules share one element, and every property there belongs to the PAIR rather than
// to either of them. A real itinerary drives the boundary drag for the same reason
// strip.test.js's harness does — a clamp rule spelled out here could drift from the
// model the app actually moves boundaries through.
import { createStrip } from './strip.js';
import { createTrip } from './trip.js';
import { createItinerary } from './itinerary.js';

// Spelled out here rather than imported, so the test pins the exact key and the
// exact floor a user's browser already holds — the convention favorites.test.js
// and storage.test.js follow with their own keys.
const HEIGHT_KEY = 'elberadweg-strip-height';
const MIN_HEIGHT = 46;

// 45% of 1000 is 450: a round maximum, so a clamp test reads as arithmetic rather
// than as a fixture. Deliberately NOT the module's own 800 px fallback viewport —
// at 800 every ceiling below would be the right number for two different reasons,
// and a broken seam would still pass everywhere except the one test that pins the
// fallback on purpose.
const VIEWPORT = 1000;
const MAX_HEIGHT = 450;

// storage.test.js's fake, with vi.fn() around each method: several tests below
// are about how MANY writes a gesture spends, not only about what it wrote.
function createFakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: vi.fn((key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null)),
    setItem: vi.fn((key, value) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key) => {
      delete store[key];
    }),
  };
}

// Private mode / quota exceeded: reads back what it was seeded with, every write
// throws. Persistence is best-effort and must never break the gesture on screen.
function createUnwritableStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

/**
 * A mounted resize handle on a strip-shaped container.
 *
 * `stored` is the RAW string the key holds (undefined = the key is absent), because
 * every repair case below is about a value the module did not write itself.
 * The container carries the rows createStrip builds, so the tests prove the handle
 * is added to a populated strip rather than to a bare div.
 */
function mount({ stored, viewport = VIEWPORT, storage: given } = {}) {
  const el = document.createElement('div');
  el.className = 'strip';
  el.innerHTML = `
    <div class="strip__summary"></div>
    <div class="strip__axis" data-strip-axis></div>
    <div class="strip__scale"></div>`;
  document.body.appendChild(el);

  let vp = viewport;
  const storage = given || createFakeStorage(stored === undefined ? {} : { [HEIGHT_KEY]: stored });
  const onResize = vi.fn();
  const resize = createStripResize({ el, storage, onResize, measureViewport: () => vp });

  return {
    resize,
    el,
    storage,
    onResize,
    handle: el.querySelector('.strip__resize'),
    // Every height reported upwards, in order — the clamp tests assert about all
    // of them, not only the last.
    reported: () => onResize.mock.calls.map(([height]) => height),
    lastReported: () => onResize.mock.calls.at(-1)?.[0],
    stored: () => storage.store?.[HEIGHT_KEY],
    writes: () => storage.setItem.mock.calls.filter(([key]) => key === HEIGHT_KEY).length,
    setViewport: (px) => {
      vp = px;
    },
  };
}

// clientX matters only in the live-seam block at the end, where the strip's own axis is
// listening too and where the pointer sits over a real boundary. `at` overrides the
// timeStamp: jsdom stamps an event when it is constructed, so two presses in a test are
// always microseconds apart, and the double-press window is the one thing here that is
// about real elapsed time.
function fire(target, type, { y = 0, x = 100, buttons = 1, button = 0, pointerId = 1, at } = {}) {
  const event = new window.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    buttons,
    button,
    pointerId,
  });
  if (at !== undefined) Object.defineProperty(event, 'timeStamp', { value: at });
  target.dispatchEvent(event);
}

// A resize drag as a browser delivers it: the press at the handle, every move and
// the release at the CAPTURE target — which is the strip container and not the
// handle (see the module header). jsdom implements no pointer capture at all, so
// the events are aimed by hand, exactly as strip.test.js aims its boundary drags
// at the axis.
function drag(mounted, fromY, ...toY) {
  fire(mounted.handle, 'pointerdown', { y: fromY });
  for (const y of toY) fire(mounted.el, 'pointermove', { y });
  fire(mounted.el, 'pointerup', { y: toY.length ? toY[toY.length - 1] : fromY });
}

function dblclick(target) {
  target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
}

// Returns the event, so a test can ask whether the handle swallowed the press or
// left it to the page.
function press(target, key, { shiftKey = false } = {}) {
  const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey });
  target.dispatchEvent(event);
  return event;
}

describe('createStripResize - the handle itself', () => {
  it('adds a handle at the top of the strip without disturbing the rows already there', () => {
    // Mount order matters in the other direction, and cannot be tested from here:
    // createStrip assigns el.innerHTML, so a handle mounted BEFORE it is silently
    // wiped. main.js must call this factory second (documented in the header).
    const { el, handle } = mount();

    expect(handle).not.toBeNull();
    expect(el.firstElementChild).toBe(handle);
    expect(el.querySelector('.strip__summary')).not.toBeNull();
    expect(el.querySelector('.strip__axis')).not.toBeNull();
    expect(el.querySelector('.strip__scale')).not.toBeNull();
  });

  it('is a focusable horizontal separator carrying its own value', () => {
    const { handle } = mount({ stored: '120' });

    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute('aria-valuenow')).toBe('120');
    expect(handle.getAttribute('aria-valuemin')).toBe(String(MIN_HEIGHT));
    expect(handle.getAttribute('aria-valuemax')).toBe(String(MAX_HEIGHT));
    // A bare 120 on a scale nobody stated says very little out loud.
    expect(handle.getAttribute('aria-valuetext')).toBe('120 pixels');
  });

  it('captures the pointer on the strip container and never on the handle', () => {
    // jsdom implements no pointer capture, so the methods are stubbed in — but the
    // choice of target is the whole reason this gesture survives the caller's
    // re-render (see the module header), and without this it is the one decision
    // here that no test would notice being reversed.
    const mounted = mount({ stored: '100' });
    mounted.el.setPointerCapture = vi.fn();
    mounted.el.releasePointerCapture = vi.fn();
    mounted.handle.setPointerCapture = vi.fn();

    fire(mounted.handle, 'pointerdown', { y: 500, pointerId: 7 });

    expect(mounted.el.setPointerCapture).toHaveBeenCalledWith(7);
    expect(mounted.handle.setPointerCapture).not.toHaveBeenCalled();

    fire(mounted.el, 'pointerup', { y: 500, pointerId: 7 });

    expect(mounted.el.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it('focuses the handle on press, so the keys are reachable after a mouse drag', () => {
    // preventDefault on pointerdown suppresses the compatibility mousedown and with
    // it the click-focus this element would otherwise get. Without an explicit
    // focus, every key below could only be reached by Tabbing back to a handle the
    // user is already holding.
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500 });

    expect(document.activeElement).toBe(mounted.handle);
  });

  it('marks the handle while a drag is in flight and unmarks it on release', () => {
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500 });
    fire(mounted.el, 'pointermove', { y: 480 });
    expect(mounted.handle.classList.contains('strip__resize--dragging')).toBe(true);

    fire(mounted.el, 'pointerup', { y: 480 });
    expect(mounted.handle.classList.contains('strip__resize--dragging')).toBe(false);
  });
});

describe('createStripResize - dragging', () => {
  it('grows the axis when the handle is dragged up', () => {
    const mounted = mount({ stored: '100' });

    drag(mounted, 500, 440);

    expect(mounted.lastReported()).toBe(160);
  });

  it('shrinks the axis when the handle is dragged down', () => {
    const mounted = mount({ stored: '100' });

    drag(mounted, 500, 540);

    expect(mounted.lastReported()).toBe(60);
  });

  it('follows the pointer continuously rather than only reporting on release', () => {
    const mounted = mount({ stored: '100' });
    mounted.onResize.mockClear(); // drop the report the load itself made

    drag(mounted, 500, 490, 480, 470);

    expect(mounted.reported()).toEqual([110, 120, 130]);
  });

  it('measures each move from where the press started, so a drag out and back returns', () => {
    // Not from the previous move: accumulating deltas drifts, and a drag that
    // leaves the bounds and comes back would then return to the wrong height.
    const mounted = mount({ stored: '100' });

    drag(mounted, 500, 300, 900, 480);

    expect(mounted.lastReported()).toBe(120);
  });

  it('ignores a press with a non-primary button', () => {
    const mounted = mount({ stored: '100' });
    mounted.onResize.mockClear();

    fire(mounted.handle, 'pointerdown', { y: 500, button: 2 });
    fire(mounted.el, 'pointermove', { y: 400 });

    expect(mounted.onResize).not.toHaveBeenCalled();
  });

  it('ignores moves that arrive with no drag in progress', () => {
    const mounted = mount({ stored: '100' });
    mounted.onResize.mockClear();

    fire(mounted.el, 'pointermove', { y: 400 });
    fire(mounted.el, 'pointerup', { y: 400 });

    expect(mounted.onResize).not.toHaveBeenCalled();
    expect(mounted.writes()).toBe(0);
  });

  it('reports nothing for a move that lands on the same whole pixel', () => {
    // The caller's onResize rebuilds the axis and re-interpolates the elevation
    // profile; sub-pixel jitter must not buy a single repaint.
    const mounted = mount({ stored: '100' });
    mounted.onResize.mockClear();

    drag(mounted, 500, 499.6, 499.8);

    expect(mounted.onResize).not.toHaveBeenCalled();
  });
});

describe('createStripResize - bounds', () => {
  it('clamps at the 46 px floor', () => {
    const mounted = mount({ stored: '100' });

    drag(mounted, 500, 700);

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
  });

  it('clamps at 45% of the viewport', () => {
    const mounted = mount({ stored: '300' });

    drag(mounted, 500, 100);

    expect(mounted.lastReported()).toBe(MAX_HEIGHT);
  });

  it('takes the maximum from the viewport seam, not from a constant', () => {
    // 600 px is neither the harness viewport nor the module's fallback, so 270 can
    // only have come from the seam.
    const mounted = mount({ stored: '200', viewport: 600 });

    drag(mounted, 500, 0);

    expect(mounted.lastReported()).toBe(270);
  });

  it('never reports an out-of-bounds height mid-drag, only at the end', () => {
    // The clamp has to happen per move. Reporting the raw value and clamping on
    // release would hand the caller a 700 px axis to render and an elevation
    // profile scaled to it, for as long as the pointer stayed out there.
    const mounted = mount({ stored: '200' });
    mounted.onResize.mockClear();

    drag(mounted, 500, 100, 0, 900, 1200, 480);

    expect(mounted.reported().length).toBeGreaterThan(0);
    for (const height of mounted.reported()) {
      expect(height).toBeGreaterThanOrEqual(MIN_HEIGHT);
      expect(height).toBeLessThanOrEqual(MAX_HEIGHT);
    }
  });

  it('keeps the floor when 45% of a tiny viewport would fall below it', () => {
    // A 120 px window puts the maximum at 54 px; a 40 px one would put it under the
    // floor, and a strip shorter than 46 px has no grabbable boundary handles left
    // to drag it back.
    const mounted = mount({ stored: '46', viewport: 40 });

    drag(mounted, 500, 100);

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
  });

  it('falls back to an 800 px viewport when the measurement is unusable', () => {
    // A 0 from a frame before layout has settled would otherwise put the ceiling
    // at the floor and freeze the gesture at 46 px until the next reload.
    const FALLBACK_MAX = 360; // 45% of the module's 800 px fallback

    for (const unusable of [0, NaN, -1]) {
      const mounted = mount({ stored: '100', viewport: unusable });

      expect(mounted.handle.getAttribute('aria-valuemax')).toBe(String(FALLBACK_MAX));

      drag(mounted, 500, 0);

      expect(mounted.lastReported()).toBe(FALLBACK_MAX);
    }
  });

  it('falls back to the window when no viewport seam is injected', () => {
    // jsdom's window.innerHeight is 768, so the maximum is 346.
    const el = document.createElement('div');
    document.body.appendChild(el);
    const onResize = vi.fn();
    createStripResize({ el, storage: createFakeStorage(), onResize });
    const handle = el.querySelector('.strip__resize');

    fire(handle, 'pointerdown', { y: 500 });
    fire(el, 'pointermove', { y: 0 });

    expect(onResize.mock.calls.at(-1)[0]).toBe(Math.round(window.innerHeight * 0.45));
  });
});

describe('createStripResize - persistence', () => {
  it('persists the height once, on release', () => {
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500 });
    fire(mounted.el, 'pointermove', { y: 480 });
    fire(mounted.el, 'pointermove', { y: 460 });
    fire(mounted.el, 'pointermove', { y: 440 });
    expect(mounted.writes()).toBe(0);

    fire(mounted.el, 'pointerup', { y: 440 });

    expect(mounted.writes()).toBe(1);
    expect(mounted.stored()).toBe('160');
  });

  it('stores a bare integer of pixels under elberadweg-strip-height', () => {
    const mounted = mount({ stored: '100' });

    drag(mounted, 500, 480.4);

    expect(mounted.storage.setItem).toHaveBeenCalledWith(HEIGHT_KEY, '120');
  });

  it('writes nothing when a press ends where it started', () => {
    // A plain click on the handle, and each half of a double-click.
    const mounted = mount({ stored: '100' });

    drag(mounted, 500);

    expect(mounted.writes()).toBe(0);
  });

  it('keeps and persists the last clamped height when the gesture is cancelled', () => {
    // A context menu or a window switch mid-drag. The strip has already moved on
    // screen, so leaving the value unwritten would undo, on the next reload, a
    // resize the user watched happen.
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500 });
    fire(mounted.el, 'pointermove', { y: 460 });
    fire(mounted.el, 'pointercancel', { y: 460 });

    expect(mounted.lastReported()).toBe(140);
    expect(mounted.stored()).toBe('140');
    expect(mounted.handle.classList.contains('strip__resize--dragging')).toBe(false);
  });

  it('ends the drag when a release is missed and the buttons come back empty', () => {
    // Capture lost to a native gesture or a window switch. Without this the strip
    // resizes under a bare hovering cursor until some later click.
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500 });
    fire(mounted.el, 'pointermove', { y: 460 });
    fire(mounted.el, 'pointermove', { y: 300, buttons: 0 });

    expect(mounted.lastReported()).toBe(140);
    expect(mounted.stored()).toBe('140');

    fire(mounted.el, 'pointermove', { y: 200 });
    expect(mounted.lastReported()).toBe(140);
  });

  it('ends the drag and persists when the capture is lost', () => {
    // The exit a real browser takes most often: a native gesture, a dialog, an
    // alt-tab. strip.js leans on this listener for the same reason.
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500 });
    fire(mounted.el, 'pointermove', { y: 460 });
    fire(mounted.el, 'lostpointercapture', { y: 460 });

    expect(mounted.lastReported()).toBe(140);
    expect(mounted.stored()).toBe('140');
    expect(mounted.handle.classList.contains('strip__resize--dragging')).toBe(false);

    fire(mounted.el, 'pointermove', { y: 300 });
    expect(mounted.lastReported()).toBe(140);
  });

  it('stays a no-op when our own release fires lostpointercapture', () => {
    // endDrag releases the capture itself, and the browser answers with a
    // lostpointercapture for the pointer that just ended. A second report or a
    // second write here would be the module answering its own echo.
    const mounted = mount({ stored: '100' });

    drag(mounted, 500, 460);
    expect(mounted.writes()).toBe(1);
    mounted.onResize.mockClear();

    fire(mounted.el, 'lostpointercapture', { y: 460 });

    expect(mounted.writes()).toBe(1);
    expect(mounted.onResize).not.toHaveBeenCalled();
  });

  it('survives a storage that cannot be written', () => {
    const mounted = mount({ storage: createUnwritableStorage({ [HEIGHT_KEY]: '100' }) });

    expect(() => drag(mounted, 500, 460)).not.toThrow();
    expect(mounted.lastReported()).toBe(140);
  });
});

describe('createStripResize - a second pointer', () => {
  it('ignores a second pointer arriving mid-drag', () => {
    // A resting palm or a second finger. strip.js keeps its boundary drags to the
    // pointer that started them for the same reason: ending on the wrong contact
    // commits the gesture wherever that contact happened to land.
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500, pointerId: 1 });
    fire(mounted.el, 'pointermove', { y: 460, pointerId: 1 });

    fire(mounted.handle, 'pointerdown', { y: 200, pointerId: 2 });
    fire(mounted.el, 'pointermove', { y: 100, pointerId: 2 });
    expect(mounted.lastReported()).toBe(140);

    fire(mounted.el, 'pointerup', { y: 100, pointerId: 2 });
    expect(mounted.writes()).toBe(0); // the first drag is still running

    fire(mounted.el, 'pointermove', { y: 440, pointerId: 1 });
    fire(mounted.el, 'pointerup', { y: 440, pointerId: 1 });

    expect(mounted.lastReported()).toBe(160);
    expect(mounted.stored()).toBe('160');
  });

  it('re-anchors when the same pointer presses again after a lost release', () => {
    // The stale drag anchored at y 500 and 100 px. A press that resumed from that
    // anchor would jump the strip by everything the cursor travelled while nothing
    // was held — here it would report 410 rather than 150.
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500 });
    fire(mounted.el, 'pointermove', { y: 460 }); // 140 px, and then the release goes missing

    fire(mounted.handle, 'pointerdown', { y: 200 });
    fire(mounted.el, 'pointermove', { y: 190 });

    expect(mounted.lastReported()).toBe(150); // 10 px up from the NEW anchor
    // The abandoned drag was still a resize the user watched happen, so ending it
    // wrote it — and the new gesture will write its own on release.
    expect(mounted.stored()).toBe('140');
  });
});

describe('createStripResize - double-click reset', () => {
  it('returns to 46 px and persists it', () => {
    const mounted = mount({ stored: '300' });

    dblclick(mounted.handle);

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
    expect(mounted.stored()).toBe(String(MIN_HEIGHT));
  });

  it('resets on a rapid second press, which is what a browser actually delivers', () => {
    // Measured in Chromium: `el.setPointerCapture` retargets the pointerup and BOTH
    // compatibility click events to the capture element, so the handle never hears its own
    // dblclick and the listener above can only fire where there is no capture (jsdom, or a
    // browser that refused it). The presses are the signal that always arrives.
    const mounted = mount({ stored: '300' });

    fire(mounted.handle, 'pointerdown', { y: 500, at: 1000 });
    fire(mounted.el, 'pointerup', { y: 500, at: 1010 });
    fire(mounted.handle, 'pointerdown', { y: 500, at: 1200 });

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
    expect(mounted.stored()).toBe(String(MIN_HEIGHT));
  });

  it('leaves two presses 600 ms apart as two presses', () => {
    // Past every platform's own double-click interval. A press, a pause and a press is
    // someone lining up a drag twice, and resetting the strip under them would be a
    // gesture nobody made.
    const mounted = mount({ stored: '300' });

    fire(mounted.handle, 'pointerdown', { y: 500, at: 1000 });
    fire(mounted.el, 'pointerup', { y: 500, at: 1010 });
    fire(mounted.handle, 'pointerdown', { y: 500, at: 1600 });

    expect(mounted.lastReported()).toBe(300);
    expect(mounted.writes()).toBe(0);
  });

  it('does not pair a press with a drag that resized something', () => {
    // A drag, then a quick fresh press: two gestures, not a double-click. Reset here, the
    // second drag would start from 46 px instead of from the height it was aimed at.
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500, at: 1000 });
    fire(mounted.el, 'pointermove', { y: 460, at: 1050 });
    fire(mounted.el, 'pointerup', { y: 460, at: 1100 });

    fire(mounted.handle, 'pointerdown', { y: 460, at: 1200 });
    fire(mounted.el, 'pointermove', { y: 450, at: 1250 });

    expect(mounted.lastReported()).toBe(150);
  });

  it('drags on from the floor when the second press turns into a drag', () => {
    // The reset lands before the drag is armed, so the pointer that carried on from the
    // second press pulls from 46 px rather than from the height it just discarded.
    const mounted = mount({ stored: '300' });

    fire(mounted.handle, 'pointerdown', { y: 500, at: 1000 });
    fire(mounted.el, 'pointerup', { y: 500, at: 1010 });
    fire(mounted.handle, 'pointerdown', { y: 500, at: 1200 });
    fire(mounted.el, 'pointermove', { y: 480, at: 1250 });

    expect(mounted.lastReported()).toBe(66);
  });

  it('spends nothing when the strip is already at 46 px', () => {
    const mounted = mount({ stored: String(MIN_HEIGHT) });
    mounted.onResize.mockClear();

    dblclick(mounted.handle);

    expect(mounted.onResize).not.toHaveBeenCalled();
    expect(mounted.writes()).toBe(0);
  });
});

describe('createStripResize - the stored height on load', () => {
  it('starts at 46 px with nothing stored, and writes no preference nobody expressed', () => {
    const mounted = mount();

    expect(mounted.reported()).toEqual([MIN_HEIGHT]);
    expect(mounted.writes()).toBe(0);
  });

  it('reports a stored height so the caller can render at it immediately', () => {
    const mounted = mount({ stored: '200' });

    expect(mounted.reported()).toEqual([200]);
    expect(mounted.writes()).toBe(0);
  });

  it('repairs a height below the floor', () => {
    const mounted = mount({ stored: '12' });

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
    expect(mounted.stored()).toBe(String(MIN_HEIGHT));
  });

  it('repairs a height above the viewport maximum', () => {
    // What a window that has since been made smaller leaves behind.
    const mounted = mount({ stored: '9999' });

    expect(mounted.lastReported()).toBe(MAX_HEIGHT);
    expect(mounted.stored()).toBe(String(MAX_HEIGHT));
  });

  it('repairs garbage', () => {
    const mounted = mount({ stored: 'tall' });

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
    expect(mounted.stored()).toBe(String(MIN_HEIGHT));
  });

  it('repairs an empty value', () => {
    const mounted = mount({ stored: '' });

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
    expect(mounted.stored()).toBe(String(MIN_HEIGHT));
  });

  it('rounds a fractional stored height to whole pixels', () => {
    const mounted = mount({ stored: '120.6' });

    expect(mounted.lastReported()).toBe(121);
    expect(mounted.stored()).toBe('121');
  });

  it('boots with no storage at all', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const onResize = vi.fn();

    expect(() => createStripResize({ el, onResize, measureViewport: () => VIEWPORT })).not.toThrow();
    expect(onResize).toHaveBeenCalledWith(MIN_HEIGHT);
  });

  it('survives a storage whose getItem throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: vi.fn(),
    };
    const el = document.createElement('div');
    document.body.appendChild(el);
    const onResize = vi.fn();

    expect(() => createStripResize({ el, storage, onResize, measureViewport: () => VIEWPORT })).not.toThrow();
    expect(onResize).toHaveBeenCalledWith(MIN_HEIGHT);
  });
});

describe('createStripResize - keyboard', () => {
  it('grows and shrinks by 8 px per arrow press, persisting each one', () => {
    const mounted = mount({ stored: '100' });

    press(mounted.handle, 'ArrowUp');
    expect(mounted.lastReported()).toBe(108);

    press(mounted.handle, 'ArrowDown');
    expect(mounted.lastReported()).toBe(100);

    expect(mounted.writes()).toBe(2);
    expect(mounted.stored()).toBe('100');
  });

  it('takes a 24 px step with shift held', () => {
    const mounted = mount({ stored: '100' });

    press(mounted.handle, 'ArrowUp', { shiftKey: true });

    expect(mounted.lastReported()).toBe(124);
  });

  it('clamps a keyboard step at the bounds', () => {
    const mounted = mount({ stored: '50' });

    press(mounted.handle, 'ArrowDown', { shiftKey: true });

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
  });

  it('resets to 46 px on Enter, the double-click by keyboard', () => {
    const mounted = mount({ stored: '300' });

    press(mounted.handle, 'Enter');

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
    expect(mounted.stored()).toBe(String(MIN_HEIGHT));
  });

  it('jumps to the ceiling on End and the floor on Home', () => {
    const mounted = mount({ stored: '100' });

    press(mounted.handle, 'End');
    expect(mounted.lastReported()).toBe(MAX_HEIGHT);
    expect(mounted.stored()).toBe(String(MAX_HEIGHT));

    press(mounted.handle, 'Home');
    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
    expect(mounted.stored()).toBe(String(MIN_HEIGHT));
  });

  it('takes End from the current viewport, not from a remembered ceiling', () => {
    const mounted = mount({ stored: '100' });
    mounted.setViewport(600);

    press(mounted.handle, 'End');

    expect(mounted.lastReported()).toBe(270);
  });

  it('leaves keys it does not own to the page, and swallows the ones it does', () => {
    // A key that reports nothing must also not preventDefault: swallowing
    // PageDown to do nothing is worse than letting the page scroll.
    const mounted = mount({ stored: '100' });
    mounted.onResize.mockClear();

    for (const key of ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Escape', ' ', 'Tab']) {
      expect(press(mounted.handle, key).defaultPrevented).toBe(false);
    }
    expect(mounted.onResize).not.toHaveBeenCalled();

    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter']) {
      expect(press(mounted.handle, key).defaultPrevented).toBe(true);
    }
  });

  it('keeps aria-valuenow in step with the height it reports', () => {
    // The handle is created once and never rebuilt, so unlike strip.js's boundary
    // sliders it can hold a value a screen reader will actually announce.
    const mounted = mount({ stored: '100' });

    press(mounted.handle, 'ArrowUp');

    expect(mounted.handle.getAttribute('aria-valuenow')).toBe('108');
    expect(mounted.handle.getAttribute('aria-valuetext')).toBe('108 pixels');
  });

  it('stands down while a pointer is holding the handle', () => {
    // The press focuses the handle (so the keys are reachable after a mouse drag),
    // which also puts every key within reach of a hand that is mid-drag. Honoured,
    // End would report and persist the ceiling — and then either be overwritten by
    // the next move or, if the user released first, stick. Which of the two happened
    // is not something the user can tell, so the pointer in flight is authoritative.
    const mounted = mount({ stored: '100' });

    fire(mounted.handle, 'pointerdown', { y: 500 });
    fire(mounted.el, 'pointermove', { y: 460 });

    const event = press(mounted.handle, 'End');

    // Declined, so the page keeps the key — the same rule this module follows for
    // every other key it does not own.
    expect(event.defaultPrevented).toBe(false);
    expect(mounted.lastReported()).toBe(140);
    expect(mounted.writes()).toBe(0);

    // And the drag it interrupted is still anchored where it started.
    fire(mounted.el, 'pointermove', { y: 440 });
    fire(mounted.el, 'pointerup', { y: 440 });

    expect(mounted.lastReported()).toBe(160);
    expect(mounted.stored()).toBe('160');
  });

  it('takes the keys back the moment the drag ends', () => {
    const mounted = mount({ stored: '100' });

    drag(mounted, 500, 460);
    press(mounted.handle, 'ArrowUp');

    expect(mounted.lastReported()).toBe(148);
  });
});

describe('createStripResize - remeasure', () => {
  it('re-clamps against a viewport that has since shrunk', () => {
    const mounted = mount({ stored: '300' });
    mounted.setViewport(400); // maximum 180

    mounted.resize.remeasure();

    expect(mounted.lastReported()).toBe(180);
    expect(mounted.stored()).toBe('180');
  });

  it('refreshes the announced range even when the height still fits', () => {
    // The ceiling is what a remeasure is about. A screen reader left holding the
    // old maximum would offer 360 px of range on a window that now allows 180.
    const mounted = mount({ stored: '100' });
    mounted.onResize.mockClear();
    mounted.setViewport(400); // ceiling 180, which 100 px still fits under

    mounted.resize.remeasure();

    expect(mounted.onResize).not.toHaveBeenCalled();
    expect(mounted.handle.getAttribute('aria-valuemax')).toBe('180');
    expect(mounted.handle.getAttribute('aria-valuenow')).toBe('100');
  });

  it('does nothing when the height still fits', () => {
    const mounted = mount({ stored: '300' });
    mounted.onResize.mockClear();

    mounted.resize.remeasure();

    expect(mounted.onResize).not.toHaveBeenCalled();
    expect(mounted.writes()).toBe(0);
  });

  it('reports the height it currently holds', () => {
    const mounted = mount({ stored: '200' });

    expect(mounted.resize.height()).toBe(200);

    drag(mounted, 500, 480);

    expect(mounted.resize.height()).toBe(220);
  });
});

// --- The live seam ---------------------------------------------------------
//
// createStrip and createStripResize on ONE element, mounted in main.js's order and with
// main.js's onResize: apply the height, then re-render. Nothing below is observable from
// either module alone — that the gesture survives the caller's re-render of the very
// element it is captured on, that the height actually reaches the elevation profile, and
// that two pointer gestures sharing an element do not reach into each other.

const SEAM_WIDTH = 1300;
const SEAM_ROAD_KM = 650;
// Spans the profile's whole declared range, so the drawn path uses the full axis height
// and the height is readable back out of the DOM (profilePoints puts minM on the
// baseline at y = height). Beyond the last sample elevationAtKm holds the last value, so
// the shape is a step — irrelevant here, where the y EXTENT is the measurement.
const SEAM_PROFILE = { spacingM: 250, minM: 0, maxM: 100, elevationsM: [0, 25, 50, 75, 100] };

/**
 * The pair, on a strip that renders a real two-day plan.
 *
 * `ends` are cumulative day ends, as strip.test.js writes plans; the model stores
 * lengths, so they are differenced on the way in.
 */
function mountSeam({ stored, ends = [80, 160] } = {}) {
  const el = document.createElement('div');
  el.id = 'strip';
  document.body.appendChild(el);

  const trip = createTrip({ startKm: 0, destinationKm: SEAM_ROAD_KM, totalKm: SEAM_ROAD_KM });
  const itinerary = createItinerary({ trip });
  let previous = 0;
  itinerary.hydrate({
    days: ends.map((end) => {
      const day = { targetKm: end - previous };
      previous = end;
      return day;
    }),
    breaks: [],
  });

  const moves = [];
  const strip = createStrip({
    el,
    callbacks: {
      // main.js's shape: apply the move to the model, then re-render. That re-render is
      // the whole reason this harness exists.
      onMoveBoundary: (index, endKm, opts = {}) => {
        moves.push({ index, endKm, commit: !!opts.commit });
        itinerary.moveBoundary(index, endKm);
        renderStrip();
      },
      onFocusDay: vi.fn(),
      onAddDay: vi.fn(),
    },
    measureWidth: () => SEAM_WIDTH,
    // The seam under test, one link shorter than production: there main.js sets the
    // custom property on the container, `.strip__axis` picks it up through CSS and
    // strip.js measures it back off the axis rect. jsdom lays nothing out, so the
    // property is read straight from the element it is set on — and an unset one falls
    // back to 46, exactly as the CSS `var(--strip-axis-height, 46px)` does.
    measureHeight: () =>
      Number.parseFloat(el.style.getPropertyValue('--strip-axis-height')) || MIN_HEIGHT,
  });

  function renderStrip() {
    strip.render({
      days: itinerary.getDays(),
      trip,
      focusedIndex: 0,
      breaks: [],
      elevation: SEAM_PROFILE,
    });
  }

  // main.js's first renderAll, which HAS to come before the mount below: the resize
  // module reports from its constructor, and a render with no argument throws until the
  // strip has been given a trip. See the ordering test.
  renderStrip();

  const storage = createFakeStorage(stored === undefined ? {} : { [HEIGHT_KEY]: stored });
  const onResize = vi.fn((heightPx) => {
    el.style.setProperty('--strip-axis-height', `${heightPx}px`);
    strip.render();
  });
  const resize = createStripResize({ el, storage, onResize, measureViewport: () => VIEWPORT });

  return {
    el,
    resize,
    storage,
    onResize,
    moves,
    handle: el.querySelector('.strip__resize'),
    axis: el.querySelector('[data-strip-axis]'),
    plan: () => itinerary.getDays().map((day) => day.endKm),
    stored: () => storage.store[HEIGHT_KEY],
    axisHeightVar: () => el.style.getPropertyValue('--strip-axis-height'),
    // The height the profile's SAMPLES were interpolated against. The stretch starts at
    // the profile's own lowest metre, which profilePoints puts on the baseline at
    // y = the height it was handed, so the line's first point is that height.
    //
    // Read off the line and not off the fill deliberately: the fill's closing corner
    // takes its height straight from the axis box, so it moves with a resize whether or
    // not the points were recomputed — a memo that had stopped keying on the height would
    // hide behind it (mutation M7, which is exactly how this was found).
    profileHeight: () => {
      const d = el.querySelector('.strip__elevation-line')?.getAttribute('d');
      return d ? Number(/^M0,([\d.]+)/.exec(d)[1]) : null;
    },
    // The fill's closing corner, from the axis box rather than the samples. Asserted
    // alongside the line in the one test that cares, so neither half can drift alone.
    profileBaseline: () => {
      const d = el.querySelector('.strip__elevation-fill')?.getAttribute('d');
      return d ? Number(/L0,([\d.]+)Z$/.exec(d)[1]) : null;
    },
  };
}

// A boundary drag, aimed the way strip.js expects: the press on the handle inside the
// axis, the moves and the release on the AXIS, which is where THAT module captures the
// pointer. jsdom's rects are all zeros, so the axis's left edge is 0 and a clientX is
// already an offset into the injected 1300 px width.
function fireX(target, type, { x = 0, y = 20, buttons = 1, pointerId = 1 } = {}) {
  target.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      buttons,
      button: 0,
      pointerId,
    }),
  );
}

// The pointer WOBBLES vertically on the way across, as a real hand does. With a constant
// clientY a resize that had wrongly armed on this press would ask for the height it
// already had and report nothing, so the test below would pass while leaking — which is
// precisely what mutation M6 (arming the drag from the container) did.
function dragBoundary(seam, index, fromX, toX) {
  const handle = seam.axis.querySelector(`[data-boundary-index="${index}"]`);
  fireX(handle, 'pointerdown', { x: fromX, y: 20 });
  fireX(seam.axis, 'pointermove', { x: Math.round((fromX + toX) / 2), y: 14 });
  fireX(seam.axis, 'pointermove', { x: toX, y: 17 });
  fireX(seam.axis, 'pointerup', { x: toX, y: 17 });
}

describe('createStripResize - live on a rendered strip', () => {
  it('reports from its constructor, which is why main.js mounts it after the first render', () => {
    // The trap, stated as the failure it is. onResize is called during construction, so
    // a caller that re-renders in onResize renders from inside this factory — and
    // strip.render() throws without a trip, which only a render WITH arguments can give
    // it. main.js's ordering (createStrip, first renderAll, then this) is what keeps that
    // throw off the boot path, and this is what it would look like reversed.
    const el = document.createElement('div');
    document.body.appendChild(el);
    const strip = createStrip({ el, callbacks: {}, measureWidth: () => SEAM_WIDTH });

    expect(() =>
      createStripResize({
        el,
        storage: createFakeStorage(),
        onResize: () => strip.render(),
        measureViewport: () => VIEWPORT,
      }),
    ).toThrow(/needs a trip/);
  });

  it('renders the stored height before the user has touched anything', () => {
    const seam = mountSeam({ stored: '210' });

    expect(seam.axisHeightVar()).toBe('210px');
    expect(seam.profileHeight()).toBe(210);
  });

  it('rescales the elevation profile to the height it is dragged to', () => {
    // The point of the whole feature: at 46 px a pixel of profile is ~6 m of climb.
    const seam = mountSeam({ stored: '100' });
    expect(seam.profileHeight()).toBe(100);

    drag(seam, 500, 400);

    expect(seam.resize.height()).toBe(200);
    // Both halves: the samples were re-interpolated at 200 px AND the fill closes there.
    expect(seam.profileHeight()).toBe(200);
    expect(seam.profileBaseline()).toBe(200);
  });

  it('survives the re-render its own drag causes, and keeps resizing through it', () => {
    // strip.js rebuilds the summary, the axis and the scale line with innerHTML on every
    // render, and this drag causes one per move. The handle is the strip's FIRST child
    // and outside all three, so the element the gesture is holding — and the class on
    // it — are the ones it started with.
    const seam = mountSeam({ stored: '100' });

    fire(seam.handle, 'pointerdown', { y: 500 });
    fire(seam.el, 'pointermove', { y: 480 });

    expect(seam.el.querySelector('.strip__resize')).toBe(seam.handle);
    expect(seam.handle.classList.contains('strip__resize--dragging')).toBe(true);
    expect(seam.profileHeight()).toBe(120);

    // And the moves that arrive after that first render still land.
    fire(seam.el, 'pointermove', { y: 460 });
    fire(seam.el, 'pointerup', { y: 460 });

    expect(seam.resize.height()).toBe(140);
    expect(seam.profileHeight()).toBe(140);
    expect(seam.stored()).toBe('140');
    expect(seam.handle.classList.contains('strip__resize--dragging')).toBe(false);
  });

  it('does not move a boundary while the strip is being resized', () => {
    // Correct by construction — the handle is a SIBLING of the axis, so strip.js's
    // listeners never see this press, and the capture on the container delivers the moves
    // and the release ABOVE the axis rather than inside it — and pinned anyway, because
    // "by construction" describes an arrangement a later task could rearrange.
    //
    // Deliberately pressed at x 160, which is exactly where day 1's boundary sits: a
    // handle mounted one element lower would be hit-tested onto that boundary, and this
    // is the only x at which that shows up. And the latch is checked as well as the
    // boundaries, because that mounting fails in the nastier way — strip.js arms on the
    // press and then gets neither a move nor a release, so the next bare hover over the
    // axis rewrites the plan.
    const seam = mountSeam({ stored: '100' });

    fire(seam.handle, 'pointerdown', { y: 500, x: 160 });
    fire(seam.el, 'pointermove', { y: 400, x: 160 });
    fire(seam.el, 'pointerup', { y: 400, x: 160 });

    expect(seam.resize.height()).toBe(200);
    expect(seam.moves).toEqual([]);
    expect(seam.plan()).toEqual([80, 160]);

    fireX(seam.axis, 'pointermove', { x: 260 });

    expect(seam.moves).toEqual([]);
    expect(seam.plan()).toEqual([80, 160]);
  });

  it('does not change the height while a boundary is being dragged', () => {
    // The other direction, and the one that is NOT free: this module listens for
    // pointermove on the container, and every move of an axis drag bubbles through it.
    // 80 km of 650 on a 1300 px axis puts day 1's boundary at 160 px; 260 px is km 130.
    const seam = mountSeam({ stored: '100' });
    seam.onResize.mockClear();

    dragBoundary(seam, 0, 160, 260);

    expect(seam.plan()).toEqual([130, 160]);
    expect(seam.onResize).not.toHaveBeenCalled();
    expect(seam.resize.height()).toBe(100);
    expect(seam.axisHeightVar()).toBe('100px');
    // Nothing armed, either: the class goes on at the press, before any move, so it
    // catches a leak that happened not to change the height.
    expect(seam.handle.classList.contains('strip__resize--dragging')).toBe(false);
  });
});
