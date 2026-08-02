import './style.css';
import { loadRoute, createRouteIndex, pointAtKm, stretchCoords, snap } from './route.js';
import { loadTowns, townsNear, nearestTown } from './towns.js';
import { loadPois, poisInRange } from './pois.js';
import { createTrip, proposeEnd } from './trip.js';
import { createItinerary, breakKey, fitDaysToLength } from './itinerary.js';
import { ARRIVED_EPSILON_KM, MIN_DAY_KM } from './boundaries.js';
import { createPlanStore } from './storage.js';
import { createFavorites, favKey } from './favorites.js';
import { createMap } from './map.js';
import { createBanner, createPickBanner } from './ui.js';
import { round1, townKey, poiKey, tripHeadline } from './ui-util.js';
import { createStrip } from './strip.js';
import { createStripResize } from './strip-resize.js';
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
  // The window belongs to the PLAN, so switching plans switches windows. These two
  // bindings are rebuilt as a PAIR, by loadPlanIntoModel and nowhere else:
  // createItinerary takes its trip once, at construction — which is what lets every day
  // chain off the window without re-passing it — so a new window means a new model, and
  // reassigning only `trip` would leave the model measuring against the old one.
  // Nothing outside boot() holds either object; every use below goes through these names.
  let trip;
  let itinerary;
  loadPlanIntoModel(store.getActivePlan());

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

  // Which end of the trip the next route click resolves ('start' | 'destination'), or
  // null. The app owns it: the two controls' pressed state, the prompt and the Escape
  // path all read it, and the map only REFLECTS it (see map.js's setPickingMode, which
  // is deliberately a plain setter so there is one owner of the fact). Not persisted —
  // a reload cancels a pick, which is right.
  let picking = null;

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

  // onRouteClick and onPickPoint are EXCLUSIVE: map.js routes a click to one or the
  // other depending on whether setPickingMode has the map armed, because a route click
  // already means "add a custom stop to the focused day" and a mode that meant both
  // would be a mode that meant neither.
  const map = createMap({
    routeFeature: route,
    onRouteClick: handleRouteClick,
    onPickPoint: handlePickPoint,
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
      // The scale line's own two ends are the controls that move them. Same handler as
      // the day panel's setup step: one picking flow, two places to reach it.
      onPickEnd: handlePickEnd,
    },
  });

  // Everything that re-lays-out the strip from OUTSIDE a render: the drag handle that
  // resizes it, the observer on its box, and the window listener that lowers its ceiling.
  // Declared here, beside the strip, and CALLED at the bottom of boot — after the first
  // renderAll — because that ordering is load-bearing. All three reach `strip.render()`
  // with no argument, and render() throws without a trip, which only a render WITH
  // arguments can give it. createStripResize reports the height it loaded from its own
  // constructor, synchronously, so it cannot be mounted any earlier; the observer's
  // initial callback is asynchronous and so has never been able to fire first, which is a
  // guarantee this would rather not depend on. (strip-resize.test.js's live-seam block
  // pins the constructor half.)
  function wireStripSize() {
    // The axis height travels as a custom property on the container: `.strip__axis` reads
    // it through CSS and strip.js measures the axis back through its own measureHeight
    // seam, so the elevation profile rescales without main.js reaching into strip.js's
    // DOM or strip.js learning that a resize handle exists. The floor, 46, lives in
    // style.css as the var() fallback.
    const stripResize = createStripResize({
      el: stripEl,
      // A UI preference, not plan data: one height for the app, kept out of the plans
      // blob so it is neither per-plan nor archived with a corridor change (spec §6b).
      storage: window.localStorage,
      onResize: (heightPx) => {
        stripEl.style.setProperty('--strip-axis-height', `${heightPx}px`);
        strip.render();
        // The strip and the map are two rows of one `auto minmax(0, 1fr) auto` grid at
        // height 100vh, so every pixel the strip takes comes off the map — and Leaflet
        // learns its container's new size only when told. It tracks the WINDOW itself,
        // which is why this is the only size change that has to say so.
        map.invalidate();
      },
    });

    // Every px in the strip's DOM derives from the axis width at render time, so a
    // width change (resizing the window, opening devtools) would otherwise leave
    // blocks and handles drawn at the old scale — and a remainder click, which
    // measures the axis rect live, would then disagree with them about where a km
    // sits. No km changes, so re-laying-out the state the strip already holds is
    // the whole fix; that is what render() with no argument does.
    //
    // Keyed on the width even though the observer is notified of both dimensions: the
    // strip's box grows in height whenever the handle above grows the axis, and that path
    // has already re-rendered — at one render per pointermove of a resize drag, a second
    // rebuild here would double the cost of the gesture to redraw an identical axis. A
    // height change the app did NOT cause (a web font landing and reflowing the summary
    // line) leaves the axis box, and every px derived from it, exactly as it was.
    let lastWidth = null;
    new ResizeObserver((entries) => {
      const { width } = entries[entries.length - 1].contentRect;
      if (width === lastWidth) return;
      lastWidth = width;
      strip.render();
    }).observe(stripEl);

    // The strip's ceiling is 45% of the VIEWPORT, and a window that gets shorter lowers
    // it. The observer above cannot see that happen: the body is a 100vh grid whose middle
    // row is `minmax(0, 1fr)`, so the map absorbs the loss and the strip's own box never
    // changes. Without this the ceiling would re-apply only on the next reload, where
    // createStripResize's load-time repair catches it.
    window.addEventListener('resize', () => stripResize.remeasure());
  }

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
      // Spec §6's "select this stop as destination": the day panel emits an index, and
      // the pick it becomes goes through the same applyPickedEnd the map does.
      onFinishHere: handleFinishHere,
      // The trip-setup step's Set start / Set finish. Same two data-actions the strip
      // uses and the same handler behind them; each module's listener is scoped to its
      // own root, so the shared names never collide.
      onPickEnd: handlePickEnd,
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

  // The picking prompt (spec §6/§8): what to click, what a pick made, and why one was
  // refused. Its own banner, not renderBanner's — that one is rewritten from plan state
  // on every save and would wipe a prompt parked in it (see createPickBanner).
  const pickBanner = createPickBanner({ el: document.getElementById('pick-banner') });

  // Anything overlaid on the map sits INSIDE the Leaflet container, so every event it
  // sees also reaches the map: a click would draft a custom stop on the focused day and
  // a press would start a pan. Leaflet's own disableClickPropagation is behind map.js's
  // import, so guard from the outside.
  //
  // The prompt needs this as much as the camera buttons do, and while a pick is armed it
  // needs it MORE: an unshielded click on the prompt — on its text, or on the `Use
  // Hamburg` button the snap offer puts there — is a route click, so the trip end would
  // land at whatever km happens to lie under the prompt rather than on the town.
  function shieldFromMap(el) {
    ['mousedown', 'touchstart', 'dblclick', 'click'].forEach((type) =>
      el.addEventListener(type, (e) => e.stopPropagation()),
    );
  }
  shieldFromMap(mapControlsEl);
  shieldFromMap(document.getElementById('pick-banner'));

  // Keeps its own stopPropagation: this handler is the camera buttons' behaviour and
  // must not depend on a shield registered elsewhere still being there.
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

  // Makes `plan` the one the app is editing: its window becomes the trip, the trip
  // becomes a fresh itinerary, and the plan's days and breaks are replayed into it.
  // Three steps that are only ever right together — boot and every plan switch both
  // come through here rather than each spelling them out.
  //
  // Storage guarantees both window ends are finite (it repairs a ruined one to the whole
  // road, end by end), so createTrip cannot throw here; totalKm rides along so a window
  // recorded against a longer road gets pulled onto this one. A missing plan — which
  // load() makes impossible — reads as the whole road with no days, rather than as a
  // reason to fail booting.
  function loadPlanIntoModel(plan) {
    trip = createTrip({ startKm: plan?.startKm, destinationKm: plan?.destinationKm, totalKm });
    itinerary = createItinerary({ trip });
    // Object form restores days AND breaks; a stored plan may predate breaks, so default
    // the field. The array form would leave the previous plan's breaks in place.
    itinerary.hydrate({ days: plan?.days ?? [], breaks: plan?.breaks ?? [] });
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
      //
      // Because every save from the app names it, storage's preserve-on-omit path is
      // unreachable from here — it exists for a future save site that forgets. One
      // consequence worth knowing: after a rebuild that SHORTENS the road, createTrip
      // pulls the stored window onto the new length, and the first save after boot
      // commits that clamp. The old destination is gone from storage at that point, so
      // a later rebuild restoring the length does not restore the window.
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
    // A plan switch is a window switch too: the incoming plan's days are lengths
    // measured along ITS trip, so the trip has to be the new one before they are
    // replayed. Same three steps as boot, same helper.
    loadPlanIntoModel(store.getActivePlan());
    // A different set of days is loaded, so any boundary gesture still in flight
    // belongs to the plan that just left (handleMoveBoundary).
    planGeneration += 1;
    // A different plan's days: the draft stop belongs to a day that no longer
    // exists, and clearing focus makes clampFocus pick the new plan's last day
    // rather than carrying over an index that merely still fits.
    customStopDraft = null;
    focusedDayIndex = null;
    lastFramedStretch = null; // a different stretch — frame it
    // A pick CONFIRMATION describes the trip it was made on, and this is a different
    // trip: left up, "your start → Prague · 877.5 km upstream" would sit over a plan
    // whose summary reads "0 / 1026.5 km planned". An ARMED prompt survives on purpose —
    // the mode belongs to the app rather than to the plan, and "click the route where
    // your trip starts" is still true of whichever plan is now loaded. (The pick banner
    // has no × by design, so nothing else would ever clear it.)
    if (!picking) pickBanner.hide();
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

  // "Near enough to BE there": the half-step of the 0.1 km grid every stored km sits
  // on, so a town names an end only when the two round to the same tenth. Move the end
  // 3 km and the name goes, because that is the truth.
  const NAME_TOLERANCE_KM = 0.05;
  // Spec §6.3's snap radius. At whole-route zoom one pixel is ~0.7 km, so a click is
  // worth ±2 km and a town this close is very likely the place the rider meant.
  const SNAP_OFFER_KM = 3;

  // What to call one end of the trip: the RIDER's ends, not the road's — on a
  // downstream trip the start IS the road's destination.
  //
  // Derived from the km, never stored. Spec's own definition is "a startKm, a
  // destinationKm, and nothing else", and a stored name would be a second source for
  // something the km already say — so there is no persisted field behind any of this,
  // no schema bump and no migration. A start that sits where a town sits is named by
  // that town; move it and the name goes with the km.
  function nameForTripEnd(tripEnd) {
    return nameAtKm(tripEnd === 'start' ? trip.startKm : trip.destinationKm);
  }

  // The same question asked of an arbitrary km rather than of a trip end, which is what
  // a refusal message needs: the km it is talking about is one the rider just PROPOSED,
  // and no end of the current trip sits there.
  //
  // The two road-end tests come FIRST and are rounded to 0.1 km, because that is the
  // gate strip-markup's `roadContinues` uses to decide whether an end is a road end (and
  // so whether to draw a stub past it). Two questions — "what is this end called" and
  // "is there road past it" — sharing one comparison. Change one, change the other, or
  // the app will name one end two ways on one screen. It is also what keeps a town near
  // a road end from renaming the road: Praha sits 0.3 km short of km 1026.5 and Cuxhaven
  // the town 3.5 km past km 0, and neither may stand in for the corridor's own endpoint.
  function nameAtKm(km) {
    if (round1(km) <= 0) return ORIGIN_NAME;
    if (round1(totalKm - km) <= 0) return DESTINATION_NAME;
    return nearestTown(towns, km, { withinKm: NAME_TOLERANCE_KM })?.name ?? null;
  }

  // The two names in the shape tripHeadline and the day panel both take. Derived
  // together so a caller cannot pass one end's name for the other's.
  function endNames() {
    return { startName: nameForTripEnd('start'), destinationName: nameForTripEnd('destination') };
  }

  // The same two names in the shape the strip keys them by — its own
  // 'start' | 'destination' tripEnd rather than tripHeadline's startName /
  // destinationName. One derivation, two spellings: the strip's markup reads a name by
  // the tripEnd it is already looping over, and translating there would put a second
  // pair of these words in a module that must hold no place names at all.
  function endNamesByTripEnd() {
    return { start: nameForTripEnd('start'), destination: nameForTripEnd('destination') };
  }

  // How a MESSAGE names a km: the town or road end it sits on, and failing that not a km
  // at all but the role it plays in the trip being proposed. Deliberately never an
  // absolute km — it would be the only absolute km on screen, which spec §2 names as
  // worse than all-absolute because nothing marks it as different. The unnamed case
  // reads a little awkwardly ("ride your finish → the point you picked"), and that is
  // the trade taken; a click within 50 m of a town avoids it, which a snapped pick
  // always is and a raw one at whole-route zoom rarely is.
  function endLabel(km) {
    const named = nameAtKm(km);
    if (named) return named;
    if (km === trip.startKm) return 'your start';
    if (km === trip.destinationKm) return 'your finish';
    return 'the point you picked';
  }

  // "from X" for a day: the previous day's overnight town, the rider's own start for
  // day 0, "your last stop" when the previous day has no town chosen.
  //
  // Day 0 used to read the ROAD's origin, which was a lie on every window that does
  // not begin at km 0: "from Cuxhaven · km 0 → 648.3" on a plan starting in Hamburg,
  // and "from Cuxhaven" on a whole-road plan ridden from Prague.
  function fromNameFor(index) {
    if (index === 0) return nameForTripEnd('start') ?? 'your start';
    return itinerary.getDays()[index - 1].townChoice?.name ?? 'your last stop';
  }

  // Every renderer below is handed the trip, and every km it puts on screen is counted
  // from the rider's start. The km in the records stay absolute — that is the whole of
  // the invariant, and the reason the conversion lives at the templates rather than here.
  // The road's own length reaches the strip on the trip (createTrip keeps it), so the
  // axis, the edge stubs and the window are one object rather than two arguments that
  // could describe different roads. The two names are the ROAD's ends — the strip
  // decides which of them names a trip end and which names a stub.
  function renderStrip(focusedIndex) {
    strip.render({
      days: itinerary.getDays(),
      trip,
      focusedIndex,
      breaks: itinerary.getBreaks(),
      originName: ORIGIN_NAME,
      destinationName: DESTINATION_NAME,
      // What the trip's OWN two ends are called — the towns they sit in, or the road's
      // name where an end is a road end. Sent on every render because it is derived
      // from the km on every render; the strip stores it only to survive an
      // argument-less re-layout, exactly as it does the two road names.
      endNames: endNamesByTripEnd(),
      elevation,
      // Which of the scale line's two end controls is drawn pressed. The strip RENDERS
      // the mode; it never owns it, which is why a cancel arrives here as picking: null
      // rather than as a call that unpresses a button in place.
      picking,
    });
  }

  function renderDayPanel(day) {
    dayPanel.render({
      day,
      trip,
      dayCount: itinerary.getDays().length,
      // Which breaks are on this day's leg is the model's question, not a render
      // decision: the half-open bucketing rule and day 0's start-line exception both
      // live in itinerary.breaksForDay (see dayOwnsKm there).
      breaks: day ? itinerary.breaksForDay(day.index) : [],
      fromName: day ? fromNameFor(day.index) : ORIGIN_NAME,
      customStopDraft,
      // Same question, same owner: the panel is told whether this day owns the draft
      // rather than deciding it from the day's km, where the rule was spelled a second
      // time and read backwards on a downstream trip.
      draftOnDay: !!(day && customStopDraft && itinerary.dayOwnsKm(day.index, customStopDraft.km)),
      climb: day && elevation ? ascentBetween(elevation, day.startKm, day.endKm) : null,
      // The trip-setup step (an empty plan) names both of the trip's own ends and arms
      // the same mode the strip's controls do. The names are the RIDER's ends, so on a
      // downstream trip startName is the road's destination — nameForTripEnd's whole job.
      ...endNames(),
      picking,
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
    // Absolute km, and the rider's own start when no day is focused: km 0 as they count
    // it. The road's origin would be a place BEHIND an offset rider, and the panel
    // measures its rows from this.
    const startKm = day ? day.startKm : trip.startKm;
    const endKm = day ? day.endKm : trip.startKm;
    // The span is in TRIP order, so it descends on a downstream trip; poisInRange
    // normalises it (it used to answer [] — an empty Food and Sights section for every
    // day of such a trip).
    const food = day && !poisMissing ? poisInRange(poiData, startKm, endKm, { kind: 'food' }) : [];
    const sights = day && !poisMissing ? poisInRange(poiData, startKm, endKm, { kind: 'sight' }) : [];
    // Which day owns a favorite's km — the favorites list's "Day 3" / "beyond plan" tag.
    // Asked of the model, once, rather than re-spelled in places.js; the day list is
    // captured here so the lookup does not rebuild it per favorite.
    const days = itinerary.getDays();
    const dayNumberForKm = (km) => {
      const owner = days.find((d) => itinerary.dayOwnsKm(d.index, km));
      return owner ? owner.index + 1 : null;
    };

    places.render({
      // 1-BASED here — the strip and the day panel both count days from 0.
      dayNumber: day ? day.index + 1 : null,
      trip,
      startKm,
      endKm,
      fromName: day ? fromNameFor(day.index) : ORIGIN_NAME,
      towns: day ? townsNear(towns, day.endKm) : [],
      selectedTownKey: day?.townChoice ? townKey(day.townChoice) : null,
      food,
      sights,
      favorites: favs,
      dayNumberForKm,
      breakKeys,
      favoriteKeys,
      poisMissing,
    });
    map.setPoiMarkers([...food, ...sights]);
    map.setFavoriteMarkers(favs);
  }

  // Where the RIDER starts, which is only the road's origin on an upstream trip that
  // begins at km 0. Trip state, so it is re-set on every render that is not a drag
  // preview — the trip's start cannot move during a boundary drag.
  function renderStartPin() {
    map.setStartPin({ coord: pointAtKm(routeIndex, trip.startKm), name: nameForTripEnd('start') });
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
      renderStartPin();
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
    // A resized day can strand the draft outside the day's stretch — drop it. Same
    // ownership question the day's legs are bucketed by, so a draft that survives is
    // one the day panel will actually list.
    const day = focusedDay();
    if (customStopDraft && day && !itinerary.dayOwnsKm(day.index, customStopDraft.km)) {
      customStopDraft = null;
    }
    persistPlan();
    renderAll();
  }

  // Spec §6: after planning a few days, make one of them the destination. The day's own
  // end is already a legal position on the trip, so the only guard that can bite is the
  // length one — a first day of 3 km cannot become a 3 km trip. It goes through
  // applyPickedEnd anyway, because a second copy of the guards is how the two drift.
  //
  // `offerSnap: false`, and this is the caller Task 12 kept the flag for. A map click is
  // a MEASUREMENT: at whole-route zoom one pixel is ~0.7 km, so naming the town the
  // rider probably meant corrects an error that is really there. A day boundary carries
  // no such error — it is the km the plan computed from a length that was typed, dragged
  // or snapped to a town, and it is the exact thing this button was pressed to keep.
  //
  // Measured with the flag flipped, on a five-day whole-road plan whose day 3 ends at
  // km 240 with Sumte as its overnight: the offer read "Alt Garge is 0.2 km behind your
  // finish — use it instead?", and one press moved the finish to 239.8, re-ran
  // fitDaysToLength against a length 0.2 km shorter, clamped day 3 from 80 km to 79.8,
  // and left it reading "Sumte sits at km 240; this day ends at km 239.8". The trip
  // ended up named after a town the rider had not chosen and was not sleeping in.
  //
  // The finish still gets NAMED when it lands on a town — nameAtKm is a separate
  // question, asked of the km rather than of the pick, and the same plan finishing at
  // km 239.5 reads "Cuxhaven → Stiepelse". What is declined is only the offer to MOVE it.
  function handleFinishHere(index) {
    const day = itinerary.getDays()[index];
    if (!day) return;
    applyPickedEnd('destination', round1(day.endKm), { offerSnap: false });
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
    // The model owns which day a km is on, so a confirmed draft lands on the day it was
    // drafted on rather than on none — a stop the day panel would never list.
    if (!itinerary.dayOwnsKm(day.index, km)) return;
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

  // --- Picking a trip end ------------------------------------------------

  // One of the four end controls was pressed — the scale line's two or the setup step's
  // two, which are the same two controls in two places.
  function handlePickEnd(tripEnd) {
    // A second press on the armed control cancels — spec §6, and the reason both
    // controls are toggles rather than plain buttons. Pressing the OTHER one re-arms:
    // exactly one end is ever being picked.
    picking = picking === tripEnd ? null : tripEnd;
    map.setPickingMode(picking);
    if (picking) {
      pickBanner.show(
        `Click the route where your trip ${picking === 'start' ? 'starts' : 'finishes'} · Esc to cancel`,
      );
    } else {
      pickBanner.hide();
    }
    // The pressed state is RENDERED, not toggled in place: the strip rebuilds its scale
    // line and the day panel its setup step on every render, so a class set by hand here
    // would survive exactly until the next one.
    renderAll();
  }

  // An armed click on the route. map.js hands over the raw lng/lat and the end it was
  // armed for; snapping to the route and to the 0.1 km grid is ours, the same way a day
  // pin's drag is snapped.
  function handlePickPoint(lngLat, tripEnd) {
    picking = null;
    map.setPickingMode(null);
    applyPickedEnd(tripEnd, round1(snap(route, lngLat).distanceKm));
  }

  // The one path from a picked km to a new window: the guards, the reflow, the save and
  // the sentence saying what happened. Three callers — a map pick, the snap offer and
  // Finish here — so a guard added here covers all three.
  //
  // `offerSnap` is how a caller says "this km is already the answer, do not offer to
  // move it". The plan justified it as what stops the offer looping — a snap landing
  // 0.4 km from ANOTHER town being answered with that one — and that is not what it
  // does: every town in the dataset sits on the 0.1 km grid (checked: 0 of 887 off it),
  // so a snap lands exactly ON its town, `nearestTown` answers that same town, and the
  // `gap !== 0` guard below already suppresses the second offer. It stays because the
  // knob is real for the OTHER callers, and `Finish here` is the one that uses it: it
  // hands over a day's end km, which is a boundary the rider chose rather than a town,
  // and offering to shift it onto a town 0.4 km away would undo the thing they just
  // asked for. See handleFinishHere.
  function applyPickedEnd(tripEnd, km, { offerSnap = true } = {}) {
    const decided = proposeEnd(trip, tripEnd, km, {
      dayCount: itinerary.getDays().length,
      minLengthKm: MIN_DAY_KM,
    });
    if (!decided.ok) {
      // A refused pick still disarmed the mode, and the pressed state is RENDERED — so
      // the refusal has to re-render too, or the control stays lit above a map that is
      // no longer armed and the next route click quietly drafts a custom stop instead.
      renderAll();
      refusePick(tripEnd, decided);
      return;
    }
    const dropped = setTripWindow(decided.trip);
    persistPlan();
    renderAll();
    reportPick(tripEnd, km, dropped, { offerSnap });
  }

  // The same three steps loadPlanIntoModel takes, with the days coming from memory
  // rather than from storage. A trip is fixed at construction — which is what lets every
  // day chain off the window without re-passing it — so a new window means a new
  // itinerary, replayed from the lengths the plan already has, trimmed to what still
  // fits (spec §8). Returns how many days did not.
  //
  // Breaks ride along untouched: they are absolute km and plan-level, so a window change
  // invalidates none of them (spec's "changing your start does not invalidate a single
  // favorite"). One consequence worth knowing: a break now outside the window keeps its
  // km and its row is simply not drawn — the strip filters glyphs to the window — and it
  // comes back if the window widens again.
  function setTripWindow(nextTrip) {
    const entries = itinerary
      .getDays()
      .map((d) => ({ targetKm: d.targetKm, townChoice: d.townChoice }));
    const breaks = itinerary.getBreaks();
    const fitted = fitDaysToLength(entries, nextTrip.lengthKm);
    trip = nextTrip;
    itinerary = createItinerary({ trip });
    itinerary.hydrate({ days: fitted.days, breaks });
    // A boundary gesture in flight belongs to the itinerary that just left — the same
    // reason a plan switch bumps this (see handleMoveBoundary).
    planGeneration += 1;
    customStopDraft = null; // its day may be gone, and its km may be off the trip
    lastFramedStretch = null; // every day's stretch moved
    return fitted.dropped;
  }

  function reportPick(tripEnd, km, dropped, { offerSnap = true } = {}) {
    const dropText = dropped
      ? ` · ${dropped} ${dropped === 1 ? 'day' : 'days'} no longer ${dropped === 1 ? 'fits' : 'fit'} and ${dropped === 1 ? 'was' : 'were'} dropped`
      : '';
    const role = tripEnd === 'start' ? 'start' : 'finish';
    // Spec §6.3: at whole-route zoom one pixel is ~0.7 km, so a click is worth ±2 km.
    // Name the town within SNAP_OFFER_KM and let one press take it.
    const town = offerSnap ? nearestTown(towns, km, { withinKm: SNAP_OFFER_KM }) : null;
    // In RIDER km, deliberately, and NOT the spec's absolute `(km 149.3)`. On a trip
    // starting at Hamburg the strip reads `km 0 · Hamburg`, so that figure would be the
    // only absolute km on screen — spec §2 names that as worse than all-absolute,
    // "because nothing marks it as different". The offset from the pick says the same
    // thing in the rider's own units, and it is the number that actually helps.
    const gap = town ? round1(trip.tripKm(town.routeDistanceKm) - trip.tripKm(km)) : 0;
    if (town && gap !== 0) {
      pickBanner.show(
        `${tripHeadline(trip, endNames())}${dropText} · ${town.name} is ${Math.abs(gap)} km ` +
          `${gap < 0 ? 'behind' : 'past'} your ${role} — use it instead?`,
        {
          // The offer takes the same path as any other pick, so a snap that would flip
          // or shorten the trip is refused by the same guards with the same words.
          action: {
            label: `Use ${town.name}`,
            onPress: () =>
              applyPickedEnd(tripEnd, round1(town.routeDistanceKm), { offerSnap: false }),
          },
        },
      );
      return;
    }
    // The trip itself is the confirmation, in the same sentence the setup step uses: a
    // rider who has just moved an end wants to know what the trip IS now, and "km 0" —
    // which is what a start always becomes — would tell them nothing.
    pickBanner.show(`${tripHeadline(trip, endNames())}${dropText}`);
  }

  // The guards are unit-tested in trip.test.js; their WORDING is this file's, and this
  // file has no test harness — so these two sentences are verified in the browser and
  // quoted verbatim into the ledger.
  function refusePick(tripEnd, decided) {
    const role = tripEnd === 'start' ? 'start' : 'finish';
    if (decided.reason === 'too-short') {
      pickBanner.show(
        `That ${role} would leave a trip of ${round1(decided.lengthKm)} km — a trip needs at least ${MIN_DAY_KM} km.`,
        { tone: 'error' },
      );
      return;
    }
    if (decided.reason === 'would-reverse') {
      // Spec §6's sentence, with the direction NAMED rather than merely refused. Since
      // Task 12 endLabel has the towns too, so the everyday shape of this reads as
      // "…ride Hamburg → Cuxhaven instead". It still falls back to a role for a km with
      // nothing within 50 m of it, and that is not the case the plan expected — the plan
      // claimed the opposite ("a whole-road trip is already named by both road ends, so
      // the common case reads right from here") and that is not reachable:
      //
      //   A proposal whose BOTH ends are road ends is never a reversal. Take the
      //   unchanged end U and the picked km P. If U = 0 the proposal's direction is
      //   forced the same way the current trip's already is, and likewise for U = totalKm
      //   — check all four (move start / move destination) × (U = 0 / U = totalKm) and
      //   every one comes out same-direction, or zero-length and refused as too-short
      //   first. So a whole-road trip cannot produce this refusal at all, and any
      //   reversal that does has at most ONE end on a road end: the picked one.
      //
      // Verified in the browser at every shape: "…ride the point you picked → your
      // finish instead", "…ride your start → the point you picked instead", and — from a
      // downstream trip whose start is picked off the end of the line at Cuxhaven —
      // "…ride Cuxhaven → your finish instead".
      pickBanner.show(
        `That would reverse the trip. Reset the trip to ride ${endLabel(decided.startKm)} → ${endLabel(decided.destinationKm)} instead.`,
        { tone: 'error' },
      );
      return;
    }
    // 'not-a-number' is a bug upstream, not a choice a rider made.
    console.warn('planner-app: ignored a pick with no finite km', decided);
  }

  // Escape cancels a pick, and failing that declines whatever the prompt is still
  // holding. Owned at the document because when a pick is armed the pointer is over the
  // MAP, and nothing there holds focus to hang a handler on. The two editors that own
  // Esc for themselves — the day panel's break-note editor and its custom-stop prompt —
  // both stopPropagation, so this cannot steal theirs.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (picking) {
      handlePickEnd(picking); // the toggle IS the cancel; one path, one place
      return;
    }
    // No mode armed, but the prompt may be parked with the snap offer from the last
    // pick — "Hamburg is 2.8 km past your start — use it instead?". An offer with no way
    // to say no would sit over the map until some later pick replaced it, and it is the
    // one thing in this line a keyboard can act on. The banner has no × by design (a
    // dismiss that left the mode armed would be a lie), so this is the way out.
    pickBanner.hide();
  });

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
  //
  // The WINDOW deliberately survives: "reset" empties the plan you made for a trip, it
  // does not undo the trip. Which is why this is not a loadPlanIntoModel path — the
  // model keeps the trip it has, and persistPlan writes that same window back.
  //
  // That is also the escape hatch the reversal refusal points at ("Reset the trip to
  // ride Hamburg → Cuxhaven instead"): proposeEnd refuses a flip only because days
  // measured along the old direction would be stranded, and after a reset there are
  // none — so the same pick, repeated, is then allowed. Nothing here had to change for
  // that to be true, which is why it is verified in the browser rather than in code.
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
  // Only now that the strip has been rendered WITH a trip: see wireStripSize.
  wireStripSize();
  // Tiles/layout can settle a frame late; nudge Leaflet to remeasure.
  requestAnimationFrame(() => map.invalidate());
}

boot().catch((err) => {
  // Surface bootstrap failures loudly rather than a blank page.
  console.error('planner-app failed to start', err);
});
