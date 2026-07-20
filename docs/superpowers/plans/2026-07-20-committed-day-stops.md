# Committed-Day Secondary Stops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Michel add labeled secondary stops (lunch, café, viewpoint, free-text "2h at the top") to *already committed* days, per `docs/superpowers/specs/2026-07-20-committed-day-stops-design.md`.

**Architecture:** A `selectedDayIndex` state in main.js re-points the existing "On the way" panel + map POI markers at a committed day's km range (day mode). Breaks stay plan-level and km-bucketed (no schema change); they gain an optional `note` field and a `kind: 'custom'` variant whose `name` is the user's label, created by clicking the route in day mode. A new `itinerary.updateBreak` supports inline ✎ editing of notes/labels.

**Tech Stack:** Vite + vanilla JS, Leaflet (map.js only), Turf (route.js only), vitest. No new dependencies.

**Task order:** Tasks 1–4 touch disjoint files and can run in parallel. Tasks 5→6→7 are sequential (5 and 6 both edit `src/ui.js`, 7 wires them in `src/main.js`). Task 8 is final verification + push.

**Conventions that must not break:** break identity is `name@km` (`breakKey`/`poiKey`); favorites keys are kind-prefixed `kind:name@km`; day bucketing is `(startKm, endKm]` with the lower bound widened to −1 when `startKm === 0`. Locked by existing tests.

---

### Task 1: itinerary.js — `note` field + `updateBreak`

**Files:**
- Modify: `src/itinerary.js`
- Test: `src/itinerary.test.js`

The `note` field already survives `addBreak`/`hydrate` (both spread `{ ...place }`) — the tests lock that in. `updateBreak` is new.

- [ ] **Step 1: Write the failing tests**

Append to `src/itinerary.test.js` (uses the existing `makeBreak` helper and `breakKey` import at the top of the file):

```js
describe('createItinerary - break notes & custom stops', () => {
  it('keeps note and custom kind through addBreak/getBreaks', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ note: '15 min coffee' }));
    itinerary.addBreak({ kind: 'custom', name: 'lunch, 2h at the top', routeDistanceKm: 55.5, lat: 53.1, lng: 10.2 });

    const breaks = itinerary.getBreaks();
    expect(breaks[0].note).toBe('15 min coffee');
    expect(breaks[1]).toMatchObject({ kind: 'custom', name: 'lunch, 2h at the top' });
  });

  it('keeps note through a hydrate round-trip', () => {
    const a = createItinerary({ totalKm: TOTAL_KM });
    a.addDay(80);
    a.addBreak(makeBreak({ note: 'try the cake' }));

    const b = createItinerary({ totalKm: TOTAL_KM });
    b.hydrate({ days: a.getDays().map((d) => ({ targetKm: d.targetKm })), breaks: a.getBreaks() });

    expect(b.getBreaks()[0].note).toBe('try the cake');
  });
});

describe('createItinerary - updateBreak', () => {
  it('sets a note without changing the key or order', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'A', routeDistanceKm: 10 }));
    itinerary.addBreak(makeBreak({ name: 'B', routeDistanceKm: 20 }));

    const newKey = itinerary.updateBreak('A@10', { note: 'coffee' });

    expect(newKey).toBe('A@10');
    expect(itinerary.getBreaks().map((b) => b.name)).toEqual(['A', 'B']);
    expect(itinerary.getBreaks()[0].note).toBe('coffee');
  });

  it('clears the note when given an empty string', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ note: 'old' }));
    const key = breakKey(itinerary.getBreaks()[0]);

    itinerary.updateBreak(key, { note: '' });

    expect('note' in itinerary.getBreaks()[0]).toBe(false);
  });

  it('renames a break and returns the new key', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    const newKey = itinerary.updateBreak('lunch@30', { name: 'lunch, 2h' });

    expect(newKey).toBe('lunch, 2h@30');
    expect(itinerary.getBreaks()[0].name).toBe('lunch, 2h');
  });

  it('returns null and changes nothing for an unknown key', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak(makeBreak({ name: 'A', routeDistanceKm: 10 }));

    expect(itinerary.updateBreak('nope@99', { note: 'x' })).toBeNull();
    expect(itinerary.getBreaks()).toHaveLength(1);
    expect('note' in itinerary.getBreaks()[0]).toBe(false);
  });

  it('returns null for an empty or whitespace-only name', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    expect(itinerary.updateBreak('lunch@30', { name: '   ' })).toBeNull();
    expect(itinerary.getBreaks()[0].name).toBe('lunch');
  });

  it('returns null when a rename collides with an existing break', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak({ kind: 'custom', name: 'X', routeDistanceKm: 30, lat: 53, lng: 10 });
    itinerary.addBreak({ kind: 'custom', name: 'Y', routeDistanceKm: 30, lat: 53, lng: 10 });

    expect(itinerary.updateBreak('X@30', { name: 'Y' })).toBeNull();
    expect(itinerary.getBreaks().map((b) => b.name).sort()).toEqual(['X', 'Y']);
  });

  it('trims the new name before applying it', () => {
    const itinerary = createItinerary({ totalKm: TOTAL_KM });
    itinerary.addBreak({ kind: 'custom', name: 'lunch', routeDistanceKm: 30, lat: 53, lng: 10 });

    expect(itinerary.updateBreak('lunch@30', { name: '  picnic  ' })).toBe('picnic@30');
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npx vitest run src/itinerary.test.js`
Expected: the two `break notes` tests PASS (spread already preserves fields); every `updateBreak` test FAILS with `itinerary.updateBreak is not a function`.

- [ ] **Step 3: Implement `updateBreak`**

In `src/itinerary.js`, insert after the `removeBreak` function (after line 161):

```js
  // Edits a break in place: `note` (optional free text; empty string clears
  // it) and/or `name` (a custom stop's label — its identity, so the key can
  // change). Returns the updated break's key, or null for an unknown key, an
  // empty name, or a rename that would collide with another break (no-op).
  // routeDistanceKm is never patched, so order is preserved and no re-sort is
  // needed.
  function updateBreak(key, patch = {}) {
    const target = breaks.find((b) => breakKey(b) === key);
    if (!target) return null;
    const next = { ...target };
    if ('name' in patch) {
      const name = typeof patch.name === 'string' ? patch.name.trim() : '';
      if (!name) return null;
      next.name = name;
    }
    if ('note' in patch) {
      const note = typeof patch.note === 'string' ? patch.note.trim() : '';
      if (note) next.note = note;
      else delete next.note;
    }
    const nextKey = breakKey(next);
    if (nextKey !== key && breaks.some((b) => breakKey(b) === nextKey)) return null;
    breaks = breaks.map((b) => (breakKey(b) === key ? next : b));
    return nextKey;
  }
```

Add `updateBreak,` to the returned object (after `removeBreak,`), and add this line to the `@returns` JSDoc block of `createItinerary` (after the `removeBreak` line):

```
 *   updateBreak: (key: string, patch: {name?: string, note?: string}) => string|null,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/itinerary.test.js`
Expected: PASS (all, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/itinerary.js src/itinerary.test.js
git commit -m "feat: break notes + updateBreak in itinerary model"
```

---

### Task 2: storage — regression test for note/custom round-trip

**Files:**
- Test: `src/storage.test.js`

`normalizePlan` already passes break objects through untouched; this test locks that in so a future "normalize breaks" change can't silently drop `note`/`kind: 'custom'`. It is expected to pass immediately — it's a regression guard, not TDD red/green.

- [ ] **Step 1: Write the test**

Append to `src/storage.test.js` (uses the existing `createFakeStorage` helper):

```js
describe('createPlanStore - break notes & custom stops', () => {
  it('round-trips note and custom-kind break fields through save and reload', () => {
    const storage = createFakeStorage();
    const store = createPlanStore({ storage, routeVersion: 'r1' });
    store.load();

    const breaks = [
      { name: 'Café X', kind: 'food', routeDistanceKm: 42, lat: 53, lng: 10, note: '15 min coffee' },
      { name: 'lunch, 2h at the top', kind: 'custom', routeDistanceKm: 55.5, lat: 53.1, lng: 10.2 },
    ];
    store.saveActivePlan({ days: [{ targetKm: 80, townChoice: null }], breaks });

    const reloaded = createPlanStore({ storage, routeVersion: 'r1' });
    reloaded.load();
    expect(reloaded.getActivePlan().breaks).toEqual(breaks);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/storage.test.js`
Expected: PASS (documents existing pass-through behavior).

- [ ] **Step 3: Commit**

```bash
git add src/storage.test.js
git commit -m "test: lock break note/custom round-trip through plan storage"
```

---

### Task 3: towns.js — `townsInRange`

**Files:**
- Modify: `src/towns.js`
- Test: `src/towns.test.js`

Day mode lists towns *within* the day's stretch (unlike `townsNear`, which scores towns around a single endpoint).

- [ ] **Step 1: Write the failing tests**

In `src/towns.test.js`, change the import line to:

```js
import { loadTowns, townsNear, townsInRange } from './towns.js';
```

Append (uses the existing `TOWNS` fixture):

```js
describe('townsInRange', () => {
  test('returns towns with routeDistanceKm in [startKm, endKm], in km order', () => {
    const names = townsInRange(TOWNS, 40, 60).map((t) => t.name);
    expect(names).toEqual(['Millbrook', 'Ashford', 'Brambury', 'Craghill', 'Dunmoor']);
  });

  test('returns empty when no town falls in the range', () => {
    expect(townsInRange(TOWNS, 100, 110)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/towns.test.js`
Expected: FAIL — `townsInRange` is not exported.

- [ ] **Step 3: Implement**

Append to `src/towns.js`:

```js
// Towns whose routeDistanceKm falls inside [startKm, endKm] — the browse
// window for a committed day in day mode. `towns` is sorted ascending by
// routeDistanceKm, so the result stays in route order.
export function townsInRange(towns, startKm, endKm) {
  return towns.filter((t) => t.routeDistanceKm >= startKm && t.routeDistanceKm <= endKm);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/towns.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/towns.js src/towns.test.js
git commit -m "feat: townsInRange for day-mode browsing"
```

---

### Task 4: map.js — 📌 icon for custom stops

**Files:**
- Modify: `src/map.js`
- Modify: `src/style.css` (append)

No unit tests — map.js is Leaflet-only and verified by the Task 8 smoke test (repo convention).

- [ ] **Step 1: Replace the fixed `BREAK_ICON` with a per-kind factory**

In `src/map.js`, replace lines 62–70 (the `BREAK_ICON` const and its comment):

```js
// A committed break: ☕ (place stop) or 📌 (custom user-labeled stop) in a
// small bordered white circle. Sized between the numbered day pin (26px) and
// the POI dot (14px) so breaks read as secondary waypoints on the day.
function breakIcon(kind) {
  const custom = kind === 'custom';
  return L.divIcon({
    className: `break-marker${custom ? ' break-marker--custom' : ''}`,
    html: `<span class="break-marker__glyph">${custom ? '📌' : '☕'}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}
```

In `setBreakMarkers`, change `icon: BREAK_ICON,` to `icon: breakIcon(b.kind),`.

- [ ] **Step 2: Append the marker style**

Append to `src/style.css`:

```css
/* Custom (user-labeled) stop marker: 📌 with a blue ring, distinguishing it
   from the amber ☕ ring of a place break. */
.break-marker--custom .break-marker__glyph {
  border-color: #2563eb;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45), 0 0 0 3px rgba(37, 99, 235, 0.28);
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `npx vitest run`
Expected: all tests PASS (map.js has none; this catches accidental syntax errors via imports in other suites — note vitest doesn't import map.js, so also run `npx vite build` and expect a successful build).

- [ ] **Step 4: Commit**

```bash
git add src/map.js src/style.css
git commit -m "feat: distinct map icon for custom stops"
```

---

### Task 5: ui.js — day-mode controls + custom-stop prompt + Esc

**Files:**
- Modify: `src/ui.js`
- Modify: `src/style.css` (append)

New callbacks used here (wired to real handlers in Task 7): `onExitDayMode()`, `onAddCustomStop(label)`, `onCancelCustomStop()`.

- [ ] **Step 1: Wrap the pending controls and add the day-mode block**

In `createUI`, replace the `controlsEl.innerHTML = ...` template (currently lines 116–131) with:

```js
  controlsEl.innerHTML = `
    <div id="pending-block">
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
      <div class="controls__breaks" id="pending-breaks"></div>
    </div>
    <div id="day-mode" hidden>
      <h2 class="controls__heading" id="day-mode-heading"></h2>
      <p class="day-mode__hint">Hit ☕ on any place below, or click the route on the map to add your own stop.</p>
      <div id="custom-stop-prompt" hidden></div>
      <button type="button" id="day-mode-done" class="btn btn--primary">Done</button>
    </div>`;
```

Below the existing element lookups (`heading`, `pendingBreaksEl`, …) add:

```js
  const pendingBlock = controlsEl.querySelector('#pending-block');
  const dayModeEl = controlsEl.querySelector('#day-mode');
  const dayModeHeading = controlsEl.querySelector('#day-mode-heading');
  const promptEl = controlsEl.querySelector('#custom-stop-prompt');
  const dayModeDone = controlsEl.querySelector('#day-mode-done');
```

- [ ] **Step 2: Wire Done and the document-level Esc**

After the existing `resetBtn.addEventListener(...)` block, add:

```js
  dayModeDone.addEventListener('click', () => callbacks.onExitDayMode?.());

  // Esc while in day mode: close the custom-stop prompt first if it's open,
  // otherwise leave day mode. The prompt input and the inline leg editors
  // stopPropagation on their own Esc, so they never double-trigger this.
  let escState = { dayMode: false, promptOpen: false };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !escState.dayMode) return;
    if (escState.promptOpen) callbacks.onCancelCustomStop?.();
    else callbacks.onExitDayMode?.();
  });
```

- [ ] **Step 3: Teach `renderControls` about day mode**

Replace the whole `renderControls` function with:

```js
  function renderControls({ dayNumber, startKm, reached, pendingBreaks = [], selectedDay = null, customStopDraft = null }) {
    escState = { dayMode: Boolean(selectedDay), promptOpen: Boolean(selectedDay && customStopDraft) };
    pendingBlock.hidden = Boolean(selectedDay);
    dayModeEl.hidden = !selectedDay;

    if (selectedDay) {
      dayModeHeading.textContent =
        `Adding stops to Day ${selectedDay.index + 1} (km ${round1(selectedDay.startKm)} → ${round1(selectedDay.endKm)})`;
      renderCustomStopPrompt(customStopDraft, selectedDay);
      return;
    }

    renderCustomStopPrompt(null, null);
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
```

- [ ] **Step 4: Add the custom-stop prompt renderer**

Add after `renderControls`:

```js
  // The "New stop at km K" prompt shown while a route click is pending a
  // label. Guarded by data-km so unrelated re-renders (e.g. toggling a ☕
  // elsewhere) don't wipe half-typed text; only a new click rebuilds it.
  function renderCustomStopPrompt(draft, selectedDay) {
    if (!draft || !selectedDay) {
      promptEl.hidden = true;
      promptEl.innerHTML = '';
      delete promptEl.dataset.km;
      return;
    }
    if (promptEl.dataset.km === String(draft.km)) return;
    promptEl.dataset.km = String(draft.km);
    promptEl.innerHTML = `
      <div class="custom-stop">
        <div class="custom-stop__title">New stop at km ${round1(draft.km)}
          (${round1(draft.km - selectedDay.startKm)} km into the day)</div>
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
        e.stopPropagation(); // handled here; must not also exit day mode
        callbacks.onCancelCustomStop?.();
      }
    });
    addBtn.addEventListener('click', () => callbacks.onAddCustomStop?.(input.value.trim()));
    promptEl.querySelector('#custom-stop-cancel')
      .addEventListener('click', () => callbacks.onCancelCustomStop?.());
    input.focus();
  }
```

- [ ] **Step 5: Optional towns heading**

Change the `renderTowns` signature's options to include a heading (used by day mode in Task 7):

```js
  function renderTowns(towns, selectedKey, { dayStartKm = 0, fromName = 'your last stop', breakKeys, favoriteKeys, heading: townsHeading = 'Overnight options' } = {}) {
```

and change the last line of the function to:

```js
    townsEl.innerHTML = `<h2 class="towns__heading">${esc(townsHeading)}</h2>${items}`;
```

- [ ] **Step 6: JSDoc + CSS**

Add to the `@param` callback list in the `createUI` JSDoc:

```
 * @param {() => void} opts.callbacks.onExitDayMode
 * @param {(label: string) => void} opts.callbacks.onAddCustomStop
 * @param {() => void} opts.callbacks.onCancelCustomStop
```

Append to `src/style.css`:

```css
/* --- Day mode (adding stops to a committed day) --------------------------- */
.day-mode__hint {
  margin: 8px 0 12px;
  font-size: 0.8rem;
  color: var(--text-dim);
}
.custom-stop {
  margin: 0 0 12px;
  padding: 10px 12px;
  background: var(--surface-hi);
  border: 1px solid var(--line);
  border-radius: 8px;
}
.custom-stop__title {
  font-size: 0.8rem;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.custom-stop__input {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--sans);
  font-size: 0.85rem;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 8px;
}
.custom-stop__input:focus-visible {
  outline: none;
  border-color: var(--river);
}
.custom-stop__actions {
  display: flex;
  gap: 8px;
}
```

- [ ] **Step 7: Verify + commit**

Run: `npx vitest run` — expected: all PASS (ui.js has no unit tests; suites that import nothing from ui.js stay green). Run `npx vite build` — expected: success.

```bash
git add src/ui.js src/style.css
git commit -m "feat: day-mode controls block with custom-stop prompt"
```

---

### Task 6: ui.js — day-card Add stops button, leg notes, ✎ inline editing

**Files:**
- Modify: `src/ui.js`
- Modify: `src/style.css` (append)

New callbacks used here (wired in Task 7): `onAddStops(dayIndex)`, `onEditBreak(key, value)`.

- [ ] **Step 1: Glyph + leg rendering with note and actions**

Change the `BREAK_GLYPH` const to:

```js
const BREAK_GLYPH = { food: '☕', sight: '📷', town: '🛏', custom: '📌' };
```

Replace the break-leg loop body inside `dayLegs` (the `lines.push(...)` for breaks, keeping the final overnight leg as is) with:

```js
    for (const b of dayBreaks) {
      const legKm = round1(b.routeDistanceKm - prevKm);
      const glyph = BREAK_GLYPH[b.kind] || '☕';
      const note = b.note ? ` <span class="day-card__leg-note">· ${esc(b.note)}</span>` : '';
      lines.push(`
        <li class="day-card__leg">
          <span class="day-card__leg-text"><span class="day-card__leg-dist">${legKm} km</span> → ${glyph} ${esc(b.name)}${note}</span>
          <span class="leg-actions">
            ${breakEditButton(b)}
            <button type="button" class="row-remove" data-action="remove-break"
                    data-break-key="${esc(poiKey(b))}" title="Remove break" aria-label="Remove break">×</button>
          </span>
        </li>`);
      prevKm = b.routeDistanceKm;
    }
```

Add the shared ✎ button builder near `rowActions`:

```js
  // ✎ on a break leg / pending-break row. For place breaks it edits the free
  // note; for custom stops it edits the label itself (= the break's name).
  function breakEditButton(b) {
    const isCustom = b.kind === 'custom';
    const label = isCustom ? 'Edit label' : 'Edit note';
    return `
      <button type="button" class="row-edit" data-action="edit-break"
              data-break-key="${esc(poiKey(b))}" data-break-kind="${esc(b.kind || 'town')}"
              data-break-name="${esc(b.name)}" data-break-note="${esc(b.note || '')}"
              title="${label}" aria-label="${label}: ${esc(b.name)}">✎</button>`;
  }
```

- [ ] **Step 2: The inline editor**

Add near `breakEditButton`:

```js
  // Swaps a leg's text for an inline input. Local DOM state only: saving
  // fires onEditBreak (main.js persists + re-renders); cancel restores the
  // original markup. `done` guards the blur that fires when a re-render (or
  // Enter/Esc) removes the input.
  function startBreakEdit(btn) {
    const row = btn.closest('.day-card__leg, .pending-break');
    if (!row || row.querySelector('.leg-edit__input')) return;
    const isCustom = btn.dataset.breakKind === 'custom';
    const textEl = row.querySelector('.day-card__leg-text, .pending-break__name');
    const original = textEl.innerHTML;
    const ariaLabel = isCustom ? 'Stop label' : 'Break note';
    textEl.innerHTML = `<input type="text" class="leg-edit__input" maxlength="120"
        aria-label="${ariaLabel}" placeholder="${isCustom ? 'Stop label' : 'e.g. 15 min coffee'}" />`;
    const input = textEl.querySelector('input');
    input.value = (isCustom ? btn.dataset.breakName : btn.dataset.breakNote) || '';
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      // A custom stop's label is its identity — refuse to blank it.
      if (save && callbacks.onEditBreak && (value || !isCustom)) {
        callbacks.onEditBreak(btn.dataset.breakKey, value);
      } else {
        textEl.innerHTML = original;
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Esc stays local (must not exit day mode)
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }
```

- [ ] **Step 3: Extend the two delegated click listeners**

Replace the `itineraryEl` click listener with:

```js
  itineraryEl.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-action="edit-break"]');
    if (edit) return startBreakEdit(edit);
    const addStops = e.target.closest('[data-action="add-stops"]');
    if (addStops) {
      callbacks.onAddStops?.(Number(addStops.dataset.dayIndex));
      return;
    }
    const btn = e.target.closest('[data-action="remove-break"]');
    if (!btn) return;
    if (callbacks.onRemoveBreak) callbacks.onRemoveBreak(btn.dataset.breakKey);
  });
```

Replace the `controlsEl` click listener (the remove-break one from line 175) with:

```js
  controlsEl.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-action="edit-break"]');
    if (edit) return startBreakEdit(edit);
    const btn = e.target.closest('[data-action="remove-break"]');
    if (!btn) return;
    if (callbacks.onRemoveBreak) callbacks.onRemoveBreak(btn.dataset.breakKey);
  });
```

- [ ] **Step 4: Pending-break rows get the ✎ too**

In `renderPendingBreaks`, replace the `<li class="pending-break">…</li>` template with:

```js
          <li class="pending-break">
            <span class="pending-break__name">${glyph} ${esc(b.name)}${b.note ? ` <span class="day-card__leg-note">· ${esc(b.note)}</span>` : ''}</span>
            <span class="pending-break__dist">${rel} km from start</span>
            <span class="leg-actions">
              ${breakEditButton(b)}
              <button type="button" class="row-remove" data-action="remove-break"
                      data-break-key="${esc(poiKey(b))}" title="Remove break" aria-label="Remove break">×</button>
            </span>
          </li>
```

- [ ] **Step 5: Day cards — selected state + Add stops button**

Change `renderItinerary`'s signature to:

```js
  function renderItinerary({ days, totalKm, reached, breaksForDay, selectedDayIndex = null }) {
```

Inside the `days.map` card builder, add before the `return`:

```js
        const isSelected = day.index === selectedDayIndex;
```

and replace the card's outer template with:

```js
        return `
          <div class="day-card${isFinish ? ' day-card--finish' : ''}${isSelected ? ' day-card--selected' : ''}">
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
            <button type="button" class="btn btn--sm day-card__add-stops${isSelected ? ' btn--primary' : ''}"
                    data-action="add-stops" data-day-index="${day.index}">
              ${isSelected ? 'Done adding stops' : '+ Add stops'}
            </button>
          </div>`;
```

- [ ] **Step 6: JSDoc + CSS**

Add to the `createUI` JSDoc callback list:

```
 * @param {(dayIndex: number) => void} opts.callbacks.onAddStops
 * @param {(key: string, value: string) => void} opts.callbacks.onEditBreak
```

Append to `src/style.css`:

```css
/* --- Committed-day stops: selected card, add button, leg editing ---------- */
.day-card--selected {
  border-color: rgba(91, 147, 255, 0.55);
  background: rgba(91, 147, 255, 0.07);
}
.day-card__add-stops {
  margin-top: 10px;
}
.leg-actions {
  flex: none;
  display: inline-flex;
  gap: 4px;
}
.row-edit {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 0.85rem;
  line-height: 1;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.row-edit:hover {
  border-color: var(--river);
  color: var(--river);
  background: rgba(91, 147, 255, 0.12);
}
.row-edit:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(91, 147, 255, 0.3);
}
.day-card__leg-note {
  color: var(--text-dim);
  font-style: italic;
}
.leg-edit__input {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--sans);
  font-size: 0.8rem;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--river);
  border-radius: 6px;
  padding: 3px 6px;
}
.leg-edit__input:focus-visible {
  outline: none;
}
```

- [ ] **Step 7: Verify + commit**

Run: `npx vitest run` — expected: all PASS. Run `npx vite build` — expected: success.

```bash
git add src/ui.js src/style.css
git commit -m "feat: add-stops button, leg notes and inline break editing on day cards"
```

---

### Task 7: main.js — day-mode state and wiring

**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: Imports and state**

Change the towns import to:

```js
import { loadTowns, townsNear, townsInRange } from './towns.js';
```

Under the `// --- Pending-day state` block, add:

```js
  // --- Day mode (adding stops to a committed day) ------------------------
  // Which committed day is being edited (null = normal pending planning) and
  // the route click awaiting a label ({km, lat, lng}). Not persisted.
  let selectedDayIndex = null;
  let customStopDraft = null;

  function selectedDay() {
    if (selectedDayIndex == null) return null;
    return itinerary.getDays()[selectedDayIndex] ?? null;
  }

  function exitDayMode() {
    selectedDayIndex = null;
    customStopDraft = null;
  }
```

- [ ] **Step 2: Register the new callbacks**

In the `createUI` callbacks object, after `onEditDay: handleEditDay,` add:

```js
      onAddStops: handleAddStops,
      onExitDayMode: handleExitDayMode,
      onAddCustomStop: handleAddCustomStop,
      onCancelCustomStop: handleCancelCustomStop,
      onEditBreak: handleEditBreak,
```

- [ ] **Step 3: Render day mode**

In `renderCommitted`, pass the selection through:

```js
    ui.renderItinerary({ days, totalKm, reached: hasReachedDresden(), breaksForDay, selectedDayIndex });
```

At the top of `renderPending`, add:

```js
    const dayForStops = selectedDay();
    if (dayForStops) return renderDayMode(dayForStops);
```

Add `renderDayMode` right after `renderPending`:

```js
  // Day mode: the same left panel + map markers as pending planning, but for
  // a committed day's stretch. Bucketing stays (start, end] — matching
  // breaksForDay — so every ☕ added here lands on the selected day's legs.
  function renderDayMode(day) {
    const breakKeys = new Set(itinerary.getBreaks().map(breakKey));
    const favoriteKeys = new Set(favorites.list().map(favKey));
    // Twin of ui.js dayFromName — same literals as pendingFromName.
    const fromName =
      day.index === 0 ? 'Hamburg' : itinerary.getDays()[day.index - 1].townChoice?.name ?? 'your last stop';

    ui.renderControls({
      dayNumber: day.index + 1,
      startKm: day.startKm,
      reached: hasReachedDresden(),
      pendingBreaks: [],
      selectedDay: day,
      customStopDraft,
    });

    map.setGhost(null);
    map.setTownHighlight(null);

    const dayTowns = townsInRange(towns, day.startKm, day.endKm);
    ui.renderTowns(dayTowns, null, {
      dayStartKm: day.startKm,
      fromName,
      breakKeys,
      favoriteKeys,
      heading: 'Towns on this stretch',
    });

    const food = poisInRange(poiData, day.startKm, day.endKm, { kind: 'food' });
    const sights = poisInRange(poiData, day.startKm, day.endKm, { kind: 'sight' });
    drawPois(food, sights, day.startKm, fromName, breakKeys, favoriteKeys);
  }
```

- [ ] **Step 4: The five new handlers**

Add after `handleEditDay`:

```js
  // + Add stops on a day card: enter day mode for that day; clicking the
  // selected day's own button (labeled "Done adding stops") exits instead.
  function handleAddStops(index) {
    if (selectedDayIndex === index) return handleExitDayMode();
    selectedDayIndex = index;
    customStopDraft = null;
    renderAll();
  }

  function handleExitDayMode() {
    exitDayMode();
    renderAll();
  }

  // Add-stop prompt confirmed: the draft becomes a plan-level custom break.
  function handleAddCustomStop(label) {
    const day = selectedDay();
    if (!day || !customStopDraft || !label) return;
    itinerary.addBreak({
      kind: 'custom',
      name: label,
      routeDistanceKm: customStopDraft.km,
      lat: customStopDraft.lat,
      lng: customStopDraft.lng,
    });
    customStopDraft = null;
    persistPlan();
    renderAll();
  }

  function handleCancelCustomStop() {
    customStopDraft = null;
    renderPending();
  }

  // ✎ save on a leg: custom stops edit their label (name = identity), place
  // breaks edit the free note. updateBreak returning null (stale key,
  // collision, blank name) is fine — the re-render restores canonical state.
  function handleEditBreak(key, value) {
    const target = itinerary.getBreaks().find((b) => breakKey(b) === key);
    if (target) {
      if (target.kind === 'custom') itinerary.updateBreak(key, { name: value });
      else itinerary.updateBreak(key, { note: value });
      persistPlan();
    }
    renderAll();
  }
```

- [ ] **Step 5: Route clicks in day mode**

Replace `handleRouteClick` with:

```js
  // Normal mode: clicking the map sets the pending distance so the day ends
  // at the clicked point. Day mode: a click inside the selected day's stretch
  // drafts a custom stop there (label prompt in the controls block); clicks
  // outside the stretch are ignored. Both snap to the route first.
  function handleRouteClick(lngLat) {
    const day = selectedDay();
    if (day) {
      const { distanceKm } = snap(route, lngLat);
      const km = Math.round(distanceKm * 10) / 10;
      const lower = day.startKm === 0 ? -1 : day.startKm; // same km-0 widening as breaksForDay
      if (km <= lower || km > day.endKm) return;
      const [lng, lat] = pointAtDistance(route, km);
      customStopDraft = { km, lat, lng };
      renderPending();
      return;
    }
    if (hasReachedDresden()) return;
    const { distanceKm } = snap(route, lngLat);
    const start = pendingStartKm();
    if (distanceKm <= start) return;
    pendingTarget = Math.round(distanceKm - start);
    pendingTown = null;
    ui.setPendingTarget(pendingTarget);
    renderPending();
  }
```

- [ ] **Step 6: Keep the selection valid**

In `hydrateActivePlan`, after `const active = store.getActivePlan();` add:

```js
    exitDayMode(); // a different plan's days — day-mode selection is stale
```

In `handleRemoveLast`, after `itinerary.removeLastDay();` add:

```js
    if (selectedDayIndex != null && selectedDayIndex >= itinerary.getDays().length) exitDayMode();
```

In `handleReset`, after `itinerary.reset();` add:

```js
    exitDayMode();
```

In `handleEditDay`, after `itinerary.editDay(index, target);` add:

```js
    // A resized day can strand the pending custom-stop draft outside the
    // selected day's stretch — drop the draft, keep day mode.
    const day = selectedDay();
    if (customStopDraft && day) {
      const lower = day.startKm === 0 ? -1 : day.startKm;
      if (customStopDraft.km <= lower || customStopDraft.km > day.endKm) customStopDraft = null;
    }
```

- [ ] **Step 7: Verify + commit**

Run: `npx vitest run` — expected: all PASS. Run `npx vite build` — expected: success.

```bash
git add src/main.js
git commit -m "feat: day mode — add secondary stops to committed days"
```

---

### Task 8: Full verification, smoke test, push

**Files:** none (verification only; fix-up commits if the smoke test finds bugs).

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all suites PASS (150 pre-existing + ~11 new).

- [ ] **Step 2: Manual smoke test in the running app**

Run `npm run dev`, open the served URL in a browser (Playwright browser tools work well), and verify:

1. Commit two days. Both day cards show **+ Add stops**.
2. Click **+ Add stops** on Day 1 → controls show "Adding stops to Day 1 (km 0 → …)", the left lists show that stretch (towns heading reads "Towns on this stretch"), map shows its POI markers, no ghost marker.
3. Toggle ☕ on a food POI → a leg appears on Day 1's card immediately; leg distances sum to the day's km.
4. Click the route inside Day 1's stretch → prompt "New stop at km …"; type "lunch, 2h at the top", Add → 📌 leg on the card + blue-ringed 📌 marker on the map.
5. Click the route *outside* the stretch → nothing happens.
6. ✎ on the food leg → type "15 min coffee", Enter → "· 15 min coffee" appears; ✎ on the 📌 leg → edit label, Enter → label updates. Esc while editing cancels (and does NOT leave day mode).
7. Esc with the prompt open closes just the prompt; Esc again leaves day mode; **Done** and the card's "Done adding stops" also leave it.
8. Shrink Day 1's target km so a stop falls beyond its end → the stop re-buckets onto Day 2's card.
9. Reload the page → stops and notes persisted. Switch plans → day mode exits cleanly.
10. Reset trip / Remove last day while in day mode → no crash, day mode exits when the day disappears.

- [ ] **Step 3: Push**

```bash
git push
```

Expected: pushed to github.com/MichelMerae/elberadweg-planner (Michel's convention: always push when a feature lands).
