// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStripResize } from './strip-resize.js';

// Spelled out here rather than imported, so the test pins the exact key and the
// exact floor a user's browser already holds — the convention favorites.test.js
// and storage.test.js follow with their own keys.
const HEIGHT_KEY = 'elberadweg-strip-height';
const MIN_HEIGHT = 46;

// 45% of 800 is 360: a round maximum, so a clamp test reads as arithmetic rather
// than as a fixture.
const VIEWPORT = 800;
const MAX_HEIGHT = 360;

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

function fire(target, type, { y = 0, buttons = 1, button = 0, pointerId = 1 } = {}) {
  target.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: y,
      buttons,
      button,
      pointerId,
    }),
  );
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

function press(target, key, { shiftKey = false } = {}) {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey }));
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
    const mounted = mount({ stored: '300', viewport: 1000 });

    drag(mounted, 500, 0);

    expect(mounted.lastReported()).toBe(450);
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
});

describe('createStripResize - double-click reset', () => {
  it('returns to 46 px and persists it', () => {
    const mounted = mount({ stored: '300' });

    dblclick(mounted.handle);

    expect(mounted.lastReported()).toBe(MIN_HEIGHT);
    expect(mounted.stored()).toBe(String(MIN_HEIGHT));
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

  it('leaves other keys to the page', () => {
    const mounted = mount({ stored: '100' });
    mounted.onResize.mockClear();

    press(mounted.handle, 'ArrowLeft');
    press(mounted.handle, 'Enter');

    expect(mounted.onResize).not.toHaveBeenCalled();
  });

  it('keeps aria-valuenow in step with the height it reports', () => {
    // The handle is created once and never rebuilt, so unlike strip.js's boundary
    // sliders it can hold a value a screen reader will actually announce.
    const mounted = mount({ stored: '100' });

    press(mounted.handle, 'ArrowUp');

    expect(mounted.handle.getAttribute('aria-valuenow')).toBe('108');
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
