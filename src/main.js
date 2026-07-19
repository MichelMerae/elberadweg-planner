import './style.css';
import { loadRoute, pointAtDistance, snap } from './route.js';
import { loadTowns, townsNear } from './towns.js';
import { createItinerary } from './itinerary.js';
import { createMap } from './map.js';
import { createUI, townKey } from './ui.js';
import meta from './data/route.meta.json';

const DEFAULT_TARGET_KM = 80;
// The plan is considered complete when the last endKm is within this of the
// route total (endKm clamps to totalKm, so it never quite exceeds it).
const DRESDEN_EPSILON_KM = 0.5;

async function boot() {
  const [route, towns] = await Promise.all([loadRoute(), loadTowns()]);
  const totalKm = meta.totalKm;

  const itinerary = createItinerary({
    totalKm,
    routeVersion: meta.builtAt,
    storage: window.localStorage,
  });
  const { loaded, routeChanged } = itinerary.load();

  // --- Pending-day state (not yet committed) ----------------------------
  let pendingTarget = DEFAULT_TARGET_KM;
  let pendingTown = null;

  const map = createMap({ routeFeature: route, onRouteClick: handleRouteClick });

  const ui = createUI({
    controlsEl: document.getElementById('controls'),
    townsEl: document.getElementById('towns'),
    itineraryEl: document.getElementById('itinerary'),
    bannerEl: document.getElementById('banner'),
    callbacks: {
      onPendingChange: handlePendingChange,
      onCommit: handleCommit,
      onRemoveLast: handleRemoveLast,
      onReset: handleReset,
      onSelectTown: handleSelectTown,
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

  // Renders the pending day: ghost marker, candidate towns, control state.
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
      return;
    }

    const ghostKm = Math.min(pendingStartKm() + pendingTarget, totalKm);
    map.setGhost(pointAtDistance(route, ghostKm));

    const candidates = townsNear(towns, ghostKm);
    ui.renderTowns(candidates, townKey(pendingTown));
    map.setTownHighlight(pendingTown ? [pendingTown.lng, pendingTown.lat] : null);
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
    ui.renderTowns(townsNear(towns, Math.min(pendingStartKm() + pendingTarget, totalKm)), townKey(town));
    map.setTownHighlight([town.lng, town.lat]);
    map.panTo([town.lng, town.lat]);
  }

  function handleCommit() {
    if (hasReachedDresden()) return;
    const day = itinerary.addDay(pendingTarget);
    if (pendingTown) itinerary.setTownChoice(day.index, pendingTown);
    itinerary.save();
    pendingTarget = DEFAULT_TARGET_KM;
    pendingTown = null;
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
