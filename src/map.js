// All Leaflet specifics live here. This is the ONLY module that deals with
// Leaflet's [lat, lng] coordinate order; every value crossing this boundary
// (in or out) is GeoJSON-style [lng, lat].

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// The focused day's stretch, drawn over the context line by setRouteHighlight.
const HIGHLIGHT_COLOR = '#2563eb';
const HIGHLIGHT_STYLE = {
  color: HIGHLIGHT_COLOR,
  weight: 7,
  opacity: 0.95,
  lineCap: 'round',
};

// The whole route is context for the focused stretch, not a competitor for it:
// thin, dashed, and a LIGHTER blue than the highlight rather than the same one at
// half opacity — so the two are told apart by lightness as well as by weight,
// which is what was missing at whole-route zoom (at day zoom the heavy highlight
// against a hairline was never ambiguous).
//
// Not grey, which is the obvious way to make the highlight pop and was tried and
// measured at 1512x900: OSM's own tiles draw state and district boundaries as grey
// dashed lines, so a grey dashed route reads as map furniture — the 570 unplanned
// km from Boizenburg to Dresden disappeared into the boundary between
// Niedersachsen and Brandenburg. Blue is the one hue these tiles reserve for water,
// and water is drawn as filled area, never as a dashed line.
const ROUTE_STYLE = { color: '#5b93ff', weight: 3, opacity: 0.75, dashArray: '7 6' };

// How much viewport to leave around a framed stretch, in px. The focused day gets
// more than the whole route does: its endpoints carry the pins and the handles a
// user is about to aim at, while the whole route just has to fit.
const FOCUS_PADDING_PX = [48, 48];
const WHOLE_ROUTE_PADDING_PX = [28, 28];

// How far in a fit is allowed to go. A product decision, not a measurement: a
// 5 km day would otherwise fill the window at street level, where the route is
// all one blue line and there is nothing to place it against. Stopping at 13
// keeps a town or two in frame.
const FOCUS_MAX_ZOOM = 13;

// How long after a camera move of our own a zoomend still counts as ours.
// Leaflet's pan/zoom animations run 250ms with a late-scheduled 250ms fallback
// timer, but the gap that matters is the measured one: fitBounds to zoomend in
// Chromium, with a full render pass in between, came in at 2, 209, 305, 311, 319
// and 374ms — and once past 400, which read our own fit as the user's and left
// camera-follow off for the rest of the session. A second keeps the failure on
// the harmless side: a wheel-zoom inside the window is missed once and the next
// step of the same gesture reports it, where a missed settle strands the camera
// silently. The honest fix is a positive signal — counting the settle events a
// move is expected to produce — which needs more design than a constant.
//
// Re-measured in Task 14's verification pass, in an automated Chromium with a busy
// main thread: zoomend arrived with 497-997ms of the window left, and a plain
// animated PAN's moveend landed 700ms in — which is why moveend is not a signal
// here (see the listener note below). No run was observed losing the zoomend race,
// but ~500ms of margin on a 1000ms window is not much, and it is thinner on slower
// hardware. Left at a second deliberately: widening it trades this failure for its
// opposite, a real user zoom inside the window that never hands the camera over.
// The settle-counting fix above is the recorded follow-up.
const PROGRAMMATIC_SETTLE_MS = 1000;

// The keys Leaflet's keyboard handler pans and zooms the map with. Pressing one
// with the map focused is the user taking the camera, exactly as a drag is.
const PAN_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  '+',
  '-',
  '=',
  '_',
]);

// [lng, lat] (GeoJSON) -> [lat, lng] (Leaflet LatLng).
function toLatLng([lng, lat]) {
  return [lat, lng];
}

// Leaflet renders a string tooltip as HTML, and place names come from OSM
// (untrusted). Escape before binding so a crafted name can't inject markup.
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function numberedPinIcon(text, variant) {
  return L.divIcon({
    className: `pin-icon pin-icon--${variant}`,
    html: `<span class="pin-icon__label">${text}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

// Small dot for a POI. `kind` is 'food' (orange) or 'sight' (teal); the colour
// itself is set in style.css off the kind class.
function poiIcon(kind) {
  return L.divIcon({
    className: `poi-marker poi-marker--${kind}`,
    html: '<span class="poi-marker__dot"></span>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

// A committed break: ☕ (place stop) or 📌 (custom user-labeled stop) in a
// small bordered white circle. Sized between the numbered day pin (26px) and
// the POI dot (14px) so breaks read as secondary waypoints on the day.
function breakIcon(kind) {
  const custom = kind === 'custom';
  return L.divIcon({
    className: `break-marker${custom ? ' break-marker--custom' : ''}`,
    html: `<span class="break-marker__glyph">${custom ? '📌' : '☕'}</span>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// A favorited place: a gold ⭐ with a soft white halo. Shown for every favorite
// across the whole route (the list is user-curated and small — no density cap).
const FAV_ICON = L.divIcon({
  className: 'fav-marker',
  html: '<span class="fav-marker__glyph">⭐</span>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// A dense city stretch can hold hundreds of food POIs, so the map shows the first
// POI_MAP_CAP of a kind in ROUTE ORDER — the order they arrive in.
//
// The criterion matters more than the number, and it has to be the same one
// places.js's ROW_CAP uses (also 40, also route order). It used to keep the 40
// NEAREST by offsetKm instead, which on a dense stretch is a different set from
// the panel's first 40: hovering a marker then highlighted nothing, because that
// POI's row was never rendered. Route order makes the two sets identical by
// construction, so every marker has a row to light up — and it is the order the
// panel reads in, which is what makes "the first 40 along this stretch" an
// explicable cap rather than an arbitrary subset.
//
// The constants are deliberately not shared: map.js imports nothing but Leaflet
// (see poiMarkerKey below for the same trade). Change one, change the other.
const POI_MAP_CAP = 40;

function cappedByKind(pois, kind) {
  return pois.filter((p) => p.kind === kind).slice(0, POI_MAP_CAP);
}

/**
 * Creates and manages the Leaflet map for the planner.
 *
 * @param {Object} opts
 * @param {Feature<LineString>} opts.routeFeature - the route in GeoJSON order.
 * @param {(lngLat: [number, number]) => void} [opts.onRouteClick] - fired when
 *   the user clicks the map; receives the clicked point as [lng, lat].
 * @param {(poi: object) => void} [opts.onPoiClick] - fired when the user clicks
 *   a POI marker; receives the POI record.
 * @param {(poi: object|null) => void} [opts.onPoiHover] - fired when the pointer
 *   enters a POI marker (with the POI record) and again with null when it leaves.
 * @param {() => void} [opts.onUserMove] - fired when the user pans or zooms the
 *   map themselves. A pan is always theirs; a zoom is attributed to the app for
 *   PROGRAMMATIC_SETTLE_MS after any move the app made, so a user zoom inside
 *   that window is missed rather than a settling animation being mistaken for one.
 * @returns {{
 *   setRouteHighlight: (coords: Array<[number, number]>|null) => void,
 *   setDayPins: (
 *     pins: Array<{index: number, coord: [number, number]}>,
 *     opts?: {draggable?: boolean,
 *             onDragBoundary?: (index: number, lngLat: [number, number], commit: boolean) => void},
 *   ) => void,
 *   setPoiMarkers: (pois: Array<object>) => void,
 *   setPoiHighlight: (poi: object|null) => void,
 *   setBreakMarkers: (breaks: Array<object>) => void,
 *   setFavoriteMarkers: (favorites: Array<object>) => void,
 *   focusRange: (coords: Array<[number, number]>, opts?: {animate?: boolean}) => boolean,
 *   fitWholeRoute: (opts?: {animate?: boolean}) => boolean,
 *   isWellInsideView: (lngLat: [number, number], inset?: number) => boolean,
 *   panTo: (lngLat: [number, number]) => void,
 *   invalidate: () => void,
 * }} the map's control surface. The two framing calls report whether the move
 *   actually ran (see moveProgrammatically); panTo and invalidate have no caller
 *   that books a frame off them, so they stay silent about it.
 */
export function createMap({
  routeFeature,
  onRouteClick,
  onPoiClick,
  onPoiHover,
  onUserMove,
} = {}) {
  const renderer = L.canvas();
  const map = L.map('map', { renderer, preferCanvas: true });

  L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);

  const routeLayer = L.geoJSON(routeFeature, {
    renderer,
    smoothFactor: 1.5,
    style: () => ROUTE_STYLE,
  }).addTo(map);

  // Index of the boundary pin being dragged, or null. Two things must stand back
  // while a pin drag is in flight: rebuilding the pins (Leaflet tears the gesture
  // down when the marker is removed) and moving the camera (a pane shift slides
  // the icon out from under the cursor).
  let draggingPinIndex = null;
  let draggingPinMarker = null;
  let pendingInvalidate = false;

  // fitBounds/panTo end in zoomend, which would look exactly like the user
  // taking over, and Leaflet flags nothing. So treat zoomend as ours for a short
  // window after each of our own moves. A boolean cleared on the next settle
  // event can't work: setView calls _stop() first, and interrupting an in-flight
  // animation fires a synchronous moveend before the new move even begins — the
  // flag would be gone by the time the real zoomend lands. A window also makes an
  // interrupting move extend the suppression instead of ending it.
  let programmaticUntil = 0;

  // Reports whether the move ran. A caller that records "this stretch is framed"
  // off a refused move would never ask for that frame again — it has to hear the
  // refusal, not infer it.
  function moveProgrammatically(fn) {
    // The dragged pin owns the map pane: Leaflet only compensates for the pans it
    // makes itself (Marker's autoPan), so any camera move of ours would desync
    // the pin from the cursor and skew the km it reports. Wait for the release.
    if (draggingPinIndex !== null) return false;
    programmaticUntil = performance.now() + PROGRAMMATIC_SETTLE_MS;
    fn();
    return true;
  }

  // The map fires dragend from one place only — the user finishing a pan — so it
  // never needs the window. Nothing programmatic can produce it.
  map.on('dragend', () => {
    if (typeof onUserMove === 'function') onUserMove();
  });

  map.on('zoomend', () => {
    if (performance.now() < programmaticUntil) return;
    if (typeof onUserMove === 'function') onUserMove();
  });

  // moveend is deliberately NOT a user-move signal, and the obvious reason to add
  // it — keyboard panning, which fires no dragend — is served by the listener below
  // instead. Gating it on the settle window looks like it would be enough and is
  // not: measured here in Chromium, a plain animated pan's moveend landed 700ms
  // after the move began, leaving 300ms of a 1000ms window. Every camera move of
  // ours ends in a moveend, so that thin race would be run on every fit, and losing
  // it once switches camera-follow off silently for the rest of the session — the
  // failure the whole programmatic-window mechanism exists to prevent. autoPan
  // makes it worse: while a dragged pin sits near the viewport edge it re-schedules
  // itself every frame, firing ~60 moveend/s with the window never re-armed.
  // invalidateSize and drag inertia emit moveend of their own as well.
  //
  // So: detect the GESTURE, not its aftermath. Arrow keys reach Leaflet's own
  // keyboard handler on the map container, which is what pans, and a keydown there
  // is unambiguous — nothing the app does synthesises one, so there is no window to
  // race. Without this a keyboard user's pan was the only pan the app did not hand
  // the camera over for, and the next focus change pulled the view back out from
  // under them where a mouse pan would have been respected.
  map.getContainer().addEventListener('keydown', (e) => {
    if (!PAN_KEYS.has(e.key)) return;
    if (typeof onUserMove === 'function') onUserMove();
  });

  // The focused day's stretch, drawn thick over the muted full route so the
  // rest of the trip stays as context rather than competing with it.
  let highlightLayer = null;

  function setRouteHighlight(coords) {
    if (highlightLayer) {
      map.removeLayer(highlightLayer);
      highlightLayer = null;
    }
    // A one-coordinate polyline draws nothing, so there is no line to show for a
    // zero-length stretch — unlike focusRange, which can legitimately frame a
    // single point (see below).
    if (!coords || coords.length < 2) return;
    highlightLayer = L.polyline(coords.map(toLatLng), {
      renderer,
      ...HIGHLIGHT_STYLE,
      // Decorative: keeping it out of the canvas hit-test list spares every
      // mousemove over the focused stretch a second path test.
      interactive: false,
    }).addTo(map);
  }

  // Frames a stretch. `animate` is false while a boundary is being dragged and
  // when the user prefers reduced motion.
  //
  // A single coordinate is accepted and frames a zero-area bounds — which lands
  // centred on the point at FOCUS_MAX_ZOOM. That asymmetry with setRouteHighlight
  // (which needs two) is deliberate: "put this place in the middle of the window"
  // is a sensible thing to ask for, and "draw a line through this one point" is
  // not. Only an empty list is refused.
  function focusRange(coords, { animate = true } = {}) {
    if (!coords || !coords.length) return false;
    const bounds = L.latLngBounds(coords.map(toLatLng));
    return moveProgrammatically(() => {
      map.fitBounds(bounds, { padding: FOCUS_PADDING_PX, animate, maxZoom: FOCUS_MAX_ZOOM });
    });
  }

  function fitWholeRoute({ animate = true } = {}) {
    return moveProgrammatically(() => {
      map.fitBounds(routeLayer.getBounds(), { padding: WHOLE_ROUTE_PADDING_PX, animate });
    });
  }

  /** True when `lngLat` sits inside the viewport shrunk by `inset` (0..0.5). */
  function isWellInsideView(lngLat, inset = 0.12) {
    const bounds = map.getBounds().pad(-inset);
    return bounds.contains(toLatLng(lngLat));
  }

  fitWholeRoute({ animate: false });

  // Static start pin at km 0 (Hamburg) — the first route coordinate.
  const startCoord = routeFeature.geometry.coordinates[0];
  L.marker(toLatLng(startCoord), {
    icon: numberedPinIcon('H', 'start'),
    zIndexOffset: 400,
    title: 'Start — Hamburg',
  }).addTo(map);

  if (typeof onRouteClick === 'function') {
    map.on('click', (e) => onRouteClick([e.latlng.lng, e.latlng.lat]));
  }

  const dayPinLayer = L.layerGroup().addTo(map);
  const poiLayer = L.layerGroup().addTo(map);
  const breakLayer = L.layerGroup().addTo(map);
  const favLayer = L.layerGroup().addTo(map);

  // Leaflet ends a marker drag on a document-level mouseup/touchend, and its
  // mousemove never asks whether the button is still down. A pointer that comes
  // up where the page can't see it — released outside the window, claimed by a
  // native gesture — therefore leaves the gesture half alive: the pin follows the
  // bare cursor, rewriting the plan on hover, no dragend arrives, and everything
  // guarded on draggingPinIndex stays switched off (pins frozen, camera dead, a
  // deferred resize never run). A pointer that is provably not held while we
  // still believe it is means exactly that, which is how the strip watches its
  // own drags too. Not window blur: focus can leave and come back with the button
  // still down, and that drag is still the user's to finish.
  //
  // Unlike the strip this cannot filter by pointerId — Leaflet's marker dragstart
  // carries no event and no pointer — so on a hybrid touch+mouse device, nudging
  // the mouse during a touch pin-drag ends the drag early. Benign: it commits at
  // the pin's real position, which is the same thing the release would have done.
  // Window-level pointerdown snooping to learn the id is not worth that.
  function onAbandonPointerMove(e) {
    if (e.buttons === 0) recoverAbandonedPinDrag();
  }

  function onAbandonPointerCancel() {
    // One task later, because Leaflet's touchcancel path does end the drag
    // properly, and where it will, it should be the one that does.
    setTimeout(recoverAbandonedPinDrag, 0);
  }

  // Handed to Leaflet's own finisher rather than unpicked by hand: it detaches
  // the document listeners, releases the Draggable._dragging static (still set,
  // and while set it blocks map panning and every later drag — Leaflet's own bug,
  // but ours to survive) and fires the dragend we never got, so recovery runs
  // through the ordinary path and the boundary commits where the pin really sits.
  // Committing beats clearing: the previews have already moved the model, so
  // dropping the commit would leave storage disagreeing with the screen rather
  // than undoing anything — the same call the strip makes on a cancelled gesture.
  //
  // Three lines here and in endPinDrag are deliberately redundant with Leaflet's
  // own idempotent finishDrag — the latch fallback below, the deferred
  // pointercancel above, and removing the listeners — so their mutants survive.
  // Do NOT "simplify" them away on that evidence: each one is the invariant that
  // makes this function safe to call at any time, from any of three paths, and the
  // symptom of getting it wrong is a map that has gone quietly dead (pins frozen,
  // camera stuck, every later drag blocked by Leaflet's Draggable._dragging).
  function recoverAbandonedPinDrag() {
    if (draggingPinIndex === null) return;
    const draggable = draggingPinMarker?.dragging?._draggable;
    if (typeof draggable?.finishDrag === 'function') draggable.finishDrag(true);
    // finishDrag fires dragend only for a gesture that moved; if this one never
    // did, nothing has cleared the latch and it is still ours to clear.
    if (draggingPinIndex !== null) endPinDrag();
  }

  function endPinDrag() {
    draggingPinIndex = null;
    draggingPinMarker = null;
    window.removeEventListener('pointermove', onAbandonPointerMove, true);
    window.removeEventListener('pointercancel', onAbandonPointerCancel, true);
    // Ahead of any commit, so the stretch is framed at the real size.
    if (pendingInvalidate) {
      pendingInvalidate = false;
      invalidate();
    }
  }

  // Draggable boundary pins: the map's twin of the strip handles. Dragging emits
  // the snapped route km continuously (commit false) and once on release.
  function setDayPins(pins, { draggable = false, onDragBoundary } = {}) {
    // A preview render must not rebuild the pins under an in-flight drag.
    // Removing the dragged marker makes Leaflet unsubscribe MarkerDrag's handlers
    // and only then disable the Draggable, so the drag it ends fires into nothing:
    // the gesture dies mid-stroke and its dragend — the commit — never arrives.
    // No other pin has moved during a preview anyway, and the render after the
    // commit rebuilds them all.
    if (draggingPinIndex !== null) return;
    dayPinLayer.clearLayers();
    (pins || []).forEach(({ index, coord }) => {
      const marker = L.marker(toLatLng(coord), {
        icon: numberedPinIcon(String(index + 1), 'day'),
        zIndexOffset: 500,
        draggable,
        // Our own camera stands still during the drag, so this is what lets a pin
        // travel past the viewport edge — Leaflet shifts the pane and corrects the
        // drag origin by the same offset, which an outside pan cannot do.
        autoPan: draggable,
        title: draggable ? `Day ${index + 1} — drag to move this overnight` : `Day ${index + 1}`,
      });
      if (draggable) {
        marker.on('dragstart', () => {
          draggingPinIndex = index;
          draggingPinMarker = marker;
          window.addEventListener('pointermove', onAbandonPointerMove, true);
          window.addEventListener('pointercancel', onAbandonPointerCancel, true);
        });
        marker.on('drag', (e) => {
          if (typeof onDragBoundary !== 'function') return;
          onDragBoundary(index, [e.latlng.lng, e.latlng.lat], false);
        });
        marker.on('dragend', (e) => {
          // Cleared before the commit: that render is the one meant to rebuild.
          endPinDrag();
          if (typeof onDragBoundary !== 'function') return;
          const { lat, lng } = e.target.getLatLng();
          onDragBoundary(index, [lng, lat], true);
        });
      }
      marker.addTo(dayPinLayer);
    });
  }

  // Committed breaks are always visible (like day pins), rebuilt each render
  // pass from getBreaks(). Records carry named lat/lng (not [lng, lat] tuples).
  // A click routes through the same highlight/pan path as a POI click; removal
  // happens on the day cards, not the marker.
  function setBreakMarkers(breaks) {
    breakLayer.clearLayers();
    (breaks || []).forEach((b) => {
      const marker = L.marker([b.lat, b.lng], {
        icon: breakIcon(b.kind),
        keyboard: false,
        zIndexOffset: 450,
      }).bindTooltip(escapeHtml(b.name));
      marker.on('click', () => {
        if (typeof onPoiClick === 'function') onPoiClick(b);
      });
      marker.addTo(breakLayer);
    });
  }

  // Every favorite gets a gold star, always visible across the whole route (no
  // density cap — the list is user-curated and small). A click routes through
  // the same highlight/pan path as POI and break markers.
  function setFavoriteMarkers(favorites) {
    favLayer.clearLayers();
    (favorites || []).forEach((fav) => {
      const marker = L.marker([fav.lat, fav.lng], {
        icon: FAV_ICON,
        keyboard: false,
        zIndexOffset: 350,
      }).bindTooltip(escapeHtml(fav.name));
      marker.on('click', () => {
        if (typeof onPoiClick === 'function') onPoiClick(fav);
      });
      marker.addTo(favLayer);
    });
  }

  // Same name@km identity convention as ui.js's poiKey/itinerary's breakKey —
  // kept local so map.js stays import-free besides Leaflet.
  function poiMarkerKey(poi) {
    return `${poi.name}@${poi.routeDistanceKm}`;
  }

  let poiMarkerIndex = new Map(); // poiMarkerKey -> marker, for panel-row hover
  let highlightedPoiMarker = null;
  // A POI dropped by the density cap has no permanent marker, so setPoiHighlight
  // shows one for the duration of the hover. It is added to the map, not to
  // poiLayer, so clearing that layer does NOT take it with it.
  let tempPoiMarker = null;

  // Drops whatever setPoiHighlight is currently emphasizing. Both of its owners
  // have to go together: the temporary marker outlives a layer rebuild, so
  // forgetting it there stranded a highlighted dot and an open tooltip on the map
  // until the next hover happened to clear it.
  function clearPoiHighlight() {
    if (highlightedPoiMarker) {
      highlightedPoiMarker.getElement()?.classList.remove('poi-marker--active');
      highlightedPoiMarker.closeTooltip();
      highlightedPoiMarker = null;
    }
    if (tempPoiMarker) {
      map.removeLayer(tempPoiMarker);
      tempPoiMarker = null;
    }
  }

  // POIs arrive as records carrying named lat/lng (not [lng, lat] tuples), so
  // the coordinate order still resolves to Leaflet's [lat, lng] right here.
  function setPoiMarkers(pois) {
    clearPoiHighlight();
    poiLayer.clearLayers();
    poiMarkerIndex = new Map();
    const list = pois || [];
    const shown = [...cappedByKind(list, 'food'), ...cappedByKind(list, 'sight')];
    shown.forEach((poi) => {
      const marker = L.marker([poi.lat, poi.lng], {
        icon: poiIcon(poi.kind),
        keyboard: false,
        zIndexOffset: 300,
      }).bindTooltip(escapeHtml(poi.name));
      marker.on('click', () => {
        if (typeof onPoiClick === 'function') onPoiClick(poi);
      });
      marker.on('mouseover', () => {
        if (typeof onPoiHover === 'function') onPoiHover(poi);
      });
      marker.on('mouseout', () => {
        if (typeof onPoiHover === 'function') onPoiHover(null);
      });
      marker.addTo(poiLayer);
      poiMarkerIndex.set(poiMarkerKey(poi), marker);
    });
  }

  // Emphasizes the marker for `poi` (from a panel-row hover); null clears. A POI
  // dropped by the density cap has no permanent marker, so a temporary one is
  // shown for the duration of the hover — every row can be located on the map.
  function setPoiHighlight(poi) {
    clearPoiHighlight();
    if (!poi) return;
    let marker = poiMarkerIndex.get(poiMarkerKey(poi));
    if (!marker) {
      tempPoiMarker = L.marker([poi.lat, poi.lng], {
        icon: poiIcon(poi.kind),
        keyboard: false,
        interactive: false,
        zIndexOffset: 400,
      })
        .bindTooltip(escapeHtml(poi.name))
        .addTo(map);
      marker = tempPoiMarker;
    }
    marker.getElement()?.classList.add('poi-marker--active');
    marker.openTooltip();
    highlightedPoiMarker = marker === tempPoiMarker ? null : marker;
  }

  function panTo(lngLat) {
    moveProgrammatically(() => {
      map.panTo(toLatLng(lngLat));
    });
  }

  // Through moveProgrammatically like every other camera move of ours: a resize
  // pans the map by half the size change, which would slide a dragged pin away
  // from the cursor just as a fit would. This one can't simply be dropped though
  // — a container whose size the map never learned stays wrong long after the
  // drag — so it waits for the release instead.
  function invalidate() {
    if (draggingPinIndex !== null) {
      pendingInvalidate = true;
      return;
    }
    moveProgrammatically(() => {
      map.invalidateSize();
    });
  }

  return {
    setRouteHighlight,
    setDayPins,
    setBreakMarkers,
    setFavoriteMarkers,
    setPoiMarkers,
    setPoiHighlight,
    focusRange,
    fitWholeRoute,
    isWellInsideView,
    panTo,
    invalidate,
  };
}
