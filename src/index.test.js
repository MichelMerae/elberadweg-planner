// The app shell itself — index.html, which no module owns and no other test
// reads. Both assertions here guard requirements that are invisible in the source
// modules: one legal, one about what a cold load looks like.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

describe('index.html', () => {
  // ODbL requires the credit for the route and town data stay visible. It has
  // already moved once (out of the dropped #panel-footer, into the header), so
  // this asserts the credit exists rather than where it sits — a later layout is
  // free to move it again, but not to lose it. Leaflet's own tile attribution is
  // a separate requirement, satisfied inside map.js.
  it('keeps the OpenStreetMap data credit in the markup', () => {
    expect(html).toContain('OpenStreetMap');
    expect(html).toContain('ODbL');
  });

  // main.js imports style.css too, so the app is styled either way once the module
  // graph has loaded. This link is what makes it styled in the FIRST frame: without
  // it every cold dev load and every CSS hot-swap paints the raw markup briefly.
  it('links the stylesheet directly, so the first paint is styled', () => {
    expect(html).toMatch(/<link\s+rel="stylesheet"\s+href="\/src\/style\.css"/);
  });
});
