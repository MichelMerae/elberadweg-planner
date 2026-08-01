// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDayPanel } from './day-panel.js';
import { MIN_DAY_KM } from './boundaries.js';
import { createTrip } from './trip.js';

// The whole road ridden forwards: tripKm is the identity on it, so every km below is
// the number it always was. The oriented cases live in their own describe at the end.
const WHOLE_ROAD = createTrip({ startKm: 0, destinationKm: 650 });

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
    onAddDay: vi.fn(),
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

// Enter as a browser really delivers it: keydown, and then — unless the handler
// prevented the default — the click the browser synthesises against whatever holds
// focus WHEN THE DEFAULT ACTION RUNS, which is after the handler has had its say.
// That ordering is the whole point: a handler that moves focus to a button and
// does not preventDefault hands that button a click nobody asked for. jsdom fires
// neither half for the other, so both happen here by hand.
function pressEnter(node) {
  const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  node.dispatchEvent(event);
  const focused = document.activeElement;
  if (!event.defaultPrevented && focused?.matches?.('button')) focused.click();
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('createDayPanel - empty plan', () => {
  it('invites a first day', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: null, dayCount: 0, breaks: [], fromName: 'Hamburg' });
    expect(el.textContent).toContain('No days yet');
  });

  // Deliberately redundant with the strip's own button. Both of the strip's
  // affordances live in the strip, so a strip that cannot be reached (a window
  // whose bottom sits under the taskbar) left no route to a first day at all.
  it('offers its own route to a first day', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: null, dayCount: 0, breaks: [], fromName: 'Hamburg' });

    el.querySelector('[data-action="add-day"]').click();

    expect(callbacks.onAddDay).toHaveBeenCalledTimes(1);
  });

  // The stepper reads off dayCount, and without a default `render({ day })` shows
  // "3 of undefined" and leaves › enabled past the end of the plan, because
  // `2 >= NaN` is false.
  it('fails safe on a missing dayCount', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY });

    expect(el.textContent).not.toContain('undefined');
    expect(el.querySelector('[data-action="focus-next"]').disabled).toBe(true);
  });
});

describe('createDayPanel - without a trip', () => {
  // Every km this panel prints is counted from the rider's start, so a render with no
  // trip has no idea where km 0 is. Falling back to the road's origin would put a
  // plausible-looking wrong number on every line; the empty-plan branch would not even
  // notice. See the file header.
  it('refuses to render, with or without a day', () => {
    const panel = mount();

    expect(() => panel.render({ day: DAY, dayCount: 4, breaks: [] })).toThrow(/trip/);
    expect(() => panel.render({ day: null, dayCount: 0, breaks: [] })).toThrow(/trip/);
  });
});

describe('createDayPanel - header', () => {
  it('names the day, where it starts from, and its km range', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen (Elbe)' });

    expect(el.querySelector('.day-panel__title').textContent).toContain('Day 3');
    expect(el.textContent).toContain('from Lenzen (Elbe)');
    expect(el.textContent).toContain('km 160 → 265');
    expect(el.textContent).toContain('3 of 4');
  });

  it('escapes the previous overnight name', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: '<img src=x>' });
    expect(el.innerHTML).not.toContain('<img src=x>');
  });
});

describe('createDayPanel - distance', () => {
  it('shows the day length and reports a typed change', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const input = el.querySelector('[data-day-distance]');
    expect(input.value).toBe('105');
    input.value = '90';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(callbacks.onEditDay).toHaveBeenCalledWith(2, 90);
  });

  it('ignores a non-positive distance', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

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
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const input = el.querySelector('[data-day-distance]');
    for (const value of ['', '-5']) {
      input.value = value;
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    }

    expect(callbacks.onEditDay).not.toHaveBeenCalled();
  });

  it('quantizes a typed distance to the 0.1 km grid', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const input = el.querySelector('[data-day-distance]');
    input.value = '90.42';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));

    expect(callbacks.onEditDay).toHaveBeenCalledWith(2, 90.4);
  });
});

describe('createDayPanel - overnight', () => {
  it('shows the chosen town and its off-route detour', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const overnight = el.querySelector('.day-panel__overnight').textContent;
    expect(overnight).toContain('Rosenhof');
    expect(overnight).toContain('0.4 km off route');
  });

  it('prompts when no town is chosen', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: { ...DAY, townChoice: null }, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    expect(el.querySelector('.day-panel__overnight').textContent).toContain('none chosen');
  });

  it('explains a boundary that could not reach the town', () => {
    const panel = mount();
    const day = { ...DAY, endKm: 263, townChoice: { name: 'Rosenhof', routeDistanceKm: 265 } };
    panel.render({ trip: WHOLE_ROAD, day, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    const note = el.querySelector('.day-panel__snap-note').textContent;
    expect(note).toContain('km 265');
    expect(note).toContain('km 263');
  });

  // The note is an exception report. A town the boundary DID reach must not
  // carry one, or every day in a healthy plan shouts about nothing.
  it('stays silent when the boundary reached the town', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    expect(el.querySelector('.day-panel__snap-note')).toBeNull();
  });

  // A 0.1 km grid can't always land on a town's exact position, so a hair's
  // difference is not a failure to reach it.
  it('stays silent for a sub-grid difference', () => {
    const panel = mount();
    const day = { ...DAY, endKm: 265, townChoice: { name: 'Rosenhof', routeDistanceKm: 264.97 } };
    panel.render({ trip: WHOLE_ROAD, day, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    expect(el.querySelector('.day-panel__snap-note')).toBeNull();
  });

  it('escapes the town name in both the overnight line and the note', () => {
    const panel = mount();
    const day = { ...DAY, endKm: 263, townChoice: { name: '<img src=x>', routeDistanceKm: 265 } };
    panel.render({ trip: WHOLE_ROAD, day, dayCount: 4, breaks: [], fromName: 'Lenzen' });

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
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

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
    panel.render({ trip: WHOLE_ROAD,
      day,
      dayCount: 1,
      breaks: [{ name: 'Five Guys', kind: 'food', routeDistanceKm: 0 }],
      fromName: 'Hamburg',
    });

    const first = el.querySelector('.day-card__leg').textContent;
    expect(first).toContain('at the start');
    expect(first).not.toContain('0 km →');
  });

  // The twin of the guard above, and reachable the same easy way: ☕ the overnight
  // town itself and the ride from it to where you sleep is a bare "0 km →".
  it('reads a break exactly at the day end as "at the day end"', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD,
      day: DAY,
      dayCount: 4,
      breaks: [{ name: 'Rosenhof', kind: 'town', routeDistanceKm: 265 }],
      fromName: 'Lenzen',
    });

    const last = el.querySelector('.day-card__leg--end').textContent;
    expect(last).toContain('at the day end');
    expect(last).not.toContain('0 km');
  });

  it('removes a break', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

    el.querySelector('[data-action="remove-break"]').click();

    expect(callbacks.onRemoveBreak).toHaveBeenCalledWith('Café Elbterrasse@195');
  });

  // Each × must carry its own leg's key, not the first one's.
  it('removes the break whose × was clicked', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

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
    panel.render({ trip: WHOLE_ROAD,
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
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });
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

  // Found in Chromium during Task 14's manual pass, and only reachable through the
  // browser's own Enter: saving re-rendered the panel, focus was restored to this
  // leg's ✎, and the keydown's default action — resolved against whatever holds
  // focus once the handler returns — then synthesised a click on that button,
  // re-opening the editor over the note just saved.
  it('saves on Enter without the browser re-opening the editor', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [food], fromName: 'Lenzen' });
    // What main.js does with the save: persist, then re-render.
    callbacks.onEditBreak.mockImplementation(() => {
      panel.render({ trip: WHOLE_ROAD,
        day: DAY,
        dayCount: 4,
        breaks: [{ ...food, note: '20 min cake' }],
        fromName: 'Lenzen',
      });
    });
    el.querySelector('[data-action="edit-break"]').click();
    const input = el.querySelector('.leg-edit__input');
    input.value = '20 min cake';

    pressEnter(input);

    expect(callbacks.onEditBreak).toHaveBeenCalledWith('Café Elbterrasse@195', '20 min cake');
    expect(el.querySelector('.leg-edit__input')).toBeNull();
    expect(el.querySelector('.day-card__leg').textContent).toContain('20 min cake');
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
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    expect(el.querySelector('#custom-stop-prompt').hidden).toBe(true);
  });

  it('names the km clicked and how far into the day it falls', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 200 }, draftOnDay: true });

    const title = el.querySelector('.custom-stop__title').textContent;
    expect(title).toContain('km 200');
    expect(title).toContain('40 km into the day');
  });

  it('reports the typed label, trimmed', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 200 }, draftOnDay: true });

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
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 200 }, draftOnDay: true });

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
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft, draftOnDay: true });

    el.querySelector('#custom-stop-label').value = 'half typ';
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft, draftOnDay: true });

    expect(el.querySelector('#custom-stop-label').value).toBe('half typ');
  });

  // ...but a NEW click is a new target, and must not inherit the old label.
  it('starts empty for a new click target', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 200 }, draftOnDay: true });

    el.querySelector('#custom-stop-label').value = 'half typ';
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 210 }, draftOnDay: true });

    expect(el.querySelector('#custom-stop-label').value).toBe('');
    expect(el.querySelector('.custom-stop__title').textContent).toContain('km 210');
  });

  // A draft belongs to the day it was clicked on. Stepping to another day strands it:
  // "(-65 km into the day)" is nonsense, and confirming it would add the stop to the
  // day the user left. WHICH day owns a km is the model's question — main.js answers it
  // with itinerary.dayOwnsKm and hands the answer down as draftOnDay — so the cases
  // that rule decides (a km past the end, one exactly on the end, one on a later day's
  // start line, day 1's own start line) are pinned in itinerary.test.js. What is pinned
  // here is that the panel honours the answer, either way.
  it('ignores a draft the model says this day does not own', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD,
      day: { index: 3, targetKm: 40, startKm: 265, endKm: 305, townChoice: null },
      dayCount: 4,
      breaks: [],
      fromName: 'Rosenhof',
      customStopDraft: { km: 200 },
      draftOnDay: false,
    });

    expect(el.querySelector('#custom-stop-prompt').hidden).toBe(true);
    expect(el.querySelector('.custom-stop__title')).toBeNull();
  });

  it('measures a draft sitting exactly on the day end', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 265 }, draftOnDay: true });
    expect(el.querySelector('.custom-stop__title').textContent).toContain('105 km into the day');
  });

  it('measures a draft sitting on the first day’s start line', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD,
      day: { index: 0, targetKm: 80, startKm: 0, endKm: 80, townChoice: null },
      dayCount: 1,
      breaks: [],
      fromName: 'Hamburg',
      customStopDraft: { km: 0 }, draftOnDay: true,
    });

    const title = el.querySelector('.custom-stop__title').textContent;
    expect(title).toContain('New stop at km 0');
    expect(title).toContain('0 km into the day');
  });

  // The prompt node outlives the markup around it, so emptying the plan has to
  // clear it explicitly or a later day inherits the label typed for a deleted one.
  it('discards a typed label when the plan empties', () => {
    const panel = mount();
    const customStopDraft = { km: 200 };
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft, draftOnDay: true });
    el.querySelector('#custom-stop-label').value = 'half typ';

    panel.render({ trip: WHOLE_ROAD, day: null, dayCount: 0, breaks: [] });
    expect(el.querySelector('#custom-stop-prompt')).toBeNull(); // not in the empty panel at all

    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft, draftOnDay: true });
    expect(el.querySelector('#custom-stop-label').value).toBe('');
    expect(el.querySelector('#custom-stop-prompt').hidden).toBe(false);
  });

  it('refreshes the distance into the day when the day start moves', () => {
    const panel = mount();
    const customStopDraft = { km: 200 };
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft, draftOnDay: true });
    panel.render({ trip: WHOLE_ROAD,
      day: { ...DAY, startKm: 150 },
      dayCount: 4,
      breaks: [],
      fromName: 'Lenzen',
      customStopDraft,
      draftOnDay: true,
    });

    expect(el.querySelector('.custom-stop__title').textContent).toContain('50 km into the day');
  });
});

// Every control the panel offers triggers a re-render through main.js, and the
// re-render rebuilds the markup those controls live in. Without restoration
// document.activeElement is BODY afterwards: a keyboard user gets one Tab journey
// per day stepped, and the ‹ › stepper is this panel's only reachable path to a
// day too short to grab in the strip.
describe('createDayPanel - focus across a re-render', () => {
  const DAY2 = { index: 1, targetKm: 60, startKm: 100, endKm: 160, townChoice: null };
  const breaks = [
    { name: 'Café Elbterrasse', kind: 'food', routeDistanceKm: 195, note: '15 min coffee' },
    { name: 'Grenzturm', kind: 'sight', routeDistanceKm: 213 },
  ];

  it('keeps focus on the stepper, so the next press lands', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY2, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    const next = el.querySelector('[data-action="focus-next"]');
    next.focus();

    // What handleFocusDay does: focus moves on, then everything re-renders.
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    expect(document.activeElement).not.toBe(next); // the node itself is gone
    expect(document.activeElement.dataset.action).toBe('focus-next');

    document.activeElement.click();
    expect(callbacks.onFocusDay).toHaveBeenCalledWith(3);
  });

  // Walking the stepper to either end disables the button under the user's
  // finger, and a disabled node can't hold focus — so the twin takes it, which is
  // also the only way back.
  it('hands focus to the twin when the stepper reaches the end', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY2, dayCount: 3, breaks: [], fromName: 'Lenzen' });
    el.querySelector('[data-action="focus-next"]').focus();

    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'Lenzen' }); // index 2 of 3: › disabled

    expect(el.querySelector('[data-action="focus-next"]').disabled).toBe(true);
    expect(document.activeElement.dataset.action).toBe('focus-prev');
  });

  it('hands focus to the twin at the start of the plan', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY2, dayCount: 3, breaks: [], fromName: 'Lenzen' });
    el.querySelector('[data-action="focus-prev"]').focus();

    panel.render({ trip: WHOLE_ROAD,
      day: { index: 0, targetKm: 100, startKm: 0, endKm: 100, townChoice: null },
      dayCount: 3,
      breaks: [],
      fromName: 'Hamburg',
    });

    expect(document.activeElement.dataset.action).toBe('focus-next');
  });

  it('drops focus rather than picking a stray control when both ends are disabled', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY2, dayCount: 3, breaks: [], fromName: 'Lenzen' });
    el.querySelector('[data-action="focus-next"]').focus();

    panel.render({ trip: WHOLE_ROAD,
      day: { index: 0, targetKm: 80, startKm: 0, endKm: 80, townChoice: null },
      dayCount: 1,
      breaks: [],
      fromName: 'Hamburg',
    });

    expect(document.activeElement).toBe(document.body);
  });

  it('keeps focus on the distance field', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    el.querySelector('[data-day-distance]').focus();

    panel.render({ trip: WHOLE_ROAD, day: { ...DAY, endKm: 250 }, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    expect(document.activeElement.matches('[data-day-distance]')).toBe(true);
  });

  // The persistent prompt node keeps the text and the caret; without this it kept
  // both while activeElement sat on BODY, so the user typed on into nothing.
  it('keeps focus and caret in the prompt input', () => {
    const panel = mount();
    const customStopDraft = { km: 200 };
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft, draftOnDay: true });
    const input = el.querySelector('#custom-stop-label');
    input.value = 'half typ';
    input.setSelectionRange(8, 8);
    input.focus();

    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft, draftOnDay: true });

    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(8);
  });

  // A brand-new draft is the user asking for the prompt, so it outranks whatever
  // held focus before.
  it('yields to a brand-new prompt', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    el.querySelector('[data-day-distance]').focus();

    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen', customStopDraft: { km: 200 }, draftOnDay: true });

    expect(document.activeElement.id).toBe('custom-stop-label');
  });

  it("keeps focus on a surviving leg's own remove button", () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });
    el.querySelectorAll('[data-action="remove-break"]')[1].focus();

    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

    expect(document.activeElement.dataset.breakKey).toBe('Grenzturm@213');
  });

  // Removing a break destroys the very button that removed it, so focus goes to
  // whichever leg slid into its place rather than back to the top of the document.
  it('hands a removed break position to the leg that takes it', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });
    el.querySelector('[data-action="remove-break"]').focus();

    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [breaks[1]], fromName: 'Lenzen' });

    expect(document.activeElement.dataset.breakKey).toBe('Grenzturm@213');
  });

  // The twin fallback is deliberately restricted to the stepper pair, where the
  // twin IS the way back from a disabled button. Extending it to every control
  // reads as harmless and is not: Split disables itself the moment a day gets too
  // short, and its nearest neighbour is "Delete day" — so the fallback would put
  // focus on a destructive control the user never aimed at.
  it('never falls back from a disabled Split to the Delete beside it', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    el.querySelector('[data-action="split-day"]').focus();

    // Editing the day down under 2 x MIN_DAY_KM disables Split under the finger.
    panel.render({ trip: WHOLE_ROAD,
      day: { ...DAY, targetKm: 8, startKm: 160, endKm: 168 },
      dayCount: 4,
      breaks: [],
      fromName: 'Lenzen',
    });

    expect(el.querySelector('[data-action="split-day"]').disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  // Removing the LAST break leaves the remembered position past the end of the
  // shortened list, and an unclamped lookup would drop focus on <body> — the one
  // case where "the leg that took its place" does not exist.
  it('clamps a removed last break position to the leg still there', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });
    el.querySelectorAll('[data-action="remove-break"]')[1].focus();

    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [breaks[0]], fromName: 'Lenzen' });

    expect(document.activeElement.dataset.breakKey).toBe('Café Elbterrasse@195');
  });

  // A re-render removes the inline editor's input without firing any blur, so the
  // typed note is discarded (see startBreakEdit). What must NOT also be lost is
  // the keyboard's place: the input has no [data-action] of its own, so it used to
  // be the only control in the panel that dropped focus on <body>.
  it('discards an open note editor but hands focus back to its ✎', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });
    el.querySelectorAll('[data-action="edit-break"]')[1].click();
    const input = el.querySelector('.leg-edit__input');
    input.value = 'half typed';
    expect(document.activeElement).toBe(input);

    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

    expect(el.querySelector('.leg-edit__input')).toBeNull(); // discarded
    expect(callbacks.onEditBreak).not.toHaveBeenCalled(); // and not saved either
    expect(document.activeElement.dataset.action).toBe('edit-break');
    expect(document.activeElement.dataset.breakKey).toBe('Grenzturm@213');
  });

  // The panel is one of four modules writing to this document. Restoration is
  // keyed on attributes, so it has to check the focused node is actually ours
  // before matching one — hence an outsider wearing the same hook here.
  it('leaves focus alone when it was not in the panel', () => {
    const outside = document.createElement('input');
    outside.setAttribute('data-day-distance', '');
    document.body.appendChild(outside);
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    outside.focus();

    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    expect(document.activeElement).toBe(outside);
  });
});

describe('createDayPanel - day operations', () => {
  it('splits and deletes the focused day', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    el.querySelector('[data-action="split-day"]').click();
    expect(callbacks.onSplitDay).toHaveBeenCalledWith(2);

    el.querySelector('[data-action="delete-day"]').click();
    expect(callbacks.onDeleteDay).toHaveBeenCalledWith(2);
  });

  it('disables split on a day too short to split', () => {
    const panel = mount();
    const day = { index: 0, targetKm: 8, startKm: 0, endKm: 8, townChoice: null };
    panel.render({ trip: WHOLE_ROAD, day, dayCount: 1, breaks: [], fromName: 'Hamburg' });

    expect(el.querySelector('[data-action="split-day"]').disabled).toBe(true);
  });

  // The model splits at exactly 2 x MIN_DAY_KM (itinerary.splitDay refuses only
  // below it), so the button must not be one km more cautious than the model.
  it('allows a split at exactly two minimum days', () => {
    const panel = mount();
    const endKm = 2 * MIN_DAY_KM;
    panel.render({ trip: WHOLE_ROAD,
      day: { index: 0, targetKm: endKm, startKm: 0, endKm, townChoice: null },
      dayCount: 1,
      breaks: [],
      fromName: 'Hamburg',
    });

    expect(el.querySelector('[data-action="split-day"]').disabled).toBe(false);
  });

  it('steps focus between days', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    el.querySelector('[data-action="focus-prev"]').click();
    expect(callbacks.onFocusDay).toHaveBeenCalledWith(1);

    el.querySelector('[data-action="focus-next"]').click();
    expect(callbacks.onFocusDay).toHaveBeenCalledWith(3);
  });

  it('disables the stepper at the ends', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD,
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
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });
    panel.render({ trip: WHOLE_ROAD,
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
    panel.render({ trip: WHOLE_ROAD, day: null, dayCount: 0, breaks: [] });

    expect(el.querySelector('[data-action="delete-day"]')).toBeNull();
    expect(callbacks.onDeleteDay).not.toHaveBeenCalled();
  });
});

// --- Oriented trips --------------------------------------------------------
//
// The day records still carry ABSOLUTE route km; every km the panel prints is counted
// from the rider's own start. Both directions, because the two failure modes differ:
// offset-forward overstates every km by the trip's start, and downstream negates every
// distance.
describe('createDayPanel - oriented trips', () => {
  const UP = createTrip({ startKm: 149.3, destinationKm: 797.6, totalKm: 1026.5 });
  const DOWN = createTrip({ startKm: 797.6, destinationKm: 149.3, totalKm: 1026.5 });
  // Day 2 of each trip: 80 km ridden, then 105 more.
  const UP_DAY = { index: 1, targetKm: 105, startKm: 229.3, endKm: 334.3, townChoice: null };
  const DOWN_DAY = { index: 1, targetKm: 105, startKm: 717.6, endKm: 612.6, townChoice: null };

  it('heads the day with km from the rider’s start', () => {
    const panel = mount();
    panel.render({ trip: UP, day: UP_DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    expect(el.querySelector('.day-panel__from').textContent).toContain('km 80 → 185');
    expect(el.innerHTML).not.toContain('229.3');
    expect(el.innerHTML).not.toContain('334.3');
  });

  it('heads a downstream day the same way round', () => {
    const panel = mount();
    panel.render({ trip: DOWN, day: DOWN_DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    expect(el.querySelector('.day-panel__from').textContent).toContain('km 80 → 185');
  });

  it('reports a downstream day’s length as a positive distance', () => {
    const panel = mount();
    panel.render({ trip: DOWN, day: DOWN_DAY, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    // 612.6 − 717.6 is −105: an absolute difference puts "-105" in the Distance field,
    // which the number input then refuses (min = MIN_DAY_KM), and "-105 km total" on
    // the Legs heading.
    expect(el.querySelector('[data-day-distance]').value).toBe('105');
    expect(el.querySelector('.day-panel__section').textContent).toContain('105 km total');
  });

  it('measures a downstream day’s legs in the order they are ridden', () => {
    const panel = mount();
    const breaks = [
      { name: 'Café', kind: 'food', routeDistanceKm: 697.6 }, // 20 km into the day
      { name: 'Schloss', kind: 'sight', routeDistanceKm: 667.6 }, // 50 km in
    ];
    panel.render({ trip: DOWN, day: DOWN_DAY, dayCount: 4, breaks, fromName: 'Lenzen' });

    const legs = [...el.querySelectorAll('.day-card__leg-dist')].map((n) => n.textContent);
    expect(legs).toEqual(['20 km', '30 km', '55 km']);
  });

  it('names the overnight town’s km and the snap gap in rider km', () => {
    const panel = mount();
    const day = {
      ...UP_DAY,
      // The town sits 2 km past where the boundary could stop, so the snap note fires.
      townChoice: { name: 'Rosenhof', routeDistanceKm: 336.3, offsetKm: 0.4 },
    };
    panel.render({ trip: UP, day, dayCount: 4, breaks: [], fromName: 'Lenzen' });

    expect(el.querySelector('.day-panel__overnight').textContent).toContain('km 185');
    const note = el.querySelector('.day-panel__snap-note').textContent;
    expect(note).toContain('km 187');
    expect(note).toContain('km 185');
  });

  it('names a draft stop in rider km', () => {
    const panel = mount();
    panel.render({
      trip: UP,
      day: UP_DAY,
      dayCount: 4,
      breaks: [],
      fromName: 'Lenzen',
      customStopDraft: { km: 269.3 },
      draftOnDay: true,
    });

    const title = el.querySelector('.custom-stop__title').textContent;
    expect(title).toContain('New stop at km 120');
    expect(title).toContain('40 km into the day');
  });

  it('names a draft stop on a downstream day too', () => {
    const panel = mount();
    panel.render({
      trip: DOWN,
      day: DOWN_DAY,
      dayCount: 4,
      breaks: [],
      fromName: 'Lenzen',
      customStopDraft: { km: 677.6 },
      draftOnDay: true,
    });

    const title = el.querySelector('.custom-stop__title').textContent;
    expect(title).toContain('New stop at km 120');
    expect(title).toContain('40 km into the day');
  });
});
