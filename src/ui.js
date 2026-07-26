// What is left of the original monolithic panel renderer: the plans bar and the
// route-changed banner. The day panel (day-panel.js), the left panel (places.js)
// and the whole-trip strip (strip.js) each own their own DOM now; Task 12 moves
// the plans bar out into plans-bar.js and this file goes away.
//
// No Leaflet, no Turf, no data-module imports — main.js owns all the domain logic
// and passes plain values/callbacks in.

import { townKey, poiKey, esc } from './ui-util.js';

// Re-exported: src/itinerary.test.js's cross-module key contract test imports
// these from here, and main.js has always taken them from ui.js.
export { townKey, poiKey };

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.plansEl
 * @param {HTMLElement} opts.bannerEl
 * @param {Object} opts.callbacks
 * @param {(id: string) => void} opts.callbacks.onSelectPlan
 * @param {(name: string) => void} opts.callbacks.onRenamePlan
 * @param {() => void} opts.callbacks.onNewPlan
 * @param {() => void} opts.callbacks.onDuplicatePlan
 * @param {() => void} opts.callbacks.onDeletePlan
 */
export function createUI({ plansEl, bannerEl, callbacks = {} }) {
  // --- Plans bar (event-delegated) --------------------------------------
  // The bar (select + name input + New/Duplicate/Delete) is re-rendered
  // wholesale by renderPlans(); currentPlans/activePlanId track what's shown so
  // an empty rename can revert to the canonical name and Delete can label its
  // confirm with the active plan's name.
  let currentPlans = [];
  let activePlanId = null;

  function activePlanName() {
    const plan = currentPlans.find((p) => p.id === activePlanId);
    return plan ? plan.name : '';
  }

  plansEl.addEventListener('change', (e) => {
    if (e.target.matches('[data-plan-select]')) {
      if (callbacks.onSelectPlan) callbacks.onSelectPlan(e.target.value);
      return;
    }
    if (e.target.matches('[data-plan-name]')) {
      const value = e.target.value.trim();
      if (!value) {
        // Empty name: revert the field to the current name, fire nothing.
        e.target.value = activePlanName();
        return;
      }
      if (callbacks.onRenamePlan) callbacks.onRenamePlan(value);
    }
  });

  plansEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-plan-action]');
    if (!btn) return;
    const action = btn.dataset.planAction;
    if (action === 'new') {
      if (callbacks.onNewPlan) callbacks.onNewPlan();
    } else if (action === 'duplicate') {
      if (callbacks.onDuplicatePlan) callbacks.onDuplicatePlan();
    } else if (action === 'delete') {
      if (window.confirm(`Delete plan "${activePlanName()}"? This can't be undone.`)) {
        if (callbacks.onDeletePlan) callbacks.onDeletePlan();
      }
    }
  });

  // --- Public render API -------------------------------------------------

  // Renders the plans bar: a dropdown of every plan (active one selected), a
  // text field with the active plan's name, and New/Duplicate/Delete. Called on
  // boot and after every plan operation so the dropdown and name field stay in
  // sync. All plan names are OSM-independent user text but still escaped, as the
  // rest of this file escapes anything it interpolates.
  function renderPlans({ plans = [], activePlanId: activeId = null } = {}) {
    currentPlans = plans;
    activePlanId = activeId;
    const active = plans.find((p) => p.id === activeId) || null;
    const options = plans
      .map(
        (p) =>
          `<option value="${esc(p.id)}"${p.id === activeId ? ' selected' : ''}>${esc(p.name)}</option>`,
      )
      .join('');
    plansEl.innerHTML = `
      <div class="plans__bar">
        <select class="plans__select" data-plan-select aria-label="Choose a plan">${options}</select>
        <input type="text" class="plans__name" data-plan-name
               value="${esc(active ? active.name : '')}" aria-label="Plan name" />
        <div class="plans__actions">
          <button type="button" class="btn btn--sm" data-plan-action="new">New</button>
          <button type="button" class="btn btn--sm" data-plan-action="duplicate">Duplicate</button>
          <button type="button" class="btn btn--sm btn--danger" data-plan-action="delete">Delete</button>
        </div>
      </div>`;
  }

  function hideBanner() {
    bannerEl.hidden = true;
    bannerEl.innerHTML = '';
  }

  function showBanner(message) {
    bannerEl.innerHTML = `
      <span>${esc(message)}</span>
      <button type="button" class="banner__dismiss" aria-label="Dismiss">×</button>`;
    bannerEl.hidden = false;
    bannerEl.querySelector('.banner__dismiss').addEventListener('click', hideBanner);
  }

  return {
    renderPlans,
    showBanner,
    hideBanner,
  };
}
