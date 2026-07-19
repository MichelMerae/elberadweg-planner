import './style.css';
import { loadRoute, pointAtDistance, snap } from './route.js';
import { loadTowns, townsNear } from './towns.js';
import { loadPois, poisInRange } from './pois.js';
import { createItinerary } from './itinerary.js';
import { createPlanStore } from './storage.js';
import { createMap } from './map.js';
import { createUI, townKey, poiKey } from './ui.js';
import meta from './data/route.meta.json';

const DEFAULT_TARGET_KM = 80;
// The plan is considered complete when the last endKm is within this of the
// route total (endKm clamps to totalKm, so it never quite exceeds it).
const DRESDEN_EPSILON_KM = 0.5;
const ROUTE_CHANGED_MESSAGE =
  'The route data changed since you last planned this trip — day distances may have shifted.';

async function boot() {
  // POI data is optional: if it fails to load (e.g. build:data never ran), the
  // app still boots and the POI sections show a note. A rejected loadPois()
  // must not sink the whole Promise.all, so it resolves to null on failure.
  const [route, towns, pois] = await Promise.all([
    loadRoute(),
    loadTowns(),
    loadPois().catch((err) => {
      console.warn('planner-app: POI data unavailable', err);
      return null;
    }),
  ]);
  const totalKm = meta.totalKm;
  const poisMissing = pois == null;
  const poiData = pois || [];

  // Storage owns the named plans; itinerary is now pure trip math fed from the
  // active plan via hydrate(). load() runs any v1→v2 migration and guarantees at
  // least one plan.
  const store = createPlanStore({ storage: window.localStorage, routeVersion: meta.builtAt });
  const initial = store.load();
  const itinerary = createItinerary({ totalKm });
  itinerary.hydrate(store.getActivePlan().days);

  // Local mirror of the plans list ({id, name}) + active id for renderPlans.
  // Kept in sync from each mutation's return value rather than re-reading the
  // store, so a quota-failed persist doesn't drop an in-memory plan on reload.
  let planList = initial.plans.map((p) => ({ id: p.id, name: p.name }));
  let activePlanId = initial.activePlanId;

  // --- Pending-day state (not yet committed) ----------------------------
  let pendingTarget = DEFAULT_TARGET_KM;
  let pendingTown = null;

  const map = createMap({
    routeFeature: route,
    onRouteClick: handleRouteClick,
    onPoiClick: handleSelectPoi,
    // Map-marker hover highlights the matching row in the left panel.
    onPoiHover: (poi) => ui.highlightPoiRow(poi ? poiKey(poi) : null),
  });

  const ui = createUI({
    controlsEl: document.getElementById('controls'),
    plansEl: document.getElementById('plans'),
    townsEl: document.getElementById('towns'),
    poisEl: document.getElementById('pois'),
    itineraryEl: document.getElementById('itinerary'),
    bannerEl: document.getElementById('banner'),
    callbacks: {
      onPendingChange: handlePendingChange,
      onCommit: handleCommit,
      onRemoveLast: handleRemoveLast,
      onReset: handleReset,
      onSelectTown: handleSelectTown,
      onSelectPoi: handleSelectPoi,
      // Panel-row hover highlights the matching marker on the map.
      onPoiRowHover: (poi) => map.setPoiHighlight(poi),
      onEditDay: handleEditDay,
      onSelectPlan: handleSelectPlan,
      onRenamePlan: handleRenamePlan,
      onNewPlan: handleNewPlan,
      onDuplicatePlan: handleDuplicatePlan,
      onDeletePlan: handleDeletePlan,
    },
  });

  // Persist the active plan's committed state. Called ONLY after user
  // mutations — never at boot or right after a plan switch. Reason: a corrupt
  // stored plan hydrates to empty days; persisting straight after would
  // overwrite the stored plan with the emptied one (silent data loss).
  function persistPlan() {
    store.saveActivePlan({
      days: itinerary.getDays().map((d) => ({ targetKm: d.targetKm, townChoice: d.townChoice })),
      breaks: [], // sub-project 2 fills this
    });
  }

  // Loads the active plan into the itinerary and resets the pending day. Used at
  // boot and on every plan switch — hydrate + render only, no persist.
  function hydrateActivePlan() {
    const active = store.getActivePlan();
    itinerary.hydrate(active ? active.days : []);
    pendingTarget = DEFAULT_TARGET_KM;
    pendingTown = null;
    ui.setPendingTarget(pendingTarget);
    renderBanner();
    renderAll();
  }

  function renderPlansBar() {
    ui.renderPlans({ plans: planList, activePlanId });
  }

  // The route-changed banner is per-plan: show it only when the active plan was
  // saved against a different route version. A brand-new plan has no
  // routeVersion until its first save — treat missing as current (no banner).
  // Re-evaluated on boot and every plan switch, so it clears when switching to a
  // plan built on the current route.
  function renderBanner() {
    const rv = store.getActivePlan()?.routeVersion;
    if (rv && rv !== meta.builtAt) ui.showBanner(ROUTE_CHANGED_MESSAGE);
    else ui.hideBanner();
  }

  function pendingStartKm() {
    return itinerary.totalPlannedKm();
  }

  function hasReachedDresden() {
    return pendingStartKm() >= totalKm - DRESDEN_EPSILON_KM;
  }

  // Renders committed days: numbered map pins + itinerary cards.
  function renderCommitted() {
    const days = itinerary.getDays();
    map.setDayPins(days.map((day) => ({ index: day.index, coord: pointAtDistance(route, day.endKm) })));
    ui.renderItinerary({ days, totalKm, reached: hasReachedDresden() });
  }

  // Drives both POI panel sections and the map markers for a given stretch.
  // When POI data is missing, shows the boot note instead and clears markers.
  function drawPois(food, sights, startKm) {
    if (poisMissing) {
      ui.renderPoisNote('No POI data — run npm run build:data');
      map.setPoiMarkers([]);
      return;
    }
    ui.renderPois({ food, sights, dayStartKm: startKm });
    map.setPoiMarkers([...food, ...sights]);
  }

  // Renders the pending day: ghost marker, candidate towns, POIs, control state.
  function renderPending() {
    const reached = hasReachedDresden();
    ui.renderControls({
      dayNumber: itinerary.getDays().length + 1,
      startKm: pendingStartKm(),
      reached,
    });

    if (reached) {
      map.setGhost(null);
      map.setTownHighlight(null);
      ui.renderTowns([]);
      drawPois([], [], pendingStartKm());
      return;
    }

    const startKm = pendingStartKm();
    const ghostKm = Math.min(startKm + pendingTarget, totalKm);
    map.setGhost(pointAtDistance(route, ghostKm));

    const candidates = townsNear(towns, ghostKm);
    ui.renderTowns(candidates, townKey(pendingTown));
    map.setTownHighlight(pendingTown ? [pendingTown.lng, pendingTown.lat] : null);

    const food = poisInRange(poiData, startKm, ghostKm, { kind: 'food' });
    const sights = poisInRange(poiData, startKm, ghostKm, { kind: 'sight' });
    drawPois(food, sights, startKm);
  }

  function renderAll() {
    renderCommitted();
    renderPending();
  }

  // --- Callbacks ---------------------------------------------------------

  function handlePendingChange(target) {
    pendingTarget = target;
    pendingTown = null; // endpoint moved; drop the stale overnight choice
    renderPending();
  }

  function handleSelectTown(town) {
    pendingTown = town;
    // renderPending() already redraws the towns list (with this town selected),
    // the ghost, and the town highlight from pendingTown — reuse it instead of
    // duplicating the ghostKm formula here. We only add the pan-to-town.
    renderPending();
    map.panTo([town.lng, town.lat]);
    persistPlan();
  }

  // Row/marker click on a POI: highlight the matching row and pan the map to it.
  // Pins are gone (favorites arrive in sub-project 3); this is view-only now.
  function handleSelectPoi(poi) {
    ui.highlightPoiRow(poiKey(poi));
    map.panTo([poi.lng, poi.lat]);
  }

  function handleCommit() {
    if (hasReachedDresden()) return;
    const day = itinerary.addDay(pendingTarget);
    if (pendingTown) itinerary.setTownChoice(day.index, pendingTown);
    persistPlan();
    pendingTarget = DEFAULT_TARGET_KM;
    pendingTown = null;
    ui.setPendingTarget(pendingTarget);
    renderAll();
  }

  function handleRemoveLast() {
    itinerary.removeLastDay();
    persistPlan();
    renderAll();
  }

  function handleReset() {
    itinerary.reset();
    persistPlan();
    pendingTarget = DEFAULT_TARGET_KM;
    pendingTown = null;
    ui.setPendingTarget(pendingTarget);
    renderAll();
  }

  function handleEditDay(index, target) {
    itinerary.editDay(index, target);
    persistPlan();
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
    renderPlansBar(); // rename only — no re-hydrate
  }

  // Clicking the map sets the pending distance so the day ends at the clicked
  // point (snapped to the route). Clicks before the pending start are ignored.
  function handleRouteClick(lngLat) {
    if (hasReachedDresden()) return;
    const { distanceKm } = snap(route, lngLat);
    const start = pendingStartKm();
    if (distanceKm <= start) return;
    pendingTarget = Math.round(distanceKm - start);
    pendingTown = null;
    ui.setPendingTarget(pendingTarget);
    renderPending();
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
