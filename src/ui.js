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

// Day-relative wording (spec §4): distance from the day's reference point (the
// last overnight stop), absolute route km shown small in a .meta__abs span.
// fromName is an OSM-derived town name, so escape it before innerHTML use.
function townMeta(town, dayStartKm, fromName) {
  const rel = round1(town.routeDistanceKm - dayStartKm);
  return `${rel} km from ${esc(fromName)} · ${town.offsetKm} km off route <span class="meta__abs">km ${round1(town.routeDistanceKm)}</span>`;
}

// Stable identity for a POI, mirroring townKey — used to match a pending pin to
// its row (poisInRange returns fresh objects each render).
export function poiKey(poi) {
  return poi ? `${poi.name}@${poi.routeDistanceKm}` : null;
}

// Same day-relative wording as towns, but the absolute km sits inline in
// parentheses (spec §4) rather than in a trailing .meta__abs span.
function poiMeta(poi, dayStartKm, fromName) {
  const rel = round1(poi.routeDistanceKm - dayStartKm);
  return `${rel} km from ${esc(fromName)} (km ${round1(poi.routeDistanceKm)}) · ${poi.offsetKm} km off route`;
}

// Glyph per break kind for day-card legs (spec §2: a food break reads as a
// coffee ☕ stop, a sight 📷, a town waypoint 🛏 — matching the day-end marker).
const BREAK_GLYPH = { food: '☕', sight: '📷', town: '🛏' };

// Glyph per kind in the favorites list — here a food place reads literally as a
// fork 🍴 (not the coffee ☕ used for break legs), a sight 📷, a town 🛏.
const FAV_GLYPH = { town: '🛏', food: '🍴', sight: '📷' };

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
 * @param {HTMLElement} opts.favoritesEl
 * @param {HTMLElement} opts.itineraryEl
 * @param {HTMLElement} opts.bannerEl
 * @param {Object} opts.callbacks
 * @param {(target: number) => void} opts.callbacks.onPendingChange
 * @param {() => void} opts.callbacks.onCommit
 * @param {() => void} opts.callbacks.onRemoveLast
 * @param {() => void} opts.callbacks.onReset
 * @param {(town: object) => void} opts.callbacks.onSelectTown
 * @param {(poi: object) => void} opts.callbacks.onSelectPoi
 * @param {(place: object) => void} opts.callbacks.onToggleBreak
 * @param {(key: string) => void} opts.callbacks.onRemoveBreak
 * @param {(place: object) => void} opts.callbacks.onToggleFavorite
 * @param {(place: object) => void} opts.callbacks.onSelectFavorite
 * @param {(poi: object|null) => void} opts.callbacks.onPoiRowHover
 * @param {(index: number, target: number) => void} opts.callbacks.onEditDay
 * @param {(id: string) => void} opts.callbacks.onSelectPlan
 * @param {(name: string) => void} opts.callbacks.onRenamePlan
 * @param {() => void} opts.callbacks.onNewPlan
 * @param {() => void} opts.callbacks.onDuplicatePlan
 * @param {() => void} opts.callbacks.onDeletePlan
 */
export function createUI({ controlsEl, plansEl, townsEl, poisEl, favoritesEl, itineraryEl, bannerEl, callbacks = {} }) {
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
    </div>
    <div class="controls__breaks" id="pending-breaks"></div>`;

  const heading = controlsEl.querySelector('#pending-heading');
  const pendingBreaksEl = controlsEl.querySelector('#pending-breaks');
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
  // The pending-stretch breaks list lives inside the controls block; its ×
  // buttons remove a plan-level break (same callback as the day-card legs).
  controlsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove-break"]');
    if (!btn) return;
    if (callbacks.onRemoveBreak) callbacks.onRemoveBreak(btn.dataset.breakKey);
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

  // --- Place lists: towns, POIs, favorites (event-delegated) ------------
  // Rows are role="button" divs (not <button>) so the ☕/⭐ action buttons can
  // nest as real buttons inside. wireRowList centralizes the shared behavior for
  // all three lists: a body click (or Enter/Space on the row) runs onBody(place);
  // a click on a nested [data-action] button runs onBreak/onFav with
  // stopPropagation so the body action doesn't also fire; the inner buttons
  // handle their own keyboard activation natively.
  let currentTowns = [];
  let currentFood = [];
  let currentSights = [];
  let currentFavorites = [];

  function poiFromRow(row) {
    const list = row.dataset.poiKind === 'food' ? currentFood : currentSights;
    return list[Number(row.dataset.poiIndex)] || null;
  }

  function wireRowList(container, rowSelector, { resolve, onBody, onBreak, onFav }) {
    if (!container) return;
    container.addEventListener('click', (e) => {
      const row = e.target.closest(rowSelector);
      if (!row) return;
      const place = resolve(row);
      if (!place) return;
      const action = e.target.closest('[data-action]');
      if (action) {
        e.stopPropagation();
        if (action.dataset.action === 'break') onBreak?.(place);
        else if (action.dataset.action === 'fav') onFav?.(place);
        return;
      }
      onBody?.(place);
    });
    container.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest(rowSelector);
      if (!row || e.target !== row) return; // inner action buttons handle their own keys
      e.preventDefault();
      const place = resolve(row);
      if (place) onBody?.(place);
    });
  }

  wireRowList(townsEl, '[data-town-index]', {
    resolve: (row) => currentTowns[Number(row.dataset.townIndex)] || null,
    onBody: (town) => callbacks.onSelectTown?.(town),
    onBreak: (town) => callbacks.onToggleBreak?.(town),
    onFav: (town) => callbacks.onToggleFavorite?.(town),
  });
  wireRowList(poisEl, '[data-poi-index]', {
    resolve: poiFromRow,
    onBody: (poi) => callbacks.onSelectPoi?.(poi),
    onBreak: (poi) => callbacks.onToggleBreak?.(poi),
    onFav: (poi) => callbacks.onToggleFavorite?.(poi),
  });
  wireRowList(favoritesEl, '[data-fav-index]', {
    resolve: (row) => currentFavorites[Number(row.dataset.favIndex)] || null,
    onBody: (fav) => callbacks.onSelectFavorite?.(fav),
    onBreak: (fav) => callbacks.onToggleBreak?.(fav),
    onFav: (fav) => callbacks.onToggleFavorite?.(fav),
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
  itineraryEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove-break"]');
    if (!btn) return;
    if (callbacks.onRemoveBreak) callbacks.onRemoveBreak(btn.dataset.breakKey);
  });

  // --- Public render API -------------------------------------------------

  /** Set the pending target silently (no callback) — used for map-click updates. */
  function setPendingTarget(value) {
    const v = round1(value);
    number.value = String(v);
    range.value = String(Math.min(Math.max(v, SLIDER_MIN), SLIDER_MAX));
  }

  function renderControls({ dayNumber, startKm, reached, pendingBreaks = [] }) {
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
    renderPendingBreaks(pendingBreaks, startKm);
  }

  // Breaks committed beyond the last planned day (no day covers them yet), shown
  // in the controls block with the same × remove control as the day-card legs.
  // Distances are relative to the pending day's start (the last committed endKm).
  function renderPendingBreaks(list, startKm) {
    if (!list.length) {
      pendingBreaksEl.innerHTML = '';
      return;
    }
    const items = list
      .map((b) => {
        const glyph = BREAK_GLYPH[b.kind] || '☕';
        const rel = round1(b.routeDistanceKm - startKm);
        return `
          <li class="pending-break">
            <span class="pending-break__name">${glyph} ${esc(b.name)}</span>
            <span class="pending-break__dist">${rel} km from start</span>
            <button type="button" class="row-remove" data-action="remove-break"
                    data-break-key="${esc(poiKey(b))}" title="Remove break" aria-label="Remove break">×</button>
          </li>`;
      })
      .join('');
    pendingBreaksEl.innerHTML =
      `<div class="controls__breaks-label">Breaks this day</div><ul class="pending-break-list">${items}</ul>`;
  }

  // The ☕ break + ⭐ favorite actions shared by every place row (towns, POIs,
  // favorites). Both are real <button>s nested in the role="button" row (valid:
  // button-in-div); state is reflected in the --active class + aria-pressed and
  // the dynamic title/aria-label.
  function rowActions(name, isBreak, isFav) {
    const safeName = esc(name);
    const breakLabel = isBreak ? 'Remove break' : 'Add as break';
    const favLabel = isFav ? 'Remove favorite' : 'Favorite';
    return `
      <span class="row-actions">
        <button type="button" class="row-action row-action--break${isBreak ? ' row-action--active' : ''}"
                data-action="break" aria-pressed="${isBreak}" title="${breakLabel}" aria-label="${breakLabel}: ${safeName}">☕</button>
        <button type="button" class="row-action row-action--fav${isFav ? ' row-action--active' : ''}"
                data-action="fav" aria-pressed="${isFav}" title="${favLabel}" aria-label="${favLabel}: ${safeName}">⭐</button>
      </span>`;
  }

  function renderTowns(towns, selectedKey, { dayStartKm = 0, fromName = 'your last stop', breakKeys, favoriteKeys } = {}) {
    currentTowns = towns || [];
    if (!currentTowns.length) {
      townsEl.innerHTML = '<p class="towns__empty">No towns near this stretch.</p>';
      return;
    }
    const breakSet = breakKeys instanceof Set ? breakKeys : new Set(breakKeys || []);
    const favSet = favoriteKeys instanceof Set ? favoriteKeys : new Set(favoriteKeys || []);
    const items = currentTowns
      .map((town, i) => {
        const selected = townKey(town) === selectedKey ? ' town--selected' : '';
        const isBreak = breakSet.has(townKey(town));
        // Favorites use a kind-prefixed key (favorites.js favKey: `${kind}:${name}@${km}`);
        // main.js passes the Set already prefixed, ui builds the town lookup here.
        const isFav = favSet.has(`town:${townKey(town)}`);
        return `
          <div class="town${selected}" role="button" tabindex="0" data-town-index="${i}">
            <span class="town__name">${esc(town.name)}</span>
            <span class="town__place">${esc(town.place)}</span>
            ${rowActions(town.name, isBreak, isFav)}
            <span class="town__meta">${townMeta(town, dayStartKm, fromName)}</span>
          </div>`;
      })
      .join('');
    townsEl.innerHTML = `<h2 class="towns__heading">Overnight options</h2>${items}`;
  }

  function poiRow(poi, index, kind, dayStartKm, fromName, isBreak, isFav) {
    const hours = poi.openingHours
      ? `<span class="poi__hours">${esc(poi.openingHours)}</span>`
      : '';
    return `
      <div class="poi poi--${kind}" role="button" tabindex="0"
           data-poi-kind="${kind}" data-poi-index="${index}" data-poi-key="${esc(poiKey(poi))}">
        <span class="poi__name">${esc(poi.name)}</span>
        <span class="poi__cat">${esc(poi.category.replace(/_/g, ' '))}</span>
        ${rowActions(poi.name, isBreak, isFav)}
        <span class="poi__meta">${poiMeta(poi, dayStartKm, fromName)}</span>
        ${hours}
      </div>`;
  }

  function poiSection(kind, label, emptyText, items, dayStartKm, fromName, breakSet, favSet) {
    const body = items.length
      ? items
          .map((poi, i) =>
            // fav lookup is kind-prefixed (`${kind}:${name}@${km}`); the row's
            // kind is known per section, so build the same key main.js used.
            poiRow(poi, i, kind, dayStartKm, fromName, breakSet.has(poiKey(poi)), favSet.has(`${kind}:${poiKey(poi)}`)),
          )
          .join('')
      : `<p class="pois__empty">${emptyText}</p>`;
    return `
      <details class="pois pois--${kind}" open>
        <summary class="pois__summary">${label} <span class="pois__count">(${items.length})</span></summary>
        <div class="pois__body">${body}</div>
      </details>`;
  }

  function renderPois({ food = [], sights = [], dayStartKm = 0, fromName = 'your last stop', breakKeys, favoriteKeys } = {}) {
    currentFood = food;
    currentSights = sights;
    const breakSet = breakKeys instanceof Set ? breakKeys : new Set(breakKeys || []);
    const favSet = favoriteKeys instanceof Set ? favoriteKeys : new Set(favoriteKeys || []);
    poisEl.innerHTML =
      poiSection('food', 'Food on the way', 'No food stops on this stretch.', food, dayStartKm, fromName, breakSet, favSet) +
      poiSection('sight', 'Worth seeing', 'No sights on this stretch.', sights, dayStartKm, fromName, breakSet, favSet);
  }

  // The favorites section (top of the left panel): a user-curated, global list
  // shown regardless of the pending stretch. Every ⭐ here is filled (each row is
  // a favorite; clicking it unfavorites). Each row keeps a ☕ to commit it as a
  // break. The day tag names the first committed day whose (startKm, endKm]
  // covers the favorite's km, else "beyond plan".
  function renderFavorites({ favorites = [], days = [], breakKeys } = {}) {
    if (!favoritesEl) return; // container is optional, same contract as wireRowList
    currentFavorites = favorites;
    // Break lookups use the NON-prefixed key shape (name@km, = poiKey) — the
    // same shape the origin rows check, not the kind-prefixed favorite key.
    const breakSet = breakKeys instanceof Set ? breakKeys : new Set(breakKeys || []);
    const count = favorites.length;
    const body = count
      ? favorites.map((fav, i) => favoriteRow(fav, i, days, breakSet)).join('')
      : '<p class="pois__empty">Nothing starred yet — hit ⭐ on any place.</p>';
    favoritesEl.innerHTML = `
      <details class="pois pois--fav" open>
        <summary class="pois__summary">⭐ Favorites <span class="pois__count">(${count})</span></summary>
        <div class="pois__body">${body}</div>
      </details>`;
  }

  function dayTagFor(fav, days) {
    // Same (startKm, endKm] convention as breaks, including the km-0 widening
    // main.js applies in breaksForDay: day 1 owns a place at exactly km 0.
    const day = days.find(
      (d) => fav.routeDistanceKm > (d.startKm === 0 ? -1 : d.startKm) && fav.routeDistanceKm <= d.endKm,
    );
    return day ? `Day ${day.index + 1}` : 'beyond plan';
  }

  function favoriteRow(fav, index, days, breakSet) {
    const glyph = FAV_GLYPH[fav.kind] || '⭐';
    const cat = fav.category
      ? `<span class="poi__cat">${esc(fav.category.replace(/_/g, ' '))}</span>`
      : '';
    const tag = dayTagFor(fav, days);
    const beyond = tag === 'beyond plan' ? ' fav-day--beyond' : '';
    // Rows carry the stored snapshot; ⭐ is always active (it's a favorite). ☕
    // reflects whether this place is currently a committed break in the plan.
    const isBreak = breakSet.has(poiKey(fav));
    return `
      <div class="poi poi--fav" role="button" tabindex="0" data-fav-index="${index}">
        <span class="poi__name">${glyph} ${esc(fav.name)}</span>
        ${cat}
        ${rowActions(fav.name, isBreak, true)}
        <span class="poi__meta">km ${round1(fav.routeDistanceKm)} <span class="fav-day${beyond}">${tag}</span></span>
      </div>`;
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

  // "from X" lead for a day card: previous day's overnight town, "Hamburg" for
  // day 0, or "your last stop" when the previous day has no town chosen. Twin of
  // main.js pendingFromName (pending day) — keep these literals in sync.
  function dayFromName(days, i) {
    if (i === 0) return 'Hamburg';
    return days[i - 1].townChoice?.name ?? 'your last stop';
  }

  // Day-card legs (spec §2): one line per break (km since the previous stop →
  // glyph + name, with a × remove), then a final leg to the overnight town /
  // day end. Distances derive from consecutive positions, so they sum to the
  // ridden distance (endKm − startKm).
  function dayLegs(day, dayBreaks) {
    const lines = [];
    let prevKm = day.startKm;
    for (const b of dayBreaks) {
      const legKm = round1(b.routeDistanceKm - prevKm);
      const glyph = BREAK_GLYPH[b.kind] || '☕';
      lines.push(`
        <li class="day-card__leg">
          <span class="day-card__leg-text"><span class="day-card__leg-dist">${legKm} km</span> → ${glyph} ${esc(b.name)}</span>
          <button type="button" class="row-remove" data-action="remove-break"
                  data-break-key="${esc(poiKey(b))}" title="Remove break" aria-label="Remove break">×</button>
        </li>`);
      prevKm = b.routeDistanceKm;
    }
    const finalKm = round1(day.endKm - prevKm);
    const endName = day.townChoice ? esc(day.townChoice.name) : 'day end';
    lines.push(`
      <li class="day-card__leg day-card__leg--end">
        <span class="day-card__leg-text"><span class="day-card__leg-dist">${finalKm} km</span> → 🛏 ${endName}</span>
      </li>`);
    return `<ol class="day-card__legs">${lines.join('')}</ol>`;
  }

  function renderItinerary({ days, totalKm, reached, breaksForDay }) {
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
        const fromName = dayFromName(days, i);
        const dayBreaks = typeof breaksForDay === 'function' ? breaksForDay(day) || [] : [];
        const town = day.townChoice ? esc(day.townChoice.name) : 'no town chosen';
        const townClass = day.townChoice ? 'day-card__town' : 'day-card__town day-card__town--none';
        // With breaks the overnight/day end shows as the final leg, so the
        // standalone town chip would duplicate it — omit it then.
        const legs = dayBreaks.length ? dayLegs(day, dayBreaks) : '';
        const townSpan = dayBreaks.length ? '' : `<span class="${townClass}">${town}</span>`;
        return `
          <div class="day-card${isFinish ? ' day-card--finish' : ''}">
            <div class="day-card__title">Day ${day.index + 1}</div>
            <div class="day-card__from">from ${esc(fromName)}</div>
            <div class="day-card__body">
              <label class="day-card__edit">
                <input type="number" min="1" step="1" value="${round1(day.targetKm)}"
                       data-day-index="${day.index}" /> km
              </label>
              <span class="day-card__range">km ${round1(day.startKm)} → ${round1(day.endKm)} of ${round1(totalKm)}</span>
              ${townSpan}
            </div>
            ${legs}
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
    renderFavorites,
    renderPoisNote,
    highlightPoiRow,
    renderItinerary,
    showBanner,
    hideBanner,
  };
}
