// Elevation along the route: loading, reading, and turning into drawable points.
//
// Pure except for loadElevation(), so the whole visual layer can be exercised
// without a DOM. The strip owns the SVG; this module owns the numbers.
//
// Two honesty constraints shape the API, and both are worth stating because the
// obvious implementation gets them wrong:
//
// 1. This corridor falls from sea level to 184 m over 1026 km. Nothing is visible
//    at true scale, so `profilePoints` takes an explicit min/max and the caller is
//    expected to LABEL it. An unlabelled exaggerated profile invites reading a 30 m
//    river terrace as a climb.
// 2. Cumulative ascent is an artefact of sampling interval and DEM noise. Sample a
//    flat road every 100 m against a DEM accurate to a few metres and you can
//    manufacture hundreds of metres of "climbing". `ascentBetween` therefore takes a
//    hysteresis threshold, and its result is approximate by construction.

const DEFAULT_ASCENT_THRESHOLD_M = 5;

// import.meta.glob, not a bare dynamic import.
//
// The obvious `await import('./data/elevation.json')` inside a try/catch LOOKS like
// it degrades, and does not: Vite resolves that specifier when it transforms the
// module, so a missing file is a build error long before any catch block runs.
// (route.js and pois.js both carry that pattern with a comment claiming otherwise —
// it holds only because their data files always exist.)
//
// glob is evaluated at build time and simply yields no entry for a file that is not
// there, which makes the elevation build genuinely optional: clone the repo, run
// `npm run dev`, and the app works without a profile.
const elevationModules = import.meta.glob('./data/elevation.json');

/**
 * Load the baked elevation profile, or null.
 *
 * The app must boot and work when the elevation build has never been run, so both
 * absence and failure resolve to null rather than rejecting.
 */
export async function loadElevation() {
  const load = elevationModules['./data/elevation.json'];
  if (!load) {
    console.warn('planner-app: no elevation data built — run `npm run build:elevation`');
    return null;
  }
  try {
    const mod = await load();
    return mod.default ?? mod;
  } catch (err) {
    console.warn('planner-app: elevation data unavailable', err);
    return null;
  }
}

/** Whether a value looks like a usable profile. */
function usable(profile) {
  return Boolean(
    profile &&
      Array.isArray(profile.elevationsM) &&
      profile.elevationsM.length > 0 &&
      Number.isFinite(profile.spacingM) &&
      profile.spacingM > 0,
  );
}

/**
 * The profile if it belongs to this route, else null.
 *
 * Elevation sampled along a different corridor describes a different road, and
 * drawing it would be worse than drawing nothing — it would look authoritative.
 * `routeId` undefined means "don't care", which keeps the module mountable alone.
 */
export function profileForRoute(profile, routeId) {
  if (!usable(profile)) return null;
  if (routeId !== undefined && profile.routeId !== routeId) {
    console.warn(
      `planner-app: elevation data is for route "${profile.routeId}", not "${routeId}" — ignoring it`,
    );
    return null;
  }
  return profile;
}

/** Metres above sea level at a route km, interpolated; clamped to the route. */
export function elevationAtKm(profile, km) {
  if (!usable(profile) || !Number.isFinite(km)) return null;
  const samples = profile.elevationsM;
  const perKm = 1000 / profile.spacingM;
  const position = km * perKm;
  if (position <= 0) return samples[0];
  if (position >= samples.length - 1) return samples[samples.length - 1];
  const low = Math.floor(position);
  const fraction = position - low;
  return samples[low] + (samples[low + 1] - samples[low]) * fraction;
}

/**
 * Elevation as [x, y] pairs across a box, ready for an SVG path.
 *
 * Resampled at column centres rather than by taking each column's extreme. On this
 * strip a pixel is ~0.73 km and the DEM resolves ~90 m, so a peak narrower than a
 * column is not a real feature — picking per-column maxima would bias the whole
 * profile upward to make noise visible.
 *
 * y is inverted for SVG (0 at the top), and `minM` sits on the baseline so a
 * profile reads as ground rather than floating.
 *
 * The window is ORIENTED: `endKm` below `startKm` means the stretch is ridden
 * downstream, and the profile comes back point-mirrored — the same terrain, read left
 * to right in the direction of travel, which is the direction the strip's axis runs.
 * `km = startKm + (endKm - startKm) * t` was always direction-correct; a zero-length
 * window is the only one refused, since every column would sample the same km and the
 * flat line that produced would read as terrain.
 *
 * @param {{startKm:number, endKm:number, width:number, height:number,
 *          columns?:number, minM?:number, maxM?:number}} opts
 *   minM/maxM default to the whole profile's range, which is what makes days
 *   comparable — per-day autoscaling would make every day look equally hilly.
 * @returns {Array<[number, number]>}
 */
export function profilePoints(profile, { startKm, endKm, width, height, columns, minM, maxM } = {}) {
  if (!usable(profile)) return [];
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return [];
  if (!Number.isFinite(startKm) || !Number.isFinite(endKm) || startKm === endKm) return [];

  const lo = Number.isFinite(minM) ? minM : profile.minM ?? Math.min(...profile.elevationsM);
  const hi = Number.isFinite(maxM) ? maxM : profile.maxM ?? Math.max(...profile.elevationsM);
  const span = hi - lo;

  // One column per pixel is plenty, but never fewer than two — a path needs a line.
  const count = Math.max(2, Math.floor(Number.isFinite(columns) ? columns : width));

  const points = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const km = startKm + (endKm - startKm) * t;
    const metres = elevationAtKm(profile, km);
    // A perfectly flat stretch has zero span; put it on the baseline rather than
    // dividing by zero and drawing it at an arbitrary height.
    const normalised = span > 0 ? (metres - lo) / span : 0;
    points.push([width * t, height - height * normalised]);
  }
  return points;
}

/**
 * Ascent, descent and range over a stretch.
 *
 * Hysteresis, not a naive sum of positive differences: only a move that carries
 * `thresholdM` clear of the last accepted reference counts, and then the reference
 * moves with it. A steady climb still totals correctly because it is accumulated in
 * threshold-sized steps; a sawtooth inside the threshold contributes nothing, which
 * is the entire point — that sawtooth is the DEM's error bar, not terrain.
 *
 * @returns {{ascentM:number|null, descentM:number|null, minM:number|null, maxM:number|null}}
 */
export function ascentBetween(
  profile,
  startKm,
  endKm,
  { thresholdM = DEFAULT_ASCENT_THRESHOLD_M } = {},
) {
  const empty = { ascentM: null, descentM: null, minM: null, maxM: null };
  if (!usable(profile)) return empty;
  if (!Number.isFinite(startKm) || !Number.isFinite(endKm)) return empty;

  const samples = profile.elevationsM;
  const perKm = 1000 / profile.spacingM;
  const first = Math.max(0, Math.ceil(Math.min(startKm, endKm) * perKm));
  const last = Math.min(samples.length - 1, Math.floor(Math.max(startKm, endKm) * perKm));

  // A stretch shorter than one sample spacing: read its endpoints rather than
  // reporting nothing, but there is no climb to accumulate between them.
  if (last <= first) {
    const a = elevationAtKm(profile, startKm);
    const b = elevationAtKm(profile, endKm);
    return { ascentM: 0, descentM: 0, minM: Math.min(a, b), maxM: Math.max(a, b) };
  }

  let ascentM = 0;
  let descentM = 0;
  let reference = samples[first];
  let minM = samples[first];
  let maxM = samples[first];

  for (let i = first + 1; i <= last; i++) {
    const metres = samples[i];
    if (metres < minM) minM = metres;
    if (metres > maxM) maxM = metres;
    const delta = metres - reference;
    if (delta >= thresholdM) {
      ascentM += delta;
      reference = metres;
    } else if (-delta >= thresholdM) {
      descentM += -delta;
      reference = metres;
    }
  }

  return { ascentM, descentM, minM, maxM };
}
