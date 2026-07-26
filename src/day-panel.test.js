// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDayPanel } from './day-panel.js';
import { MIN_DAY_KM } from './boundaries.js';

let el;
let callbacks;

function mount() {
  el = document.createElement('div');
  document.body.appendChild(el);
  callbacks = {
    onEditDay: vi.fn(),
    onSplitDay: vi.fn(),
    onDeleteDay: vi.fn(),
    onFocusDay: vi.fn(),
    onRemoveBreak: vi.fn(),
    onEditBreak: vi.fn(),
    onAddCustomStop: vi.fn(),
    onCancelCustomStop: vi.fn(),
  };
  return createDayPanel({ el, callbacks });
}

const DAY = { index: 2, targetKm: 105, startKm: 160, endKm: 265, townChoice: { name: 'Rosenhof', routeDistanceKm: 265, offsetKm: 0.4 } };

function press(node, key) {
  node.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('createDayPanel - empty plan', () => {
  it('invites a first day', () => {
    const panel = mount();
    panel.render({ day: null, dayCount: 0, breaks: [], fromName: 'Hamburg' });
    expect(el.textContent).toContain('No days yet');
  });
});

describe('createDayPanel - header', () => {
  it('names the day, where it starts from, and its km range', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen (Elbe)' });

    expect(el.querySelector('.day-panel__title').textContent).toContain('Day 3');
    expect(el.textContent).toContain('from Lenzen (Elbe)');
    expect(el.textContent).toContain('km 160 → 265');
    expect(el.textContent).toContain('3 of 4');
  });

  it('escapes the previous overnight name', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: '<img src=x>' });
    expect(el.innerHTML).not.toContain('<img src=x>');
  });
});

describe('createDayPanel - distance', () => {
  it('shows the day length and reports a typed change', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const input = el.querySelector('[data-day-distance]');
    expect(input.value).toBe('105');
    input.value = '90';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(callbacks.onEditDay).toHaveBeenCalledWith(2, 90);
  });

  it('ignores a non-positive distance', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const input = el.querySelector('[data-day-distance]');
    input.value = '0';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(callbacks.onEditDay).not.toHaveBeenCalled();
  });

  // A cleared field and a negative are the two ways a real keyboard produces a
  // non-positive length; both must stay local rather than reach the model,
  // which throws on them.
  it('ignores a cleared or negative distance', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const input = el.querySelector('[data-day-distance]');
    for (const value of ['', '-5']) {
      input.value = value;
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    }

    expect(callbacks.onEditDay).not.toHaveBeenCalled();
  });

  it('quantizes a typed distance to the 0.1 km grid', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const input = el.querySelector('[data-day-distance]');
    input.value = '90.42';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(callbacks.onEditDay).toHaveBeenCalledWith(2, 90.4);
  });
});

describe('createDayPanel - overnight', () => {
  it('shows the chosen town and its off-route detour', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const overnight = el.querySelector('.day-panel__overnight').textContent;
    expect(overnight).toContain('Rosenhof');
    expect(overnight).toContain('0.4 km off route');
  });

  it('prompts when no town is chosen', () => {
    const panel = mount();
    panel.render({ day: { ...DAY, townChoice: null }, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    expect(el.querySelector('.day-panel__overnight').textContent).toContain('none chosen');
  });

  it('explains a boundary that could not reach the town', () => {
    const panel = mount();
    const day = { ...DAY, endKm: 263, townChoice: { name: 'Rosenhof', routeDistanceKm: 265 } };
    panel.render({ day, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const note = el.querySelector('.day-panel__snap-note').textContent;
    expect(note).toContain('km 265');
    expect(note).toContain('km 263');
  });

  // The note is an exception report. A town the boundary DID reach must not
  // carry one, or every day in a healthy plan shouts about nothing.
  it('stays silent when the boundary reached the town', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    expect(el.querySelector('.day-panel__snap-note')).toBeNull();
  });

  // A 0.1 km grid can't always land on a town's exact position, so a hair's
  // difference is not a failure to reach it.
  it('stays silent for a sub-grid difference', () => {
    const panel = mount();
    const day = { ...DAY, endKm: 265, townChoice: { name: 'Rosenhof', routeDistanceKm: 264.97 } };
    panel.render({ day, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    expect(el.querySelector('.day-panel__snap-note')).toBeNull();
  });

  it('escapes the town name in both the overnight line and the note', () => {
    const panel = mount();
    const day = { ...DAY, endKm: 263, townChoice: { name: '<img src=x>', routeDistanceKm: 265 } };
    panel.render({ day, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    expect(el.querySelector('.day-panel__snap-note').textContent).toContain('<img src=x>');
    expect(el.innerHTML).not.toContain('<img src=x>');
  });
});

describe('createDayPanel - legs', () => {
  const breaks = [
    { name: 'Café Elbterrasse', kind: 'food', routeDistanceKm: 195, note: '15 min coffee' },
    { name: 'Grenzturm', kind: 'sight', routeDistanceKm: 213 },
  ];

  it('lists legs as distance since the previous stop', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

    const legs = [...el.querySelectorAll('.day-card__leg')].map((li) => li.textContent.replace(/\s+/g, ' ').trim());
    expect(legs[0]).toContain('35 km');
    expect(legs[0]).toContain('Café Elbterrasse');
    expect(legs[0]).toContain('15 min coffee');
    expect(legs[1]).toContain('18 km');
    expect(legs[2]).toContain('52 km');
    expect(legs[2]).toContain('Rosenhof');
  });

  it('reads a break at the very start as "at the start"', () => {
    const panel = mount();
    const day = { index: 0, targetKm: 80, startKm: 0, endKm: 80, townChoice: null };
    panel.render({
      day,
      dayCount: 1,
      breaks: [{ name: 'Five Guys', kind: 'food', routeDistanceKm: 0 }],
      fromName: 'Hamburg',
    });

    const first = el.querySelector('.day-card__leg').textContent;
    expect(first).toContain('at the start');
    expect(first).not.toContain('0 km →');
  });

  it('removes a break', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

    el.querySelector('[data-action="remove-break"]').click();

    expect(callbacks.onRemoveBreak).toHaveBeenCalledWith('Café Elbterrasse@195');
  });

  // Each × must carry its own leg's key, not the first one's.
  it('removes the break whose × was clicked', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

    el.querySelectorAll('[data-action="remove-break"]')[1].click();

    expect(callbacks.onRemoveBreak).toHaveBeenCalledWith('Grenzturm@213');
  });

  // A break name reaches both a text position and four attributes, so the
  // payload carries a quote as well as a tag: unescaped, the tag would become an
  // element and the quote would truncate data-break-key and let the rest of the
  // name become attributes of the button. (innerHTML is no use as a whole-panel
  // assertion here — the serializer legitimately leaves < unescaped inside a
  // quoted attribute value.)
  it('escapes a break name and its note', () => {
    const panel = mount();
    const name = '<img src=x onerror="boom">';
    panel.render({
      day: DAY,
      dayCount: 4,
      breaks: [{ name, kind: 'food', routeDistanceKm: 195, note: '<b>bold</b>' }],
      fromName: 'Lenzen',
    });

    const text = el.querySelector('.day-card__leg-text');
    expect(text.textContent).toContain(name);
    expect(text.innerHTML).not.toContain('<img');
    expect(text.innerHTML).not.toContain('<b>bold</b>');
    expect(el.querySelectorAll('img')).toHaveLength(0);
    expect(el.querySelector('[data-action="remove-break"]').dataset.breakKey).toBe(`${name}@195`);
    expect(el.querySelector('[data-action="edit-break"]').dataset.breakName).toBe(name);
  });
});

// Moved here from ui.js with the legs they belong to: ✎ swaps a leg's text for
// an inline input. Local DOM state only — main.js never re-renders for a cancel.
describe('createDayPanel - editing a break inline', () => {
  const food = { name: 'Café Elbterrasse', kind: 'food', routeDistanceKm: 195, note: '15 min coffee' };
  const custom = { name: 'Picnic spot', kind: 'custom', routeDistanceKm: 200 };

  function openEditor(breaks = [food]) {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });
    el.querySelector('[data-action="edit-break"]').click();
    return el.querySelector('.leg-edit__input');
  }

  it('opens on the leg with the current note prefilled', () => {
    const input = openEditor();
    expect(input.value).toBe('15 min coffee');
  });

  it('reports a new note on Enter', () => {
    const input = openEditor();
    input.value = '20 min cake';
    press(input, 'Enter');

    expect(callbacks.onEditBreak).toHaveBeenCalledWith('Café Elbterrasse@195', '20 min cake');
  });

  it('restores the leg on Escape without reporting', () => {
    const input = openEditor();
    input.value = '20 min cake';
    press(input, 'Escape');

    expect(callbacks.onEditBreak).not.toHaveBeenCalled();
    expect(el.querySelector('.leg-edit__input')).toBeNull();
    expect(el.querySelector('.day-card__leg').textContent).toContain('15 min coffee');
  });

  // The load-bearing case: an unchanged value restores locally, so a plain blur
  // fires no callback and no re-render — and therefore can't swallow the click
  // the user was actually making somewhere else.
  it('restores locally when a blur leaves the note unchanged', () => {
    const input = openEditor();
    input.blur();

    expect(callbacks.onEditBreak).not.toHaveBeenCalled();
    expect(el.querySelector('.leg-edit__input')).toBeNull();
    expect(el.querySelector('.day-card__leg').textContent).toContain('15 min coffee');
  });

  it('edits a custom stop label rather than a note', () => {
    const input = openEditor([custom]);
    expect(input.value).toBe('Picnic spot');

    input.value = 'Lunch by the lock';
    press(input, 'Enter');

    expect(callbacks.onEditBreak).toHaveBeenCalledWith('Picnic spot@200', 'Lunch by the lock');
  });

  // A custom stop's label is its identity, so blanking it is refused rather
  // than persisted as a nameless pin.
  it('refuses to blank a custom stop label', () => {
    const input = openEditor([custom]);
    input.value = '   ';
    press(input, 'Enter');

    expect(callbacks.onEditBreak).not.toHaveBeenCalled();
    expect(el.querySelector('.day-card__leg').textContent).toContain('Picnic spot');
  });

  it('clears a note when emptied', () => {
    const input = openEditor();
    input.value = '';
    press(input, 'Enter');

    expect(callbacks.onEditBreak).toHaveBeenCalledWith('Café Elbterrasse@195', '');
  });
});

// Also moved from ui.js: the label prompt for a stop clicked on the map. It
// always targets the focused day now, so there is no day-mode selection to pass.
describe('createDayPanel - custom stop prompt', () => {
  it('is hidden with no draft', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    expect(el.querySelector('#custom-stop-prompt').hidden).toBe(true);
  });

  it('names the km clicked and how far into the day it falls', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 200 } });

    const title = el.querySelector('.custom-stop__title').textContent;
    expect(title).toContain('km 200');
    expect(title).toContain('40 km into the day');
  });

  it('reports the typed label, trimmed', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 200 } });

    const input = el.querySelector('#custom-stop-label');
    const addBtn = el.querySelector('#custom-stop-add');
    expect(addBtn.disabled).toBe(true);

    input.value = '  lunch  ';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(addBtn.disabled).toBe(false);
    addBtn.click();

    expect(callbacks.onAddCustomStop).toHaveBeenCalledWith('lunch');
  });

  it('cancels on Escape and on the Cancel button', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 200 } });

    press(el.querySelector('#custom-stop-label'), 'Escape');
    el.querySelector('#custom-stop-cancel').click();

    expect(callbacks.onCancelCustomStop).toHaveBeenCalledTimes(2);
  });

  // The panel rebuilds itself wholesale on every render, and a ☕ toggled in the
  // left panel re-renders it. Half-typed text must survive that: the prompt is
  // the same click target, so it keeps its node.
  it('keeps half-typed text through an unrelated re-render', () => {
    const panel = mount();
    const customStopDraft = { km: 200 };
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft });

    el.querySelector('#custom-stop-label').value = 'half typ';
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft });

    expect(el.querySelector('#custom-stop-label').value).toBe('half typ');
  });

  // ...but a NEW click is a new target, and must not inherit the old label.
  it('starts empty for a new click target', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 200 } });

    el.querySelector('#custom-stop-label').value = 'half typ';
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 210 } });

    expect(el.querySelector('#custom-stop-label').value).toBe('');
    expect(el.querySelector('.custom-stop__title').textContent).toContain('km 210');
  });

  it('refreshes the distance into the day when the day start moves', () => {
    const panel = mount();
    const customStopDraft = { km: 200 };
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft });
    panel.render({
      day: { ...DAY, startKm: 150 },
      dayCount: 4,
      breaks: [],
      fromName: 'Lenzen',
      customStopDraft,
    });

    expect(el.querySelector('.custom-stop__title').textContent).toContain('50 km into the day');
  });
});

describe('createDayPanel - day operations', () => {
  it('splits and deletes the focused day', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    el.querySelector('[data-action="split-day"]').click();
    expect(callbacks.onSplitDay).toHaveBeenCalledWith(2);

    el.querySelector('[data-action="delete-day"]').click();
    expect(callbacks.onDeleteDay).toHaveBeenCalledWith(2);
  });

  it('disables split on a day too short to split', () => {
    const panel = mount();
    const day = { index: 0, targetKm: 8, startKm: 0, endKm: 8, townChoice: null };
    panel.render({ day, dayCount: 1, breaks: [], fromName: 'Hamburg' });

    expect(el.querySelector('[data-action="split-day"]').disabled).toBe(true);
  });

  // The model splits at exactly 2 x MIN_DAY_KM (itinerary.splitDay refuses only
  // below it), so the button must not be one km more cautious than the model.
  it('allows a split at exactly two minimum days', () => {
    const panel = mount();
    const endKm = 2 * MIN_DAY_KM;
    panel.render({
      day: { index: 0, targetKm: endKm, startKm: 0, endKm, townChoice: null },
      dayCount: 1,
      breaks: [],
      fromName: 'Hamburg',
    });

    expect(el.querySelector('[data-action="split-day"]').disabled).toBe(false);
  });

  it('steps focus between days', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    el.querySelector('[data-action="focus-prev"]').click();
    expect(callbacks.onFocusDay).toHaveBeenCalledWith(1);

    el.querySelector('[data-action="focus-next"]').click();
    expect(callbacks.onFocusDay).toHaveBeenCalledWith(3);
  });

  it('disables the stepper at the ends', () => {
    const panel = mount();
    panel.render({
      day: { index: 0, targetKm: 80, startKm: 0, endKm: 80, townChoice: null },
      dayCount: 1,
      breaks: [],
      fromName: 'Hamburg',
    });

    expect(el.querySelector('[data-action="focus-prev"]').disabled).toBe(true);
    expect(el.querySelector('[data-action="focus-next"]').disabled).toBe(true);
  });

  // Every control reads the day from the LAST render, not the one it was built
  // with — the panel's listeners outlive its markup.
  it('acts on the newly focused day after a re-render', () => {
    const panel = mount();
    panel.render({ day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    panel.render({
      day: { index: 3, targetKm: 40, startKm: 265, endKm: 305, townChoice: null },
      dayCount: 4,
      breaks: [],
      fromName: 'Rosenhof',
    });

    el.querySelector('[data-action="delete-day"]').click();
    expect(callbacks.onDeleteDay).toHaveBeenCalledWith(3);
  });

  it('ignores day operations with no day in the panel', () => {
    const panel = mount();
    panel.render({ day: null, dayCount: 0, breaks: [] });

    expect(el.querySelector('[data-action="delete-day"]')).toBeNull();
    expect(callbacks.onDeleteDay).not.toHaveBeenCalled();
  });
});
