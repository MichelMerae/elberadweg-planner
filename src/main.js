import './style.css';
import { loadRoute, createRouteIndex, pointAtKm, stretchCoords, snap } from './route.js';
import { loadTowns, townsNear } from './towns.js';
import { loadPois, poisInRange } from './pois.js';
import { createTrip } from './trip.js';
import { createItinerary, breakKey } from './itinerary.js';
import { ARRIVED_EPSILON_KM, MIN_DAY_KM } from './boundaries.js';
import { createPlanStore } from './storage.js';
import { createFavorites, favKey } from './favorites.js';
import { createMap } from './map.js';
import { createBanner } from './ui.js';
import { round1, townKey, poiKey } from './ui-util.js';
import { createStrip } from './strip.js';
import { createDayPanel } from './day-panel.js';
import { createPlaces } from './places.js';
import { createPlansBar } from './plans-bar.js';
import { loadElevation, profileForRoute, ascentBetween } from './elevation.js';
import meta from './data/route.meta.json';

const DEFAULT_TARGET_KM = 80;
const ROUTE_CHANGED_MESSAGE =
  'The route data changed since you last planned this trip — day distances may have shifted.';

// Sentinel for "the camera is framing the whole route", which is what an empty
// plan gets — it has no focused stretch to key on.
const WHOLE_ROUTE = 'whole-route';

async function boot() {
  // POI data is optional: if it fails to load (e.g. build:data never ran), the
  // app still boots and the POI sections show a note. A rejected loadPois()
  // must not sink the whole Promise.all, so it resolves to null on failure.
  const [route, towns, pois, elevationRaw] = await Promise.all([
    loadRoute(),
    loadTowns(),
    loadPois().catch((err) => {
      console.warn('planner-app: POI data unavailable', err);
      return null;
    }),
    // Same contract as POIs: optional data, resolved to null on any failure, so an
    // app whose elevation build has never been run still boots.
    loadElevation(),
  ]);
  const totalKm = meta.totalKm;
  // The corridor's endpoints are data. Read once here so no module below holds a
  // place name of its own.
  const ORIGIN_NAME = meta.origin.name;
  const DESTINATION_NAME = meta.destination.name;
  // The header names the corridor, which is data rather than markup.
  const routeLabel = document.getElementById('app-route');
  if (routeLabel) routeLabel.textContent = `${ORIGIN_NAME} → ${DESTINATION_NAME}`;
  const poisMissing = pois == null;
  const poiData = pois || [];
  // Elevation sampled along a different corridor describes a different road, so it
  // is rejected rather than drawn — a wrong profile would look authoritative.
  const elevation = profileForRoute(elevationRaw, meta.routeId);

  // Built once: every render turns km into map coordinates (five day pins, the
  // whole focused stretch), and a boundary drag re-renders on every pointermove.
  // Straight off route.js's turf helpers that is ~250 ms a frame — measured — and
  // off the index it is microseconds.
  const routeIndex = createRouteIndex(route);

  // Storage owns the named plans; itinerary is now pure trip math fed from the
  // active plan via hydrate(). load() runs any v1→v2 migration and guarantees at
  // least one plan.
  // routeVersion (builtAt) drives the "distances may have shifted" banner for a
  // rebuild of the same corridor; routeId is coarser and drives the archive-and-
  // reset for a corridor whose km measure from a different origin entirely.
  // totalKm is where a plan that records no window ends — the store refuses to guess
  // the road's length rather than hand every such plan a zero-length trip at km 0.
  const store = createPlanStore({
    storage: window.localStorage,
    routeVersion: meta.builtAt,
    routeId: meta.routeId,
    totalKm,
  });
  const initial = store.load();
  const bootPlan = store.getActivePlan();
  // The window belongs to the PLAN, so switching plans switches windows. These two
  // bindings are rebuilt together, and only in hydrateActivePlan: createItinerary
  // takes its trip once, at construction — which is what lets every day chain off
  // the window without re-passing it — so a new window means a new model. Nothing
  // outside boot() holds either object; every use below goes through these names.
  let trip = tripFor(bootPlan);
  let itinerary = createItinerary({ trip });
  // Object form restores days AND breaks; a stored plan may predate breaks, so
  // default the field. Using the array form here would leave breaks untouched.
  itinerary.hydrate({ days: bootPlan.days, breaks: bootPlan.breaks ?? [] });

  // Favorites are a single global list, persisted independently of plans (its
  // key already holds any pins migrated from the v1 schema in sub-project 1).
  const favorites = createFavorites({ storage: window.localStorage });

  // Local mirror of the plans list ({id, name}) + active id for renderPlansBar.
  // Kept in sync from each mutation's return value rather than re-reading the
  // store, so a quota-failed persist doesn't drop an in-memory plan on reload.
  let planList = initial.plans.map((p) => ({ id: p.id, name: p.name }));
  let activePlanId = initial.activePlanId;

  // --- Focus (which day the panels and the map are pointed at) ------------
  // Exactly one day is focused whenever the plan has any days; the default is
  // the last one. Not persisted — a reload or plan switch focuses the last day.
  let focusedDayIndex = null;

  // A route click awaiting a label ({km, lat, lng}), always targeting the
  // focused day. Not persisted.
  let customStopDraft = null;

  // Which plan the itinerary currently holds: hydrateActivePlan bumps it, so a
  // boundary gesture can tell whether the plan it started in is still loaded.
  // gestureGeneration is the generation the open gesture began in, or null when no
  // gesture is open. See handleMoveBoundary.
  let planGeneration = 0;
  let gestureGeneration = null;

  // Clamped at both ends: three modules call handleFocusDay, and an index below 0
  // would survive to focusedDay() as undefined — every panel would report "no day
  // focused" while the plan plainly has days.
  function clampFocus() {
    const count = itinerary.getDays().length;
    focusedDayIndex = count ? Math.max(0, Math.min(focusedDayIndex ?? count - 1, count - 1)) : null;
  }

  function focusedDay() {
    if (focusedDayIndex == null) return null;
    return itinerary.getDays()[focusedDayIndex] ?? null;
  }

  // --- Camera policy ------------------------------------------------------
  // Fit the focused stretch whenever it changes; during a drag only pan when the
  // moving end is about to leave the viewport, then fit on release. A manual pan
  // or zoom hands the camera to the user, and only the ⤢ buttons take it back.
  //
  // Declared above createMap because map.js frames the whole route from inside
  // it, synchronously, and onUserMove closes over these.
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let cameraFollows = true;
  // What the camera last framed: the focused day's index AND its span. Keying on
  // the span too means a day whose boundary just moved gets reframed, while the
  // many re-renders that leave the stretch alone (a ☕ toggle, a hover, a break
  // edit) leave the user's own zoom where it is.
  let lastFramedStretch = null;

  const map = createMap({
    routeFeature: route,
    originName: ORIGIN_NAME,
    onRouteClick: handleRouteClick,
    onPoiClick: handleSelectPoi,
    // Map-marker hover highlights the matching row in the left panel.
    onPoiHover: (poi) => places.highlightPoiRow(poi ? poiKey(poi) : null),
    onUserMove: () => {
      cameraFollows = false;
    },
  });

  // Trip-level, so it sits in the header: which plan you are editing, its name,
  // and the plan-wide operations.
  const plansBar = createPlansBar({
    el: document.getElementById('plans'),
    callbacks: {
      onSelectPlan: handleSelectPlan,
      onRenamePlan: handleRenamePlan,
      onNewPlan: handleNewPlan,
      onDuplicatePlan: handleDuplicatePlan,
      onResetTrip: handleResetTrip,
      onDeletePlan: handleDeletePlan,
    },
  });

  const banner = createBanner({ el: document.getElementById('banner') });

  // The strip owns the whole-trip view. Boundary drags fire continuously with
  // commit:false for live feedback and once with commit:true on release, so a
  // drag writes to storage exactly once.
  const stripEl = document.getElementById('strip');
  const strip = createStrip({
    el: stripEl,
    callbacks: {
      onFocusDay: handleFocusDay,
      onMoveBoundary: handleMoveBoundary,
      onAddDay: handleAddDay,
    },
  });

  // Every px in the strip's DOM derives from the axis width at render time, so a
  // width change (resizing the window, opening devtools) would otherwise leave
  // blocks and handles drawn at the old scale — and a remainder click, which
  // measures the axis rect live, would then disagree with them about where a km
  // sits. No km changes, so re-laying-out the state the strip already holds is
  // the whole fix; that is what render() with no argument does.
  new ResizeObserver(() => strip.render()).observe(stripEl);

  // The right panel: the focused day and nothing else.
  const dayPanel = createDayPanel({
    el: document.getElementById('day-panel'),
    callbacks: {
      onEditDay: handleEditDay,
      onSplitDay: handleSplitDay,
      onDeleteDay: handleDeleteDay,
      onFocusDay: handleFocusDay,
      // The empty state's redundant "+ add a first day": same call the strip's
      // own button makes, so the app has a route to day 1 that does not depend on
      // the strip being reachable.
      onAddDay: () => handleAddDay(null),
      onRemoveBreak: handleRemoveBreak,
      onEditBreak: handleEditBreak,
      onAddCustomStop: handleAddCustomStop,
      onCancelCustomStop: handleCancelCustomStop,
    },
  });

  // The left panel: favorites, overnight candidates, food and sights.
  const places = createPlaces({
    el: document.getElementById('places'),
    callbacks: {
      onSelectTown: handleSelectTown,
      // A favorite row's body click and a fav map-marker click both pan/highlight
      // — identical to a POI select, so places routes both here.
      onSelectPoi: handleSelectPoi,
      onToggleBreak: handleToggleBreak,
      onToggleFavorite: handleToggleFavorite,
      // Panel-row hover highlights the matching marker on the map.
      onPoiRowHover: (poi) => map.setPoiHighlight(poi),
    },
  });

  const mapControlsEl = document.getElementById('map-controls');

  // The buttons sit inside the Leaflet container, so every event they see also
  // reaches the map: a click would draft a custom stop on the focused day and a
  // press would start a pan. Leaflet's own disableClickPropagation is behind
  // map.js's import, so guard from the outside.
  ['mousedown', 'touchstart', 'dblclick'].forEach((type) =>
    mapControlsEl.addEventListener(type, (e) => e.stopPropagation()),
  );

  mapControlsEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'focus-day') {
      // The only way back to an auto-following camera once a manual pan or zoom
      // has switched it off.
      cameraFollows = true;
      lastFramedStretch = null;
      renderCamera();
      return;
    }
    if (action === 'whole-route') {
      // Deliberately leaves cameraFollows off: the next re-render must not yank
      // the view back to the focused day.
      cameraFollows = false;
      lastFramedStretch = null;
      map.fitWholeRoute({ animate: !prefersReducedMotion });
    }
  });

  // The window a plan rides, as a trip. Storage guarantees both ends are finite (it
  // repairs a ruined one to the whole road end by end), so this cannot throw; totalKm
  // rides along so createTrip can pull a window recorded against a longer road onto
  // this one. A missing plan — which load() makes impossible — reads as the whole
  // road rather than as a reason to fail booting.
  function tripFor(plan) {
    return createTrip({
      startKm: plan?.startKm,
      destinationKm: plan?.destinationKm,
      totalKm,
    });
  }

  // Persist the active plan's committed state. Called ONLY after user
  // mutations — never at boot or right after a plan switch. Reason: a corrupt
  // stored plan hydrates to empty days; persisting straight after would
  // overwrite the stored plan with the emptied one (silent data loss).
  function persistPlan() {
    store.saveActivePlan({
      days: itinerary.getDays().map((d) => ({ targetKm: d.targetKm, townChoice: d.townChoice })),
      breaks: itinerary.getBreaks(),
      // Named explicitly even though storage preserves an omitted window: what it
      // means to save a plan is to save the days AND the trip they were measured
      // along, and a save site that says only half of that leaves the two to be kept
      // in step by luck.
      startKm: trip.startKm,
      destinationKm: trip.destinationKm,
    });
    // Saving stamps the plan with the current route version, so a stale
    // route-changed banner must clear now, not on the next plan switch.
    renderBanner();
  }

  // Loads the active plan into the itinerary. Used on every plan switch —
  // hydrate + render only, no persist.
  function hydrateActivePlan() {
    const active = store.getActivePlan();
    // A plan switch is a window switch: the incoming plan's days are lengths measured
    // along ITS trip, so the trip has to be the new one before they are replayed. The
    // itinerary is rebuilt with it (it holds the trip it was constructed on), which
    // also means the new model starts with no days and no breaks of its own.
    trip = tripFor(active);
    itinerary = createItinerary({ trip });
    // Object form so the new plan's breaks replace the previous plan's — the
    // array form would leak breaks across a plan switch.
    itinerary.hydrate({ days: active?.days ?? [], breaks: active?.breaks ?? [] });
    // A different set of days is loaded, so any boundary gesture still in flight
    // belongs to the plan that just left (handleMoveBoundary).
    planGeneration += 1;
    // A different plan's days: the draft stop belongs to a day that no longer
    // exists, and clearing focus makes clampFocus pick the new plan's last day
    // rather than carrying over an index that merely still fits.
    customStopDraft = null;
    focusedDayIndex = null;
    lastFramedStretch = null; // a different stretch — frame it
    renderBanner();
    renderAll();
  }

  function renderPlansBar() {
    plansBar.render({ plans: planList, activePlanId });
  }

  // The route-changed banner is per-plan: show it only when the active plan was
  // saved against a different route version. A brand-new plan has no
  // routeVersion until its first save — treat missing as current (no banner).
  // Re-evaluated on boot and every plan switch, so it clears when switching to a
  // plan built on the current route.
  function renderBanner() {
    const rv = store.getActivePlan()?.routeVersion;
    if (rv && rv !== meta.builtAt) banner.show(ROUTE_CHANGED_MESSAGE);
    else banner.hide();
  }

  // The plan is complete when the distance ridden comes within the shared arrival
  // tolerance of the TRIP's length — not the road's. Both sides are rider km: days
  // clamp at the destination, so totalPlannedKm() never quite exceeds trip.lengthKm.
  // Compared against totalKm instead, a 200 km window on a 1026 km road could never
  // be finished, and every day past its destination would still be offered.
  // The strip collapses its remainder on the same constant.
  function hasReachedDestination() {
    return itinerary.totalPlannedKm() >= trip.lengthKm - ARRIVED_EPSILON_KM;
  }

  // "from X" for a day: the previous day's overnight town, the route's origin for
  // day 0, "your last stop" when the previous day has no town chosen.
  function fromNameFor(index) {
    if (index === 0) return ORIGIN_NAME;
    return itinerary.getDays()[index - 1].townChoice?.name ?? 'your last stop';
  }

  // A day's own breaks, by km range, so editing a day re-buckets them
  // automatically. Constraint: a break exactly on the rider's start line must own a
  // leg somewhere — the (start, end] rule hands a shared km to the previous day and
  // day 1 has none, so it would belong to no day and have no × to remove it with.
  // `includeFrom` is itinerary's name for that, keyed on the day's INDEX: day 1 starts
  // wherever the trip does, which is only km 0 on a whole-road plan.
  function breaksForDay(day) {
    return itinerary.breaksInRange(day.startKm, day.endKm, { includeFrom: day.index === 0 });
  }

  // Whether an absolute route km falls on `day`'s leg, under the same rule
  // breaksForDay buckets by: half-open `(start, end]`, with day 1 also owning its own
  // start. Compared in RIDER km so the two ends keep meaning "behind" and "ahead"
  // whichever way the trip runs — the absolute-km form this replaced reads backwards
  // on a downstream trip, accepting exactly the km it should refuse.
  function dayOwnsKm(day, km) {
    const from = trip.tripKm(day.startKm);
    const at = trip.tripKm(km);
    return (day.index === 0 ? at >= from : at > from) && at <= trip.tripKm(day.endKm);
  }

  function renderStrip(focusedIndex) {
    strip.render({
      days: itinerary.getDays(),
      totalKm,
      focusedIndex,
      breaks: itinerary.getBreaks(),
      originName: ORIGIN_NAME,
      destinationName: DESTINATION_NAME,
      elevation,
    });
  }

  function renderDayPanel(day) {
    dayPanel.render({
      day,
      dayCount: itinerary.getDays().length,
      breaks: day ? breaksForDay(day) : [],
      fromName: day ? fromNameFor(day.index) : ORIGIN_NAME,
      customStopDraft,
      climb: day && elevation ? ascentBetween(elevation, day.startKm, day.endKm) : null,
    });
  }

  // The left panel is scoped to the focused day: candidates, food and sights all
  // come from that stretch. With no day focused, only favorites make sense.
  function renderPlaces(day) {
    const breakKeys = new Set(itinerary.getBreaks().map(breakKey));
    const favs = favorites.list();
    // Kind-prefixed (favKey: `${kind}:${name}@${km}`), unlike breakKeys — places
    // names the kind for each section and calls the same favKey to look a row up.
    const favoriteKeys = new Set(favs.map(favKey));
    const startKm = day ? day.startKm : 0;
    const endKm = day ? day.endKm : 0;
    const food = day && !poisMissing ? poisInRange(poiData, startKm, endKm, { kind: 'food' }) : [];
    const sights = day && !poisMissing ? poisInRange(poiData, startKm, endKm, { kind: 'sight' }) : [];

    places.render({
      // 1-BASED here — the strip and the day panel both count days from 0.
      dayNumber: day ? day.index + 1 : null,
      startKm,
      endKm,
      fromName: day ? fromNameFor(day.index) : ORIGIN_NAME,
      towns: day ? townsNear(towns, day.endKm) : [],
      selectedTownKey: day?.townChoice ? townKey(day.townChoice) : null,
      food,
      sights,
      favorites: favs,
      days: itinerary.getDays(),
      breakKeys,
      favoriteKeys,
      poisMissing,
    });
    map.setPoiMarkers([...food, ...sights]);
    map.setFavoriteMarkers(favs);
  }

  // Numbered boundary pins, the map's twin of the strip handles. map.js emits raw
  // lng/lat and ignores a rebuild while a pin is in flight; snapping to the route
  // and the 0.1 km grid are ours.
  function renderDayPins() {
    map.setDayPins(
      itinerary.getDays().map((day) => ({ index: day.index, coord: pointAtKm(routeIndex, day.endKm) })),
      {
        draggable: true,
        onDragBoundary: (index, lngLat, commit) => {
          handleMoveBoundary(index, round1(snap(route, lngLat).distanceKm), { commit });
        },
      },
    );
  }

  // The focused stretch, as the route's own vertices. Both the thick highlight
  // and the fit want the same thing: the real shape of the day, not a sampled
  // approximation of it.
  //
  // The span goes over in ROAD order, which is what stretchCoords reads — it answers
  // [] for a descending one, and a downstream day's span descends, so every day would
  // come back shapeless: no highlight drawn and the camera left on the previous day
  // (see renderCamera's zero-length guard). Neither consumer cares which way the
  // vertices run; one draws a polyline through them, the other fits their bounds.
  function focusedCoords(day) {
    if (!day) return [];
    return stretchCoords(
      routeIndex,
      Math.min(day.startKm, day.endKm),
      Math.max(day.startKm, day.endKm),
    );
  }

  function renderCamera({ dragging = false } = {}) {
    const day = focusedDay();
    // The highlight and the fit frame the same coordinates; derive them once.
    const coords = focusedCoords(day);
    map.setRouteHighlight(coords);
    if (!day) {
      if (cameraFollows && lastFramedStretch !== WHOLE_ROUTE) {
        if (map.fitWholeRoute({ animate: !prefersReducedMotion })) {
          lastFramedStretch = WHOLE_ROUTE;
        }
      }
      return;
    }
    if (!cameraFollows) return;
    if (dragging) {
      // Don't fight the drag: only nudge when the boundary nears the edge. This
      // does nothing for a PIN drag — map.js holds our camera still and lets
      // Leaflet's own autoPan carry the marker past the edge instead — but it is
      // what keeps a strip-handle drag's endpoint on screen.
      const end = pointAtKm(routeIndex, day.endKm);
      if (!map.isWellInsideView(end)) map.panTo(end);
      return;
    }
    const key = `${day.index}:${round1(day.startKm)}:${round1(day.endKm)}`;
    if (lastFramedStretch === key) return;
    // A zero-length day has no stretch to frame and focusRange declines it. The
    // record below already waits for a fit that ran, so this guard is belt and
    // braces — it keeps the intent legible here. A day can reach zero length: a
    // stored plan that outruns its window piles its trailing days at the
    // destination, which every one of them then clamps to.
    if (!coords.length) return;
    // Recorded only if the fit ran. map.js refuses camera moves while a pin drag
    // is in flight, and a frame booked but never drawn is one this stretch never
    // gets again — the map would sit on the old day with both panels reading the
    // new one, and only "⤢ this day" could break the tie.
    if (map.focusRange(coords, { animate: !prefersReducedMotion })) lastFramedStretch = key;
  }

  // `dragging` marks a boundary-drag preview, which arrives on every pointermove.
  // Everything that describes the moving boundary has to keep up with it; the
  // left panel does not, and measurably cannot — rebuilding its ~600 rows and
  // handing the map up to 80 fresh POI markers costs more than a frame, for a
  // stretch the user is in the middle of choosing and is not reading. It catches
  // up on release, which is also the only render the breaks can have changed in.
  function renderAll({ dragging = false } = {}) {
    clampFocus();
    // One focused day, named three ways: the strip takes a 0-based index (null
    // when nothing is focused), the day panel takes the record (0-based .index),
    // and places takes a 1-based number. Derived together, here, so the +1 can
    // never drift out of sight of the two that don't want it.
    const day = focusedDay();
    renderStrip(day ? day.index : null);
    renderDayPanel(day);
    if (!dragging) {
      renderPlaces(day);
      map.setBreakMarkers(itinerary.getBreaks());
    }
    renderDayPins();
    renderCamera({ dragging });
  }

  // --- Place callbacks ---------------------------------------------------

  // An overnight town IS the day's end, so choosing one snaps the boundary there
  // (the neighbour absorbs the change) — that is itinerary.setTownChoice's job.
  function handleSelectTown(town) {
    const day = focusedDay();
    if (!day) return;
    itinerary.setTownChoice(day.index, town);
    persistPlan();
    renderAll();
    map.panTo([town.lng, town.lat]);
  }

  // Row/marker click on a POI (also reused for favorite rows/markers): highlight
  // the matching panel row and pan the map to it — view-only. Committing happens
  // through the explicit ☕ break / ⭐ favorite actions, never a plain click.
  function handleSelectPoi(poi) {
    places.highlightPoiRow(poiKey(poi));
    map.panTo([poi.lng, poi.lat]);
  }

  // ☕ on a town/food/sight row toggles that place as a plan-level break. Towns
  // carry no kind of their own, so snapshot them as 'town' for the leg glyph.
  function handleToggleBreak(place) {
    const key = breakKey(place);
    const isBreak = itinerary.getBreaks().some((b) => breakKey(b) === key);
    if (isBreak) itinerary.removeBreak(key);
    else itinerary.addBreak({ ...place, kind: place.kind ?? 'town' });
    persistPlan();
    renderAll();
  }

  // × on a leg removes that break by key.
  function handleRemoveBreak(key) {
    itinerary.removeBreak(key);
    persistPlan();
    renderAll();
  }

  // ⭐ on any row toggles the place in the global favorites list. Towns carry no
  // kind, so snapshot them as 'town' (matching the break snapshot). Favorites
  // are their OWN store — this must NOT persistPlan. renderAll refreshes the
  // origin-list stars, the favorites section, and the gold markers.
  function handleToggleFavorite(place) {
    favorites.toggle({ ...place, kind: place.kind ?? 'town' });
    renderAll();
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

  // --- Day callbacks -----------------------------------------------------

  function handleFocusDay(index) {
    focusedDayIndex = index;
    // The draft belongs to the day it was clicked on. Carried onto another day it
    // would read as a negative distance into it, and confirming it would add the
    // stop to the day the user just left.
    customStopDraft = null;
    renderAll();
  }

  function handleEditDay(index, target) {
    itinerary.editDay(index, target);
    // A resized day can strand the draft outside the day's stretch — drop it.
    const day = focusedDay();
    if (customStopDraft && day && !dayOwnsKm(day, customStopDraft.km)) customStopDraft = null;
    persistPlan();
    renderAll();
  }

  function handleSplitDay(index) {
    if (!itinerary.splitDay(index)) return; // too short — the model refused
    persistPlan();
    renderAll();
  }

  function handleDeleteDay(index) {
    itinerary.deleteDay(index);
    // focusedDayIndex is deliberately left alone: clampFocus turns it into the
    // day that slid into the deleted one's place, or the new last day when the
    // deleted one was last.
    customStopDraft = null; // its day is gone
    persistPlan();
    renderAll();
  }

  // A boundary gesture — a map pin or a strip handle, held with finger A while
  // finger B works the header — can outlive the plan it started in, and the latched
  // index then goes wrong in two different ways. Both guards are needed; neither
  // subsumes the other:
  //
  //   existence   the day is gone. Reset trip, Delete plan and Delete day empty or
  //               shorten the plan the gesture is already in, and moveBoundary
  //               asserts on an index past the end. Same guard, same reason, as
  //               strip.js's emitMove. A same-plan deletion never changes the
  //               generation, so only this layer sees it.
  //   generation  the day still exists — in a different plan. A switch mid-gesture
  //               leaves the index pointing at the NEW plan's day, which passes the
  //               existence check whenever that plan is at least as long, and then
  //               rewrites a day the user never touched. Measured: dragging plan A's
  //               day-2 pin and switching to B mid-drag took B from [60, 70, 65] to
  //               [60, 107.7, 27.3] on release, silently.
  function handleMoveBoundary(index, endKm, { commit } = {}) {
    // A preview with no gesture open starts one. A keyboard nudge arrives as a lone
    // commit: it opens nothing, and the check below passes trivially.
    if (!commit && gestureGeneration === null) gestureGeneration = planGeneration;
    const fromAnotherPlan = gestureGeneration !== null && gestureGeneration !== planGeneration;
    // Every commit ends the gesture, refused or not, so the next one starts clean.
    if (commit) gestureGeneration = null;
    if (fromAnotherPlan || !itinerary.getDays()[index]) {
      // Not redundant with the renders the switch or the reset already ran: while a
      // pin drag is latched setDayPins refuses every rebuild, and map.js clears
      // draggingPinIndex just BEFORE handing us this commit — which makes this the
      // first render able to sweep the pins the gesture came from. Measured with
      // this line removed: 3 draggable pins left on an emptied plan, 0 with it.
      if (commit) renderAll();
      return;
    }
    itinerary.moveBoundary(index, endKm);
    if (commit) persistPlan();
    renderAll({ dragging: !commit });
  }

  // A remainder click gives an absolute end km; the + button gives null, meaning
  // "another day the length of the last one" (80 km for the first day).
  //
  // addDay takes a LENGTH — a positive distance ridden — so the clicked position is
  // converted to rider km before the plan's own reach is subtracted from it. Both
  // terms then count from the rider's start: subtracting totalPlannedKm() straight
  // off an absolute km silently added the trip's own offset to every day the strip
  // created, and on a downstream trip it came out negative.
  //
  // Two clamps on the computed length. MIN_DAY_KM is the floor: a click within
  // 5 km of the plan end — or, from a caller that measured against something
  // other than the remainder, before it — would otherwise append a day shorter
  // than the model allows, or an inverted one. And the result is rounded to the
  // 0.1 km grid: addDay stores the length verbatim, so this is the one entry
  // point that could put an off-grid boundary into the plan (every other write
  // path rounds), and a remainder click is off-grid by nature.
  function handleAddDay(endKm) {
    if (hasReachedDestination()) return;
    const days = itinerary.getDays();
    const plannedKm = itinerary.totalPlannedKm();
    const fallback = days.length ? days[days.length - 1].targetKm : DEFAULT_TARGET_KM;
    const length = endKm == null ? fallback : Math.max(MIN_DAY_KM, trip.tripKm(endKm) - plannedKm);
    itinerary.addDay(round1(length));
    focusedDayIndex = itinerary.getDays().length - 1;
    customStopDraft = null;
    persistPlan();
    renderAll();
  }

  // --- Custom stops ------------------------------------------------------

  // A route click adds a stop to the focused day. Moving a boundary is dragging
  // its pin or its strip handle — the click no longer means two different things
  // depending on a mode.
  function handleRouteClick(lngLat) {
    const day = focusedDay();
    if (!day) return;
    const { distanceKm } = snap(route, lngLat);
    const km = round1(distanceKm);
    // Same rule the break bucketing uses, so a confirmed draft lands on the day it was
    // drafted on rather than on none — a stop the day panel would never list.
    if (!dayOwnsKm(day, km)) return;
    const [lng, lat] = pointAtKm(routeIndex, km);
    customStopDraft = { km, lat, lng };
    renderAll();
  }

  // Add-stop prompt confirmed: the draft becomes a plan-level custom break.
  function handleAddCustomStop(label) {
    const day = focusedDay();
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
    renderAll();
  }

  // --- Plan callbacks ----------------------------------------------------

  function handleSelectPlan(id) {
    const active = store.setActivePlan(id);
    if (!active) return;
    activePlanId = active.id;
    hydrateActivePlan();
    renderPlansBar(); // keep dropdown + name field in sync with the new active plan
  }

  function handleNewPlan() {
    const plan = store.createPlan();
    if (!plan) return;
    planList.push({ id: plan.id, name: plan.name });
    activePlanId = plan.id;
    hydrateActivePlan();
    renderPlansBar();
  }

  function handleDuplicatePlan() {
    const plan = store.duplicatePlan(activePlanId);
    if (!plan) return;
    planList.push({ id: plan.id, name: plan.name });
    activePlanId = plan.id;
    hydrateActivePlan();
    renderPlansBar();
  }

  // Empties the active plan — every day and every break — while the plan keeps
  // its id, name and place in the dropdown. The trip-level counterpart to the day
  // panel's Delete day, and the thing Delete plan is NOT: that takes the plan
  // itself. Nothing to hydrate (the itinerary is already the new state), so this
  // is an ordinary mutation: persist, then render.
  function handleResetTrip() {
    // Nothing to empty: return before persisting. A write here would bump
    // updatedAt for no change, and updatedAt is what deletePlan picks the
    // surviving plan by — so resetting an already-empty plan quietly changed
    // which plan a later Delete would leave you in.
    if (!itinerary.getDays().length && !itinerary.getBreaks().length) return;
    itinerary.reset();
    customStopDraft = null; // the day it was drafted on is gone
    persistPlan();
    renderAll();
  }

  function handleDeletePlan() {
    const deletedId = activePlanId;
    // deletePlan returns the plan that becomes active afterwards (the
    // most-recently-updated survivor, or a fresh "My plan" if it was the last).
    const active = store.deletePlan(deletedId);
    if (!active) return;
    planList = planList.filter((p) => p.id !== deletedId);
    if (!planList.some((p) => p.id === active.id)) {
      // The store created a fresh plan (we deleted the last one).
      planList.push({ id: active.id, name: active.name });
    }
    activePlanId = active.id;
    hydrateActivePlan();
    renderPlansBar();
  }

  function handleRenamePlan(name) {
    const plan = store.renamePlan(activePlanId, name);
    if (!plan) return;
    const entry = planList.find((p) => p.id === activePlanId);
    if (entry) entry.name = plan.name;
    // Patched, not re-rendered (see plans-bar.js's updateActiveName): a rename
    // lands on the name field's blur, and rebuilding the bar under a mousedown
    // swallows the click that caused the blur. No re-hydrate either — the plan's
    // days have not changed, only its name.
    plansBar.updateActiveName(plan.name);
  }

  renderPlansBar();
  renderBanner();
  renderAll();
  // Tiles/layout can settle a frame late; nudge Leaflet to remeasure.
  requestAnimationFrame(() => map.invalidate());
}

boot().catch((err) => {
  // Surface bootstrap failures loudly rather than a blank page.
  console.error('planner-app failed to start', err);
});
