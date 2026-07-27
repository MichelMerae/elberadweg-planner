// The plans control: a dropdown of every plan, a rename field, and
// New / Duplicate / Reset trip / Delete plan. Trip-level, so it lives in the app
// header rather than in the day panel — "Reset trip" among them because emptying
// the plan you are in is a whole-trip act, and the day panel only ever addresses
// one day.
//
// No Leaflet, no Turf, no data-module imports — main.js owns all the domain logic
// and passes plain values/callbacks in.

import { esc } from './ui-util.js';

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.el
 * @param {Object} opts.callbacks
 * @param {(id: string) => void} opts.callbacks.onSelectPlan
 * @param {(name: string) => void} opts.callbacks.onRenamePlan
 * @param {() => void} opts.callbacks.onNewPlan
 * @param {() => void} opts.callbacks.onDuplicatePlan
 * @param {() => void} opts.callbacks.onResetTrip
 * @param {() => void} opts.callbacks.onDeletePlan
 */
export function createPlansBar({ el, callbacks = {} }) {
  // The bar (select + name input + the four actions) is re-rendered wholesale by
  // render(). What has to outlive a render is only which plan is active and what
  // it is called: an empty rename reverts to that name, and the Reset/Delete
  // confirms say it out loud. Kept as the bar's own two values rather than a
  // reference to the caller's plans array, so updateActiveName has nothing of
  // main.js's to reach into.
  let activePlanId = null;
  let activeName = '';

  function activePlanName() {
    return activeName;
  }

  el.addEventListener('change', (e) => {
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

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-plan-action]');
    if (!btn) return;
    const action = btn.dataset.planAction;
    if (action === 'new') {
      if (callbacks.onNewPlan) callbacks.onNewPlan();
    } else if (action === 'duplicate') {
      if (callbacks.onDuplicatePlan) callbacks.onDuplicatePlan();
    } else if (action === 'reset') {
      // Empties the plan; Delete destroys it. Both ask first, and the confirm
      // spells out which one this is — the two sit side by side.
      if (
        window.confirm(
          `Reset "${activePlanName()}"? Every day and break in this plan goes; the plan itself stays.`,
        )
      ) {
        if (callbacks.onResetTrip) callbacks.onResetTrip();
      }
    } else if (action === 'delete') {
      if (window.confirm(`Delete plan "${activePlanName()}"? This can't be undone.`)) {
        if (callbacks.onDeletePlan) callbacks.onDeletePlan();
      }
    }
  });

  // Renders the plans bar: a dropdown of every plan (active one selected), a
  // text field with the active plan's name, and the four actions. Called on
  // boot and after every plan operation so the dropdown and name field stay in
  // sync. All plan names are OSM-independent user text but still escaped, as the
  // rest of the render modules escape anything they interpolate.
  function render({ plans = [], activePlanId: activeId = null } = {}) {
    activePlanId = activeId;
    const active = plans.find((p) => p.id === activeId) || null;
    activeName = active ? active.name : '';
    const options = plans
      .map(
        (p) =>
          `<option value="${esc(p.id)}"${p.id === activeId ? ' selected' : ''}>${esc(p.name)}</option>`,
      )
      .join('');
    el.innerHTML = `
      <div class="plans__bar">
        <select class="plans__select" data-plan-select aria-label="Choose a plan">${options}</select>
        <input type="text" class="plans__name" data-plan-name
               value="${esc(active ? active.name : '')}" aria-label="Plan name" />
        <div class="plans__actions">
          <button type="button" class="btn btn--sm" data-plan-action="new">New</button>
          <button type="button" class="btn btn--sm" data-plan-action="duplicate">Duplicate</button>
          <button type="button" class="btn btn--sm" data-plan-action="reset"
                  title="Remove every day and break, keeping the plan">Reset trip</button>
          <button type="button" class="btn btn--sm btn--danger" data-plan-action="delete"
                  title="Delete this plan and everything in it">Delete plan</button>
        </div>
      </div>`;
  }

  // Renames the active plan in place. Deliberately NOT a render(): the rename
  // arrives from the name field's `change`, which fires on blur, and that blur is
  // usually a mousedown on one of the action buttons. Rebuilding the bar there
  // detaches the pressed button between mousedown and mouseup, the browser then
  // resolves no click at all, and New/Duplicate/Reset/Delete silently does
  // nothing — the user has to click it twice. Patching the two places the name
  // shows leaves the pressed button attached. Written through textContent and
  // value, so a hostile name needs no esc() here.
  function updateActiveName(name) {
    // activePlanName() feeds the Reset/Delete confirms and the empty-rename
    // revert, so the bar's own record moves with the rename.
    activeName = name;
    const select = el.querySelector('[data-plan-select]');
    const option = select && [...select.options].find((o) => o.value === activePlanId);
    if (option) option.textContent = name;
    // The store has the last word on the name, so what it returned shows here even
    // when that differs from what was typed.
    const field = el.querySelector('[data-plan-name]');
    if (field && field.value !== name) field.value = name;
  }

  return { render, updateActiveName };
}
