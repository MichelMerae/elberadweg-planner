import { describe, it, expect } from 'vitest';
import { kmToX, xToKm, labelTier, stripLayout, hitTestHandle } from './strip-geometry.js';

const TOTAL_KM = 650;
const WIDTH = 1300; // 2 px per km, so the arithmetic is obvious
// The whole road ridden forwards — the window every assertion in the first half of
// this file was written against, now spelled as the window it always was. Its numbers
// are unchanged: a trip spanning the whole road is an identity for the new mapping.
const WHOLE = { startKm: 0, endKm: TOTAL_KM, width: WIDTH };

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
    expect(kmToX(0, WHOLE)).toBe(0);
    expect(kmToX(325, WHOLE)).toBe(650);
    expect(kmToX(TOTAL_KM, WHOLE)).toBe(WIDTH);
  });

  it('clamps out-of-route values onto the axis', () => {
    expect(kmToX(-40, WHOLE)).toBe(0);
    expect(kmToX(900, WHOLE)).toBe(WIDTH);
  });

  it('round-trips through xToKm', () => {
    const km = 412.5;
    const x = kmToX(km, WHOLE);
    expect(xToKm(x, WHOLE)).toBeCloseTo(km, 6);
  });

  it('degrades to 0 rather than NaN for a zero-width axis', () => {
    expect(kmToX(100, { ...WHOLE, width: 0 })).toBe(0);
    expect(xToKm(100, { ...WHOLE, width: 0 })).toBe(0);
  });

  // What `kmAtClientX` leans on: a pointer can leave the axis mid-drag (the gesture
  // captures on the axis, so a move 200 px past its edge still arrives here), and it
  // must read as the end it went past rather than as km off the road.
  it('clamps a pointer past either end of the axis onto the window', () => {
    expect(xToKm(-100, WHOLE)).toBe(0);
    expect(xToKm(WIDTH + 100, WHOLE)).toBe(TOTAL_KM);
  });

  // Defense in depth. The model throws on a non-finite endKm, so this shouldn't be
  // reachable — but a NaN here would propagate silently into a CSS length, where it
  // renders as garbage rather than failing, and this project has already shipped two
  // bugs whose whole problem was looking fine until much later.
  it('degrades to 0 rather than NaN for a non-finite position', () => {
    expect(kmToX(Number.NaN, WHOLE)).toBe(0);
    expect(kmToX(Infinity, WHOLE)).toBe(0);
    expect(xToKm(Number.NaN, WHOLE)).toBe(0);
  });

  // Both ends of the window are now inputs, so both can arrive ruined.
  it('degrades to 0 rather than NaN for a non-finite window end', () => {
    expect(kmToX(100, { startKm: 0, endKm: Number.NaN, width: WIDTH })).toBe(0);
    expect(kmToX(100, { startKm: Number.NaN, endKm: TOTAL_KM, width: WIDTH })).toBe(0);
    expect(xToKm(100, { startKm: 0, endKm: Number.NaN, width: WIDTH })).toBe(0);
    expect(xToKm(100, { startKm: Number.NaN, endKm: TOTAL_KM, width: WIDTH })).toBe(0);
  });
});

// The axis maps the TRIP, not the road: the rider's own start at x 0, their
// destination at the full width, whichever way along the road that runs. One
// expression serves both directions — a descending window makes the denominator
// negative and the mapping still runs left to right in trip order.
describe('kmToX / xToKm - oriented windows', () => {
  const up = { startKm: 149.3, endKm: 797.6, width: 1000 };
  const down = { startKm: 797.6, endKm: 149.3, width: 1000 };

  it('puts the trip start at x=0 and the destination at the full width', () => {
    expect(kmToX(149.3, up)).toBeCloseTo(0, 6);
    expect(kmToX(797.6, up)).toBeCloseTo(1000, 6);
    expect(kmToX(797.6, down)).toBeCloseTo(0, 6);
    expect(kmToX(149.3, down)).toBeCloseTo(1000, 6);
  });

  it('runs left-to-right in trip order on a downstream trip', () => {
    expect(kmToX(700, down)).toBeLessThan(kmToX(300, down));
  });

  it('clamps outside the window, either direction', () => {
    expect(kmToX(50, up)).toBe(0);
    expect(kmToX(900, up)).toBe(1000);
    expect(kmToX(900, down)).toBe(0);
    expect(kmToX(50, down)).toBe(1000);
  });

  it('round-trips through xToKm', () => {
    for (const opts of [up, down]) {
      expect(xToKm(kmToX(400, opts), opts)).toBeCloseTo(400, 3);
    }
  });

  it('reads a pointer position back as an absolute km inside the window', () => {
    // Both directions, halfway along a 648.3 km window.
    expect(xToKm(500, up)).toBeCloseTo(473.45, 6);
    expect(xToKm(500, down)).toBeCloseTo(473.45, 6);
  });

  // Past the left edge is the rider's START whichever way the trip runs — which
  // downstream is the numerically LARGER km, so a numeric clamp would answer with the
  // wrong end of the window.
  it('clamps a pointer off the axis onto the trip’s own ends, either direction', () => {
    expect(xToKm(-100, up)).toBeCloseTo(149.3, 6);
    expect(xToKm(1100, up)).toBeCloseTo(797.6, 6);
    expect(xToKm(-100, down)).toBeCloseTo(797.6, 6);
    expect(xToKm(1100, down)).toBeCloseTo(149.3, 6);
  });

  // A zero-length window is the degenerate every consumer would divide by.
  it('collapses a zero-length window onto x=0 rather than dividing by zero', () => {
    const nil = { startKm: 300, endKm: 300, width: 1000 };
    expect(kmToX(300, nil)).toBe(0);
    expect(kmToX(900, nil)).toBe(0);
    expect(xToKm(500, nil)).toBe(300);
  });
});

describe('labelTier', () => {
  it('degrades detail as a block narrows', () => {
    expect(labelTier(200)).toBe('full');
    expect(labelTier(117)).toBe('full');
    expect(labelTier(116)).toBe('town');
    expect(labelTier(88)).toBe('town');
    expect(labelTier(87)).toBe('km');
    expect(labelTier(70)).toBe('km');
    expect(labelTier(69)).toBe('number');
    expect(labelTier(28)).toBe('number');
    expect(labelTier(27)).toBe('none');
  });

  // Spec §5's degradation order, as one ordered claim rather than five thresholds: the
  // climb is the first thing a narrowing block gives up and the town is the second, so
  // there is exactly one tier that carries a town without a climb and none the other way
  // round. Measured in Chromium at the real 11px/10px Archivo (see TIER_FULL_PX).
  it('gives up the climb one tier before the town', () => {
    const ladder = [200, 117, 116, 88, 87, 70, 69, 28, 27].map(labelTier);
    expect(ladder).toEqual([
      'full',
      'full',
      'town',
      'town',
      'km',
      'km',
      'number',
      'number',
      'none',
    ]);
  });
});

describe('stripLayout', () => {
  it('lays blocks out to scale, contiguously', () => {
    const layout = stripLayout(days(80, 160, 265, 320), WHOLE);

    expect(layout.blocks).toHaveLength(4);
    expect(layout.blocks[0]).toMatchObject({ index: 0, x: 0, width: 160 });
    expect(layout.blocks[2]).toMatchObject({ index: 2, x: 320, width: 210 });
    layout.blocks.slice(1).forEach((block, i) => {
      expect(block.x).toBeCloseTo(layout.blocks[i].x + layout.blocks[i].width, 6);
    });
  });

  it('tags each block with the label tier its width allows', () => {
    const layout = stripLayout(days(80, 85), WHOLE);
    expect(layout.blocks[0].tier).toBe('full'); // 160 px
    expect(layout.blocks[1].tier).toBe('none'); // 10 px
  });

  it('fills the trailing remainder out to the destination', () => {
    const layout = stripLayout(days(80, 160), WHOLE);
    expect(layout.remainder).toMatchObject({ x: 320, width: 980, startKm: 160, endKm: TOTAL_KM });
  });

  it('makes the remainder the whole axis for an empty plan', () => {
    const layout = stripLayout([], WHOLE);
    expect(layout.blocks).toEqual([]);
    expect(layout.remainder).toMatchObject({ x: 0, width: WIDTH, startKm: 0 });
  });

  it('leaves no remainder once the plan reaches the destination', () => {
    const layout = stripLayout(days(TOTAL_KM), WHOLE);
    expect(layout.remainder.width).toBe(0);
  });

  // Real data: route.meta.json carries a fractional totalKm while boundary edits
  // quantize lengths to the 0.1 km grid, so a finished plan tops out 0.04 km short and
  // leaves that un-closable. A bare `width > 0` check would render a permanent
  // one-pixel dashed sliver with a "+ add a day" button in it.
  it('treats a sub-epsilon remainder as finished, so an off-grid end leaves no sliver', () => {
    const layout = stripLayout(days(650.2), { startKm: 0, endKm: 650.24, width: WIDTH });
    expect(layout.remainder.width).toBe(0);
  });

  // The bolded half of this function's contract, and until now only its prose: an
  // inverted day keeps a NEGATIVE width so that `x + width` still equals kmToX(endKm)
  // and its handle stays where its end is. Clamping at source here (rather than in the
  // renderer, which has its own test) would move that handle to the day's start.
  it('keeps an inverted day’s width negative, so its handle stays on its own end', () => {
    const layout = stripLayout(
      [
        { index: 0, startKm: 0, endKm: 80 },
        { index: 1, startKm: 80, endKm: 60 },
      ],
      WHOLE,
    );

    expect(layout.blocks[1].width).toBeLessThan(0);
    expect(layout.blocks[1].x + layout.blocks[1].width).toBeCloseTo(kmToX(60, WHOLE), 9);
    expect(hitTestHandle(kmToX(60, WHOLE), layout)).toBe(1);
  });
});

describe('stripLayout - oriented windows', () => {
  const UP = { startKm: 149.3, endKm: 797.6, width: 1000 };
  const DOWN = { startKm: 797.6, endKm: 149.3, width: 1000 };
  const PX_PER_KM = 1000 / 648.3;

  // Days as itinerary.js chains them: lengths ridden from the trip's own start, in the
  // trip's direction — so a downstream day's endKm is BELOW its startKm.
  function tripDays({ startKm, endKm }, ...lengths) {
    const direction = endKm >= startKm ? 1 : -1;
    let prev = startKm;
    return lengths.map((lengthKm, index) => {
      const dayEnd = prev + lengthKm * direction;
      const day = { index, startKm: prev, endKm: dayEnd };
      prev = dayEnd;
      return day;
    });
  }

  it('starts the first block at x=0 in both directions', () => {
    expect(stripLayout(tripDays(UP, 80), UP).blocks[0].x).toBeCloseTo(0, 6);
    expect(stripLayout(tripDays(DOWN, 80), DOWN).blocks[0].x).toBeCloseTo(0, 6);
  });

  // A downstream day used to come out of here with a NEGATIVE width, which renderers
  // clamp to 0 px — so it carried no label tier at all and its "80 km" could not be
  // observed. The window mapping is what gives it real width.
  it('gives a downstream day positive width, wide enough for a label', () => {
    const layout = stripLayout(tripDays(DOWN, 80, 100), DOWN);
    expect(layout.blocks[0].width).toBeCloseTo(80 * PX_PER_KM, 6);
    expect(layout.blocks[1].width).toBeCloseTo(100 * PX_PER_KM, 6);
    expect(layout.blocks[0].tier).toBe('full');
    layout.blocks.slice(1).forEach((block, i) => {
      expect(block.x).toBeCloseTo(layout.blocks[i].x + layout.blocks[i].width, 6);
    });
  });

  it('keeps each block’s own absolute km, which stay in trip order', () => {
    const layout = stripLayout(tripDays(DOWN, 80), DOWN);
    expect(layout.blocks[0]).toMatchObject({ startKm: 797.6, endKm: 717.6 });
  });

  it('runs the remainder from the last day to the WINDOW’s end', () => {
    const up = stripLayout(tripDays(UP, 80), UP);
    expect(up.remainder.x).toBeCloseTo(80 * PX_PER_KM, 6);
    expect(up.remainder.startKm).toBeCloseTo(229.3, 6);
    expect(up.remainder.endKm).toBe(797.6);

    const down = stripLayout(tripDays(DOWN, 80), DOWN);
    expect(down.remainder.x).toBeCloseTo(80 * PX_PER_KM, 6);
    expect(down.remainder.startKm).toBeCloseTo(717.6, 6);
    expect(down.remainder.endKm).toBe(149.3);
  });

  it('starts an empty plan’s remainder at the rider’s own start', () => {
    expect(stripLayout([], UP).remainder).toMatchObject({
      x: 0,
      width: 1000,
      startKm: 149.3,
      endKm: 797.6,
    });
  });

  // The split Task 6 left behind, closed here. The summary and the scale line already
  // counted the TRIP while this function still counted the ROAD, so a completed
  // offset-forward trip read "0 km to Prague" beside a 289.9 px remainder with a
  // "+ add a day" button in it, and the scale line never said "reached".
  it('counts arrival at the trip’s destination, not the road’s end', () => {
    const layout = stripLayout(tripDays(UP, 648.3), UP);
    expect(layout.remainder.width).toBe(0);
    expect(layout.blocks[0].width).toBeCloseTo(1000, 6);
  });

  it('counts arrival downstream too', () => {
    const layout = stripLayout(tripDays(DOWN, 648.3), DOWN);
    expect(layout.remainder.width).toBe(0);
  });

  it('applies the arrival tolerance to an off-grid window end', () => {
    const offGrid = { startKm: 149.3, endKm: 797.64, width: 1000 };
    expect(stripLayout(tripDays(offGrid, 648.3), offGrid).remainder.width).toBe(0);
  });

  // The remainder is still real road on a window the plan has not filled — its size
  // is what the "+ add a day" button lives in.
  it('leaves the unridden part of the window as the remainder', () => {
    const layout = stripLayout(tripDays(UP, 80), UP);
    expect(layout.remainder.width).toBeCloseTo(1000 - 80 * PX_PER_KM, 6);
  });

  // `arrived` compares a DISTANCE, and this is the case that needs it to. Signed,
  // `endKm - plannedKm` is 149.3 − 717.6 downstream: hugely negative, so under the
  // tolerance, so "arrived" — and an 80 km plan on a 648 km window would collapse its
  // remainder and read as finished on its first day.
  it('does not mistake an unfinished downstream window for a finished one', () => {
    const layout = stripLayout(tripDays(DOWN, 80), DOWN);
    expect(layout.remainder.width).toBeCloseTo(1000 - 80 * PX_PER_KM, 6);
  });
});

describe('hitTestHandle', () => {
  it('finds the boundary handle under the pointer', () => {
    const layout = stripLayout(days(80, 160), WHOLE);
    expect(hitTestHandle(160, layout)).toBe(0);
    expect(hitTestHandle(320, layout)).toBe(1);
  });

  it('accepts a near miss inside the tolerance', () => {
    const layout = stripLayout(days(80, 160), WHOLE);
    expect(hitTestHandle(168, layout)).toBe(0);
  });

  it('returns null outside the tolerance', () => {
    const layout = stripLayout(days(80, 160), WHOLE);
    expect(hitTestHandle(240, layout)).toBeNull();
  });

  it('picks the nearer of two crowded handles', () => {
    const layout = stripLayout(days(80, 85), WHOLE);
    // handles at 160 and 170
    expect(hitTestHandle(168, layout)).toBe(1);
    expect(hitTestHandle(162, layout)).toBe(0);
  });

  // Unchanged by the rescale: it works in px, and a downstream block's right edge is
  // its day END exactly as an upstream one's is.
  it('finds a downstream boundary at its own right edge', () => {
    const layout = stripLayout(
      [
        { index: 0, startKm: 797.6, endKm: 717.6 },
        { index: 1, startKm: 717.6, endKm: 617.6 },
      ],
      { startKm: 797.6, endKm: 149.3, width: 1000 },
    );
    expect(hitTestHandle(layout.blocks[0].x + layout.blocks[0].width, layout)).toBe(0);
    expect(hitTestHandle(layout.blocks[1].x + layout.blocks[1].width, layout)).toBe(1);
  });
});
