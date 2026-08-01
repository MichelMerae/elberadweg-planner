// Pure geometry and assembly helpers for the data build. No fetching, no file
// I/O, no console — everything here is a function of its arguments, so the parts
// of the pipeline that can be subtly wrong are the parts that are tested.
// build-data.mjs keeps orchestration, network and the validation report.
//
// Coordinates are [lng, lat] throughout, matching GeoJSON and the rest of the
// pipeline.

import * as turf from '@turf/turf';

// Turf's earth radius, so haversineM and turf.length agree. With 6371000 the two
// drift ~1.5 m per 1000 km, which is enough to fail a "the segments and the total
// describe the same line" assertion for no real reason.
const EARTH_RADIUS_M = 6371008.8;

/** Great-circle distance in metres between two [lng,lat] points. */
export function haversineM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Cumulative distance in metres from the first coordinate, one entry per coordinate. */
export function cumulativeAlongM(coords) {
  const along = [0];
  for (let i = 1; i < coords.length; i++) {
    along[i] = along[i - 1] + haversineM(coords[i - 1], coords[i]);
  }
  return along;
}

/**
 * The closest approach between two lines: where one segment should hand over to
 * the next.
 *
 * Derived rather than anchored, because guessing a coordinate for the place two
 * lines meet is guessing an answer the data already holds — and guessing it
 * badly is easy. Both interior junctions on this route were mis-estimated by
 * 3x to 16x before being measured: Finkenwerder–Landungsbrücken is 2.25 km at
 * its nearest, not the 8.55 km a naive anchor pair produced nor the 1.3 km that
 * was assumed; the German/Czech border hand-over is 3.26 km and provably no
 * shorter anywhere along either line.
 *
 * Vertex-to-vertex, not perpendicular: the trim has to land on a real vertex so
 * the two segments can be concatenated without inventing geometry.
 *
 * Coarse-then-refine rather than a spatial grid. A grid has to pick a cell size,
 * and no single size serves both a 200 m river crossing and a 3.3 km border
 * hand-over; worse, when a grid sweep finds nothing it can only report that it
 * found nothing, which is the least useful thing to say at precisely the moment a
 * number is needed. Subsampling always produces a measurement, so the error can
 * always name the distance that failed.
 *
 * @param {number} [opts.coarseTarget] - vertices each line is subsampled to for
 *   the first pass. 2000 x 2000 is ~4M distance checks, well under a second.
 * @returns {{indexA: number, indexB: number, gapM: number, alongKmA: number,
 *            alongKmB: number, pointA: number[], pointB: number[]}}
 */
export function findJunction(
  coordsA,
  coordsB,
  { maxGapKm = 10, name = 'junction', coarseTarget = 2000 } = {},
) {
  if (!coordsA?.length || !coordsB?.length) {
    throw new Error(`${name}: both lines need at least one coordinate`);
  }

  const strideA = Math.max(1, Math.ceil(coordsA.length / coarseTarget));
  const strideB = Math.max(1, Math.ceil(coordsB.length / coarseTarget));

  // Pass 1: every strideA-th vertex against every strideB-th vertex. Always
  // finite, because it is an exhaustive scan of the subsamples.
  let best = { gapM: Infinity, indexA: 0, indexB: 0 };
  for (let i = 0; i < coordsA.length; i += strideA) {
    for (let j = 0; j < coordsB.length; j += strideB) {
      const gapM = haversineM(coordsA[i], coordsB[j]);
      if (gapM < best.gapM) best = { gapM, indexA: i, indexB: j };
    }
  }

  // Pass 2: full resolution within a window either side of the coarse winner,
  // wide enough to contain whatever the subsampling stepped over.
  const loA = Math.max(0, best.indexA - strideA * 2);
  const hiA = Math.min(coordsA.length - 1, best.indexA + strideA * 2);
  const loB = Math.max(0, best.indexB - strideB * 2);
  const hiB = Math.min(coordsB.length - 1, best.indexB + strideB * 2);
  for (let i = loA; i <= hiA; i++) {
    for (let j = loB; j <= hiB; j++) {
      const gapM = haversineM(coordsA[i], coordsB[j]);
      if (gapM < best.gapM) best = { gapM, indexA: i, indexB: j };
    }
  }

  if (best.gapM / 1000 > maxGapKm) {
    throw new Error(
      `${name}: closest approach between the two lines is ${(best.gapM / 1000).toFixed(2)} km, ` +
        `above the ${maxGapKm} km ceiling — they do not meet, so one of the sources is wrong`,
    );
  }

  const alongA = cumulativeAlongM(coordsA);
  const alongB = cumulativeAlongM(coordsB);
  return {
    indexA: best.indexA,
    indexB: best.indexB,
    gapM: best.gapM,
    alongKmA: alongA[best.indexA] / 1000,
    alongKmB: alongB[best.indexB] / 1000,
    pointA: coordsA[best.indexA],
    pointB: coordsB[best.indexB],
  };
}

/**
 * Concatenate pre-trimmed segments into one coordinate array, recording where
 * each segment sits and how long each join turned out to be.
 *
 * The joins are *declared*, not discovered. Feeding all sixteen relations to one
 * stitcher would surface the two ferries as generic hard-gap warnings,
 * indistinguishable from corrupt data — and would let a genuine break hide among
 * warnings that are expected. Here every join is named up front and carries a
 * ceiling, so an unexpected distance fails the build instead of being logged.
 *
 * Segments must already be trimmed, simplified and rounded: the km recorded here
 * are measured on the coordinates as given, so they are exactly the km of the
 * file that gets written.
 *
 * @param {Array<{name: string, coords: number[][]}>} segments - in route order.
 * @param {{bridges: Array<{name: string, maxKm: number}>}} opts - one fewer
 *   bridge than there are segments, in the same order as the joins.
 * @returns {{coords: number[][], totalKm: number,
 *            segments: Array<object & {startKm: number, endKm: number}>,
 *            bridges: Array<{name: string, km: number, lengthKm: number}>}}
 */
export function joinSegments(segments, { bridges = [] } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('joinSegments needs at least one segment');
  }
  const needed = segments.length - 1;
  if (bridges.length !== needed) {
    throw new Error(
      `joinSegments needs ${needed} bridge(s) for ${segments.length} segment(s), got ${bridges.length}`,
    );
  }

  const coords = [];
  const outSegments = [];
  const outBridges = [];
  let alongM = 0; // length of `coords` so far

  segments.forEach((segment, index) => {
    const { coords: segCoords, ...rest } = segment;
    if (!Array.isArray(segCoords) || segCoords.length < 2) {
      throw new Error(
        `segment "${segment.name}" has ${segCoords?.length ?? 0} coordinate(s), needs at least 2`,
      );
    }

    if (index > 0) {
      const bridge = bridges[index - 1];
      const gapM = haversineM(coords[coords.length - 1], segCoords[0]);
      const gapKm = gapM / 1000;
      if (gapKm > bridge.maxKm) {
        throw new Error(
          `bridge "${bridge.name}" measures ${gapKm.toFixed(2)} km, above its ${bridge.maxKm} km ` +
            `ceiling — the segments do not meet where they were expected to`,
        );
      }
      // The bridge starts where the previous segment ended. The joined polyline
      // spans it implicitly, so alongM must account for it before the next
      // segment's own first vertex.
      outBridges.push({ name: bridge.name, km: alongM / 1000, lengthKm: gapKm });
      alongM += gapM;
    }

    const startM = alongM;
    coords.push(...segCoords);
    alongM += cumulativeAlongM(segCoords)[segCoords.length - 1];
    outSegments.push({ ...rest, startKm: startM / 1000, endKm: alongM / 1000 });
  });

  return { coords, totalKm: alongM / 1000, segments: outSegments, bridges: outBridges };
}

/**
 * How much of a line doubles back on itself: the km whose vertices lie within
 * `radiusM` of a part of the same line more than `minAlongKm` away measured
 * *along* it.
 *
 * The along-route condition is what makes this useful. A cycle route is full of
 * vertices metres from their neighbours; only a return past a point already
 * ridden indicates a spur, and a spur means every distance the app quotes is
 * inflated. One stage's `alternative` members once produced a spurious 8.6 km
 * jump this way.
 *
 * Uses a flat lat/lng grid for neighbour lookup, so cost is linear in vertices
 * rather than quadratic. Cell size is a degree figure, not metres: at these
 * latitudes 0.0005 degrees is 35–56 m, comfortably above a 30 m radius, and the
 * ±2 cell sweep covers the rest.
 *
 * @returns {{flaggedKm: number, totalKm: number, percent: number,
 *            clusters: Array<{startKm: number, endKm: number, lengthKm: number}>}}
 */
export function doublingBackReport(
  coords,
  { radiusM = 30, minAlongKm = 1, cellDeg = 0.0005 } = {},
) {
  const along = cumulativeAlongM(coords);
  const totalM = along[along.length - 1] ?? 0;
  const minAlongM = minAlongKm * 1000;

  const grid = new Map();
  const cellKey = (lng, lat) => `${Math.floor(lng / cellDeg)},${Math.floor(lat / cellDeg)}`;
  coords.forEach(([lng, lat], i) => {
    const key = cellKey(lng, lat);
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });

  const flagged = new Set();
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    const cx = Math.floor(lng / cellDeg);
    const cy = Math.floor(lat / cellDeg);
    let hit = false;
    for (let dx = -2; dx <= 2 && !hit; dx++) {
      for (let dy = -2; dy <= 2 && !hit; dy++) {
        for (const j of grid.get(`${cx + dx},${cy + dy}`) || []) {
          if (Math.abs(along[i] - along[j]) <= minAlongM) continue;
          if (haversineM(coords[i], coords[j]) <= radiusM) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) flagged.add(i);
  }

  // Turn flagged vertices into km, and into contiguous runs, so the report can
  // point at where the trouble is rather than only how much of it there is.
  let flaggedM = 0;
  const runs = [];
  let run = null;
  for (let i = 0; i < coords.length; i++) {
    if (flagged.has(i)) {
      if (i > 0) flaggedM += along[i] - along[i - 1];
      if (run) run.endM = along[i];
      else run = { startM: along[i], endM: along[i] };
    } else if (run) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);

  const clusters = runs.map(({ startM, endM }) => ({
    startKm: startM / 1000,
    endKm: endM / 1000,
    lengthKm: (endM - startM) / 1000,
  }));
  clusters.sort((a, b) => b.lengthKm - a.lengthKm);

  return {
    flaggedKm: flaggedM / 1000,
    totalKm: totalM / 1000,
    percent: totalM > 0 ? (flaggedM / totalM) * 100 : 0,
    clusters,
  };
}

/**
 * Split a line into consecutive chunks and return a padded bounding box for each.
 *
 * This is how the place queries reach Overpass, and it replaced an `around:`
 * coordinate-list corridor that Overpass would not serve. Measured: at 2 km
 * spacing (515 coordinates) the single-clause towns query returned HTTP 504 and
 * then dropped the connection; at 8 km spacing (130 coordinates) it failed the
 * same way across two mirrors. A union of hundreds of circles is expensive to
 * evaluate, whereas a bounding box is exactly what a spatial index is fast at.
 *
 * One box for the whole route is not an option either — this corridor's bbox spans
 * ~5.5° × 6.5° and contains Berlin, Hannover, Leipzig and Nuremberg's latitude
 * band. Per-chunk boxes hug a diagonal river far more tightly: eleven ~100 km
 * chunks cover a small fraction of the area of the one big rectangle.
 *
 * `padKm` must be at least the corridor half-width the caller filters to, or
 * places inside the filter fall outside the query. Padding is converted per chunk
 * using that chunk's own mean latitude, because a degree of longitude is 66 km at
 * 53°N and 71 km at 50°N.
 *
 * @returns {Array<{south:number, west:number, north:number, east:number,
 *                  startKm:number, endKm:number}>}
 */
export function chunkBboxes(coords, { chunkKm = 100, padKm = 6 } = {}) {
  if (!Array.isArray(coords) || coords.length < 2) return [];
  const along = cumulativeAlongM(coords);
  const totalM = along[along.length - 1];
  const chunkM = chunkKm * 1000;
  const boxes = [];

  let startIndex = 0;
  while (startIndex < coords.length - 1) {
    const startM = along[startIndex];
    let endIndex = startIndex;
    while (endIndex < coords.length - 1 && along[endIndex] - startM < chunkM) endIndex++;

    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (let i = startIndex; i <= endIndex; i++) {
      const [lng, lat] = coords[i];
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }

    const meanLat = (minLat + maxLat) / 2;
    const padLat = padKm / 110.574;
    const padLng = padKm / (111.32 * Math.cos((meanLat * Math.PI) / 180));

    boxes.push({
      south: minLat - padLat,
      west: minLng - padLng,
      north: maxLat + padLat,
      east: maxLng + padLng,
      startKm: startM / 1000,
      endKm: along[endIndex] / 1000,
    });

    if (endIndex >= coords.length - 1) break;
    startIndex = endIndex;
  }

  // A trailing chunk shorter than chunkKm is still a chunk; the loop above ends on
  // the last vertex either way, so the union always covers the whole line.
  if (boxes.length && boxes[boxes.length - 1].endKm < totalM / 1000 - 0.001) {
    throw new Error(
      `chunkBboxes covered only ${boxes[boxes.length - 1].endKm.toFixed(1)} km of ` +
        `${(totalM / 1000).toFixed(1)} km — places past that point would never be queried`,
    );
  }
  return boxes;
}

/**
 * Sample a line every `spacingKm`, plus its final coordinate, for use as an
 * Overpass `around:` coordinate list.
 *
 * NOTE: kept for `corridorPoints`-based tooling, but the place queries use
 * `chunkBboxes` instead — see that function for the measurements that forced the
 * change.
 *
 * Why this exists: the Cuxhaven → Prague bounding box spans roughly 5.5° × 6.5°
 * and contains Berlin, Hannover, Leipzig and Nuremberg's latitude band. Querying
 * POIs in that rectangle fetches an enormous amount the off-route filter then
 * discards, and very likely times out first.
 *
 * Coverage geometry, which sets the radius the caller must pass: circles of
 * radius r centred every s km along a line cover a band of half-width
 * sqrt(r² - (s/2)²). At s = 2 km, r = 3.5 km covers 3.35 km (enough for the 3 km
 * sight corridor) and r = 5.5 km covers 5.4 km (enough for the 5 km town
 * corridor). r = 3 km would cover only 2.83 km — a silent shortfall.
 */
export function corridorPoints(line, spacingKm = 2) {
  const totalKm = turf.length(line, { units: 'kilometers' });
  const points = [];
  for (let km = 0; km < totalKm; km += spacingKm) {
    points.push(turf.along(line, km, { units: 'kilometers' }).geometry.coordinates);
  }
  const coords = line.geometry.coordinates;
  points.push(coords[coords.length - 1]);
  return points;
}
