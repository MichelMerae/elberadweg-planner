// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPlaces } from './places.js';
import { favKey } from './favorites.js';

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
    ...STRETCH,
    towns: [],
    food: [],
    sights: [],
    favorites: [],
    breakKeys: new Set(),
    favoriteKeys: new Set(),
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
  it('renders 40 rows and says how many there are', () => {
    const places = mount();
    places.render(renderArgs({ food: MANY }));

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(40);
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
      days: [{ index: 0, startKm: 0, endKm: 265 }],
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
      days: [{ index: 0, startKm: 0, endKm: 265 }],
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

// Day ownership is (startKm, endKm], widened at km 0 so day 1 owns the start —
// the same convention main.js uses for breaks.
describe('createPlaces - favorite day tags', () => {
  const DAYS = [
    { index: 0, startKm: 0, endKm: 265 },
    { index: 1, startKm: 265, endKm: 320 },
  ];

  it('gives a favorite on a boundary to the day that ends there', () => {
    const places = mount();
    places.render(renderArgs({
      favorites: [poi('Boundary', 265, 'sight'), poi('Just past', 265.1, 'sight')],
      days: DAYS,
    }));

    const rows = [...el.querySelectorAll('[data-place-section="fav"]')];
    expect(rows[0].querySelector('.fav-day').textContent).toBe('Day 1');
    expect(rows[1].querySelector('.fav-day').textContent).toBe('Day 2');
  });

  it('gives a favorite at km 0 to day 1', () => {
    const places = mount();
    places.render(renderArgs({ favorites: [poi('Hamburg dock', 0, 'sight')], days: DAYS }));

    expect(el.querySelector('[data-place-section="fav"] .fav-day').textContent).toBe('Day 1');
  });

  it('marks a favorite no day covers', () => {
    const places = mount();
    places.render(renderArgs({ favorites: [poi('Far Away', 600, 'sight')], days: DAYS }));

    const tag = el.querySelector('[data-place-section="fav"] .fav-day');
    expect(tag.textContent).toBe('beyond plan');
    expect(tag.classList.contains('fav-day--beyond')).toBe(true);
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
