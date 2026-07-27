// All that is left of the original monolithic panel renderer: the route-changed
// banner. Two functions and no state of its own, which is why it never grew into
// a module named after itself — but this file has to stay whatever happens to it,
// because src/itinerary.test.js's cross-module key contract test reaches
// townKey/poiKey through `await import('./ui.js')`. A grep for the static import
// form finds nothing; the re-export below is load-bearing all the same.
//
// No Leaflet, no Turf, no data-module imports — main.js owns all the domain logic
// and passes plain values/callbacks in.

import { townKey, poiKey, esc } from './ui-util.js';

export { townKey, poiKey };

/**
 * The route-data-changed warning above the day panel: main.js shows it when the
 * active plan was last saved against a different route version, and the × or the
 * next save clears it.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.el
 */
export function createBanner({ el }) {
  function hide() {
    el.hidden = true;
    el.innerHTML = '';
  }

  function show(message) {
    el.innerHTML = `
      <span>${esc(message)}</span>
      <button type="button" class="banner__dismiss" aria-label="Dismiss">×</button>`;
    el.hidden = false;
    el.querySelector('.banner__dismiss').addEventListener('click', hide);
  }

  return { show, hide };
}
