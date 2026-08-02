// The focused day, and only the focused day: its length, its overnight town, its
// legs, and the two operations that change the shape of the plan around it
// (split, delete). Bounded content by construction — one day — so this panel can
// never outgrow the window the way the old scrolling itinerary did.
//
// The day and its breaks arrive in ABSOLUTE route km; every km this panel prints is
// counted from the rider's own start, through the `trip` render() is given. There is
// deliberately no fallback for a missing trip: a display module that quietly counts
// from the road's origin instead is the one bug this feature can produce, and it
// produces it silently — every number still looks like a number.

import { esc, round1, poiKey, glyphFor, tripHeadline } from './ui-util.js';
import { MIN_DAY_KM } from './boundaries.js';

const SNAP_EPSILON_KM = 0.05;

// Distance ridden from one absolute km to another, counted the rider's way: positive
// along the trip whichever direction it runs. tripKm is linear, so the difference of
// two conversions IS the ride.
function rideKm(trip, fromKm, toKm) {
  return trip.tripKm(toKm) - trip.tripKm(fromKm);
}

const STEPPER_TWIN = {
  '[data-action="focus-prev"]': '[data-action="focus-next"]',
  '[data-action="focus-next"]': '[data-action="focus-prev"]',
};

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

// The distance ridden to reach a leg. Zero is reachable three ways — a break on the
// day's start line, a second entry sharing a km with the one before it (coffee at the
// bridgehead, then across), and a break on the day's end (handled by its own twin
// below) — and a bare "0 km →" reads as a bug in all of them, so each says where it
// is instead. "at the start" is only true while nothing has been ridden yet; saying
// it 48.9 km into the day would be a plain lie about where the rider is.
function legDistance(legKm, atDayStart) {
  if (legKm > 0) return `<span class="day-card__leg-dist">${legKm} km</span> →`;
  return `<span class="day-card__leg-dist">${atDayStart ? 'at the start' : 'at the same spot'}</span>`;
}

// A crossing the rider has taken, as a leg of the day — the day carries on from it,
// so it sits in the running distance chain exactly as a break does.
//
// An `implicit` one is the exception: where the alt bank's road ends, the path model
// puts the rider back across rather than letting them ride off the end of it (see
// `composed` in path.js). That is not a decision, so it carries no × — a rider cannot
// decline a leg the model will immediately put back — and it says why it is there.
//
// The remove glyph is × , the one this app uses everywhere (the break beside it in
// this same list, ui.js's banner dismiss). The plan sketched ✕; two different remove
// glyphs one line apart in one <ol> is a difference that says something and means
// nothing.
function crossingLeg(c, dist) {
  const ferry = c.kind === 'ferry' ? ' ⛴' : '';
  if (c.implicit) {
    return `
      <li class="day-card__leg day-card__leg--crossing">
        <span class="day-card__leg-text">${dist} ⇄ <b>Cross back here</b> · ${esc(c.name)}${ferry}
          <span class="day-card__leg-note">· the bank you are riding ends here</span></span>
      </li>`;
  }
  return `
    <li class="day-card__leg day-card__leg--crossing">
      <span class="day-card__leg-text">${dist} ⇄ <b>Cross to the other bank</b> · ${esc(c.name)}${ferry}</span>
      <span class="leg-actions">
        <button type="button" class="row-remove" data-action="remove-crossing"
                data-crossing-id="${esc(c.id)}" title="Remove crossing" aria-label="Remove crossing: ${esc(c.name)}">×</button>
      </span>
    </li>`;
}

// The crossings this day rides past without taking — the offer, peer to ending the
// day: "I want the option to cross to the other side like the option to end the day".
//
// Filtered on `chosen` AND `implicit`, not on `chosen` alone: a forced rejoin is
// `chosen: false` (it was never a decision, so activeCrossings must not carry it) and
// would otherwise appear here as something to press, next to the leg above saying the
// rider already crosses there.
//
// A ferry is hinted rather than disabled: whether it is running is a question about
// today's timetable, which nothing in this app knows.
function crossingsGroup(dayCrossings) {
  const rows = dayCrossings.filter((c) => !c.chosen && !c.implicit);
  if (!rows.length) return '';
  return `
    <div class="day-crossings">
      <div class="day-crossings__label">Crossings you pass today</div>
      ${rows
        .map(
          (c) => `
        <div class="day-crossings__row">
          <span>${c.kind === 'ferry' ? '⛴' : '🌉'} ${esc(c.name)}${
            c.kind === 'ferry' ? ' <span class="day-crossings__hint">check operating times</span>' : ''
          }</span>
          <button type="button" class="btn btn--sm" data-action="add-crossing"
                  data-crossing-id="${esc(c.id)}" ${c.canCross ? '' : 'disabled'}
                  title="${c.canCross ? 'Cross to the other bank here' : 'The other bank ends here — no onward riding'}">⇄ Cross</button>
        </div>`,
        )
        .join('')}
    </div>`;
}

// Swaps a leg's text for an inline input. Local DOM state only: saving fires
// onEditBreak (main.js persists + re-renders); cancel restores the original
// markup.
//
// What `done` actually guards is Esc: finish(false) restores the markup and then
// btn.focus() moves focus off the input, which DOES fire blur, whose handler
// would immediately finish(true) and save the value the user just cancelled.
//
// It does not guard a re-render, because a re-render fires nothing — removing a
// focused element fires no blur, in jsdom or in a browser. So an unrelated
// re-render with this editor open silently discards whatever was typed. That is
// deliberate, and deliberately unlike the custom-stop prompt (which survives
// renders verbatim): the prompt holds a route click that would otherwise have to
// be made again, while a note is a small amendment to a break that is still
// there, re-openable with one ✎. Focus goes back to that ✎ (see focusedTarget),
// so the keyboard path is not broken by the discard — only the text is lost.
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
    if (e.key === 'Enter') {
      // preventDefault, or saving re-opens the editor. A browser runs the keydown's
      // default action AFTER this handler returns, and resolves it against whatever
      // holds focus BY THEN — and by then finish(true) has re-rendered the panel and
      // focus has been restored to this leg's ✎. Chromium duly synthesises a click
      // on that button, which opens a fresh editor over the note just saved.
      // (Measured in Chromium; the focus restoration is what makes it reachable.)
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      finish(false);
      btn.focus(); // keyboard context back to the ✎ — cancel never re-renders
    }
  });
  input.addEventListener('blur', () => finish(true));
}

// A draft belongs to the day it was clicked on, and focus can move off that day
// (‹ ›, a strip click) while the draft is still open. Shown on the wrong day it
// reads "(-65 km into the day)" and confirming it would add the stop to the day
// the user left. main.js clears a stranded draft as well; this keeps the panel
// honest whatever it is handed.
//
// WHICH day owns a km is the model's question, not this panel's: `ownedByDay` is
// itinerary.dayOwnsKm's answer, handed down by main.js. Re-deciding it here meant a
// second copy of the half-open rule and of day 1's start-line exception — spelled in
// absolute km against a hardcoded km 0, so on an offset trip it fired for no day at
// all, and on a downstream trip every comparison read backwards.
function draftForDay(draft, day, ownedByDay) {
  return draft && day && ownedByDay ? draft : null;
}

// The "New stop at km K" prompt shown while a route click is pending a label,
// always targeting the focused day. Guarded by data-km so unrelated re-renders
// (e.g. toggling a ☕ elsewhere) don't wipe half-typed text; only a new click
// rebuilds it.
/**
 * The day's climb, or nothing when there is no elevation data.
 *
 * This is the line that answers "how hard is this day" — the strip's profile shows
 * *where* it gets hard, which is a different question and belongs on the axis.
 *
 * The ≈ is not decoration. Cumulative ascent derived from a DEM is an artefact of
 * the sampling interval: this profile is sampled every 250 m against data accurate
 * to a few metres, and only runs clearing a 5 m threshold are counted, so the figure
 * is a fair comparison between days rather than a number to quote.
 */
function climbMarkup(climb) {
  if (!climb || !Number.isFinite(climb.ascentM)) return '';
  const title =
    'Approximate: sampled every 250 m from a 90 m surface model, counting only rises ' +
    'and falls of more than 5 m. A surface model measures the top of what stands on ' +
    'the ground, so buildings and tree cover add climb the road does not have. Good ' +
    'for comparing one day against another, not for quoting.';
  return `<div class="day-panel__climb" title="${esc(title)}">
            <span class="day-panel__climb-up">↑ ${Math.round(climb.ascentM)} m</span>
            <span class="day-panel__climb-down">↓ ${Math.round(climb.descentM)} m</span>
            <span class="day-panel__climb-approx" aria-hidden="true">≈</span>
          </div>`;
}

function renderCustomStopPrompt(draft, day, trip, callbacks, promptEl) {
  if (!draft || !day) {
    promptEl.hidden = true;
    promptEl.innerHTML = '';
    delete promptEl.dataset.km;
    return;
  }
  // Keyed on the ABSOLUTE km, which is the click's identity — two different trips
  // could otherwise agree on a rider km and inherit each other's half-typed label.
  if (promptEl.dataset.km === String(draft.km)) {
    // Same click target; only the day's start may have shifted (an earlier
    // boundary moving drags it) — refresh the title, keep typed text.
    promptEl.querySelector('.custom-stop__title').textContent =
      `New stop at km ${round1(trip.tripKm(draft.km))} (${round1(rideKm(trip, day.startKm, draft.km))} km into the day)`;
    return;
  }
  promptEl.dataset.km = String(draft.km);
  promptEl.innerHTML = `
    <div class="custom-stop">
      <div class="custom-stop__title">New stop at km ${round1(trip.tripKm(draft.km))}
        (${round1(rideKm(trip, day.startKm, draft.km))} km into the day)</div>
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

  // What the panel holds focus on, resolved to something that will still exist
  // after render's innerHTML write destroys the node itself. Without this every
  // control costs a keyboard user a fresh Tab journey through the document:
  // ‹ › re-render, so does committing a distance, and the stepper is this panel's
  // only reachable path to a day too short to grab in the strip.
  //
  // The panel's own controls are unique within it, so data-action identifies
  // them. A leg's buttons repeat, so those carry their position among the legs
  // instead of their break key: the key of a break that was just removed matches
  // nothing, while the position is taken over by whichever leg slid into it.
  //
  // The crossing rows repeat the same way, and press the same disappearing act:
  // taking a crossing turns its row into a leg above, so the id that was focused
  // matches nothing afterwards while the position is taken by the next crossing down.
  const repeated = (selector) =>
    [...el.querySelectorAll(`.day-card__leg ${selector}, .day-crossings__row ${selector}`)];

  function focusedTarget() {
    const active = document.activeElement;
    if (!active || !el.contains(active)) return null;
    // The prompt survives a render verbatim, so its own nodes are the target —
    // input, Add and Cancel alike.
    if (promptEl.contains(active)) return { node: active };
    if (active.matches('[data-day-distance]')) return { selector: '[data-day-distance]' };
    // The inline leg editor's input is the one control with no [data-action] of
    // its own, so it used to be the only one that dropped focus on <body>. A
    // re-render discards the editor either way (see startBreakEdit), so focus goes
    // back to the ✎ that opened it — which is where the user was.
    const control =
      active.closest('[data-action]') ??
      active.closest('.day-card__leg')?.querySelector('[data-action="edit-break"]');
    if (!control) return null;
    const selector = `[data-action="${control.dataset.action}"]`;
    const siblings = repeated(selector);
    const at = siblings.indexOf(control);
    return at === -1 ? { selector } : { selector, at };
  }

  // preventScroll: the panel sits in a height:100vh, overflow:hidden body, and
  // scrolling it to "reveal" a control shoves the whole app off screen.
  function restoreFocus(target) {
    if (!target) return;
    if (target.node) {
      // The containment check is belt and braces: the only nodes reaching here are
      // the prompt's, and the prompt is moved back into `el` before this runs. No
      // test covers the false branch because no gesture reaches it.
      if (el.contains(target.node)) target.node.focus({ preventScroll: true });
      return;
    }
    if (target.at === undefined) {
      const node = el.querySelector(target.selector);
      if (node && !node.disabled) {
        node.focus({ preventScroll: true });
        return;
      }
      // Walking ‹ ›  to either end disables the button being pressed, and a
      // disabled node can't hold focus — so hand it to the twin, which by
      // definition is the way back. Only the stepper: the other controls' nearest
      // neighbour is "Delete day", which is nowhere to land focus by accident.
      const twin = STEPPER_TWIN[target.selector];
      const back = twin && el.querySelector(twin);
      if (back && !back.disabled) back.focus({ preventScroll: true });
      return;
    }
    const siblings = repeated(target.selector);
    siblings[Math.min(target.at, siblings.length - 1)]?.focus({ preventScroll: true });
  }

  // Each leg is a distance RIDDEN from the last stop, so the arithmetic runs in rider
  // km: absolute differences come out negative on a downstream trip, which turned
  // every leg into the "at the start" case below.
  function legs(day, breaks, trip, dayCrossings) {
    // A crossing the rider rides — chosen, or forced on them where the alt bank runs
    // out — is an entry in the day beside its breaks, ordered with them by km.
    //
    // The range guard is not defensive noise. main.js gets these from
    // crossingsBetween(day.startKm, day.endKm), so it can pass nothing outside the
    // day; but render() is a public contract, and a crossing outside the day would
    // not merely print a nonsense distance — it takes over prevKm, so every leg after
    // it AND the ride to the overnight town would be measured from a point this day
    // never reaches. Rider km on both sides: the comparison inverts in absolute km on
    // a downstream trip, where the day's end is the SMALLER number.
    const dayStart = trip.tripKm(day.startKm);
    const dayEnd = trip.tripKm(day.endKm);
    const crossingLegs = dayCrossings
      .filter((c) => c.chosen || c.implicit)
      .filter((c) => {
        const km = trip.tripKm(c.kmCanonical);
        return km >= dayStart && km <= dayEnd;
      })
      .map((c) => ({ __crossing: true, ...c, routeDistanceKm: c.kmCanonical }));
    // Sort is stable (ES2019), and the breaks are concatenated first, so a break and
    // a crossing on one km read as "stop, then cross" — the order a rider taking a
    // coffee at the bridgehead does them in.
    const entries = [...breaks, ...crossingLegs].sort(
      (a, b) => trip.tripKm(a.routeDistanceKm) - trip.tripKm(b.routeDistanceKm),
    );
    const lines = [];
    let prevKm = day.startKm;
    for (const entry of entries) {
      const legKm = round1(rideKm(trip, prevKm, entry.routeDistanceKm));
      // prevKm is still identically day.startKm until the first entry moves it, which
      // is exactly "nothing has been ridden yet" — no epsilon needed, and no second
      // copy of the day's own start line.
      const dist = legDistance(legKm, prevKm === day.startKm);
      prevKm = entry.routeDistanceKm;
      if (entry.__crossing) {
        lines.push(crossingLeg(entry, dist));
        continue;
      }
      const glyph = glyphFor(entry);
      const note = entry.note ? ` <span class="day-card__leg-note">· ${esc(entry.note)}</span>` : '';
      lines.push(`
        <li class="day-card__leg">
          <span class="day-card__leg-text">${dist} ${glyph} ${esc(entry.name)}${note}</span>
          <span class="leg-actions">
            ${breakEditButton(entry)}
            <button type="button" class="row-remove" data-action="remove-break"
                    data-break-key="${esc(poiKey(entry))}" title="Remove break" aria-label="Remove break">×</button>
          </span>
        </li>`);
    }
    const finalKm = round1(rideKm(trip, prevKm, day.endKm));
    const endName = day.townChoice ? esc(day.townChoice.name) : 'day end';
    // The twin of the `at the start` guard above: ☕-ing the overnight town itself
    // puts a break exactly at the day's end, and the ride from there is a bare
    // "0 km →" that reads as a bug. Say where it is instead.
    const finalDist =
      finalKm <= 0
        ? '<span class="day-card__leg-dist">at the day end</span>'
        : `<span class="day-card__leg-dist">${finalKm} km</span> →`;
    lines.push(`
      <li class="day-card__leg day-card__leg--end">
        <span class="day-card__leg-text">${finalDist} 🛏 ${endName}</span>
      </li>`);
    return `<ol class="day-card__legs">${lines.join('')}</ol>`;
  }

  function overnight(day, trip) {
    if (!day.townChoice) {
      return `<span class="day-panel__overnight-name day-panel__overnight-name--none">none chosen</span>
              <span class="day-panel__hint">pick one from the left, or drag the pin on the map</span>`;
    }
    const town = day.townChoice;
    const offset =
      typeof town.offsetKm === 'number' ? ` · ${round1(town.offsetKm)} km off route` : '';
    return `<span class="day-panel__overnight-name">🛏 ${esc(town.name)}</span>
            <span class="day-panel__hint">km ${round1(trip.tripKm(day.endKm))}${offset}</span>`;
  }

  // The boundary clamps at MIN_DAY_KM from its neighbour, so a town very close
  // to the next overnight can't be reached exactly. Say so rather than showing a
  // day length that silently disagrees with the town's position.
  //
  // The gap is measured with Math.abs on absolute km — a tolerance, not a number on
  // screen, and it is the same size whichever way the trip runs. Only the two km it
  // names are converted.
  function snapNote(day, trip) {
    const km = day.townChoice?.routeDistanceKm;
    if (typeof km !== 'number' || Math.abs(km - day.endKm) <= SNAP_EPSILON_KM) return '';
    return `<p class="day-panel__snap-note">${esc(day.townChoice.name)} sits at km ${round1(trip.tripKm(km))};
      this day ends at km ${round1(trip.tripKm(day.endKm))}.</p>`;
  }

  // dayCount defaults to 0 rather than being required: without it a caller that
  // forgets it renders "3 of undefined" in the stepper, and `2 >= NaN` is false —
  // so `›` stays enabled past the end of the plan. Zero fails safe (both
  // disabled) and is visibly wrong rather than quietly wrong.
  function render({
    day,
    trip,
    dayCount = 0,
    breaks = [],
    // path.crossingsBetween(day.startKm, day.endKm), verbatim: every crossing this
    // day rides past, annotated with whether the rider took it (`chosen`), whether
    // the alt bank running out forces it on them (`implicit`), and whether pressing
    // it would leave them with nowhere to ride (`canCross`).
    dayCrossings = [],
    fromName = 'your last stop',
    customStopDraft = null,
    // Whether the focused day owns the draft's km — itinerary.dayOwnsKm's answer, from
    // main.js. See draftForDay.
    draftOnDay = false,
    climb = null,
    // The trip's two ends, named and armed. main.js resolves the names from the road's
    // towns; null is a real answer (an end in open country has no name), which is why
    // these default to null rather than to a string. `picking` is the end a click on the
    // map would move, or null — the same shape the strip's own controls take.
    startName = null,
    destinationName = null,
    picking = null,
  }) {
    // The header above says there is no fallback for a missing trip; this is what makes
    // that true rather than incidental. Without it the empty-plan branch below returns
    // before touching the trip, so a caller that forgot it renders cleanly and only
    // fails once the plan has a day — one render later, somewhere else.
    if (!trip || typeof trip.tripKm !== 'function') {
      throw new Error('day panel render needs a trip (see createTrip in src/trip.js)');
    }
    current = { day, dayCount };
    const focusTarget = focusedTarget();
    if (!day) {
      // A plan with no days is not an empty plan — storage gives every plan a real
      // window — so this is not an empty state, it is where the trip gets set (spec §6a,
      // ruled 2026-08-01). ONE state, not the two §6a sketched: there is no "not set" an
      // end can be in, so the step shows the ends it already has, named, and keeps its
      // route to a first day throughout. A rider happy with the whole road can ignore
      // every word of it and press "+ add a first day".
      //
      // The km here are ABSOLUTE and say so — `of the road` is the whole point of the
      // line. These two controls are the one place where where-on-the-road is the
      // question being asked, and a trip-relative km would answer it with "km 0" for
      // every start ever picked.
      //
      // That first-day button is deliberately redundant with the strip's own "+ add a
      // day". Both of the strip's affordances are in the strip, so anything that makes
      // the strip unreachable — a window whose bottom edge sits under the taskbar, a
      // projector cropping the page — left the app with NO route to a first day and
      // nothing to do but resize. One button here keeps it recoverable.
      el.innerHTML = `
        <div class="day-panel day-panel--empty">
          <h2 class="day-panel__title">Where are you riding?</h2>
          <dl class="trip-setup">
            <div class="trip-setup__row">
              <dt>Start</dt>
              <dd>${esc(startName ?? 'anywhere on the road')}<span class="day-panel__hint">km ${round1(trip.startKm)} of the road</span></dd>
              <button type="button" class="btn btn--sm" data-action="set-start"
                      aria-pressed="${picking === 'start'}">Set start</button>
            </div>
            <div class="trip-setup__row">
              <dt>Finish</dt>
              <dd>${esc(destinationName ?? 'anywhere on the road')}<span class="day-panel__hint">km ${round1(trip.destinationKm)} of the road</span></dd>
              <button type="button" class="btn btn--sm" data-action="set-finish"
                      aria-pressed="${picking === 'destination'}">Set finish</button>
            </div>
          </dl>
          <p class="trip-setup__headline">${tripHeadline(trip, { startName, destinationName })}</p>
          <p class="day-panel__hint">Both ends default to the whole road, so you can skip this and
            just add a day. Click the strip below to pick where day 1 ends — or add one here and
            drag its boundary afterwards.</p>
          <div class="day-panel__actions">
            <button type="button" class="btn btn--sm btn--primary" data-action="add-day">+ add a first day</button>
          </div>
        </div>`;
      // A draft stop needs a day to belong to, so a plan with no days discards it
      // rather than parking typed text where it can never be added.
      renderCustomStopPrompt(null, null, trip, callbacks, promptEl);
      // The setup step has controls now, and pressing one re-renders. Without this a
      // keyboard user has to Tab back to `Set start` to press it a second time — which
      // is the documented way to cancel.
      restoreFocus(focusTarget);
      return;
    }
    // The distance RIDDEN, which is what the Distance field edits (editDay takes a
    // length) and what the split threshold compares. `endKm - startKm` is its negation
    // on a downstream trip: a "-105" the number input refuses, and a split button
    // disabled on every day of the plan.
    const length = round1(rideKm(trip, day.startKm, day.endKm));
    const canSplit = length >= 2 * MIN_DAY_KM;
    // Rider km on both sides, and the predicate is "does this day already end where the
    // trip does". In absolute km the comparison inverts downstream — `day.endKm >=
    // trip.destinationKm` is true for every day of such a trip, disabling the button
    // across the whole plan. In rider km the day's end and the trip's length are two
    // distances from one origin, which is the same question whichever way the trip runs.
    // `>=` rather than `===`: days clamp AT the destination, so nothing can exceed the
    // length, and the rounding is what makes a boundary a few centimetres short of it
    // still count as arrived.
    const atFinish = round1(trip.tripKm(day.endKm)) >= round1(trip.lengthKm);
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
        <div class="day-panel__from">from ${esc(fromName)} · km ${round1(trip.tripKm(day.startKm))} → ${round1(trip.tripKm(day.endKm))}</div>
        ${climbMarkup(climb)}

        <label class="day-panel__field">
          <span>Distance</span>
          <input type="number" min="${MIN_DAY_KM}" step="1" value="${length}" data-day-distance
                 aria-label="Day ${day.index + 1} distance in km" /> km
        </label>

        <div class="day-panel__field day-panel__overnight">
          <span>Overnight</span>
          ${overnight(day, trip)}
        </div>
        ${snapNote(day, trip)}

        <h3 class="day-panel__section">Legs <span class="pois__count">${length} km total</span></h3>
        ${legs(day, breaks, trip, dayCrossings)}
        ${crossingsGroup(dayCrossings)}

        <div data-custom-stop-slot></div>
        <p class="day-panel__hint">Click the route on the map to add a stop to this day.</p>
        <div class="day-panel__actions">
          <button type="button" class="btn btn--sm" data-action="finish-here" ${atFinish ? 'disabled' : ''}
                  title="${atFinish ? 'This day already ends at your finish' : `Finish the trip at km ${round1(trip.tripKm(day.endKm))}, dropping any later days`}">Finish here</button>
          <button type="button" class="btn btn--sm" data-action="split-day" ${canSplit ? '' : 'disabled'}
                  title="${canSplit ? 'Split this day in two' : `Too short to split (needs ${2 * MIN_DAY_KM} km)`}">Split day</button>
          <button type="button" class="btn btn--sm btn--danger" data-action="delete-day">Delete day</button>
        </div>
      </div>`;
    el.querySelector('[data-custom-stop-slot]').replaceWith(promptEl);
    restoreFocus(focusTarget);
    // Built after the innerHTML swap so the prompt's own listeners survive it,
    // and so its input is focusable — it is in the document by now. After
    // restoreFocus, too: a draft the user has just opened is a request for the
    // prompt, and focusing its input outranks putting focus back where it was.
    renderCustomStopPrompt(draftForDay(customStopDraft, day, draftOnDay), day, trip, callbacks, promptEl);
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
    // Above the `!current.day` guard with the break actions: a crossing id is
    // self-contained, so neither of these needs the focused day's index.
    const addCrossing = e.target.closest('[data-action="add-crossing"]');
    if (addCrossing) return callbacks.onAddCrossing?.(addCrossing.dataset.crossingId);
    const removeCrossing = e.target.closest('[data-action="remove-crossing"]');
    if (removeCrossing) return callbacks.onRemoveCrossing?.(removeCrossing.dataset.crossingId);
    // The trip-setup step's own controls, so they have to run before the guard below —
    // there is no focused day when that step is the only thing on screen, and everything
    // past the guard reads `current.day.index`.
    if (e.target.closest('[data-action="add-day"]')) return callbacks.onAddDay?.();
    if (e.target.closest('[data-action="set-start"]')) return callbacks.onPickEnd?.('start');
    if (e.target.closest('[data-action="set-finish"]')) return callbacks.onPickEnd?.('destination');
    if (!current.day) return;
    const index = current.day.index;
    if (e.target.closest('[data-action="finish-here"]')) return callbacks.onFinishHere?.(index);
    if (e.target.closest('[data-action="split-day"]')) return callbacks.onSplitDay?.(index);
    if (e.target.closest('[data-action="delete-day"]')) return callbacks.onDeleteDay?.(index);
    if (e.target.closest('[data-action="focus-prev"]')) return callbacks.onFocusDay?.(index - 1);
    if (e.target.closest('[data-action="focus-next"]')) return callbacks.onFocusDay?.(index + 1);
  });

  return { render };
}
