// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPlaces } from './places.js';

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

const STRETCH = { dayNumber: 3, startKm: 160, endKm: 265, fromName: 'Lenzen' };

// jsdom does no layout, so scrollIntoView is missing entirely — the highlight
// path calls it to bring a marker's row into view.
window.Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('createPlaces - scoping', () => {
  it('says which day the lists belong to', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: [], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.querySelector('.places__scope').textContent).toContain('Day 3');
    expect(el.querySelector('.places__scope').textContent).toContain('km 160 → 265');
  });
});

describe('createPlaces - overnight candidates', () => {
  it('lists candidates with day-relative distance', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [town('Rosenhof', 265, 0.4)],
      food: [], sights: [], favorites: [],
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    const row = el.querySelector('[data-place-section="town"]');
    expect(row.textContent).toContain('Rosenhof');
    expect(row.textContent).toContain('105 km from Lenzen');
    expect(row.textContent).toContain('0.4 km off route');
  });

  it('chooses a town as the overnight on a body click', () => {
    const places = mount();
    const t = town('Rosenhof', 265);
    places.render({ ...STRETCH, towns: [t], food: [], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    el.querySelector('[data-place-section="town"] .town__name').click();

    expect(callbacks.onSelectTown).toHaveBeenCalledWith(t);
  });

  it('marks the town that is already the overnight choice', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [town('Rosenhof', 265)],
      selectedTownKey: 'Rosenhof@265',
      food: [], sights: [], favorites: [],
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    expect(el.querySelector('[data-place-section="town"]').classList.contains('town--selected')).toBe(true);
  });
});

describe('createPlaces - row actions', () => {
  it('toggles a break and a favorite without triggering the body action', () => {
    const places = mount();
    const p = poi('Café Elbterrasse', 195);
    places.render({ ...STRETCH, towns: [], food: [p], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    const row = el.querySelector('[data-place-section="food"]');
    row.querySelector('[data-action="break"]').click();
    row.querySelector('[data-action="fav"]').click();

    expect(callbacks.onToggleBreak).toHaveBeenCalledWith(p);
    expect(callbacks.onToggleFavorite).toHaveBeenCalledWith(p);
    expect(callbacks.onSelectPoi).not.toHaveBeenCalled();
  });

  it('reflects break and favorite state on the buttons', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [], sights: [], favorites: [],
      food: [poi('Café Elbterrasse', 195)],
      breakKeys: new Set(['Café Elbterrasse@195']),
      favoriteKeys: new Set(['food:Café Elbterrasse@195']),
    });

    const row = el.querySelector('[data-place-section="food"]');
    expect(row.querySelector('[data-action="break"]').getAttribute('aria-pressed')).toBe('true');
    expect(row.querySelector('[data-action="fav"]').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('createPlaces - the 40-row cap', () => {
  const many = Array.from({ length: 451 }, (_, i) => poi(`Place ${i}`, 161 + i * 0.2));

  it('renders 40 rows and says how many there are', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many, sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(40);
    expect(el.querySelector('.places__more').textContent).toContain('showing 40 nearest of 451');
  });

  it('expands to the full list when asked', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many, sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    el.querySelector('[data-action="show-all"]').click();

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(451);
    expect(el.querySelector('.places__more')).toBeNull();
  });

  it('collapses back to 40 when the focused day changes', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many, sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });
    el.querySelector('[data-action="show-all"]').click();

    places.render({ ...STRETCH, dayNumber: 4, startKm: 265, endKm: 320, towns: [], food: many, sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(40);
  });

  it('shows no footer when a section fits', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many.slice(0, 12), sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.querySelector('.places__more')).toBeNull();
  });

  it('expands only the section that was asked', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many, sights: many, favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    el.querySelector('.pois--food [data-action="show-all"]').click();

    expect(el.querySelectorAll('[data-place-section="food"]')).toHaveLength(451);
    expect(el.querySelectorAll('[data-place-section="sight"]')).toHaveLength(40);
  });
});

describe('createPlaces - missing POI data', () => {
  it('says the data is missing instead of pretending the stretch is empty', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [town('Rosenhof', 265)],
      food: [], sights: [], favorites: [],
      poisMissing: true,
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    expect(el.querySelector('.pois__note').textContent).toContain('npm run build:data');
    expect(el.querySelector('.pois--food')).toBeNull();
    // The candidate list is independent of POI data and must still render.
    expect(el.querySelector('[data-place-section="town"]')).not.toBeNull();
  });
});

describe('createPlaces - favorites', () => {
  it('tags each favorite with the day that covers it', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [], food: [], sights: [],
      favorites: [poi('Grenzturm', 213, 'sight'), poi('Far Away', 600, 'sight')],
      days: [{ index: 0, startKm: 0, endKm: 265 }],
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    const rows = [...el.querySelectorAll('[data-place-section="fav"]')];
    expect(rows[0].textContent).toContain('Day 1');
    expect(rows[1].textContent).toContain('beyond plan');
  });

  it('invites a first favorite when there are none', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: [], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    expect(el.textContent).toContain('Nothing starred yet');
  });
});

describe('createPlaces - hover', () => {
  it('reports a hovered POI once and clears on exit', () => {
    const places = mount();
    const p = poi('Café Elbterrasse', 195);
    places.render({ ...STRETCH, towns: [], food: [p], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

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
    places.render({ ...STRETCH, towns: [], food: [first, second], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    el.querySelectorAll('[data-place-section="food"]')[1]
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    expect(callbacks.onPoiRowHover).toHaveBeenCalledWith(second);
  });

  // Towns and favorites have no POI marker for the map to light up (only food
  // and sight rows carry a data-poi-key), so hovering them reports nothing.
  it('stays quiet when a town row is hovered', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [town('Rosenhof', 265)], food: [], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    el.querySelector('[data-place-section="town"]')
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

    expect(callbacks.onPoiRowHover).not.toHaveBeenCalled();
  });
});

describe('createPlaces - row identity', () => {
  it('resolves a clicked row against its own section', () => {
    const places = mount();
    const sight = poi('Grenzturm', 213, 'sight');
    places.render({
      ...STRETCH,
      towns: [],
      food: [poi('Bäckerei', 170), poi('Café Elbterrasse', 195)],
      sights: [sight],
      favorites: [],
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    el.querySelector('[data-place-section="sight"]').click();

    expect(callbacks.onSelectPoi).toHaveBeenCalledWith(sight);
  });

  it('resolves a row past the cap after expanding', () => {
    const many = Array.from({ length: 451 }, (_, i) => poi(`Place ${i}`, 161 + i * 0.2));
    const places = mount();
    places.render({ ...STRETCH, towns: [], food: many, sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });
    el.querySelector('[data-action="show-all"]').click();

    el.querySelectorAll('[data-place-section="food"]')[200].click();

    expect(callbacks.onSelectPoi).toHaveBeenCalledWith(many[200]);
  });
});

describe('createPlaces - keyboard', () => {
  it('chooses a town with Enter on the row', () => {
    const places = mount();
    const t = town('Rosenhof', 265);
    places.render({ ...STRETCH, towns: [t], food: [], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    el.querySelector('[data-place-section="town"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(callbacks.onSelectTown).toHaveBeenCalledWith(t);
  });

  it('leaves Enter on a nested action button to the button', () => {
    const places = mount();
    places.render({ ...STRETCH, towns: [town('Rosenhof', 265)], food: [], sights: [], favorites: [], breakKeys: new Set(), favoriteKeys: new Set() });

    el.querySelector('[data-place-section="town"] [data-action="break"]')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(callbacks.onSelectTown).not.toHaveBeenCalled();
  });
});

describe('createPlaces - escaping', () => {
  it('renders hostile OSM text as text', () => {
    const places = mount();
    const nasty = '<img src=x onerror="boom()">';
    places.render({
      ...STRETCH,
      towns: [town(nasty, 265)],
      food: [{ ...poi('Ok', 195), category: '<b>cafe</b>' }],
      sights: [], favorites: [],
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    expect(el.querySelector('.town__name img')).toBeNull();
    expect(el.querySelector('.town__name').textContent).toBe(nasty);
    expect(el.querySelector('.poi--food .poi__cat b')).toBeNull();
  });
});

describe('createPlaces - marker hover highlight', () => {
  it('highlights the row matching a POI key and clears on null', () => {
    const places = mount();
    places.render({
      ...STRETCH,
      towns: [],
      food: [poi('Bäckerei', 170), poi('Café Elbterrasse', 195)],
      sights: [], favorites: [],
      breakKeys: new Set(), favoriteKeys: new Set(),
    });

    places.highlightPoiRow('Café Elbterrasse@195');
    const rows = [...el.querySelectorAll('[data-place-section="food"]')];
    expect(rows[1].classList.contains('poi--hover')).toBe(true);
    expect(rows[0].classList.contains('poi--hover')).toBe(false);

    places.highlightPoiRow(null);
    expect(el.querySelector('.poi--hover')).toBeNull();
  });
});
