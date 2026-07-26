// The focused day, and only the focused day: its length, its overnight town, its
// legs, and the two operations that change the shape of the plan around it
// (split, delete). Bounded content by construction — one day — so this panel can
// never outgrow the window the way the old scrolling itinerary did.

import { esc, round1, poiKey, BREAK_GLYPH } from './ui-util.js';
import { MIN_DAY_KM } from './boundaries.js';

const SNAP_EPSILON_KM = 0.05;

// ✎ on a break leg. For place breaks it edits the free note; for custom stops it
// edits the label itself (= the break's name).
function breakEditButton(b) {
  const isCustom = b.kind === 'custom';
  const label = isCustom ? 'Edit label' : 'Edit note';
  return `
    <button type="button" class="row-edit" data-action="edit-break"
            data-break-key="${esc(poiKey(b))}" data-break-kind="${esc(b.kind || 'town')}"
            data-break-name="${esc(b.name)}" data-break-note="${esc(b.note || '')}"
            title="${label}" aria-label="${label}: ${esc(b.name)}">✎</button>`;
}

// Swaps a leg's text for an inline input. Local DOM state only: saving
// fires onEditBreak (main.js persists + re-renders); cancel restores the
// original markup. `done` guards the blur that fires when a re-render (or
// Enter/Esc) removes the input.
function startBreakEdit(btn, callbacks) {
  const row = btn.closest('.day-card__leg');
  if (!row || row.querySelector('.leg-edit__input')) return;
  const isCustom = btn.dataset.breakKind === 'custom';
  const textEl = row.querySelector('.day-card__leg-text');
  const original = textEl.innerHTML;
  const ariaLabel = isCustom ? 'Stop label' : 'Break note';
  textEl.innerHTML = `<input type="text" class="leg-edit__input" maxlength="120"
      aria-label="${ariaLabel}" placeholder="${isCustom ? 'Stop label' : 'e.g. 15 min coffee'}" />`;
  const input = textEl.querySelector('input');
  const initial = (isCustom ? btn.dataset.breakName : btn.dataset.breakNote) || '';
  input.value = initial;
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    // A custom stop's label is its identity — refuse to blank it. An
    // unchanged value restores locally (no callback, no re-render), so a
    // plain blur doesn't eat the user's next click.
    if (save && callbacks.onEditBreak && value !== initial && (value || !isCustom)) {
      callbacks.onEditBreak(btn.dataset.breakKey, value);
    } else {
      textEl.innerHTML = original;
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // this editor owns Esc; it must not reach the document
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') {
      finish(false);
      btn.focus(); // keyboard context back to the ✎ — cancel never re-renders
    }
  });
  input.addEventListener('blur', () => finish(true));
}

// The "New stop at km K" prompt shown while a route click is pending a label,
// always targeting the focused day. Guarded by data-km so unrelated re-renders
// (e.g. toggling a ☕ elsewhere) don't wipe half-typed text; only a new click
// rebuilds it.
function renderCustomStopPrompt(draft, day, callbacks, promptEl) {
  if (!draft || !day) {
    promptEl.hidden = true;
    promptEl.innerHTML = '';
    delete promptEl.dataset.km;
    return;
  }
  if (promptEl.dataset.km === String(draft.km)) {
    // Same click target; only the day's start may have shifted (an earlier
    // boundary moving drags it) — refresh the title, keep typed text.
    promptEl.querySelector('.custom-stop__title').textContent =
      `New stop at km ${round1(draft.km)} (${round1(draft.km - day.startKm)} km into the day)`;
    return;
  }
  promptEl.dataset.km = String(draft.km);
  promptEl.innerHTML = `
    <div class="custom-stop">
      <div class="custom-stop__title">New stop at km ${round1(draft.km)}
        (${round1(draft.km - day.startKm)} km into the day)</div>
      <input type="text" class="custom-stop__input" id="custom-stop-label" maxlength="120"
             placeholder="e.g. lunch, 2h at the top" aria-label="Stop label" />
      <div class="custom-stop__actions">
        <button type="button" class="btn btn--sm btn--primary" id="custom-stop-add" disabled>Add stop</button>
        <button type="button" class="btn btn--sm" id="custom-stop-cancel">Cancel</button>
      </div>
    </div>`;
  promptEl.hidden = false;
  const input = promptEl.querySelector('#custom-stop-label');
  const addBtn = promptEl.querySelector('#custom-stop-add');
  input.addEventListener('input', () => {
    addBtn.disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      callbacks.onAddCustomStop?.(input.value.trim());
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // handled here; the prompt owns Esc while it is open
      callbacks.onCancelCustomStop?.();
    }
  });
  addBtn.addEventListener('click', () => callbacks.onAddCustomStop?.(input.value.trim()));
  promptEl.querySelector('#custom-stop-cancel')
    .addEventListener('click', () => callbacks.onCancelCustomStop?.());
  input.focus();
}

export function createDayPanel({ el, callbacks = {} }) {
  let current = { day: null, dayCount: 0 };

  // Lives outside the rendered markup and is moved back into it after every
  // innerHTML write. The prompt holds a half-typed label and its own listeners;
  // rebuilding it from scratch each render would throw both away.
  const promptEl = document.createElement('div');
  promptEl.id = 'custom-stop-prompt';
  promptEl.hidden = true;

  function legs(day, breaks) {
    const lines = [];
    let prevKm = day.startKm;
    for (const b of breaks) {
      const glyph = BREAK_GLYPH[b.kind] || '☕';
      const legKm = round1(b.routeDistanceKm - prevKm);
      // A break sitting exactly at the day's start has no leg to speak of; a
      // bare "0 km →" reads as a bug, so say where it is instead.
      const dist =
        legKm <= 0
          ? '<span class="day-card__leg-dist">at the start</span>'
          : `<span class="day-card__leg-dist">${legKm} km</span> →`;
      const note = b.note ? ` <span class="day-card__leg-note">· ${esc(b.note)}</span>` : '';
      lines.push(`
        <li class="day-card__leg">
          <span class="day-card__leg-text">${dist} ${glyph} ${esc(b.name)}${note}</span>
          <span class="leg-actions">
            ${breakEditButton(b)}
            <button type="button" class="row-remove" data-action="remove-break"
                    data-break-key="${esc(poiKey(b))}" title="Remove break" aria-label="Remove break">×</button>
          </span>
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

  function overnight(day) {
    if (!day.townChoice) {
      return `<span class="day-panel__overnight-name day-panel__overnight-name--none">none chosen</span>
              <span class="day-panel__hint">pick one from the left, or drag the pin on the map</span>`;
    }
    const town = day.townChoice;
    const offset =
      typeof town.offsetKm === 'number' ? ` · ${round1(town.offsetKm)} km off route` : '';
    return `<span class="day-panel__overnight-name">🛏 ${esc(town.name)}</span>
            <span class="day-panel__hint">km ${round1(day.endKm)}${offset}</span>`;
  }

  // The boundary clamps at MIN_DAY_KM from its neighbour, so a town very close
  // to the next overnight can't be reached exactly. Say so rather than showing a
  // day length that silently disagrees with the town's position.
  function snapNote(day) {
    const km = day.townChoice?.routeDistanceKm;
    if (typeof km !== 'number' || Math.abs(km - day.endKm) <= SNAP_EPSILON_KM) return '';
    return `<p class="day-panel__snap-note">${esc(day.townChoice.name)} sits at km ${round1(km)};
      this day ends at km ${round1(day.endKm)}.</p>`;
  }

  function render({ day, dayCount, breaks = [], fromName = 'your last stop', customStopDraft = null }) {
    current = { day, dayCount };
    if (!day) {
      el.innerHTML = `
        <div class="day-panel day-panel--empty">
          <h2 class="day-panel__title">No days yet</h2>
          <p class="day-panel__hint">Click the strip below, or hit <b>+ add a day</b>, to plan your first day out of Hamburg.</p>
        </div>`;
      // A draft stop needs a day to belong to, so an empty plan discards it
      // rather than parking typed text where it can never be added.
      renderCustomStopPrompt(null, null, callbacks, promptEl);
      return;
    }
    const length = round1(day.endKm - day.startKm);
    const canSplit = length >= 2 * MIN_DAY_KM;
    el.innerHTML = `
      <div class="day-panel">
        <div class="day-panel__head">
          <h2 class="day-panel__title">Day ${day.index + 1}</h2>
          <div class="day-panel__stepper">
            <span>${day.index + 1} of ${dayCount}</span>
            <button type="button" class="row-edit" data-action="focus-prev" aria-label="Previous day"
                    ${day.index === 0 ? 'disabled' : ''}>‹</button>
            <button type="button" class="row-edit" data-action="focus-next" aria-label="Next day"
                    ${day.index >= dayCount - 1 ? 'disabled' : ''}>›</button>
          </div>
        </div>
        <div class="day-panel__from">from ${esc(fromName)} · km ${round1(day.startKm)} → ${round1(day.endKm)}</div>

        <label class="day-panel__field">
          <span>Distance</span>
          <input type="number" min="${MIN_DAY_KM}" step="1" value="${length}" data-day-distance
                 aria-label="Day ${day.index + 1} distance in km" /> km
        </label>

        <div class="day-panel__field day-panel__overnight">
          <span>Overnight</span>
          ${overnight(day)}
        </div>
        ${snapNote(day)}

        <h3 class="day-panel__section">Legs <span class="pois__count">${length} km total</span></h3>
        ${legs(day, breaks)}

        <div data-custom-stop-slot></div>
        <p class="day-panel__hint">Click the route on the map to add a stop to this day.</p>
        <div class="day-panel__actions">
          <button type="button" class="btn btn--sm" data-action="split-day" ${canSplit ? '' : 'disabled'}
                  title="${canSplit ? 'Split this day in two' : `Too short to split (needs ${2 * MIN_DAY_KM} km)`}">Split day</button>
          <button type="button" class="btn btn--sm btn--danger" data-action="delete-day">Delete day</button>
        </div>
      </div>`;
    el.querySelector('[data-custom-stop-slot]').replaceWith(promptEl);
    // Built after the innerHTML swap so the prompt's own listeners survive it,
    // and so its input is focusable — it is in the document by now.
    renderCustomStopPrompt(customStopDraft, day, callbacks, promptEl);
  }

  el.addEventListener('change', (e) => {
    if (!e.target.matches('[data-day-distance]') || !current.day) return;
    const value = Number(e.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    // The model stores lengths on the 0.1 km grid; quantize here so what the
    // panel reports is what the plan can hold.
    callbacks.onEditDay?.(current.day.index, round1(value));
  });

  el.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-action="edit-break"]');
    if (edit) return startBreakEdit(edit, callbacks);
    const remove = e.target.closest('[data-action="remove-break"]');
    if (remove) return callbacks.onRemoveBreak?.(remove.dataset.breakKey);
    if (!current.day) return;
    const index = current.day.index;
    if (e.target.closest('[data-action="split-day"]')) return callbacks.onSplitDay?.(index);
    if (e.target.closest('[data-action="delete-day"]')) return callbacks.onDeleteDay?.(index);
    if (e.target.closest('[data-action="focus-prev"]')) return callbacks.onFocusDay?.(index - 1);
    if (e.target.closest('[data-action="focus-next"]')) return callbacks.onFocusDay?.(index + 1);
  });

  return { render };
}
