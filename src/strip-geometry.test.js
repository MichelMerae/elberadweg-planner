import { describe, it, expect } from 'vitest';
import { kmToX, xToKm, labelTier, stripLayout, hitTestHandle } from './strip-geometry.js';

const TOTAL_KM = 650;
const WIDTH = 1300; // 2 px per km, so the arithmetic is obvious

function days(...ends) {
  let prev = 0;
  return ends.map((endKm, index) => {
    const day = { index, startKm: prev, endKm };
    prev = endKm;
    return day;
  });
}

describe('kmToX / xToKm', () => {
  it('maps km onto the axis width', () => {
    expect(kmToX(0, { totalKm: TOTAL_KM, width: WIDTH })).toBe(0);
    expect(kmToX(325, { totalKm: TOTAL_KM, width: WIDTH })).toBe(650);
    expect(kmToX(TOTAL_KM, { totalKm: TOTAL_KM, width: WIDTH })).toBe(WIDTH);
  });

  it('clamps out-of-route values onto the axis', () => {
    expect(kmToX(-40, { totalKm: TOTAL_KM, width: WIDTH })).toBe(0);
    expect(kmToX(900, { totalKm: TOTAL_KM, width: WIDTH })).toBe(WIDTH);
  });

  it('round-trips through xToKm', () => {
    const km = 412.5;
    const x = kmToX(km, { totalKm: TOTAL_KM, width: WIDTH });
    expect(xToKm(x, { totalKm: TOTAL_KM, width: WIDTH })).toBeCloseTo(km, 6);
  });

  it('degrades to 0 rather than NaN for a zero width', () => {
    expect(kmToX(100, { totalKm: TOTAL_KM, width: 0 })).toBe(0);
    expect(xToKm(100, { totalKm: 0, width: WIDTH })).toBe(0);
  });

  // Defense in depth. The model throws on a non-finite endKm, so this shouldn't be
  // reachable — but a NaN here would propagate silently into a CSS length, where it
  // renders as garbage rather than failing, and this project has already shipped two
  // bugs whose whole problem was looking fine until much later.
  it('degrades to 0 rather than NaN for a non-finite position', () => {
    expect(kmToX(Number.NaN, { totalKm: TOTAL_KM, width: WIDTH })).toBe(0);
    expect(kmToX(Infinity, { totalKm: TOTAL_KM, width: WIDTH })).toBe(0);
    expect(xToKm(Number.NaN, { totalKm: TOTAL_KM, width: WIDTH })).toBe(0);
  });
});

describe('labelTier', () => {
  it('degrades detail as a block narrows', () => {
    expect(labelTier(120)).toBe('full');
    expect(labelTier(88)).toBe('full');
    expect(labelTier(87)).toBe('km');
    expect(labelTier(70)).toBe('km');
    expect(labelTier(69)).toBe('number');
    expect(labelTier(28)).toBe('number');
    expect(labelTier(27)).toBe('none');
  });
});

describe('stripLayout', () => {
  it('lays blocks out to scale, contiguously', () => {
    const layout = stripLayout(days(80, 160, 265, 320), { totalKm: TOTAL_KM, width: WIDTH });

    expect(layout.blocks).toHaveLength(4);
    expect(layout.blocks[0]).toMatchObject({ index: 0, x: 0, width: 160 });
    expect(layout.blocks[2]).toMatchObject({ index: 2, x: 320, width: 210 });
    layout.blocks.slice(1).forEach((block, i) => {
      expect(block.x).toBeCloseTo(layout.blocks[i].x + layout.blocks[i].width, 6);
    });
  });

  it('tags each block with the label tier its width allows', () => {
    const layout = stripLayout(days(80, 85), { totalKm: TOTAL_KM, width: WIDTH });
    expect(layout.blocks[0].tier).toBe('full'); // 160 px
    expect(layout.blocks[1].tier).toBe('none'); // 10 px
  });

  it('fills the trailing remainder out to Dresden', () => {
    const layout = stripLayout(days(80, 160), { totalKm: TOTAL_KM, width: WIDTH });
    expect(layout.remainder).toMatchObject({ x: 320, width: 980, startKm: 160, endKm: TOTAL_KM });
  });

  it('makes the remainder the whole axis for an empty plan', () => {
    const layout = stripLayout([], { totalKm: TOTAL_KM, width: WIDTH });
    expect(layout.blocks).toEqual([]);
    expect(layout.remainder).toMatchObject({ x: 0, width: WIDTH, startKm: 0 });
  });

  it('leaves no remainder once the plan reaches Dresden', () => {
    const layout = stripLayout(days(TOTAL_KM), { totalKm: TOTAL_KM, width: WIDTH });
    expect(layout.remainder.width).toBe(0);
  });

  // Real data: route.meta.json carries totalKm 650.24 while boundary edits quantize
  // lengths to the 0.1 km grid, so a finished plan tops out at km 650.2 and leaves
  // 0.04 km un-closable. A bare `width > 0` check would render a permanent
  // one-pixel dashed sliver with a "+ add a day" button in it.
  it('treats a sub-epsilon remainder as finished, so an off-grid totalKm leaves no sliver', () => {
    const layout = stripLayout(days(650.2), { totalKm: 650.24, width: WIDTH });
    expect(layout.remainder.width).toBe(0);
  });
});

describe('hitTestHandle', () => {
  it('finds the boundary handle under the pointer', () => {
    const layout = stripLayout(days(80, 160), { totalKm: TOTAL_KM, width: WIDTH });
    expect(hitTestHandle(160, layout)).toBe(0);
    expect(hitTestHandle(320, layout)).toBe(1);
  });

  it('accepts a near miss inside the tolerance', () => {
    const layout = stripLayout(days(80, 160), { totalKm: TOTAL_KM, width: WIDTH });
    expect(hitTestHandle(168, layout)).toBe(0);
  });

  it('returns null outside the tolerance', () => {
    const layout = stripLayout(days(80, 160), { totalKm: TOTAL_KM, width: WIDTH });
    expect(hitTestHandle(240, layout)).toBeNull();
  });

  it('picks the nearer of two crowded handles', () => {
    const layout = stripLayout(days(80, 85), { totalKm: TOTAL_KM, width: WIDTH });
    // handles at 160 and 170
    expect(hitTestHandle(168, layout)).toBe(1);
    expect(hitTestHandle(162, layout)).toBe(0);
  });
});
