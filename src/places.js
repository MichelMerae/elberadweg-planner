// The left panel: everything you can choose from, windowed to the focused day's
// stretch — favorites, overnight candidates, food, sights. One delegated
// listener serves all four sections. No Leaflet and no data of its own: main.js
// windows the lists and passes them in.
//
// The places, the stretch and the favorites all arrive in ABSOLUTE route km; every km
// a row shows is counted from the rider's own start, through the `trip` render() is
// given. There is deliberately no fallback for a missing trip: a display module that
// quietly counts from the road's origin instead is the one bug this feature can
// produce, and it produces it silently — every number still looks like a number.
//
// Every km-ordered list here runs in the rider's DIRECTION OF TRAVEL — the first row is
// the first place they will reach — which matters twice over, because the 40-row cap
// keeps the front of each list (see ROW_CAP). Food and sights arrive that way already
// (poisInRange orders them); favorites are ordered here, being the one list with no
// stretch to carry a direction (see inRideOrder).
//
// The overnight candidates are the deliberate exception: towns.js ranks them by how well
// each suits the day's END — distance to it, weighted against the detour off route — and
// its measure is symmetric, so the ranking already means the same thing in both
// directions. Best-first is the point of that list; ride order would be a downgrade.

import { esc, round1, townKey, poiKey, favGlyphFor } from './ui-util.js';
// The one model import, and only for the key builder — a pure function, no store
// and no storage, the same trade strip.js makes with boundaries.js. The favorites
// Set main.js hands us is keyed with favKey, so spelling that shape by hand on
// this side is a contract nothing binds: change the separator there and every
// star switches off with the suite still green.
import { favKey } from './favorites.js';

// Presentation-only stopgap: a dense stretch can hold 450+ food POIs, and a panel
// that scrolls 50,000 px is unusable. Ranking/grouping is a separate project —
// until then, show the first 40 along the stretch and say how many there are.
//
// A PREFIX of each list, which is what makes those 40 the first 40 the rider will
// reach: every list here already runs in the rider's direction of travel, so the cap
// has only to take the front of it. It used to take the front of an absolute-km
// ascending list, which downstream is the far end of the day — a rider looking for
// lunch was shown the cafés they would reach last.
//
// The order, not nearest-by-detour, and map.js's POI_MAP_CAP must agree on both the
// number and the criterion: the map draws that same set, and marker-hover highlights a
// row by key, so a marker whose row was never rendered highlights nothing. They agree
// by construction rather than by coincidence — main.js hands both this panel and the
// map the one array poisInRange returned, and each takes its first 40. (map.js imports
// nothing but Leaflet, which is why the constant is duplicated rather than shared.)
const ROW_CAP = 40;

// Distance ridden from one absolute km to another, counted the rider's way: positive
// along the trip whichever direction it runs. tripKm is linear, so the difference of
// two conversions IS the ride — and an absolute difference is its negation downstream,
// which read "-40 km from Lenzen" on every row of such a trip.
function rideKm(trip, fromKm, toKm) {
  return trip.tripKm(toKm) - trip.tripKm(fromKm);
}

// Day-relative wording (spec §4): distance from the day's reference point (the
// last overnight stop), then the place's own km — counted from the rider's start,
// like every km on screen — shown small in a .meta__abs span.
// fromName is an OSM-derived town name, so escape it before innerHTML use.
//
// The detour is rounded like every other km on screen. It arrives with two
// decimals, and printing it raw put "0.05 km off route" here and "0.1 km off
// route" in the day panel for the same town at the same moment.
function townMeta(town, dayStartKm, fromName, trip) {
  const rel = round1(rideKm(trip, dayStartKm, town.routeDistanceKm));
  return `${rel} km from ${esc(fromName)} · ${round1(town.offsetKm)} km off route <span class="meta__abs">km ${round1(trip.tripKm(town.routeDistanceKm))}</span>`;
}

// Same day-relative wording as towns, but the place's own km sits inline in
// parentheses (spec §4) rather than in a trailing .meta__abs span.
function poiMeta(poi, dayStartKm, fromName, trip) {
  const rel = round1(rideKm(trip, dayStartKm, poi.routeDistanceKm));
  return `${rel} km from ${esc(fromName)} (km ${round1(trip.tripKm(poi.routeDistanceKm))}) · ${round1(poi.offsetKm)} km off route`;
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

// Every list this panel shows runs in the rider's direction of travel, so the first
// row is the first place they will reach. For the food and sights lists that is
// already true when they arrive — poisInRange returns a stretch in the order its span
// was asked in, and main.js asks in trip order — and the favorites list is the one
// exception, ordered HERE.
//
// It has to be: the starred list is global rather than windowed to a stretch, so there
// is no span to carry a direction, and the store that holds it is shared across plans
// and has no trip to order by. This module holds both the list and the trip, which
// makes it the only place the question can be answered.
//
// Sorted through trip.tripKm rather than by `(a - b) * trip.direction`, which is the
// same number: the conversion has one owner, and a change to it should reach this
// list without anyone remembering to come back here. Copied, not sorted in place —
// main.js hands the same array to map.setFavoriteMarkers afterwards.
//
// tripKm is signed, so a favorite starred BEHIND the rider's start is at a negative
// rider km and one past their destination is beyond the trip's length. Both stay on the
// one monotone axis — the order these places would be met riding the whole road this way
// — and the row's own "beyond plan" tag is what says a place is not on the plan.
//
// But the ones BEHIND the start are then grouped to the tail, and that grouping is the
// whole reason this is not a plain sort. The front of a signed list is not the first
// place the rider reaches: it is the place furthest behind them, which they will never
// reach at all. `section`'s cap takes the FRONT of this list, so a plain sort spent the
// 40 rows on places off the trip before it reached places on it — the same false
// promise the caps themselves used to make, one layer in, and printed under the same
// "showing the first 40" footer. Grouped, the cap fills itself with the trip first and
// only spends what is left over on the road behind, so the promise is true again.
//
// Reachable by design rather than exotic: the starred list is global and
// plan-independent — which is why the ordering has to happen here at all — so favorites
// left over from a previous plan on this road are the ordinary case, not a corner one.
//
// Places past the DESTINATION need no such handling: they sort last on the same axis, so
// the cap already drops them before anything the rider will actually pass.
//
// Sorted through trip.tripKm rather than by `(a - b) * trip.direction`, which is the
// same number: the conversion has one owner, and a change to it should reach this
// list without anyone remembering to come back here. Copied, not sorted in place —
// main.js hands the same array to map.setFavoriteMarkers afterwards.
function inRideOrder(places, trip) {
  const riderKm = (place) => trip.tripKm(place.routeDistanceKm);
  const sorted = [...places].sort((a, b) => riderKm(a) - riderKm(b));
  // Two passes over one sorted array, so each group keeps that order internally. Rider
  // km 0 is the start LINE and belongs to the trip, not to the road behind it.
  return [...sorted.filter((p) => riderKm(p) >= 0), ...sorted.filter((p) => riderKm(p) < 0)];
}

// Which day a favorite falls on is the model's question: `dayNumberForKm` is
// itinerary.dayOwnsKm's answer (1-based, or null when no day owns the km), handed down
// by main.js. This file only words it. Deciding it here meant a third copy of the
// half-open rule and of day 1's start-line exception — spelled in absolute km against a
// hardcoded km 0, so on an offset trip day 1 lost its start line and on a downstream
// trip every favorite came back "beyond plan".
function dayTagFor(fav, dayNumberForKm) {
  const dayNumber = dayNumberForKm(fav.routeDistanceKm);
  return dayNumber == null ? 'beyond plan' : `Day ${dayNumber}`;
}

export function createPlaces({ el, callbacks = {} }) {
  // Rendered rows, per section, so a delegated click can resolve back to the
  // record without re-deriving it (the windowing functions return fresh objects
  // each render, so reference equality can't be used).
  let lists = { fav: [], town: [], food: [], sight: [] };
  let expanded = new Set();
  let scopeKey = '';
  // Last render arguments, so "show all" can re-render the same state with one
  // more section expanded without main.js having to be involved. Copied rather
  // than held by reference: a caller that reuses one state object between
  // renders must not be able to move the stretch out from under that click.
  let lastArgs = {};
  // The POI the cursor is on, so a mouseover repeating across a row's children
  // reports once; and the POI a map marker asked us to highlight, so the class
  // can be re-applied after a render has replaced every row.
  let lastRowHoverKey = null;
  let highlightKey = null;

  function section(name, label, items, emptyText, renderRow) {
    const capped = expanded.has(name) ? items : items.slice(0, ROW_CAP);
    const body = capped.length
      ? capped.map(renderRow).join('')
      : `<p class="pois__empty">${esc(emptyText)}</p>`;
    const more =
      items.length > capped.length
        ? `<p class="places__more">showing the first ${capped.length} of ${items.length} ·
             <button type="button" data-action="show-all" data-section="${name}">show all</button></p>`
        : '';
    return `
      <details class="pois pois--${name}" open>
        <summary class="pois__summary">${label} <span class="pois__count">(${items.length})</span></summary>
        <div class="pois__body">${body}${more}</div>
      </details>`;
  }

  function townRow(town, i, { startKm, fromName, selectedTownKey, breakKeys, favoriteKeys, trip }) {
    const selected = townKey(town) === selectedTownKey ? ' town--selected' : '';
    const isBreak = breakKeys.has(townKey(town));
    // Favorites use the kind-prefixed key shape. A town candidate carries no kind
    // of its own — it becomes one only once starred — so name the kind here and
    // let favKey build the string, the way main.js snapshots the Set.
    const isFav = favoriteKeys.has(favKey({ ...town, kind: 'town' }));
    return `
      <div class="town${selected}" role="button" tabindex="0"
           data-place-section="town" data-place-index="${i}">
        <span class="town__name">${esc(town.name)}</span>
        <span class="town__place">${esc(town.place)}</span>
        ${rowActions(town.name, isBreak, isFav)}
        <span class="town__meta">${townMeta(town, startKm, fromName, trip)}</span>
      </div>`;
  }

  function poiRow(poi, i, kind, { startKm, fromName, breakKeys, favoriteKeys, trip }) {
    const hours = poi.openingHours ? `<span class="poi__hours">${esc(poi.openingHours)}</span>` : '';
    const isBreak = breakKeys.has(poiKey(poi));
    // The section's kind, not the record's: the two agree for every POI the data
    // produces, and this row is in this section either way.
    const isFav = favoriteKeys.has(favKey({ ...poi, kind }));
    return `
      <div class="poi poi--${kind}" role="button" tabindex="0"
           data-place-section="${kind}" data-place-index="${i}" data-poi-key="${esc(poiKey(poi))}">
        <span class="poi__name">${esc(poi.name)}</span>
        <span class="poi__cat">${esc(poi.category.replace(/_/g, ' '))}</span>
        ${rowActions(poi.name, isBreak, isFav)}
        <span class="poi__meta">${poiMeta(poi, startKm, fromName, trip)}</span>
        ${hours}
      </div>`;
  }

  function favRow(fav, i, { dayNumberForKm, breakKeys, trip }) {
    const glyph = favGlyphFor(fav);
    const cat = fav.category ? `<span class="poi__cat">${esc(fav.category.replace(/_/g, ' '))}</span>` : '';
    const tag = dayTagFor(fav, dayNumberForKm);
    const beyond = tag === 'beyond plan' ? ' fav-day--beyond' : '';
    // ⭐ is always active here (every row IS a favorite); ☕ reflects whether the
    // place is currently a committed break, matched on the non-prefixed key.
    return `
      <div class="poi poi--fav" role="button" tabindex="0"
           data-place-section="fav" data-place-index="${i}">
        <span class="poi__name">${glyph} ${esc(fav.name)}</span>
        ${cat}
        ${rowActions(fav.name, breakKeys.has(poiKey(fav)), true)}
        <span class="poi__meta">km ${round1(trip.tripKm(fav.routeDistanceKm))} <span class="fav-day${beyond}">${tag}</span></span>
      </div>`;
  }

  function render(args = {}) {
    // The header above says there is no fallback for a missing trip; this is what makes
    // that true rather than incidental. The conversions below are all inside row
    // builders, so a caller that forgot the trip AND named its own startKm/endKm
    // rendered a panel with no rows perfectly quietly — and the first starred place
    // turned that into a TypeError with no hint of which argument was missing.
    if (!args.trip || typeof args.trip.tripKm !== 'function') {
      throw new Error('places render needs a trip (see createTrip in src/trip.js)');
    }
    lastArgs = { ...args };
    const {
      dayNumber = null,
      trip,
      // The focused day's stretch, in ABSOLUTE route km. With no day focused there is
      // no stretch, and the rider's own start stands in for one: km 0 as they count it.
      // Zero would be the ROAD's origin, which on an offset trip is behind them.
      startKm = trip.startKm,
      endKm = trip.startKm,
      fromName = 'your last stop',
      towns: townsIn,
      selectedTownKey = null,
      food: foodIn,
      sights: sightsIn,
      favorites: favoritesIn,
      // itinerary.dayOwnsKm's answer for a km, 1-based, from main.js. See dayTagFor.
      dayNumberForKm,
      breakKeys,
      favoriteKeys,
      poisMissing = false,
    } = args;
    // Not destructuring defaults: those fire only on `undefined`, so an explicit
    // null — a caller reading a list straight off a nullable field — threw here
    // where the ui.js this replaced tolerated it.
    const [towns, food, sights, favorites] = [townsIn, foodIn, sightsIn, favoritesIn].map((value) =>
      Array.isArray(value) ? value : [],
    );
    const breakSet = breakKeys instanceof Set ? breakKeys : new Set(breakKeys || []);
    const favSet = favoriteKeys instanceof Set ? favoriteKeys : new Set(favoriteKeys || []);
    // A different stretch is a different question — collapse expanded sections
    // back to the cap so switching days never inherits a 451-row list. Keyed on the
    // absolute km deliberately: an identity for the stretch, never rendered.
    const nextScope = `${startKm}:${endKm}`;
    if (nextScope !== scopeKey) {
      scopeKey = nextScope;
      expanded = new Set();
    }
    // Ordered before section() caps it, because the cap keeps a PREFIX: ordering after
    // it would pick the wrong 40 and then sort those 40 nicely. `lists` holds the same
    // ordered array the rows are built from — a click resolves back through
    // data-place-index, so the two cannot be allowed to disagree.
    const favRows = inRideOrder(favorites, trip);
    lists = { fav: favRows, town: towns, food, sight: sights };

    const ctx = { startKm, fromName, selectedTownKey, breakKeys: breakSet, favoriteKeys: favSet, trip };
    // Day numbers here are 1-based, but they are 0-based nearly everywhere else
    // in the app — only an absent one means "no day focused", never a zero.
    const scope = dayNumber != null
      ? `<span><b>On the way</b> · Day ${dayNumber}</span>
         <span class="places__scope-range">km ${round1(trip.tripKm(startKm))} → ${round1(trip.tripKm(endKm))}</span>`
      : '<span><b>On the way</b></span><span class="places__scope-range">no day focused</span>';

    // POI data is optional (build:data may never have run); the food and sight
    // sections say so rather than pretending the stretch is empty.
    const poiSections = poisMissing
      ? '<p class="pois__note">No POI data — run npm run build:data</p>'
      : section('food', '☕ Food on the way', food, 'No food stops on this stretch.', (p, i) => poiRow(p, i, 'food', ctx)) +
        section('sight', '📷 Worth seeing', sights, 'No sights on this stretch.', (p, i) => poiRow(p, i, 'sight', ctx));

    el.innerHTML = `
      <div class="places__scope">${scope}</div>
      ${section('fav', '⭐ Favorites', favRows, 'Nothing starred yet — hit ⭐ on any place.', (f, i) => favRow(f, i, { dayNumberForKm, breakKeys: breakSet, trip }))}
      ${section('town', '🛏 Overnight options', towns, 'No towns near this stretch.', (t, i) => townRow(t, i, ctx))}
      ${poiSections}`;

    // Every row is a fresh node now. The cursor's dedupe key must not outlive
    // the node it was set for — a removed row fires no mouseout, so the next
    // hover of that row would be swallowed as a repeat (a ☕ toggle re-renders
    // under a stationary cursor, so this happens on ordinary use). A marker's
    // highlight, by contrast, belongs to a hover that is still happening, so it
    // is re-applied rather than dropped.
    lastRowHoverKey = null;
    applyHighlight({ scroll: false });
  }

  // One delegated listener for all four sections. A body click runs the
  // section's select callback; a click on a nested [data-action] button runs
  // break/fav and returns before reaching that, so the body action doesn't also
  // fire.
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
  // The key outlives the row so a re-render can restore the class.
  function highlightPoiRow(key) {
    highlightKey = key || null;
    applyHighlight({ scroll: true });
  }

  // Looked up by key, never by held node — rows are replaced wholesale, and a
  // remembered element would be a detached node one render later. Only a fresh
  // marker hover scrolls: re-applying after a render must not drag the panel
  // away from wherever the user has scrolled it.
  function applyHighlight({ scroll }) {
    el.querySelector('.poi--hover')?.classList.remove('poi--hover');
    if (!highlightKey) return;
    const row = [...el.querySelectorAll('[data-poi-key]')].find(
      (candidate) => candidate.dataset.poiKey === highlightKey,
    );
    if (!row) return;
    row.classList.add('poi--hover');
    if (scroll) row.scrollIntoView({ block: 'nearest' });
  }

  return { render, highlightPoiRow };
}
