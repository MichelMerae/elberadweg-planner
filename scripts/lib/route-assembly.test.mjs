import { describe, it, expect } from 'vitest';
import * as turf from '@turf/turf';
import {
  haversineM,
  cumulativeAlongM,
  findJunction,
  joinSegments,
  doublingBackReport,
  corridorPoints,
} from './route-assembly.mjs';

// A ~111 km meridian segment: one degree of latitude, which is 111.195 km on
// turf's sphere. Round numbers keep the km bookkeeping in these tests readable.
const line = turf.lineString([
  [0, 0],
  [0, 0.5],
  [0, 1],
]);

describe('haversineM', () => {
  it('measures a degree of latitude as ~111.195 km', () => {
    expect(haversineM([0, 0], [0, 1]) / 1000).toBeCloseTo(111.195, 2);
  });

  it('agrees with turf.length to within a metre over the same line', () => {
    const mine = haversineM([0, 0], [0, 0.5]) + haversineM([0, 0.5], [0, 1]);
    const turfs = turf.length(line, { units: 'kilometers' }) * 1000;
    expect(Math.abs(mine - turfs)).toBeLessThan(1);
  });

  it('is zero for a point against itself', () => {
    expect(haversineM([9.9686, 53.5457], [9.9686, 53.5457])).toBe(0);
  });
});

describe('cumulativeAlongM', () => {
  it('starts at zero and increases monotonically', () => {
    const along = cumulativeAlongM([
      [0, 0],
      [0, 0.5],
      [0, 1],
    ]);
    expect(along[0]).toBe(0);
    expect(along[1]).toBeGreaterThan(along[0]);
    expect(along[2]).toBeGreaterThan(along[1]);
  });

  it('ends at the whole line length', () => {
    const along = cumulativeAlongM([
      [0, 0],
      [0, 0.5],
      [0, 1],
    ]);
    expect(along[2] / 1000).toBeCloseTo(111.195, 2);
  });

  it('returns a single zero for a one-point line', () => {
    expect(cumulativeAlongM([[0, 0]])).toEqual([0]);
  });
});

describe('findJunction', () => {
  it('locates a single anchor point against a line, which is how outer trims work', () => {
    const j = findJunction(line.geometry.coordinates, [[0.01, 0.5]], {
      maxGapKm: 2,
      name: 'CUXHAVEN',
    });
    expect(j.indexA).toBe(1);
    expect(j.gapM / 1000).toBeGreaterThan(0.5);
    expect(j.gapM / 1000).toBeLessThan(1.5);
  });

  it('throws when an anchor lies beyond its ceiling, naming it', () => {
    expect(() =>
      findJunction(line.geometry.coordinates, [[1, 0.5]], { maxGapKm: 2, name: 'FINKENWERDER' }),
    ).toThrow(/FINKENWERDER/);
  });

  // Two parallel meridians 0.02 degrees of longitude apart — 2.226 km at these
  // latitudes. b spans a shorter stretch centred on a's midpoint, so the closest
  // pair is unambiguous: a[1] to b[1], straight across.
  const a = [
    [0, 0],
    [0, 0.5],
    [0, 1],
  ];
  const b = [
    [0.02, 0.4],
    [0.02, 0.5],
    [0.02, 0.6],
  ];

  it('finds the closest pair of vertices between two lines', () => {
    const j = findJunction(a, b);
    expect(j.gapM).toBeCloseTo(2226, -2);
    expect(j.indexA).toBe(1);
    expect(j.indexB).toBe(1);
  });

  it('reports how far along each line the junction sits', () => {
    const j = findJunction(a, b);
    expect(j.alongKmA).toBeCloseTo(55.6, 0);
    expect(j.alongKmB).toBeCloseTo(11.12, 1);
  });

  it('hands back both coordinates', () => {
    const j = findJunction(a, b);
    expect(j.pointA).toEqual([0, 0.5]);
    expect(j.pointB).toEqual([0.02, 0.5]);
  });

  it('throws when the lines never come within maxGapKm', () => {
    const far = [
      [40, 40],
      [40, 41],
    ];
    expect(() => findJunction(a, far, { maxGapKm: 5, name: 'left→right' })).toThrow(/left→right/);
  });

  it('measures a wide junction rather than missing it', () => {
    // ~40 km apart: far beyond any sensible grid cell, still measurable, and a
    // legitimate junction if the ceiling allows it.
    const b40 = [
      [0.36, 0.4],
      [0.36, 0.5],
      [0.36, 0.6],
    ];
    const j = findJunction(a, b40, { maxGapKm: 60 });
    expect(j.gapM / 1000).toBeCloseTo(40.07, 1);
  });

  it('names the measured gap in its error so the ceiling can be judged', () => {
    const far = [
      [40, 40],
      [40, 41],
    ];
    expect(() => findJunction(a, far, { maxGapKm: 5 })).toThrow(/\d+\.\d{2} km/);
  });

  it('refines past its own subsampling to the true nearest vertex', () => {
    // A dense line whose single nearest vertex sits between coarse samples: with
    // coarseTarget 3 the stride steps over index 47, and the refine pass must
    // still land on it.
    const dense = [];
    for (let i = 0; i < 100; i++) dense.push([0, i * 0.001]);
    dense[47] = [0.0001, 0.047]; // a hair closer to b than its neighbours
    const other = [[0.0002, 0.047]];
    const j = findJunction(dense, other, { coarseTarget: 3, maxGapKm: 10 });
    expect(j.indexA).toBe(47);
  });

  it('throws on an empty line rather than reporting a junction at index 0', () => {
    expect(() => findJunction(a, [], { name: 'right→cz' })).toThrow(/right→cz/);
  });
});

describe('joinSegments', () => {
  // Fragments one degree of longitude wide at the equator, ~111 km each, with
  // ~111 km gaps between them.
  const segAt = (lng) => [
    [lng, 0],
    [lng + 1, 0],
  ];
  const segments = () => [
    { name: 'left', coords: segAt(0) },
    { name: 'right', coords: segAt(2) },
    { name: 'cz', coords: segAt(4) },
  ];
  const bridges = () => [
    { name: 'ferry A', maxKm: 200 },
    { name: 'ferry B', maxKm: 200 },
  ];

  it('concatenates every coordinate in order', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.coords).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
    ]);
  });

  it('reports a total equal to the joined polyline length', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    const turfKm = turf.length(turf.lineString(out.coords), { units: 'kilometers' });
    expect(out.totalKm).toBeCloseTo(turfKm, 3);
  });

  it('gives each segment the km range it occupies in the joined line', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.segments[0].startKm).toBeCloseTo(0, 3);
    expect(out.segments[0].endKm).toBeCloseTo(111.195, 1);
    expect(out.segments[1].startKm).toBeCloseTo(222.39, 1);
    expect(out.segments[2].endKm).toBeCloseTo(out.totalKm, 3);
  });

  it('places each bridge at the end of the segment before it', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.bridges).toHaveLength(2);
    expect(out.bridges[0].km).toBeCloseTo(out.segments[0].endKm, 3);
    expect(out.bridges[1].km).toBeCloseTo(out.segments[1].endKm, 3);
    expect(out.bridges[0].name).toBe('ferry A');
  });

  it('measures each bridge length', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.bridges[0].lengthKm).toBeCloseTo(111.195, 1);
  });

  it('leaves no gap between a bridge and the segment after it', () => {
    const out = joinSegments(segments(), { bridges: bridges() });
    expect(out.bridges[0].km + out.bridges[0].lengthKm).toBeCloseTo(out.segments[1].startKm, 3);
  });

  it('throws when a bridge exceeds its ceiling, naming it and its measurement', () => {
    expect(() =>
      joinSegments(segments(), {
        bridges: [
          { name: 'ferry A', maxKm: 3 },
          { name: 'ferry B', maxKm: 200 },
        ],
      }),
    ).toThrow(/ferry A.*111\.\d+ km.*3 km/);
  });

  it('throws when the bridge count does not match the segment count', () => {
    expect(() => joinSegments(segments(), { bridges: [{ name: 'only one', maxKm: 200 }] })).toThrow(
      /2 bridge/,
    );
  });

  it('accepts a single segment with no bridges', () => {
    const out = joinSegments([{ name: 'solo', coords: segAt(0) }], { bridges: [] });
    expect(out.bridges).toEqual([]);
    expect(out.segments[0].startKm).toBe(0);
  });

  it('throws on a segment with fewer than two coordinates', () => {
    expect(() => joinSegments([{ name: 'stub', coords: [[0, 0]] }], { bridges: [] })).toThrow(
      /stub/,
    );
  });

  it('throws on no segments at all', () => {
    expect(() => joinSegments([], { bridges: [] })).toThrow(/at least one segment/);
  });

  it('carries arbitrary segment metadata through to the output', () => {
    const out = joinSegments(
      [{ name: 'left', coords: segAt(0), source: 'elberadweg-left', relations: [1, 2] }],
      { bridges: [] },
    );
    expect(out.segments[0].source).toBe('elberadweg-left');
    expect(out.segments[0].relations).toEqual([1, 2]);
    expect(out.segments[0].coords).toBeUndefined(); // geometry does not belong in meta
  });
});

describe('doublingBackReport', () => {
  // ~1.1 km per 0.01 degree of latitude, so these are readable distances.
  const straight = [];
  for (let i = 0; i <= 100; i++) straight.push([0, i * 0.01]);

  it('reports nothing for a line that never revisits itself', () => {
    const out = doublingBackReport(straight);
    expect(out.flaggedKm).toBeCloseTo(0, 3);
    expect(out.percent).toBeCloseTo(0, 3);
    expect(out.clusters).toEqual([]);
  });

  it('flags an out-and-back spur', () => {
    const spur = [
      ...straight.slice(0, 20),
      ...straight.slice(0, 20).reverse(),
      ...straight.slice(20),
    ];
    const out = doublingBackReport(spur);
    expect(out.flaggedKm).toBeGreaterThan(20);
    expect(out.percent).toBeGreaterThan(10);
    expect(out.clusters.length).toBeGreaterThan(0);
  });

  it('does not flag a hairpin that is close along the route as well as in space', () => {
    const hairpin = [];
    for (let i = 0; i < 40; i++) hairpin.push([i % 2 === 0 ? 0 : 0.0001, i * 0.0001]);
    const out = doublingBackReport(hairpin, { minAlongKm: 1 });
    expect(out.flaggedKm).toBeCloseTo(0, 3);
  });

  it('respects a widened radius', () => {
    // Two near-parallel passes ~50 m apart: invisible at 30 m, flagged at 120 m.
    const parallel = [
      ...straight.slice(0, 30),
      ...straight
        .slice(0, 30)
        .reverse()
        .map(([lng, lat]) => [lng + 0.00075, lat]),
    ];
    expect(doublingBackReport(parallel, { radiusM: 30 }).flaggedKm).toBeCloseTo(0, 1);
    expect(doublingBackReport(parallel, { radiusM: 120 }).flaggedKm).toBeGreaterThan(10);
  });

  it('returns clusters ordered longest first, with km positions', () => {
    const spur = [
      ...straight.slice(0, 20),
      ...straight.slice(0, 20).reverse(),
      ...straight.slice(20),
    ];
    const out = doublingBackReport(spur);
    const lengths = out.clusters.map((c) => c.lengthKm);
    expect([...lengths].sort((x, y) => y - x)).toEqual(lengths);
    expect(out.clusters[0].endKm).toBeGreaterThanOrEqual(out.clusters[0].startKm);
  });

  it('reports the route total it measured against', () => {
    const out = doublingBackReport(straight);
    expect(out.totalKm).toBeCloseTo(111.195, 0);
  });

  it('reports zero for an empty or single-point line rather than dividing by zero', () => {
    expect(doublingBackReport([]).percent).toBe(0);
    expect(doublingBackReport([[0, 0]]).percent).toBe(0);
  });
});

describe('corridorPoints', () => {
  const long = turf.lineString([
    [0, 0],
    [0, 1],
  ]); // ~111.195 km

  it('samples about every spacingKm, plus the final coordinate', () => {
    const pts = corridorPoints(long, 10);
    expect(pts).toHaveLength(13); // 0,10,…,110 = 12 samples + the endpoint
  });

  it('starts at the line start and ends at the line end', () => {
    const pts = corridorPoints(long, 10);
    expect(pts[0][1]).toBeCloseTo(0, 4);
    expect(pts[pts.length - 1][1]).toBeCloseTo(1, 6);
  });

  it('yields at least two points for a line shorter than the spacing', () => {
    const short = turf.lineString([
      [0, 0],
      [0, 0.001],
    ]); // ~111 m
    expect(corridorPoints(short, 2).length).toBeGreaterThanOrEqual(2);
  });

  it('returns [lng,lat] pairs', () => {
    const pts = corridorPoints(long, 50);
    for (const p of pts) {
      expect(Array.isArray(p)).toBe(true);
      expect(p).toHaveLength(2);
    }
  });

  it('spaces consecutive samples by roughly the requested distance', () => {
    const pts = corridorPoints(long, 10);
    expect(haversineM(pts[0], pts[1]) / 1000).toBeCloseTo(10, 1);
  });
});
