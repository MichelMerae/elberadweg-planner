// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDayPanel } from './day-panel.js';
import { MIN_DAY_KM } from './boundaries.js';
import { createTrip } from './trip.js';
// The real ascent reader, for the one test that pins the day panel's climb against the
// direction of the trip: the figures swap because the day's own km do, and a fixture
// climb hand-written in this file would pin nothing about that.
import { ascentBetween } from './elevation.js';

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
    onPickEnd: vi.fn(),
    onFinishHere: vi.fn(),
    onAddCrossing: vi.fn(),
    onRemoveCrossing: vi.fn(),
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
  // CHANGED EXPECTATION (spec §6a, ruled 2026-08-01): this used to assert 'No days yet'.
  // The state that sentence named no longer exists — storage v4 gives every plan a real
  // window, so a plan with no days is not an empty plan, it is a trip nobody has ridden
  // yet. The panel therefore asks where the trip runs and shows the window it already
  // has (see 'the empty plan is trip setup' below). Recorded in the ledger as one of the
  // three expectation changes phase 4 sanctions.
  it('asks where the trip runs', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: null, dayCount: 0, breaks: [], fromName: 'Hamburg' });
    expect(el.querySelector('.day-panel__title').textContent).toBe('Where are you riding?');
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

// Spec §6, and §6a as ruled on 2026-08-01: a plan with no days is where the trip itself
// gets set, so this panel names both ends, where they sit on the road, and the trip they
// make — with the two controls that move them. ONE state, not two: there is no "not set"
// an end can be in, so the step is skippable rather than blocking and `+ add a first day`
// stays throughout (its own test lives in 'empty plan' above and still passes).
//
// This is also the only direct test of tripHeadline, which is why the direction word is
// pinned in both directions over the same two ends.
describe('createDayPanel - the empty plan is trip setup', () => {
  const UP = createTrip({ startKm: 149.3, destinationKm: 797.6, totalKm: 1026.5 });
  const DOWN = createTrip({ startKm: 797.6, destinationKm: 149.3, totalKm: 1026.5 });
  const NAMED = { startName: 'Hamburg', destinationName: 'Dresden' };
  const setup = (trip, extra = {}) => ({ trip, day: null, dayCount: 0, breaks: [], ...extra });
  const control = (role) => el.querySelector(`[data-action="set-${role}"]`);
  const headline = () => el.querySelector('.trip-setup__headline').textContent;

  it('names both ends, where they sit on the road, and the trip they make', () => {
    const panel = mount();
    panel.render(setup(UP, NAMED));

    const rows = [...el.querySelectorAll('.trip-setup__row')].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Hamburg');
    expect(rows[0]).toContain('km 149.3 of the road');
    expect(rows[1]).toContain('Dresden');
    expect(rows[1]).toContain('km 797.6 of the road');
    expect(headline()).toBe('Hamburg → Dresden · 648.3 km upstream');
  });

  // The same two ends, ridden the other way. Not a duplicate: a hardcoded 'upstream'
  // passes the test above, and so does a headline that reads its ends off the road
  // rather than off the trip — here the rider starts at the LARGER km.
  it('turns the sentence round when the same two ends are ridden the other way', () => {
    const panel = mount();
    panel.render(setup(DOWN, { startName: 'Dresden', destinationName: 'Hamburg' }));

    const rows = [...el.querySelectorAll('.trip-setup__row')].map((r) => r.textContent);
    expect(rows[0]).toContain('Dresden');
    expect(rows[0]).toContain('km 797.6 of the road');
    expect(rows[1]).toContain('Hamburg');
    expect(rows[1]).toContain('km 149.3 of the road');
    expect(headline()).toBe('Dresden → Hamburg · 648.3 km downstream');
  });

  // main.js resolves the names from the road's towns, and an end in open country has
  // none. Whatever this prints, it must not be the word `null` — which is what a bare
  // interpolation prints, and which reads as a claim about the trip rather than an
  // absence of one.
  it('reads an unnamed end as what it is rather than as null', () => {
    const panel = mount();
    panel.render(setup(UP));

    const rows = [...el.querySelectorAll('.trip-setup__row')].map((r) => r.textContent);
    expect(rows[0]).toContain('anywhere on the road');
    expect(rows[1]).toContain('anywhere on the road');
    expect(headline()).toBe('your start → your finish · 648.3 km upstream');
    expect(el.textContent).not.toContain('null');
    expect(el.textContent).not.toContain('undefined');
  });

  // A name reaches ELEMENT CONTENT in both the row and the headline, where that payload
  // really does parse into an element — so the assertion can fail in both directions:
  // unescaped it injects, and escaped twice it reads `&lt;img` on screen.
  it('escapes an end name rather than letting it become markup', () => {
    const panel = mount();
    const name = '<img src=x onerror="alert(1)">';
    panel.render(setup(UP, { startName: name, destinationName: 'Dresden' }));

    expect(el.querySelectorAll('img')).toHaveLength(0);
    expect(el.querySelector('.trip-setup__row').textContent).toContain(name);
    expect(headline()).toBe(`${name} → Dresden · 648.3 km upstream`);
  });

  it('emits the end each control owns', () => {
    const panel = mount();
    panel.render(setup(UP, NAMED));

    control('start').click();
    control('finish').click();

    // Both calls, in order: one control reporting both ends is the failure, and
    // `toHaveBeenCalledWith` passes as long as ANY call matches.
    expect(callbacks.onPickEnd.mock.calls).toEqual([['start'], ['destination']]);
  });

  // There is no focused day while this panel is on screen, so the two actions have to sit
  // ABOVE the `if (!current.day) return` guard — and everything below that guard then
  // reads `current.day.index` off null.
  //
  // The error listener is load-bearing, not belt-and-braces: jsdom swallows an exception
  // thrown inside an event handler, so `.click()` returns normally and a dropped guard
  // leaves `not.toHaveBeenCalled()` passing with only the "Unhandled Errors" banner to
  // show for it.
  it('arms nothing when the click lands on the setup step but on neither control', () => {
    const errors = [];
    const onError = (e) => errors.push(e.message || String(e.error));
    window.addEventListener('error', onError);
    const panel = mount();
    panel.render(setup(UP, NAMED));

    el.querySelector('.trip-setup').click();
    window.removeEventListener('error', onError);

    expect(errors).toEqual([]);
    expect(callbacks.onPickEnd).not.toHaveBeenCalled();
    expect(callbacks.onAddDay).not.toHaveBeenCalled();
  });

  // main.js renders this panel long before anything is armed, and a control that starts
  // pressed tells the rider a click on the map means something it does not.
  it('leaves both controls released when nothing is armed', () => {
    const panel = mount();
    panel.render(setup(UP, NAMED));

    expect(control('start').getAttribute('aria-pressed')).toBe('false');
    expect(control('finish').getAttribute('aria-pressed')).toBe('false');
  });

  it('presses the start control, and only it, while the start is armed', () => {
    const panel = mount();
    panel.render(setup(UP, { ...NAMED, picking: 'start' }));

    expect(control('start').getAttribute('aria-pressed')).toBe('true');
    expect(control('finish').getAttribute('aria-pressed')).toBe('false');
  });

  // The mirror image, and not a duplicate: without it a hardcoded 'start', or a
  // truthiness test that presses whichever control renders first, passes above. Note the
  // asymmetry the finish control has to survive — its action is `set-finish`, the value
  // it reports and compares against is `destination`.
  it('presses the finish control, and only it, while the finish is armed', () => {
    const panel = mount();
    panel.render(setup(UP, { ...NAMED, picking: 'destination' }));

    expect(control('finish').getAttribute('aria-pressed')).toBe('true');
    expect(control('start').getAttribute('aria-pressed')).toBe('false');
  });

  // Pressing a control arms the pick, and main.js re-renders — destroying the button
  // under the finger. Without restoration a keyboard user has to Tab back to `Set start`
  // to press it a second time, which is the documented way to cancel.
  it('keeps focus on the control across the re-render pressing it causes', () => {
    const panel = mount();
    panel.render(setup(UP, NAMED));
    const button = control('start');
    button.focus();

    panel.render(setup(UP, { ...NAMED, picking: 'start' }));

    expect(document.activeElement).not.toBe(button); // the node itself is gone
    expect(document.activeElement.dataset.action).toBe('set-start');
    expect(document.activeElement.getAttribute('aria-pressed')).toBe('true');
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

  // The composition main.js makes — `ascentBetween(profile, day.startKm, day.endKm)` on a
  // day whose km arrive in TRIP order — asserted through the real panel, because that
  // composition is the whole of why the day panel became direction-aware without a
  // call-site change. The SAME stretch of road is ridden both ways here.
  it('swaps the day’s climb and its descent with the trip’s direction', () => {
    // 10 m of climb per km of road, so every 1 km sample clears the 5 m threshold and a
    // stretch's figure is just its length in km × 10. The arithmetic is not the point.
    const slope = {
      routeId: 'slope',
      spacingM: 1000,
      count: 900,
      elevationsM: Array.from({ length: 900 }, (_, i) => i * 10),
    };
    const upDay = { index: 1, targetKm: 105, startKm: 229.3, endKm: 334.3, townChoice: null };
    const downDay = { index: 1, targetKm: 105, startKm: 334.3, endKm: 229.3, townChoice: null };
    const climbFor = (day) => ascentBetween(slope, day.startKm, day.endKm);
    const panel = mount();

    panel.render({ trip: UP, day: upDay, dayCount: 4, breaks: [], fromName: 'Lenzen', climb: climbFor(upDay) });
    expect(el.querySelector('.day-panel__climb-up').textContent).toBe('↑ 1040 m');
    expect(el.querySelector('.day-panel__climb-down').textContent).toBe('↓ 0 m');

    panel.render({ trip: DOWN, day: downDay, dayCount: 4, breaks: [], fromName: 'Lenzen', climb: climbFor(downDay) });
    expect(el.querySelector('.day-panel__climb-up').textContent).toBe('↑ 0 m');
    expect(el.querySelector('.day-panel__climb-down').textContent).toBe('↓ 1040 m');
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

// Spec §6's "after planning some days, select this stop as destination". The panel only
// EMITS the day's index; main.js turns that into a pick through the same applyPickedEnd
// the map uses, so every guard and the day-trimming come for free.
//
// A 300 km window offset 100 km along the road, ridden both ways, so no day's rider km
// is ever equal to its absolute km — an implementation that compared the two in absolute
// km would have to get lucky twice.
describe('createDayPanel - Finish here', () => {
  const UP = createTrip({ startKm: 100, destinationKm: 400, totalKm: 1026.5 });
  const DOWN = createTrip({ startKm: 400, destinationKm: 100, totalKm: 1026.5 });
  const button = () => el.querySelector('[data-action="finish-here"]');
  // Three days of 100 km on UP; the third arrives.
  const DAY_1_OF_3 = { index: 0, targetKm: 100, startKm: 100, endKm: 200, townChoice: null };
  const DAY_2_OF_3 = { index: 1, targetKm: 100, startKm: 200, endKm: 300, townChoice: null };
  const LAST_DAY_AT_DESTINATION = { index: 2, targetKm: 100, startKm: 300, endKm: 400, townChoice: null };
  // The same plan stopping 20 km short of the finish — the ordinary half-planned trip.
  const LAST_DAY_SHORT_OF_DESTINATION = { index: 2, targetKm: 80, startKm: 300, endKm: 380, townChoice: null };
  // Day 1 of the DOWNSTREAM trip: it ends at absolute km 300, which is 200 km PAST the
  // road position of that trip's destination (km 100) and 100 rider km into its 300.
  const DOWNSTREAM_DAY_1 = { index: 0, targetKm: 100, startKm: 400, endKm: 300, townChoice: null };
  const show = (day, trip = UP) =>
    ({ trip, day, dayCount: 3, breaks: [], fromName: 'Lenzen' });

  it('offers to finish the trip at this day’s end', () => {
    const panel = mount();
    panel.render(show(DAY_1_OF_3));

    button().click();

    expect(callbacks.onFinishHere).toHaveBeenCalledWith(0);
  });

  // Not a duplicate of the above: a hardcoded 0 passes it, and so does a button wired to
  // the panel's own first day rather than to the focused one.
  it('names the day whose end it would use, not the focused index', () => {
    const panel = mount();
    panel.render(show(DAY_2_OF_3));

    button().click();

    expect(callbacks.onFinishHere).toHaveBeenCalledWith(1);
  });

  // A day already ending at the finish has nothing to offer, and a button that does
  // nothing is worse than no button.
  it('is disabled on a day that already ends at the trip’s finish', () => {
    const panel = mount();
    panel.render(show(LAST_DAY_AT_DESTINATION));

    expect(button().disabled).toBe(true);
  });

  it('is enabled on the last day when the plan stops short of the finish', () => {
    const panel = mount();
    panel.render(show(LAST_DAY_SHORT_OF_DESTINATION));

    expect(button().disabled).toBe(false);
  });

  // The direction case. `day.endKm >= trip.destinationKm` — the shape someone writes
  // without thinking — is true for EVERY day of a downstream trip, so it would disable
  // the button across the whole plan while passing every upstream case above.
  it('is enabled on a downstream day that ends short of the finish', () => {
    const panel = mount();
    panel.render(show(DOWNSTREAM_DAY_1, DOWN));

    expect(button().disabled).toBe(false);
  });

  // The km in the title is the only km this button displays, and the file's whole
  // contract is that a displayed km is counted from the rider's start. Day 2 ends at
  // absolute km 300 and rider km 200, so an absolute-km title fails on both halves.
  it('titles the button with the rider km it would finish at, and says why when it cannot', () => {
    const panel = mount();
    panel.render(show(DAY_2_OF_3));

    expect(button().title).toContain('km 200');
    expect(button().title).not.toContain('300');

    panel.render(show(LAST_DAY_AT_DESTINATION));

    expect(button().title).toContain('already ends at your finish');
    expect(button().title).not.toContain('Finish the trip at');
  });
});

// Crossing the river is a DAY-PLANNING action, peer to ending the day: "I want the
// option to cross to the other side like the option to end the day, so I can have a
// cross after 50 km and from there continue planning the day till I end the day."
//
// So a crossing the rider has taken is a leg of the day — in the running distance
// chain, removable with a × — and the ones the day merely rides past are an offer
// below it. The rows are path.crossingsBetween(day.startKm, day.endKm)'s, verbatim.
describe('crossings in the day panel', () => {
  const CROSSINGS = [
    { id: 'rogaetz-ferry-192', name: 'Rogätz–Grieben ferry', kind: 'ferry', kmCanonical: 192.1, lengthKm: 0.4, chosen: false, canCross: true },
    { id: 'magdeburg-sternbruecke-209', name: 'Magdeburg, Sternbrücke', kind: 'bridge', kmCanonical: 208.9, lengthKm: 0.6, chosen: true, canCross: true },
    { id: 'schoenebeck-bruecke-223', name: 'Schönebeck bridge', kind: 'bridge', kmCanonical: 222.7, lengthKm: 0.5, chosen: false, canCross: false },
  ];
  // What the path model inserts where the alt line runs out: the rider is put back
  // across rather than riding off the end of the bank. `chosen` is false — it was
  // never a decision — so anything keyed on that alone offers it as an option.
  const FORCED_BACK = {
    id: 'bad-schandau-240', name: 'Bad Schandau bridge', kind: 'bridge', kmCanonical: 240,
    lengthKm: 0.3, chosen: false, implicit: true, canCross: true,
  };

  it('renders a chosen crossing as a removable leg at its km', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'Tangermünde', dayCrossings: CROSSINGS });
    const leg = el.querySelector('.day-card__leg--crossing');
    expect(leg.textContent).toContain('Magdeburg, Sternbrücke');
    expect(leg.textContent).toContain('⇄');
    leg.querySelector('[data-action="remove-crossing"]').click();
    expect(callbacks.onRemoveCrossing).toHaveBeenCalledWith('magdeburg-sternbruecke-209');
  });

  it('offers unchosen crossings with a Cross button, ferries hinted', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'x', dayCrossings: CROSSINGS });
    const rows = [...el.querySelectorAll('.day-crossings__row')];
    expect(rows).toHaveLength(2); // the chosen one is a leg, not a row
    expect(rows[0].textContent).toContain('⛴');
    expect(rows[0].textContent).toContain('check operating times');
    rows[0].querySelector('[data-action="add-crossing"]').click();
    expect(callbacks.onAddCrossing).toHaveBeenCalledWith('rogaetz-ferry-192');
  });

  it('a canCross:false row renders disabled', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'x', dayCrossings: CROSSINGS });
    const btn = [...el.querySelectorAll('[data-action="add-crossing"]')].find((b) => b.dataset.crossingId === 'schoenebeck-bruecke-223');
    expect(btn.disabled).toBe(true);
  });

  it('renders no group at all when the day passes no crossings', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'x', dayCrossings: [] });
    expect(el.querySelector('.day-crossings')).toBeNull();
  });

  // The point of a crossing being a LEG rather than a note: the day carries on from
  // it. Break at 195, cross at 208.9, sleep at 265 — so the ride to bed is measured
  // from the bridge, not from the café.
  it('measures the rest of the day from the crossing', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD,
      day: DAY,
      dayCount: 3,
      breaks: [{ name: 'Café Elbterrasse', kind: 'food', routeDistanceKm: 195 }],
      fromName: 'Tangermünde',
      dayCrossings: CROSSINGS,
    });

    const dists = [...el.querySelectorAll('.day-card__leg-dist')].map((n) => n.textContent);
    expect(dists).toEqual(['35 km', '13.9 km', '56.1 km']);
  });

  // Where the alt bank's road ends the rider crosses back whether they like it or
  // not, so this row is neither an offer nor a mistake — it is the route explaining
  // itself. Offering it a × would let the rider "decline" a leg the path model will
  // put straight back.
  it('explains a forced crossing back as a leg, with nothing to press', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'x', dayCrossings: [FORCED_BACK] });

    const leg = el.querySelector('.day-card__leg--crossing');
    expect(leg.textContent).toContain('Bad Schandau bridge');
    expect(leg.textContent).toContain('Cross back here');
    expect(leg.textContent).toContain('the bank you are riding ends here');
    expect(leg.querySelector('[data-action="remove-crossing"]')).toBeNull();
    // `chosen` is false on it, so a group keyed on that alone puts it on offer too.
    expect(el.querySelector('.day-crossings')).toBeNull();
  });

  // Coffee at the bridgehead, then across: two entries on one km. The zero-km leg
  // that makes must not claim to be at the day's start — it is 48.9 km into it.
  it('says where a crossing sharing a km with a break is, not "at the start"', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD,
      day: DAY,
      dayCount: 3,
      breaks: [{ name: 'Café Elbterrasse', kind: 'food', routeDistanceKm: 208.9 }],
      fromName: 'Tangermünde',
      dayCrossings: CROSSINGS,
    });

    const dists = [...el.querySelectorAll('.day-card__leg-dist')].map((n) => n.textContent);
    expect(dists).toEqual(['48.9 km', 'at the same spot', '56.1 km']);
    expect(el.querySelector('.day-card__leg--crossing').textContent).not.toContain('at the start');
  });

  // render() is a public contract, and main.js is not the only caller a future
  // refactor gives it. A crossing outside the day would not just print a nonsense
  // distance — it takes over the running km, so every leg after it AND the ride to
  // the overnight town would be measured from a point this day never reaches.
  it('ignores a chosen crossing that falls outside the day', () => {
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD,
      day: DAY, // 160 → 265
      dayCount: 3,
      breaks: [{ name: 'Café Elbterrasse', kind: 'food', routeDistanceKm: 195 }],
      fromName: 'Tangermünde',
      dayCrossings: [
        { id: 'before-100', name: 'Yesterday’s bridge', kind: 'bridge', kmCanonical: 100, lengthKm: 0.4, chosen: true, canCross: true },
        { id: 'after-300', name: 'Tomorrow’s bridge', kind: 'bridge', kmCanonical: 300, lengthKm: 0.4, chosen: true, canCross: true },
      ],
    });

    expect(el.querySelector('.day-card__leg--crossing')).toBeNull();
    const dists = [...el.querySelectorAll('.day-card__leg-dist')].map((n) => n.textContent);
    expect(dists).toEqual(['35 km', '70 km']);
  });

  it('escapes a crossing name in the leg, the row and their attributes', () => {
    const panel = mount();
    const name = '<img src=x onerror="boom">';
    panel.render({ trip: WHOLE_ROAD,
      day: DAY,
      dayCount: 3,
      breaks: [],
      fromName: 'x',
      dayCrossings: [
        { id: 'chosen"id', name, kind: 'bridge', kmCanonical: 200, lengthKm: 0.4, chosen: true, canCross: true },
        { id: 'row"id', name, kind: 'ferry', kmCanonical: 220, lengthKm: 0.4, chosen: false, canCross: true },
      ],
    });

    expect(el.querySelectorAll('img')).toHaveLength(0);
    expect(el.querySelector('.day-card__leg--crossing').textContent).toContain(name);
    expect(el.querySelector('.day-crossings__row').textContent).toContain(name);
    expect(el.querySelector('[data-action="remove-crossing"]').dataset.crossingId).toBe('chosen"id');
    expect(el.querySelector('[data-action="add-crossing"]').dataset.crossingId).toBe('row"id');
  });

  // Pressing ⇄ Cross re-renders the whole panel through main.js, destroying the
  // button under the finger — and the row it was in, which is now a leg. Every other
  // repeated control in this panel hands its position to whatever slides into it;
  // without this one a keyboard user is back at the top of the document after each
  // crossing they take.
  it('hands a taken crossing’s position to the row that takes it', () => {
    // Schönebeck crossable here: a disabled button cannot hold focus, and this test
    // is about the handover rather than about that (see the Split/Delete case above
    // for why a disabled target drops focus rather than picking a neighbour).
    const offered = CROSSINGS.map((c) => (c.canCross ? c : { ...c, canCross: true }));
    const panel = mount();
    panel.render({ trip: WHOLE_ROAD, day: DAY, dayCount: 3, breaks: [], fromName: 'x', dayCrossings: offered });
    el.querySelector('[data-action="add-crossing"]').focus();

    // What main.js does with the press: the ferry is chosen now, so its row is gone.
    panel.render({ trip: WHOLE_ROAD,
      day: DAY,
      dayCount: 3,
      breaks: [],
      fromName: 'x',
      dayCrossings: offered.map((c) => (c.id === 'rogaetz-ferry-192' ? { ...c, chosen: true } : c)),
    });

    expect(document.activeElement.dataset.crossingId).toBe('schoenebeck-bruecke-223');
  });
});
