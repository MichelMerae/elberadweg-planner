// DOM rendering + interaction wiring for the planner panel. No Leaflet, no
// Turf, no data-module imports — main.js owns all the domain logic and passes
// plain values/callbacks in. This keeps the UI a thin, testable render layer.

const SLIDER_MIN = 20;
const SLIDER_MAX = 160;
const SLIDER_STEP = 1;
const PENDING_DEBOUNCE_MS = 40;

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Stable identity for a town across re-renders (townsNear returns fresh
// objects each call, so reference equality can't be used for selection).
export function townKey(town) {
  return town ? `${town.name}@${town.routeDistanceKm}` : null;
}

function townMeta(town) {
  return `${round1(town.routeDistanceKm)} km along · ${town.offsetKm} km off route`;
}

// Stable identity for a POI, mirroring townKey — used to match a pending pin to
// its row (poisInRange returns fresh objects each render).
export function poiKey(poi) {
  return poi ? `${poi.name}@${poi.routeDistanceKm}` : null;
}

function poiMeta(poi, dayStartKm) {
  const into = round1(poi.routeDistanceKm - dayStartKm);
  return `${into} km into your day (km ${round1(poi.routeDistanceKm)}) · ${poi.offsetKm} km off route`;
}

// Escape user-facing data (OSM town names) before innerHTML interpolation.
// None of the current dataset needs it, but a data rebuild could introduce
// names containing & or < and must not become markup.
function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Debounced wrapper with a .flush() escape hatch so commit can synchronously
// deliver the latest pending value before it is read.
function debounce(fn, ms) {
  let handle = null;
  let lastArgs = null;
  const wrapped = (...args) => {
    lastArgs = args;
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      fn(...lastArgs);
    }, ms);
  };
  wrapped.flush = () => {
    if (handle) {
      clearTimeout(handle);
      handle = null;
      fn(...lastArgs);
    }
  };
  return wrapped;
}

/**
 * Builds the panel UI and returns render methods. The pending-day controls are
 * created once (so the slider keeps focus/interaction between renders); the
 * towns and itinerary sections are re-rendered wholesale each time.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.controlsEl
 * @param {HTMLElement} opts.plansEl
 * @param {HTMLElement} opts.townsEl
 * @param {HTMLElement} opts.poisEl
 * @param {HTMLElement} opts.itineraryEl
 * @param {HTMLElement} opts.bannerEl
 * @param {Object} opts.callbacks
 * @param {(target: number) => void} opts.callbacks.onPendingChange
 * @param {() => void} opts.callbacks.onCommit
 * @param {() => void} opts.callbacks.onRemoveLast
 * @param {() => void} opts.callbacks.onReset
 * @param {(town: object) => void} opts.callbacks.onSelectTown
 * @param {(poi: object) => void} opts.callbacks.onSelectPoi
 * @param {(poi: object|null) => void} opts.callbacks.onPoiRowHover
 * @param {(index: number, target: number) => void} opts.callbacks.onEditDay
 * @param {(id: string) => void} opts.callbacks.onSelectPlan
 * @param {(name: string) => void} opts.callbacks.onRenamePlan
 * @param {() => void} opts.callbacks.onNewPlan
 * @param {() => void} opts.callbacks.onDuplicatePlan
 * @param {() => void} opts.callbacks.onDeletePlan
 */
export function createUI({ controlsEl, plansEl, townsEl, poisEl, itineraryEl, bannerEl, callbacks = {} }) {
  // --- Controls (built once) --------------------------------------------
  controlsEl.innerHTML = `
    <h2 class="controls__heading" id="pending-heading">Day 1 — start at km 0</h2>
    <div class="controls__row">
      <input type="range" id="pending-range"
             min="${SLIDER_MIN}" max="${SLIDER_MAX}" step="${SLIDER_STEP}" value="80" />
      <label class="controls__num">
        <input type="number" id="pending-number" min="1" step="1" value="80" />
        <span>km</span>
      </label>
    </div>
    <div class="controls__buttons">
      <button type="button" id="commit-btn" class="btn btn--primary">Commit day</button>
      <button type="button" id="remove-btn" class="btn">Remove last day</button>
      <button type="button" id="reset-btn" class="btn btn--danger">Reset trip</button>
    </div>`;

  const heading = controlsEl.querySelector('#pending-heading');
  const range = controlsEl.querySelector('#pending-range');
  const number = controlsEl.querySelector('#pending-number');
  const commitBtn = controlsEl.querySelector('#commit-btn');
  const removeBtn = controlsEl.querySelector('#remove-btn');
  const resetBtn = controlsEl.querySelector('#reset-btn');

  const emitPending = debounce((value) => {
    if (callbacks.onPendingChange) callbacks.onPendingChange(value);
  }, PENDING_DEBOUNCE_MS);

  // Sync the two inputs and report the change. `source` is the element the user
  // touched; we mirror its value onto the other one.
  function handlePendingInput(source) {
    const value = Number(source.value);
    if (!Number.isFinite(value) || value <= 0) return;
    if (source === range) {
      number.value = String(value);
    } else {
      // Pin the slider to its range; the number input may exceed the max.
      range.value = String(Math.min(Math.max(value, SLIDER_MIN), SLIDER_MAX));
    }
    emitPending(value);
  }

  range.addEventListener('input', () => handlePendingInput(range));
  number.addEventListener('input', () => handlePendingInput(number));
  commitBtn.addEventListener('click', () => {
    // A commit within the debounce window must not act on a stale target:
    // deliver any pending change synchronously before committing.
    emitPending.flush();
    if (callbacks.onCommit) callbacks.onCommit();
  });
  removeBtn.addEventListener('click', () => callbacks.onRemoveLast && callbacks.onRemoveLast());
  resetBtn.addEventListener('click', () => {
    if (window.confirm('Reset the whole trip? This clears every planned day.')) {
      if (callbacks.onReset) callbacks.onReset();
    }
  });

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

  // --- Towns (event-delegated) ------------------------------------------
  let currentTowns = [];
  townsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-town-index]');
    if (!btn) return;
    const town = currentTowns[Number(btn.dataset.townIndex)];
    if (town && callbacks.onSelectTown) callbacks.onSelectTown(town);
  });

  // --- POIs (event-delegated) -------------------------------------------
  // Two lists share one container; the row's kind selects which to index into.
  let currentFood = [];
  let currentSights = [];
  poisEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-poi-index]');
    if (!btn) return;
    const list = btn.dataset.poiKind === 'food' ? currentFood : currentSights;
    const poi = list[Number(btn.dataset.poiIndex)];
    if (poi && callbacks.onSelectPoi) callbacks.onSelectPoi(poi);
  });

  // Hovering a row reports the POI (or null on leave) so the map can highlight
  // the matching marker. mouseover repeats while moving across a row's children,
  // so dedupe by key.
  let lastRowHoverKey = null;
  poisEl.addEventListener('mouseover', (e) => {
    const btn = e.target.closest('[data-poi-index]');
    if (!btn) return;
    if (btn.dataset.poiKey === lastRowHoverKey) return;
    lastRowHoverKey = btn.dataset.poiKey;
    const list = btn.dataset.poiKind === 'food' ? currentFood : currentSights;
    const poi = list[Number(btn.dataset.poiIndex)];
    if (poi && callbacks.onPoiRowHover) callbacks.onPoiRowHover(poi);
  });
  poisEl.addEventListener('mouseout', (e) => {
    const btn = e.target.closest('[data-poi-index]');
    if (!btn) return;
    // Ignore moves between a row's own children; only fire on a real exit.
    if (btn.contains(e.relatedTarget)) return;
    lastRowHoverKey = null;
    if (callbacks.onPoiRowHover) callbacks.onPoiRowHover(null);
  });

  // --- Itinerary (event-delegated) --------------------------------------
  itineraryEl.addEventListener('change', (e) => {
    const input = e.target.closest('[data-day-index]');
    if (!input) return;
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) return;
    if (callbacks.onEditDay) callbacks.onEditDay(Number(input.dataset.dayIndex), value);
  });

  // --- Public render API -------------------------------------------------

  /** Set the pending target silently (no callback) — used for map-click updates. */
  function setPendingTarget(value) {
    const v = round1(value);
    number.value = String(v);
    range.value = String(Math.min(Math.max(v, SLIDER_MIN), SLIDER_MAX));
  }

  function renderControls({ dayNumber, startKm, reached }) {
    const disabled = Boolean(reached);
    range.disabled = disabled;
    number.disabled = disabled;
    commitBtn.disabled = disabled;
    if (reached) {
      heading.textContent = "You've reached Dresden!";
      heading.classList.add('controls__heading--done');
    } else {
      heading.textContent = `Day ${dayNumber} — start at km ${round1(startKm)}`;
      heading.classList.remove('controls__heading--done');
    }
  }

  function renderTowns(towns, selectedKey) {
    currentTowns = towns || [];
    if (!currentTowns.length) {
      townsEl.innerHTML = '<p class="towns__empty">No towns near this stretch.</p>';
      return;
    }
    const items = currentTowns
      .map((town, i) => {
        const selected = townKey(town) === selectedKey ? ' town--selected' : '';
        return `
          <button type="button" class="town${selected}" data-town-index="${i}">
            <span class="town__name">${esc(town.name)}</span>
            <span class="town__place">${esc(town.place)}</span>
            <span class="town__meta">${townMeta(town)}</span>
          </button>`;
      })
      .join('');
    townsEl.innerHTML = `<h2 class="towns__heading">Overnight options</h2>${items}`;
  }

  function poiRow(poi, index, kind, dayStartKm) {
    const hours = poi.openingHours
      ? `<span class="poi__hours">${esc(poi.openingHours)}</span>`
      : '';
    return `
      <button type="button" class="poi poi--${kind}"
              data-poi-kind="${kind}" data-poi-index="${index}" data-poi-key="${esc(poiKey(poi))}">
        <span class="poi__name">${esc(poi.name)}</span>
        <span class="poi__cat">${esc(poi.category.replace(/_/g, ' '))}</span>
        <span class="poi__meta">${poiMeta(poi, dayStartKm)}</span>
        ${hours}
      </button>`;
  }

  function poiSection(kind, label, emptyText, items, dayStartKm) {
    const body = items.length
      ? items.map((poi, i) => poiRow(poi, i, kind, dayStartKm)).join('')
      : `<p class="pois__empty">${emptyText}</p>`;
    return `
      <details class="pois pois--${kind}" open>
        <summary class="pois__summary">${label} <span class="pois__count">(${items.length})</span></summary>
        <div class="pois__body">${body}</div>
      </details>`;
  }

  function renderPois({ food = [], sights = [], dayStartKm = 0 } = {}) {
    currentFood = food;
    currentSights = sights;
    poisEl.innerHTML =
      poiSection('food', 'Food on the way', 'No food stops on this stretch.', food, dayStartKm) +
      poiSection('sight', 'Worth seeing', 'No sights on this stretch.', sights, dayStartKm);
  }

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

  // Boot-time fallback when POI data failed to load.
  function renderPoisNote(message) {
    currentFood = [];
    currentSights = [];
    poisEl.innerHTML = `<p class="pois__note">${esc(message)}</p>`;
  }

  // Highlights the row matching `key` (from a map-marker hover); null clears.
  // Scrolls the row into view inside the left panel so the match is visible.
  let hoveredRow = null;
  function highlightPoiRow(key) {
    if (hoveredRow) {
      hoveredRow.classList.remove('poi--hover');
      hoveredRow = null;
    }
    if (!key) return;
    hoveredRow =
      [...poisEl.querySelectorAll('[data-poi-key]')].find((el) => el.dataset.poiKey === key) || null;
    if (hoveredRow) {
      hoveredRow.classList.add('poi--hover');
      hoveredRow.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderItinerary({ days, totalKm, reached }) {
    const plannedKm = days.length ? days[days.length - 1].endKm : 0;
    const remaining = Math.max(0, totalKm - plannedKm);
    const pct = totalKm > 0 ? Math.min(100, Math.max(0, (plannedKm / totalKm) * 100)) : 0;

    const summary = `
      <div class="summary${reached ? ' summary--done' : ''}">
        <div class="summary__head">
          <span>${round1(plannedKm)} / ${round1(totalKm)} km planned</span>
          <span>${round1(remaining)} km to Dresden</span>
        </div>
        <div class="summary__track">
          <div class="summary__fill" style="width: ${round1(pct)}%"></div>
        </div>
      </div>`;

    if (!days.length) {
      itineraryEl.innerHTML = `<h2 class="itinerary__heading">Itinerary</h2>${summary}
        <p class="itinerary__empty">No days planned yet. Set a distance and commit your first day.</p>`;
      return;
    }

    const cards = days
      .map((day, i) => {
        const isFinish = reached && i === days.length - 1;
        const town = day.townChoice ? esc(day.townChoice.name) : 'no town chosen';
        const townClass = day.townChoice ? 'day-card__town' : 'day-card__town day-card__town--none';
        return `
          <div class="day-card${isFinish ? ' day-card--finish' : ''}">
            <div class="day-card__title">Day ${day.index + 1}</div>
            <div class="day-card__body">
              <label class="day-card__edit">
                <input type="number" min="1" step="1" value="${round1(day.targetKm)}"
                       data-day-index="${day.index}" /> km
              </label>
              <span class="day-card__range">km ${round1(day.startKm)} → ${round1(day.endKm)}</span>
              <span class="${townClass}">${town}</span>
            </div>
          </div>`;
      })
      .join('');

    itineraryEl.innerHTML = `<h2 class="itinerary__heading">Itinerary</h2>${summary}<div class="day-list">${cards}</div>`;
  }

  function hideBanner() {
    bannerEl.hidden = true;
    bannerEl.innerHTML = '';
  }

  function showBanner(message) {
    bannerEl.innerHTML = `
      <span>${message}</span>
      <button type="button" class="banner__dismiss" aria-label="Dismiss">×</button>`;
    bannerEl.hidden = false;
    bannerEl.querySelector('.banner__dismiss').addEventListener('click', hideBanner);
  }

  return {
    setPendingTarget,
    renderControls,
    renderPlans,
    renderTowns,
    renderPois,
    renderPoisNote,
    highlightPoiRow,
    renderItinerary,
    showBanner,
    hideBanner,
  };
}
