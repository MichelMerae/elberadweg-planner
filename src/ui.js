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

/**
 * The picking line above the map: what to click, what was picked, and the one
 * refinement a pick can offer (spec §6.3's "Start at Hamburg instead?").
 *
 * Not createBanner, deliberately. That one is a dismissable WARNING about the route
 * data, and main.js's renderBanner shows or hides it from plan state on every save — a
 * prompt parked in it would be wiped by the first persist. This one is owned entirely
 * by the picking flow: role="status" so it is announced, no × (a dismiss that left the
 * mode armed would be a lie — Escape and the control itself are the way out), and an
 * optional action button, which is the only interactive thing the flow needs.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.el
 */
export function createPickBanner({ el }) {
  function hide() {
    el.hidden = true;
    el.innerHTML = '';
    el.classList.remove('banner--error');
  }

  /**
   * @param {string} text
   * @param {{tone?: 'hint'|'error', action?: {label: string, onPress: () => void}|null}} [opts]
   *   `tone` toggles rather than adds: a refusal that never cleared would leave every
   *   later hint red.
   */
  function show(text, { tone = 'hint', action = null } = {}) {
    el.classList.toggle('banner--error', tone === 'error');
    el.innerHTML =
      `<span>${esc(text)}</span>` +
      (action
        ? `<button type="button" class="btn btn--sm btn--primary" data-action="pick-action">${esc(action.label)}</button>`
        : '');
    el.hidden = false;
    // Spent before the callback runs: the offer is taken, and whatever the callback
    // does next reports itself in this same line.
    el.querySelector('[data-action="pick-action"]')?.addEventListener('click', () => {
      hide();
      action.onPress();
    });
  }

  return { show, hide };
}
