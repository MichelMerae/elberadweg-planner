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
 * @param {HTMLElement} opts.townsEl
 * @param {HTMLElement} opts.itineraryEl
 * @param {HTMLElement} opts.bannerEl
 * @param {Object} opts.callbacks
 * @param {(target: number) => void} opts.callbacks.onPendingChange
 * @param {() => void} opts.callbacks.onCommit
 * @param {() => void} opts.callbacks.onRemoveLast
 * @param {() => void} opts.callbacks.onReset
 * @param {(town: object) => void} opts.callbacks.onSelectTown
 * @param {(index: number, target: number) => void} opts.callbacks.onEditDay
 */
export function createUI({ controlsEl, townsEl, itineraryEl, bannerEl, callbacks = {} }) {
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

  // --- Towns (event-delegated) ------------------------------------------
  let currentTowns = [];
  townsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-town-index]');
    if (!btn) return;
    const town = currentTowns[Number(btn.dataset.townIndex)];
    if (town && callbacks.onSelectTown) callbacks.onSelectTown(town);
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

  function showBanner(message) {
    bannerEl.innerHTML = `
      <span>${message}</span>
      <button type="button" class="banner__dismiss" aria-label="Dismiss">×</button>`;
    bannerEl.hidden = false;
    bannerEl.querySelector('.banner__dismiss').addEventListener('click', () => {
      bannerEl.hidden = true;
      bannerEl.innerHTML = '';
    });
  }

  return { setPendingTarget, renderControls, renderTowns, renderItinerary, showBanner };
}
