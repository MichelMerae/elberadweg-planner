// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPlaces } from './places.js';
import { favKey } from './favorites.js';
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
    onSelectTown: vi.fn(),
    onSelectPoi: vi.fn(),
    onToggleBreak: vi.fn(),
    onToggleFavorite: vi.fn(),
    onPoiRowHover: vi.fn(),
  };
  return createPlaces({ el, callbacks });
}

function town(name, km, offsetKm = 0.5) {
  return { name, place: 'village', routeDistanceKm: km, offsetKm, lat: 53, lng: 10 };
}

function poi(name, km, kind = 'food') {
  return { name, kind, category: 'cafe', routeDistanceKm: km, offsetKm: 0.2, lat: 53, lng: 10 };
}

// A day start off the integer grid, so every km the panel prints has to go
// through round1 to match: unrounded, 265 − 160.44 reads 104.55999999999999.
const STRETCH = { dayNumber: 3, startKm: 160.44, endKm: 265, fromName: 'Lenzen' };

// The lists and key Sets every render needs; each test names only what it
// exercises. Sets are rebuilt per call so no test can leak state into the next.
function renderArgs(overrides = {}) {
  return {
    trip: WHOLE_ROAD,
    ...STRETCH,
    towns: [],
    food: [],
    sights: [],
    favorites: [],
    breakKeys: new Set(),
    favoriteKeys: new Set(),
    // Which day owns a km is itinerary.dayOwnsKm's answer, handed down by main.js. The
    // default says "no day": tests about the tag name their own answers.
    dayNumberForKm: () => null,
    ...overrides,
  };
}

// The case the 40-row cap exists for: a dense stretch of 451 food POIs.
const MANY = Array.from({ length: 451 }, (_, i) => poi(`Place ${i}`, 161 + i * 0.2));

// jsdom does no layout, so scrollIntoView is missing entirely — the highlight
// path calls it to bring a marker's row into view. Re-stubbed per test: a spy
// shared across the file would carry every earlier test's calls into the counts
// asserted below.
let scrollSpy;

beforeEach(() => {
  document.body.innerHTML = '';
  scrollSpy = vi.fn();
  window.Element.prototype.scrollIntoView = scrollSpy;
});

describe('createPlaces - scoping', () => {
  it('says which day the lists belong to', () => {
    const places = mount();
    places.render(renderArgs());

    expect(el.querySelector('.places__scope').textContent).toContain('Day 3');
    expect(el.querySelector('.places__scope').textContent).toContain('km 160.4 → 265');
  });

  it('says so when no day is focused', () => {
    const places = mount();
    places.render(renderArgs({ dayNumber: null }));

    expect(el.querySelector('.places__scope').textContent).toContain('no day focused');
  });

  // Day numbers are 1-based here but 0-based nearly everywhere else in the app,
  // so a 0 that slips through must read as day zero, not as "no day at all".
  it('trusts a day number of 0 instead of reading it as no day', () => {
    const places = mount();
    places.render(renderArgs({ dayNumber: 0 }));

    const scope = el.querySelector('.places__scope').textContent;
    expect(scope).toContain('Day 0');
    expect(scope).not.toContain('no day focused');
  });
});

describe('createPlaces - overnight candidates', () => {
  // Off-grid km on both sides of the subtraction: the day-relative difference
  // and the absolute km each have to be rounded on the way out.
  it('lists candidates with day-relative distance', () => {
    const places = mount();
    places.render(renderArgs({ towns: [town('Rosenhof', 265.06, 0.4)] }));

    const row = el.querySelector('[data-place-section="town"]');
    expect(row.textContent).toContain('Rosenhof');
    expect(row.textContent).toContain('104.6 km from Lenzen');
    expect(row.textContent).toContain('0.4 km off route');
    expect(row.querySelector('.meta__abs').textContent).toBe('km 265.1');
  });

  // The detour is data, carrying two decimals, and every other km on screen goes
  // through round1 — so an unrounded one put "0.05 km off route" in this panel and
  // "0.1 km off route" in the day panel for the same town, at the same moment.
  it('rounds the detour the same way every other km is rounded', () => {
    const places = mount();
    places.render(renderArgs({
      towns: [town('Niegripp', 265, 0.05)],
      food: [{ ...poi('Café Elbterrasse', 195), offsetKm: 0.05 }],
    }));

    expect(el.querySelector('[data-place-section="town"]').textContent).toContain('0.1 km off route');
    expect(el.querySelector('[data-place-section="food"]').textContent).toContain('0.1 km off route');
  });

  it('chooses a town as the overnight on a body click', () => {
    const places = mount();
    const t = town('Rosenhof', 265);
    places.render(renderArgs({ towns: [t] }));

    el.querySelector('[data-place-section="town"] .town__name').click();

    expect(callbacks.onSelectTown).toHaveBeenCalledWith(t);
  });

  it('marks the town that is already the overnight choice', () => {
    const places = mount();
    places.render(renderArgs({ towns: [town('Rosenhof', 265)], selectedTownKey: 'Rosenhof@265' }));

    expect(el.querySelector('[data-place-section="town"]').classList.contains('town--selected')).toBe(true);
  });
});

describe('createPlaces - POI rows', () => {
  it('gives a POI row the same day-relative wording, absolute km inline', () => {
    const places = mount();
    places.render(renderArgs({ food: [poi('Café Elbterrasse', 195.06)] }));

    const meta = el.querySelector('[data-place-section="food"] .poi__meta').textContent;
    expect(meta).toContain('34.6 km from Lenzen');
    expect(meta).toContain('(km 195.1)');
    expect(meta).toContain('0.2 km off route');
  });

  it('shows opening hours when the data has them', () => {
    const places = mount();
    places.render(renderArgs({ food: [{ ...poi('Café Elbterrasse', 195), openingHours: 'Mo-Fr 08:00-18:00' }] }));

    expect(el.querySelector('.poi__hours').textContent).toBe('Mo-Fr 08:00-18:00');
  });

  it('leaves the hours out when the data has none', () => {
    const places = mount();
    places.render(renderArgs({ food: [poi('Café Elbterrasse', 195)] }));

    expect(el.querySelector('.poi__hours')).toBeNull();
  });
});

describe('createPlaces - row actions', () => {
  it('toggles a break and a favorite without triggering the body action', () => {
    const places = mount();
    const p = poi('Café Elbterrasse', 195);
    places.render(renderArgs({ food: [p] }));

    const row = el.querySelector('[data-place-section="food"]');
    row.querySelector('[data-action="break"]').click();
    row.querySelector('[data-action="fav"]').click();

    expect(callbacks.onToggleBreak).toHaveBeenCalledWith(p);
    expect(callbacks.onToggleFavorite).toHaveBeenCalledWith(p);
    expect(callbacks.onSelectPoi).not.toHaveBeenCalled();
  });

  it('reflects break and favorite state on the buttons', () => {
    const places = mount();
    places.render(renderArgs({
      food: [poi('Café Elbterrasse', 195)],
      breakKeys: new Set(['Café Elbterrasse@195']),
      favoriteKeys: new Set(['food:Café Elbterrasse@195']),
    }));

    const row = el.querySelector('[data-place-section="food"]');
    expect(row.querySelector('[data-action="break"]').getAttribute('aria-pressed')).toBe('true');
    expect(row.querySelector('[data-action="fav"]').getAttribute('aria-pressed')).toBe('true');
  });
});

// main.js hands over two key shapes: breaks are bare (name@km), favorites are
// kind-prefixed (kind:name@km). Each row type has to pick the right one.
describe('createPlaces - key shapes', () => {
  it('reads a town favorite from the town-prefixed key', () => {
    const places = mount();
    places.render(renderArgs({
      towns: [town('Rosenhof', 265)],
      breakKeys: new Set(['Rosenhof@265']),
      favoriteKeys: new Set(['town:Rosenhof@265']),
    }));

    const row = el.querySelector('[data-place-section="town"]');
    expect(row.querySelector('[data-action="break"]').getAttribute('aria-pressed')).toBe('true');
    expect(row.querySelector('[data-action="fav"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('does not read a bare key as a town favorite', () => {
    const places = mount();
    places.render(renderArgs({
      towns: [town('Rosenhof', 265)],
      favoriteKeys: new Set(['Rosenhof@265']),
    }));

    expect(el.querySelector('[data-place-section="town"] [data-action="fav"]').getAttribute('aria-pressed')).toBe('false');
  });

  it('reads a favorite row break from the bare key', () => {
    const places = mount();
    places.render(renderArgs({
      favorites: [poi('Grenzturm', 213, 'sight')],
      breakKeys: new Set(['Grenzturm@213']),
    }));

    const row = el.querySelector('[data-place-section="fav"]');
    expect(row.querySelector('[data-action="break"]').getAttribute('aria-pressed')).toBe('true');
    // Every row in this section is a favorite, so ⭐ is always active.
    expect(row.querySelector('[data-action="fav"]').getAttribute('aria-pressed')).toBe('true');
  });

  it('does not read a kind-prefixed key as a favorite row break', () => {
    const places = mount();
    places.render(renderArgs({
      favorites: [poi('Grenzturm', 213, 'sight')],
      breakKeys: new Set(['sight:Grenzturm@213']),
    }));

    expect(el.querySelector('[data-place-section="fav"] [data-action="break"]').getAttribute('aria-pressed')).toBe('false');
  });

  // The prefixed shape above is favorites.js's, and main.js snapshots the lookup
  // Set with favKey itself — so these rows have to build the same string from the
  // same builder. Spelled by hand on this side, a separator change in favorites.js
  // would turn every star off with the suite still green.
  it('builds the favorite key the way favorites.js does', () => {
    const places = mount();
    const candidate = town('Rosenhof', 265);
    const cafe = poi('Café Elbterrasse', 195);
    places.render(renderArgs({
      towns: [candidate],
      food: [cafe],
      favoriteKeys: new Set([
        favKey({ ...candidate, kind: 'town' }),
        favKey({ ...cafe, kind: 'food' }),
      ]),
    }));

    expect(el.querySelector('[data-place-section="town"] [data-action="fav"]').getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-place-section="food"] [data-action="fav"]').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('createPlaces - the 40-row cap', () => {
  // Which 40, not just how many. The footer promises "the first 40" and the list
  // arrives in ride order, so they have to be the 40 the rider meets FIRST — and
  // counting rows cannot tell the difference: a cap keeping the LAST 40 of the stretch
  // rendered 40 rows under that same footer and passed this whole file.
  it('renders the first 40 rows of the stretch and says how many there are', () => {
    const places = mount();
    places.render(renderArgs({ food: MANY }));

    const names = [...el.querySelectorAll('[data-place-section="food"] .poi__name')].map((n) => n.textContent);
    expect(names).toHaveLength(40);
    expect(names[0]).toBe('Place 0');
    expect(names[39]).toBe('Place 39');
    expect(el.querySelector('.places__more').textContent).toContain('showing the first 40 of 451');
  });

  it('counts the whole section in the summary, not the rendered rows', () => {
    const places = mount();
    places.render(renderArgs({ food: MANY }));

    expect(el.querySelector('.pois--food .pois__count').textContent).toBe('(451)');
  });

  it('expands to the full list when asked', () => {
    const places = mount();
    places.render(renderArgs({ food: MANY }));

    el.querySelector('[data-action="show-all"]').click();

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(451);
    expect(el.querySelector('.places__more')).toBeNull();
  });

  it('collapses back to 40 when the focused day changes', () => {
    const places = mount();
    places.render(renderArgs({ food: MANY }));
    el.querySelector('[data-action="show-all"]').click();

    places.render(renderArgs({ dayNumber: 4, startKm: 265, endKm: 320, food: MANY }));

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(40);
  });

  // Toggling a ☕ re-renders the same stretch; that must not fold the list the
  // user just opened.
  it('keeps an expanded section through a same-scope re-render', () => {
    const places = mount();
    places.render(renderArgs({ food: MANY }));
    el.querySelector('[data-action="show-all"]').click();

    places.render(renderArgs({ food: MANY, breakKeys: new Set(['Place 0@161']) }));

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(451);
  });

  it('shows no footer when a section fits', () => {
    const places = mount();
    places.render(renderArgs({ food: MANY.slice(0, 12) }));

    expect(el.querySelector('.places__more')).toBeNull();
  });

  it('expands only the section that was asked', () => {
    const places = mount();
    places.render(renderArgs({ food: MANY, sights: MANY }));

    el.querySelector('.pois--food [data-action="show-all"]').click();

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(451);
    expect(el.querySelectorAll('[data-place-section="sight"]')).toHaveLength(40);
  });

  // "show all" re-renders from the arguments of the last render, so a caller
  // that reuses and mutates its own state object must not be able to move the
  // stretch out from under the click.
  it('re-expands against the arguments as they were rendered', () => {
    const places = mount();
    const args = renderArgs({ food: MANY });
    places.render(args);
    args.startKm = 999;

    el.querySelector('[data-action="show-all"]').click();

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(451);
  });
});

describe('createPlaces - missing POI data', () => {
  it('says the data is missing instead of pretending the stretch is empty', () => {
    const places = mount();
    places.render(renderArgs({ towns: [town('Rosenhof', 265)], poisMissing: true }));

    expect(el.querySelector('.pois__note').textContent).toContain('npm run build:data');
    expect(el.querySelector('.pois--food')).toBeNull();
    // The candidate list is independent of POI data and must still render.
    expect(el.querySelector('[data-place-section="town"]')).not.toBeNull();
  });
});

describe('createPlaces - favorites', () => {
  it('tags each favorite with the day that covers it', () => {
    const places = mount();
    places.render(renderArgs({
      favorites: [poi('Grenzturm', 213, 'sight'), poi('Far Away', 600, 'sight')],
      dayNumberForKm: (km) => (km <= 265 ? 1 : null),
    }));

    const rows = [...el.querySelectorAll('[data-place-section="fav"]')];
    expect(rows[0].textContent).toContain('Day 1');
    expect(rows[1].textContent).toContain('beyond plan');
  });

  it('invites a first favorite when there are none', () => {
    const places = mount();
    places.render(renderArgs());

    expect(el.textContent).toContain('Nothing starred yet');
  });

  it('shows a favorite at its rounded route km', () => {
    const places = mount();
    places.render(renderArgs({
      favorites: [poi('Grenzturm', 213.06, 'sight')],
      dayNumberForKm: () => 1,
    }));

    expect(el.querySelector('[data-place-section="fav"] .poi__meta').textContent).toContain('km 213.1');
  });

  // kind comes from a stored list a user could have hand-edited, and a bare
  // property lookup on the glyph table reaches Object.prototype — 'constructor'
  // would interpolate a function body into the row. Same guarded-lookup invariant
  // ui-util.js documents for break glyphs.
  it.each(['constructor', 'toString', 'unheard-of'])('falls back to a star for kind %s', (kind) => {
    const places = mount();
    places.render(renderArgs({ favorites: [{ ...poi('Grenzturm', 213, kind), category: null }] }));

    const name = el.querySelector('[data-place-section="fav"] .poi__name').textContent;
    expect(name).toBe('⭐ Grenzturm');
  });

  it('selects a favorite through the POI callback', () => {
    const places = mount();
    const fav = poi('Grenzturm', 213, 'sight');
    places.render(renderArgs({ favorites: [fav] }));

    el.querySelector('[data-place-section="fav"] .poi__name').click();

    expect(callbacks.onSelectPoi).toHaveBeenCalledWith(fav);
  });
});

// Which day owns a km is the model's rule — half-open (start, end] in RIDER km, plus
// day 1's start line — and it is pinned once, in itinerary.test.js (dayOwnsKm). This
// panel is handed the answer and words it; what follows is the wording.
describe('createPlaces - favorite day tags', () => {
  it('names the day the model gives a favorite to', () => {
    const places = mount();
    places.render(renderArgs({
      favorites: [poi('Boundary', 265, 'sight'), poi('Just past', 265.1, 'sight')],
      dayNumberForKm: (km) => (km <= 265 ? 1 : 2),
    }));

    const rows = [...el.querySelectorAll('[data-place-section="fav"]')];
    expect(rows[0].querySelector('.fav-day').textContent).toBe('Day 1');
    expect(rows[1].querySelector('.fav-day').textContent).toBe('Day 2');
  });

  it('marks a favorite no day covers', () => {
    const places = mount();
    places.render(renderArgs({ favorites: [poi('Far Away', 600, 'sight')], dayNumberForKm: () => null }));

    const tag = el.querySelector('[data-place-section="fav"] .fav-day');
    expect(tag.textContent).toBe('beyond plan');
    expect(tag.classList.contains('fav-day--beyond')).toBe(true);
  });
});

describe('createPlaces - without a trip', () => {
  // The conversions all live inside row builders, so a trip-less render with its own
  // stretch and no places used to succeed in silence — and then throw an unhelpful
  // TypeError the first time something WAS in the lists. See the file header.
  it('refuses to render, even with a stretch named and nothing to show', () => {
    const places = mount();

    expect(() =>
      places.render({ dayNumber: 2, startKm: 160, endKm: 265, towns: [], food: [], sights: [], favorites: [] }),
    ).toThrow(/trip/);
  });
});

describe('createPlaces - hover', () => {
  it('reports a hovered POI once and clears on exit', () => {
    const places = mount();
    const p = poi('Café Elbterrasse', 195);
    places.render(renderArgs({ food: [p] }));

    const row = el.querySelector('[data-place-section="food"]');
    row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    row.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    expect(callbacks.onPoiRowHover).toHaveBeenCalledTimes(1);

    row.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: el }));
    expect(callbacks.onPoiRowHover).toHaveBeenLastCalledWith(null);
  });

  it('reports the hovered record, not just the fact of a hover', () => {
    const places = mount();
    const first = poi('Bäckerei', 170);
    const second = poi('Café Elbterrasse', 195);
    places.render(renderArgs({ food: [first, second] }));

    el.querySelectorAll('[data-place-section="food"]')[1]
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    expect(callbacks.onPoiRowHover).toHaveBeenCalledWith(second);
  });

  // Towns and favorites have no POI marker for the map to light up (only food
  // and sight rows carry a data-poi-key), so hovering them reports nothing.
  it('stays quiet when a town row is hovered', () => {
    const places = mount();
    places.render(renderArgs({ towns: [town('Rosenhof', 265)] }));

    el.querySelector('[data-place-section="town"]')
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    expect(callbacks.onPoiRowHover).not.toHaveBeenCalled();
  });

  // A ☕ toggle rebuilds the rows under a stationary cursor: the hovered node is
  // replaced without ever firing mouseout, so a dedupe key that outlived the
  // render would suppress every later hover of that row.
  it('reports a hover again after the rows are rebuilt under the cursor', () => {
    const places = mount();
    const p = poi('Café Elbterrasse', 195);
    places.render(renderArgs({ food: [p] }));
    el.querySelector('[data-place-section="food"]')
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    expect(callbacks.onPoiRowHover).toHaveBeenCalledTimes(1);

    places.render(renderArgs({ food: [p], breakKeys: new Set(['Café Elbterrasse@195']) }));
    el.querySelector('[data-place-section="food"]')
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    expect(callbacks.onPoiRowHover).toHaveBeenCalledTimes(2);
  });
});

describe('createPlaces - row identity', () => {
  it('resolves a clicked row against its own section', () => {
    const places = mount();
    const sight = poi('Grenzturm', 213, 'sight');
    places.render(renderArgs({
      food: [poi('Bäckerei', 170), poi('Café Elbterrasse', 195)],
      sights: [sight],
    }));

    el.querySelector('[data-place-section="sight"]').click();

    expect(callbacks.onSelectPoi).toHaveBeenCalledWith(sight);
  });

  it('resolves a row past the cap after expanding', () => {
    const places = mount();
    places.render(renderArgs({ food: MANY }));
    el.querySelector('[data-action="show-all"]').click();

    el.querySelectorAll('[data-place-section="food"]')[200].click();

    expect(callbacks.onSelectPoi).toHaveBeenCalledWith(MANY[200]);
  });
});

describe('createPlaces - keyboard', () => {
  it('chooses a town with Enter on the row', () => {
    const places = mount();
    const t = town('Rosenhof', 265);
    places.render(renderArgs({ towns: [t] }));

    el.querySelector('[data-place-section="town"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(callbacks.onSelectTown).toHaveBeenCalledWith(t);
  });

  it('chooses a town with Space on the row', () => {
    const places = mount();
    const t = town('Rosenhof', 265);
    places.render(renderArgs({ towns: [t] }));

    el.querySelector('[data-place-section="town"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));

    expect(callbacks.onSelectTown).toHaveBeenCalledWith(t);
  });

  it('leaves Enter on a nested action button to the button', () => {
    const places = mount();
    places.render(renderArgs({ towns: [town('Rosenhof', 265)] }));

    el.querySelector('[data-place-section="town"] [data-action="break"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(callbacks.onSelectTown).not.toHaveBeenCalled();
  });
});

// Every value here comes from OSM or from stored user text; none of it may
// become markup.
describe('createPlaces - escaping', () => {
  const NASTY = '<img src=x onerror="boom()">';

  it('renders a hostile town name, place and reference town as text', () => {
    const places = mount();
    places.render(renderArgs({
      fromName: NASTY,
      towns: [{ ...town(NASTY, 265), place: '<i>village</i>' }],
    }));

    const row = el.querySelector('[data-place-section="town"]');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('i')).toBeNull();
    expect(row.querySelector('.town__name').textContent).toBe(NASTY);
    expect(row.querySelector('.town__place').textContent).toBe('<i>village</i>');
    expect(row.querySelector('.town__meta').textContent).toContain(NASTY);
  });

  it('renders a hostile POI category and opening hours as text', () => {
    const places = mount();
    places.render(renderArgs({
      food: [{ ...poi('Ok', 195), category: '<b>cafe</b>', openingHours: '<script>boom()</script>' }],
    }));

    const row = el.querySelector('[data-place-section="food"]');
    expect(row.querySelector('b')).toBeNull();
    expect(row.querySelector('script')).toBeNull();
    expect(row.querySelector('.poi__cat').textContent).toBe('<b>cafe</b>');
    expect(row.querySelector('.poi__hours').textContent).toBe('<script>boom()</script>');
  });

  it('renders a hostile favorite name and category as text', () => {
    const places = mount();
    places.render(renderArgs({
      favorites: [{ ...poi(NASTY, 213, 'sight'), category: '<b>viewpoint</b>' }],
    }));

    const row = el.querySelector('[data-place-section="fav"]');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
    expect(row.querySelector('.poi__name').textContent).toContain(NASTY);
    expect(row.querySelector('.poi__cat').textContent).toBe('<b>viewpoint</b>');
  });

  // A food row puts the name in a text position AND in the data-poi-key
  // attribute, so one name has to survive both escapings at once. Asserted three
  // ways, because no single one covers it: the text position's content, the
  // absence of any element the payload could have created, and the key
  // round-tripping out of the attribute (a raw < is legal inside a quoted
  // attribute value, so serialized markup is not evidence either way).
  it('keeps a hostile POI name out of both the text and the key attribute', () => {
    const places = mount();
    const p = poi(NASTY, 195);
    places.render(renderArgs({ food: [p] }));

    const row = el.querySelector('[data-place-section="food"]');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('.poi__name').textContent).toBe(NASTY);
    expect(row.dataset.poiKey).toBe(`${NASTY}@195`);

    places.highlightPoiRow(`${NASTY}@195`);
    expect(row.classList.contains('poi--hover')).toBe(true);
  });

  // A quote in a name would close the data-poi-key attribute early and break
  // both the row's identity and the aria-labels built from it.
  it('round-trips a quote-bearing name through the attributes it lands in', () => {
    const places = mount();
    const p = poi('Café "Elbe" & Co', 195);
    places.render(renderArgs({ food: [p] }));

    const row = el.querySelector('[data-place-section="food"]');
    expect(row.dataset.poiKey).toBe('Café "Elbe" & Co@195');
    expect(row.querySelector('[data-action="break"]').getAttribute('aria-label'))
      .toBe('Add as break: Café "Elbe" & Co');

    // The map hands back the same unescaped key, so the lookup must still match.
    places.highlightPoiRow('Café "Elbe" & Co@195');
    expect(row.classList.contains('poi--hover')).toBe(true);
  });
});

describe('createPlaces - marker hover highlight', () => {
  it('highlights the row matching a POI key and clears on null', () => {
    const places = mount();
    places.render(renderArgs({ food: [poi('Bäckerei', 170), poi('Café Elbterrasse', 195)] }));

    places.highlightPoiRow('Café Elbterrasse@195');
    const rows = [...el.querySelectorAll('[data-place-section="food"]')];
    expect(rows[1].classList.contains('poi--hover')).toBe(true);
    expect(rows[0].classList.contains('poi--hover')).toBe(false);

    places.highlightPoiRow(null);
    expect(el.querySelector('.poi--hover')).toBeNull();
  });

  // The map keeps its marker hovered across a re-render (hovering one pans the
  // map, which re-renders the panel), so the highlight has to survive with it.
  it('keeps the highlight through a re-render and still clears afterwards', () => {
    const places = mount();
    const p = poi('Café Elbterrasse', 195);
    places.render(renderArgs({ food: [p] }));
    places.highlightPoiRow('Café Elbterrasse@195');

    places.render(renderArgs({ food: [p] }));

    expect(el.querySelector('.poi--hover')).not.toBeNull();
    expect(el.querySelector('.poi--hover').dataset.poiKey).toBe('Café Elbterrasse@195');

    places.highlightPoiRow(null);
    expect(el.querySelector('.poi--hover')).toBeNull();
  });

  it('brings a freshly highlighted row into view', () => {
    const places = mount();
    places.render(renderArgs({ food: [poi('Café Elbterrasse', 195)] }));

    places.highlightPoiRow('Café Elbterrasse@195');

    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  // Scrolling belongs to the marker hover, not to the render that follows it: a
  // boundary drag re-renders continuously, and scrolling on each one would drag
  // the panel away from the user ~60 times a second.
  it('does not scroll again when a re-render re-applies the highlight', () => {
    const places = mount();
    const p = poi('Café Elbterrasse', 195);
    places.render(renderArgs({ food: [p] }));
    places.highlightPoiRow('Café Elbterrasse@195');
    scrollSpy.mockClear();

    places.render(renderArgs({ food: [p] }));

    // Asserted together: "didn't scroll" must not be satisfiable by simply
    // having dropped the highlight.
    expect(el.querySelector('.poi--hover')).not.toBeNull();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('drops the highlight when the row leaves the list', () => {
    const places = mount();
    places.render(renderArgs({ food: [poi('Café Elbterrasse', 195)] }));
    places.highlightPoiRow('Café Elbterrasse@195');

    places.render(renderArgs({ food: [] }));

    expect(el.querySelector('.poi--hover')).toBeNull();
  });
});

// --- Oriented trips --------------------------------------------------------
//
// The records and the stretch arrive in ABSOLUTE route km; every km on a row is
// counted from the rider's own start.
describe('createPlaces - oriented trips', () => {
  const UP = createTrip({ startKm: 149.3, destinationKm: 797.6, totalKm: 1026.5 });
  const DOWN = createTrip({ startKm: 797.6, destinationKm: 149.3, totalKm: 1026.5 });
  // Day 2 of each trip: 80 km ridden, then 105 more.
  const UP_STRETCH = { dayNumber: 2, startKm: 229.3, endKm: 334.3, fromName: 'Lenzen' };
  const DOWN_STRETCH = { dayNumber: 2, startKm: 717.6, endKm: 612.6, fromName: 'Lenzen' };

  it('scopes the panel to the stretch in rider km', () => {
    const places = mount();
    places.render(renderArgs({ trip: UP, ...UP_STRETCH }));

    expect(el.querySelector('.places__scope-range').textContent).toContain('km 80 → 185');
    expect(el.innerHTML).not.toContain('229.3');
  });

  it('scopes a downstream stretch the same way round', () => {
    const places = mount();
    places.render(renderArgs({ trip: DOWN, ...DOWN_STRETCH }));

    expect(el.querySelector('.places__scope-range').textContent).toContain('km 80 → 185');
  });

  it('measures a town from the day’s start and names its rider km', () => {
    const places = mount();
    places.render(renderArgs({ trip: UP, ...UP_STRETCH, towns: [town('Rosenhof', 269.3)] }));

    const meta = el.querySelector('.town__meta').textContent;
    expect(meta).toContain('40 km from Lenzen');
    expect(meta).toContain('km 120');
  });

  it('measures a town on a downstream day as a positive distance ridden', () => {
    const places = mount();
    places.render(renderArgs({ trip: DOWN, ...DOWN_STRETCH, towns: [town('Rosenhof', 677.6)] }));

    // 677.6 − 717.6 is −40: an absolute difference reads "-40 km from Lenzen".
    const meta = el.querySelector('.town__meta').textContent;
    expect(meta).toContain('40 km from Lenzen');
    expect(meta).not.toContain('-40');
    expect(meta).toContain('km 120');
  });

  it('measures a POI on a downstream day too', () => {
    const places = mount();
    places.render(renderArgs({ trip: DOWN, ...DOWN_STRETCH, food: [poi('Café', 677.6)] }));

    const meta = el.querySelector('.poi__meta').textContent;
    expect(meta).toContain('40 km from Lenzen');
    expect(meta).toContain('(km 120)');
  });

  it('shows a favorite at its rider km', () => {
    const places = mount();
    places.render(renderArgs({
      trip: UP,
      ...UP_STRETCH,
      favorites: [poi('Grenzturm', 349.3, 'sight')],
      dayNumberForKm: () => 3,
    }));

    const meta = el.querySelector('[data-place-section="fav"] .poi__meta').textContent;
    expect(meta).toContain('km 200');
    expect(meta).toContain('Day 3');
  });

  // tripKm is signed and unclamped by design (see trip.js): a place BEHIND the rider's
  // start is genuinely at a negative km on their trip. The signed number is what we
  // show — "km -3.2" is odd to read but it is true, and the alternatives are worse: 0
  // would put an off-trip favorite on the start line, and prose ("3.2 km behind you")
  // is a copy decision the spec does not make. The row already says "beyond plan".
  it('shows a favorite behind the rider’s start as a negative km', () => {
    const places = mount();
    places.render(renderArgs({
      trip: UP,
      ...UP_STRETCH,
      favorites: [poi('Hamburg dock', 146.1, 'sight')],
      dayNumberForKm: () => null,
    }));

    const row = el.querySelector('[data-place-section="fav"]');
    expect(row.querySelector('.poi__meta').textContent).toContain('km -3.2');
    expect(row.querySelector('.fav-day').textContent).toBe('beyond plan');
  });

  // The favorites list is the one list this panel orders itself: it is the global
  // starred list, not windowed to any stretch, and the store that holds it has no trip
  // to order it by (see the note at inRideOrder in places.js). Three favorites at the
  // same three absolute km, ridden both ways — the only variable between these two
  // tests is the trip's direction.
  const A = poi('A', 249.3, 'sight'); // UP: rider 100 · DOWN: rider 548.3
  const B = poi('B', 349.3, 'sight'); // UP: rider 200 · DOWN: rider 448.3
  const C = poi('C', 449.3, 'sight'); // UP: rider 300 · DOWN: rider 348.3

  function favNamesAndKm() {
    return [...el.querySelectorAll('[data-place-section="fav"]')].map((row) => [
      row.querySelector('.poi__name').textContent.replace(/^\S+\s/, ''),
      row.querySelector('.poi__meta').textContent.trim().split(' ').slice(0, 2).join(' '),
    ]);
  }

  it('lists favorites in ride order, whatever order they arrive in', () => {
    const places = mount();
    places.render(renderArgs({ trip: UP, ...UP_STRETCH, favorites: [C, A, B], dayNumberForKm: () => 1 }));

    // Arrived C, A, B and rendered A, B, C: the panel orders them, it does not just
    // pass an already-sorted list through.
    expect(favNamesAndKm()).toEqual([['A', 'km 100'], ['B', 'km 200'], ['C', 'km 300']]);
  });

  // The bug this closes: sorted by ABSOLUTE km, a downstream rider's starred places ran
  // back-to-front — the first row was the one they would reach LAST.
  it('runs the same favorites the other way round on a downstream trip', () => {
    const places = mount();
    const given = [A, B, C];
    places.render(renderArgs({ trip: DOWN, ...DOWN_STRETCH, favorites: given, dayNumberForKm: () => 1 }));

    expect(favNamesAndKm()).toEqual([['C', 'km 348.3'], ['B', 'km 448.3'], ['A', 'km 548.3']]);
    // Ordered on a copy: main.js hands this very array to map.setFavoriteMarkers after
    // the render returns, and lastArgs keeps a reference to it for "show all".
    expect(given).toEqual([A, B, C]);
  });

  // Reordering rows and resolving a click both go through data-place-index, so a
  // reordered list is exactly where the two can come apart — and the symptom is silent:
  // starring or ☕-ing one place would act on a different one. Every other favorite test
  // in this file renders a single row, where any alignment passes.
  it('resolves a click on a reordered favorite row to the row that was shown', () => {
    const places = mount();
    places.render(renderArgs({ trip: DOWN, ...DOWN_STRETCH, favorites: [A, B, C], dayNumberForKm: () => 1 }));

    const first = el.querySelector('[data-place-section="fav"]');
    expect(first.textContent).toContain('C'); // the place this rider meets first
    first.querySelector('.poi__name').click();

    expect(callbacks.onSelectPoi).toHaveBeenCalledWith(C);
  });

  // Ordering decides which favorites the 40-row cap KEEPS, which is the more serious
  // half: in absolute order a downstream rider with more than 40 starred places was
  // shown the 40 furthest from them and lost every one they would pass first.
  it('caps the favorites at the ones the rider meets first, not last', () => {
    const places = mount();
    // Absolute 200…244. Downstream the rider starts at 797.6, so 244 is met FIRST and
    // 200 last; the five that must drop off are the lowest absolute km, not the highest.
    const many = Array.from({ length: 45 }, (_, i) => poi(`Fav ${String(i).padStart(2, '0')}`, 200 + i, 'sight'));
    places.render(renderArgs({ trip: DOWN, ...DOWN_STRETCH, favorites: many, dayNumberForKm: () => 1 }));

    const rows = favNamesAndKm();
    expect(rows).toHaveLength(40);
    expect(rows[0]).toEqual(['Fav 44', 'km 553.6']);
    expect(rows[39]).toEqual(['Fav 05', 'km 592.6']);
    expect(el.textContent).not.toContain('Fav 00');
    expect(el.querySelector('.pois--fav .places__more').textContent).toContain('showing the first 40 of 45');
  });

  // The same argument the caps themselves were wrong about, one layer in: the front of a
  // signed-rider-km list is not the first place the rider reaches, it is the place
  // furthest BEHIND them — one they will never reach at all. So a cap taking the plain
  // front of it drops places on the trip in favour of places off it, under a footer
  // promising "the first 40". Reachable by design, not exotic: the starred list is global
  // and plan-independent, so leftovers from a previous plan on this road are the normal
  // case. Ahead of the start is therefore grouped first and the cap eats that group first.
  it('gives the cap the places ahead of the rider before any behind them', () => {
    const places = mount();
    const startLine = poi('Start line', 149.3, 'sight'); // rider km 0, exactly on the start
    const ahead = Array.from({ length: 35 }, (_, i) => poi(`Ahead ${String(i).padStart(2, '0')}`, 200 + i, 'sight'));
    const behind = Array.from({ length: 10 }, (_, i) => poi(`Behind ${String(i).padStart(2, '0')}`, 100 + i, 'sight'));

    places.render(renderArgs({
      trip: UP,
      ...UP_STRETCH,
      // Arriving behind-first, which is the order the old signed sort rendered them in.
      favorites: [...behind, startLine, ...ahead],
      dayNumberForKm: (km) => (km >= 149.3 && km <= 234 ? 1 : null),
    }));

    const rows = favNamesAndKm();
    expect(rows).toHaveLength(40);
    // Not one of the 36 places on the trip was dropped, so the footer's promise is true.
    expect(rows.filter(([name]) => name.startsWith('Ahead'))).toHaveLength(35);
    expect(rows[0]).toEqual(['Start line', 'km 0']); // rider km 0 counts as ahead, not behind
    expect(rows[35]).toEqual(['Ahead 34', 'km 84.7']);
    // ...and only then the tail, in the same monotone order, filling the 4 slots left.
    expect(rows[36]).toEqual(['Behind 00', 'km -49.3']);
    expect(rows[39]).toEqual(['Behind 03', 'km -46.3']);
    expect(el.textContent).not.toContain('Behind 04');
    expect(el.querySelector('.pois--fav .places__more').textContent).toContain('showing the first 40 of 46');
    // Task 6's tag still speaks for the tail.
    expect(el.querySelectorAll('[data-place-section="fav"]')[36].querySelector('.fav-day').textContent)
      .toBe('beyond plan');
  });

  it('falls back to the rider’s own start when no day is focused', () => {
    const places = mount();
    places.render({
      trip: UP,
      dayNumber: null,
      // A row is what makes the fallback observable at all: with no places rendered,
      // any fallback passes. The road's origin — the value this replaced — would
      // measure this town from 149.3 km behind the rider and read "169.3 km from".
      towns: [town('Rosenhof', 169.3)],
      food: [],
      sights: [],
      favorites: [],
      breakKeys: new Set(),
      favoriteKeys: new Set(),
      dayNumberForKm: () => null,
    });

    expect(el.querySelector('.places__scope-range').textContent).toBe('no day focused');
    expect(el.querySelector('.town__meta').textContent).toContain('20 km from your last stop');
  });
});
