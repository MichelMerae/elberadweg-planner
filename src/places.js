// The left panel: everything you can choose from, windowed to the focused day's
// stretch — favorites, overnight candidates, food, sights. One delegated
// listener serves all four sections. No Leaflet, no data modules: main.js
// windows the lists and passes them in.

import { esc, round1, townKey, poiKey, FAV_GLYPH } from './ui-util.js';

// Presentation-only stopgap: a dense stretch can hold 450+ food POIs, and a
// panel that scrolls 50,000 px is unusable. Ranking/grouping is a separate
// project — until then, show the nearest 40 and say how many there are.
const ROW_CAP = 40;

// Day-relative wording (spec §4): distance from the day's reference point (the
// last overnight stop), absolute route km shown small in a .meta__abs span.
// fromName is an OSM-derived town name, so escape it before innerHTML use.
function townMeta(town, dayStartKm, fromName) {
  const rel = round1(town.routeDistanceKm - dayStartKm);
  return `${rel} km from ${esc(fromName)} · ${town.offsetKm} km off route <span class="meta__abs">km ${round1(town.routeDistanceKm)}</span>`;
}

// Same day-relative wording as towns, but the absolute km sits inline in
// parentheses (spec §4) rather than in a trailing .meta__abs span.
function poiMeta(poi, dayStartKm, fromName) {
  const rel = round1(poi.routeDistanceKm - dayStartKm);
  return `${rel} km from ${esc(fromName)} (km ${round1(poi.routeDistanceKm)}) · ${poi.offsetKm} km off route`;
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

function dayTagFor(fav, days) {
  // Same (startKm, endKm] convention as breaks, including the km-0 widening
  // main.js applies in breaksForDay: day 1 owns a place at exactly km 0.
  const day = days.find(
    (d) => fav.routeDistanceKm > (d.startKm === 0 ? -1 : d.startKm) && fav.routeDistanceKm <= d.endKm,
  );
  return day ? `Day ${day.index + 1}` : 'beyond plan';
}

export function createPlaces({ el, callbacks = {} }) {
  // Rendered rows, per section, so a delegated click can resolve back to the
  // record without re-deriving it (the windowing functions return fresh objects
  // each render, so reference equality can't be used).
  let lists = { fav: [], town: [], food: [], sight: [] };
  let expanded = new Set();
  let scopeKey = '';
  // Last render arguments, so "show all" can re-render the same state with one
  // more section expanded without main.js having to be involved.
  let lastArgs = {};

  function section(name, label, items, emptyText, renderRow) {
    const capped = expanded.has(name) ? items : items.slice(0, ROW_CAP);
    const body = capped.length
      ? capped.map(renderRow).join('')
      : `<p class="pois__empty">${esc(emptyText)}</p>`;
    const more =
      items.length > capped.length
        ? `<p class="places__more">showing ${capped.length} nearest of ${items.length} ·
             <button type="button" data-action="show-all" data-section="${name}">show all</button></p>`
        : '';
    return `
      <details class="pois pois--${name}" open>
        <summary class="pois__summary">${label} <span class="pois__count">(${items.length})</span></summary>
        <div class="pois__body">${body}${more}</div>
      </details>`;
  }

  function townRow(town, i, { startKm, fromName, selectedTownKey, breakKeys, favoriteKeys }) {
    const selected = townKey(town) === selectedTownKey ? ' town--selected' : '';
    const isBreak = breakKeys.has(townKey(town));
    // Favorites use the kind-prefixed key shape; towns carry no kind of their
    // own, so build the lookup the way main.js snapshots them.
    const isFav = favoriteKeys.has(`town:${townKey(town)}`);
    return `
      <div class="town${selected}" role="button" tabindex="0"
           data-place-section="town" data-place-index="${i}">
        <span class="town__name">${esc(town.name)}</span>
        <span class="town__place">${esc(town.place)}</span>
        ${rowActions(town.name, isBreak, isFav)}
        <span class="town__meta">${townMeta(town, startKm, fromName)}</span>
      </div>`;
  }

  function poiRow(poi, i, kind, { startKm, fromName, breakKeys, favoriteKeys }) {
    const hours = poi.openingHours ? `<span class="poi__hours">${esc(poi.openingHours)}</span>` : '';
    const isBreak = breakKeys.has(poiKey(poi));
    const isFav = favoriteKeys.has(`${kind}:${poiKey(poi)}`);
    return `
      <div class="poi poi--${kind}" role="button" tabindex="0"
           data-place-section="${kind}" data-place-index="${i}" data-poi-key="${esc(poiKey(poi))}">
        <span class="poi__name">${esc(poi.name)}</span>
        <span class="poi__cat">${esc(poi.category.replace(/_/g, ' '))}</span>
        ${rowActions(poi.name, isBreak, isFav)}
        <span class="poi__meta">${poiMeta(poi, startKm, fromName)}</span>
        ${hours}
      </div>`;
  }

  function favRow(fav, i, { days, breakKeys }) {
    const glyph = FAV_GLYPH[fav.kind] || '⭐';
    const cat = fav.category ? `<span class="poi__cat">${esc(fav.category.replace(/_/g, ' '))}</span>` : '';
    const tag = dayTagFor(fav, days);
    const beyond = tag === 'beyond plan' ? ' fav-day--beyond' : '';
    // ⭐ is always active here (every row IS a favorite); ☕ reflects whether the
    // place is currently a committed break, matched on the non-prefixed key.
    return `
      <div class="poi poi--fav" role="button" tabindex="0"
           data-place-section="fav" data-place-index="${i}">
        <span class="poi__name">${glyph} ${esc(fav.name)}</span>
        ${cat}
        ${rowActions(fav.name, breakKeys.has(poiKey(fav)), true)}
        <span class="poi__meta">km ${round1(fav.routeDistanceKm)} <span class="fav-day${beyond}">${tag}</span></span>
      </div>`;
  }

  function render(args = {}) {
    lastArgs = args;
    const {
      dayNumber = null,
      startKm = 0,
      endKm = 0,
      fromName = 'your last stop',
      towns = [],
      selectedTownKey = null,
      food = [],
      sights = [],
      favorites = [],
      days = [],
      breakKeys,
      favoriteKeys,
      poisMissing = false,
    } = args;
    const breakSet = breakKeys instanceof Set ? breakKeys : new Set(breakKeys || []);
    const favSet = favoriteKeys instanceof Set ? favoriteKeys : new Set(favoriteKeys || []);
    // A different stretch is a different question — collapse expanded sections
    // back to the cap so switching days never inherits a 451-row list.
    const nextScope = `${startKm}:${endKm}`;
    if (nextScope !== scopeKey) {
      scopeKey = nextScope;
      expanded = new Set();
    }
    lists = { fav: favorites, town: towns, food, sight: sights };

    const ctx = { startKm, fromName, selectedTownKey, breakKeys: breakSet, favoriteKeys: favSet };
    const scope = dayNumber
      ? `<span><b>On the way</b> · Day ${dayNumber}</span>
         <span class="places__scope-range">km ${round1(startKm)} → ${round1(endKm)}</span>`
      : '<span><b>On the way</b></span><span class="places__scope-range">no day focused</span>';

    // POI data is optional (build:data may never have run); the food and sight
    // sections say so rather than pretending the stretch is empty.
    const poiSections = poisMissing
      ? '<p class="pois__note">No POI data — run npm run build:data</p>'
      : section('food', '☕ Food on the way', food, 'No food stops on this stretch.', (p, i) => poiRow(p, i, 'food', ctx)) +
        section('sight', '📷 Worth seeing', sights, 'No sights on this stretch.', (p, i) => poiRow(p, i, 'sight', ctx));

    el.innerHTML = `
      <div class="places__scope">${scope}</div>
      ${section('fav', '⭐ Favorites', favorites, 'Nothing starred yet — hit ⭐ on any place.', (f, i) => favRow(f, i, { days, breakKeys: breakSet }))}
      ${section('town', '🛏 Overnight options', towns, 'No towns near this stretch.', (t, i) => townRow(t, i, ctx))}
      ${poiSections}`;
  }

  // One delegated listener for all four sections. A body click runs the section's
  // select callback; a click on a nested [data-action] button runs break/fav and
  // stops there, so the body action doesn't also fire.
  el.addEventListener('click', (e) => {
    const showAll = e.target.closest('[data-action="show-all"]');
    if (showAll) {
      expanded.add(showAll.dataset.section);
      render(lastArgs); // scope is unchanged, so `expanded` survives
      return;
    }
    const row = e.target.closest('[data-place-section]');
    if (!row) return;
    const place = lists[row.dataset.placeSection]?.[Number(row.dataset.placeIndex)];
    if (!place) return;
    const action = e.target.closest('[data-action]');
    if (action) {
      e.stopPropagation();
      if (action.dataset.action === 'break') callbacks.onToggleBreak?.(place);
      else if (action.dataset.action === 'fav') callbacks.onToggleFavorite?.(place);
      return;
    }
    if (row.dataset.placeSection === 'town') callbacks.onSelectTown?.(place);
    else callbacks.onSelectPoi?.(place);
  });

  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-place-section]');
    if (!row || e.target !== row) return; // inner action buttons handle their own keys
    e.preventDefault();
    row.click();
  });

  // Hovering a row reports the POI (or null on leave) so the map can highlight
  // the matching marker. Only food and sight rows carry a data-poi-key — towns
  // and favorites have no POI marker to light up. mouseover repeats while moving
  // across a row's children, so dedupe by key.
  let lastRowHoverKey = null;
  el.addEventListener('mouseover', (e) => {
    const row = e.target.closest('[data-poi-key]');
    if (!row) return;
    if (row.dataset.poiKey === lastRowHoverKey) return;
    lastRowHoverKey = row.dataset.poiKey;
    const poi = lists[row.dataset.placeSection]?.[Number(row.dataset.placeIndex)];
    if (poi && callbacks.onPoiRowHover) callbacks.onPoiRowHover(poi);
  });
  el.addEventListener('mouseout', (e) => {
    const row = e.target.closest('[data-poi-key]');
    if (!row) return;
    // Ignore moves between a row's own children; only fire on a real exit.
    if (row.contains(e.relatedTarget)) return;
    lastRowHoverKey = null;
    if (callbacks.onPoiRowHover) callbacks.onPoiRowHover(null);
  });

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
      [...el.querySelectorAll('[data-poi-key]')].find((row) => row.dataset.poiKey === key) || null;
    if (hoveredRow) {
      hoveredRow.classList.add('poi--hover');
      hoveredRow.scrollIntoView({ block: 'nearest' });
    }
  }

  return { render, highlightPoiRow };
}
