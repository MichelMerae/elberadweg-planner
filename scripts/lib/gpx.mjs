// Minimal GPX track reader. Regex, not XML: GPX track points are flat,
// attribute-only elements, and the official files carry nothing exotic.
// Segments are kept separate so the caller can decide how to join them.

/**
 * @param {string} xml
 * @returns {Array<Array<[number, number]>>} one [lng,lat] array per <trkseg>
 */
export function parseGpxTracks(xml) {
  const segments = [];
  const segRe = /<trkseg[^>]*>([\s\S]*?)<\/trkseg>/g;
  const attr = (s, name) => {
    const m = new RegExp(`${name}="([-\\d.]+)"`).exec(s);
    return m ? Number(m[1]) : NaN;
  };
  for (let seg; (seg = segRe.exec(xml)); ) {
    const coords = [];
    // Fresh regex per segment. A shared `g`-flagged RegExp would happen to work
    // here — the inner loop always drains to a failing exec(), which resets
    // lastIndex — but correctness that depends on that detail is not worth the
    // one allocation it saves.
    const ptRe = /<trkpt\b([^>]*)>/g;
    for (let pt; (pt = ptRe.exec(seg[1])); ) {
      const lat = attr(pt[1], 'lat');
      const lon = attr(pt[1], 'lon');
      if (Number.isFinite(lat) && Number.isFinite(lon)) coords.push([lon, lat]);
    }
    if (coords.length) segments.push(coords);
  }
  if (!segments.length) throw new Error('parseGpxTracks: no trkpt found in document');
  return segments;
}
