import './style.css';
import { loadRoute, pointAtDistance, snap } from './route.js';
import { loadTowns, townsNear } from './towns.js';
import { loadPois, poisInRange } from './pois.js';
import { createItinerary } from './itinerary.js';
import { createMap } from './map.js';
import { createUI, townKey, poiKey } from './ui.js';
import meta from './data/route.meta.json';

const DEFAULT_TARGET_KM = 80;
// The plan is considered complete when the last endKm is within this of the
// route total (endKm clamps to totalKm, so it never quite exceeds it).
const DRESDEN_EPSILON_KM = 0.5;

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

  const itinerary = createItinerary({
    totalKm,
    routeVersion: meta.builtAt,
    storage: window.localStorage,
  });
  const { loaded, routeChanged } = itinerary.load();

  // --- Pending-day state (not yet committed) ----------------------------
  let pendingTarget = DEFAULT_TARGET_KM;
  let pendingTown = null;
  let pendingPoiPins = [];

  const map = createMap({
    routeFeature: route,
    onRouteClick: handleRouteClick,
    onPoiClick: handleTogglePoi,
  });

  const ui = createUI({
    controlsEl: document.getElementById('controls'),
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
      onTogglePoi: handleTogglePoi,
      onEditDay: handleEditDay,
    },
  });

  if (loaded && routeChanged) {
    ui.showBanner(
      'The route data changed since you last planned this trip — day distances may have shifted.',
    );
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
    const pinnedKeys = new Set(pendingPoiPins.map(poiKey));
    ui.renderPois({ food, sights, pinnedKeys, dayStartKm: startKm });
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
  }

  // Toggles a POI in the pending day's pins (same path from list rows and map
  // clicks), then re-renders and pans to it. Kept across slider/map moves so a
  // pin chosen at one endpoint survives a nudge; cleared only on commit/reset.
  function handleTogglePoi(poi) {
    const key = poiKey(poi);
    const at = pendingPoiPins.findIndex((p) => poiKey(p) === key);
    if (at >= 0) pendingPoiPins.splice(at, 1);
    else pendingPoiPins.push(poi);
    renderPending();
    map.panTo([poi.lng, poi.lat]);
  }

  function handleCommit() {
    if (hasReachedDresden()) return;
    const day = itinerary.addDay(pendingTarget);
    if (pendingTown) itinerary.setTownChoice(day.index, pendingTown);
    pendingPoiPins.forEach((pin) => itinerary.togglePoiPin(day.index, pin));
    itinerary.save();
    pendingTarget = DEFAULT_TARGET_KM;
    pendingTown = null;
    pendingPoiPins = [];
    ui.setPendingTarget(pendingTarget);
    renderAll();
  }

  function handleRemoveLast() {
    itinerary.removeLastDay();
    itinerary.save();
    renderAll();
  }

  function handleReset() {
    itinerary.reset();
    itinerary.save();
    pendingTarget = DEFAULT_TARGET_KM;
    pendingTown = null;
    pendingPoiPins = [];
    ui.setPendingTarget(pendingTarget);
    renderAll();
  }

  function handleEditDay(index, target) {
    itinerary.editDay(index, target);
    itinerary.save();
    renderAll();
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

  renderAll();
  // Tiles/layout can settle a frame late; nudge Leaflet to remeasure.
  requestAnimationFrame(() => map.invalidate());
}

boot().catch((err) => {
  // Surface bootstrap failures loudly rather than a blank page.
  console.error('planner-app failed to start', err);
});
