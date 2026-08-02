import { describe, it, expect } from 'vitest';
import { parseGpxTracks } from './gpx.mjs';

const GPX = `<?xml version="1.0"?>
<gpx version="1.1"><trk><name>A links</name>
<trkseg>
<trkpt lat="53.8600" lon="8.6900"><ele>3</ele></trkpt>
<trkpt lon="8.7000" lat="53.8550"/>
</trkseg>
<trkseg>
<trkpt lat="53.8500" lon="8.7100"/>
</trkseg>
</trk></gpx>`;

describe('parseGpxTracks', () => {
  it('returns one coords array per trkseg, as [lng, lat]', () => {
    expect(parseGpxTracks(GPX)).toEqual([
      [[8.69, 53.86], [8.7, 53.855]],
      [[8.71, 53.85]],
    ]);
  });

  it('accepts either attribute order and self-closed trkpt', () => {
    const segs = parseGpxTracks(GPX);
    expect(segs[0][1]).toEqual([8.7, 53.855]);
  });

  it('throws on a document with no trkpt at all', () => {
    expect(() => parseGpxTracks('<gpx><trk></trk></gpx>')).toThrow(/no trkpt/i);
  });

  it('ignores waypoints and route points — only trkseg counts', () => {
    const withWpt = GPX.replace('</gpx>', '<wpt lat="0" lon="0"/></gpx>');
    expect(parseGpxTracks(withWpt).flat()).toHaveLength(3);
  });
});
