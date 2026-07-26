// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createStrip } from './strip.js';

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

describe('createStrip - summary', () => {
  it('reports planned, remaining, day count and average', () => {
    const strip = mount();
    strip.render({ days: days(80, 160, 265, 320), totalKm: TOTAL_KM, focusedIndex: 2, breaks: [] });

    const summary = el.querySelector('.strip__summary').textContent;
    expect(summary).toContain('320 / 650 km planned');
    expect(summary).toContain('330 km to Dresden');
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

  it('shows breaks past the last day on the remainder', () => {
    const strip = mount();
    strip.render({
      days: days(80),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      breaks: [{ name: 'Later', kind: 'sight', routeDistanceKm: 300 }],
    });

    const glyph = el.querySelector('.strip__remainder .strip__glyph');
    expect(glyph).not.toBeNull();
    expect(glyph.textContent).toBe('📷');
  });

  // The fixture above puts its glyph inside a day that starts at km 0, where a
  // renderer that forgot to subtract the container's own left edge would still
  // land on the right pixel. Pin the offset on a day that starts elsewhere.
  it('positions a glyph relative to its own block, not the axis', () => {
    const strip = mount();
    strip.render({
      days: days(80, 160),
      totalKm: TOTAL_KM,
      focusedIndex: 0,
      breaks: [{ name: 'Café', kind: 'food', routeDistanceKm: 100 }],
    });

    // Day 2 spans km 80-160, so its block starts at x 160. The glyph sits at
    // km 100 -> x 200 on the axis, i.e. 40 px into its own block.
    const glyph = el.querySelectorAll('.strip__block')[1].querySelector('.strip__glyph');
    expect(glyph.style.left).toBe('40px');
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

  it('hides the remainder once the plan reaches Dresden', () => {
    const strip = mount();
    strip.render({ days: days(TOTAL_KM), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    expect(el.querySelector('.strip__remainder')).toBeNull();
    expect(el.querySelector('.strip__finish')).not.toBeNull();
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

  it('lets the last handle run to the end of the route', () => {
    const strip = mount();
    strip.render({ days: days(80), totalKm: TOTAL_KM, focusedIndex: 0, breaks: [] });

    expect(el.querySelector('.strip__handle').getAttribute('aria-valuemax')).toBe('650');
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
