// All Leaflet specifics live here. This is the ONLY module that deals with
// Leaflet's [lat, lng] coordinate order; every value crossing this boundary
// (in or out) is GeoJSON-style [lng, lat].

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Thin, dashed and muted: the whole route is context for the focused day's
// stretch (drawn thick over it by setRouteHighlight), not a competitor for it.
const ROUTE_STYLE = { color: '#2563eb', weight: 3, opacity: 0.5, dashArray: '7 6' };

// How long after a camera move of our own a zoomend still counts as ours.
// Leaflet's pan/zoom animations run 250ms and zoomend can arrive on a
// late-scheduled 250ms fallback timer, so the window has to outlast both.
const PROGRAMMATIC_SETTLE_MS = 400;

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

const TOWN_ICON = L.divIcon({
  className: 'town-icon',
  html: '<span class="town-icon__dot"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

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

// The map only ever shows the nearest-to-route POIs of a kind; dense city
// stretches can hold hundreds of food POIs and the panel list stays complete.
const POI_MAP_CAP = 40;

function cappedByKind(pois, kind) {
  const ofKind = pois.filter((p) => p.kind === kind);
  if (ofKind.length <= POI_MAP_CAP) return ofKind;
  // Copy before sorting so the caller's array order is never disturbed.
  return [...ofKind].sort((a, b) => a.offsetKm - b.offsetKm).slice(0, POI_MAP_CAP);
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
 *   setTownHighlight: (lngLat: [number, number]|null) => void,
 *   setPoiMarkers: (pois: Array<object>) => void,
 *   setPoiHighlight: (poi: object|null) => void,
 *   setBreakMarkers: (breaks: Array<object>) => void,
 *   setFavoriteMarkers: (favorites: Array<object>) => void,
 *   focusRange: (coords: Array<[number, number]>, opts?: {animate?: boolean}) => void,
 *   fitWholeRoute: (opts?: {animate?: boolean}) => void,
 *   isWellInsideView: (lngLat: [number, number], inset?: number) => boolean,
 *   panTo: (lngLat: [number, number]) => void,
 *   invalidate: () => void,
 * }}
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

  // fitBounds/panTo end in zoomend, which would look exactly like the user
  // taking over, and Leaflet flags nothing. So treat zoomend as ours for a short
  // window after each of our own moves. A boolean cleared on the next settle
  // event can't work: setView calls _stop() first, and interrupting an in-flight
  // animation fires a synchronous moveend before the new move even begins — the
  // flag would be gone by the time the real zoomend lands. A window also makes an
  // interrupting move extend the suppression instead of ending it.
  let programmaticUntil = 0;

  function moveProgrammatically(fn) {
    // The dragged pin owns the map pane: Leaflet only compensates for the pans it
    // makes itself (Marker's autoPan), so any camera move of ours would desync
    // the pin from the cursor and skew the km it reports. Wait for the release.
    if (draggingPinIndex !== null) return;
    programmaticUntil = performance.now() + PROGRAMMATIC_SETTLE_MS;
    fn();
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
  // it later — keyboard panning, which fires no dragend — would break the camera.
  // autoPan re-schedules itself every frame while a dragged pin sits near the
  // viewport edge, each pass firing movestart/move/moveend, and the guard above
  // holds moveProgrammatically off for the whole drag, so the window is never
  // re-armed: all ~60 moveend/s would read as the user taking over and switch
  // camera-follow off mid-drag, which is exactly what the guard exists to prevent.
  // invalidateSize and drag inertia emit moveend of their own as well. Keyboard
  // panning needs a narrower signal — Leaflet's own keyboard handler.

  // The focused day's stretch, drawn thick over the muted full route so the
  // rest of the trip stays as context rather than competing with it.
  let highlightLayer = null;

  function setRouteHighlight(coords) {
    if (highlightLayer) {
      map.removeLayer(highlightLayer);
      highlightLayer = null;
    }
    if (!coords || coords.length < 2) return;
    highlightLayer = L.polyline(coords.map(toLatLng), {
      renderer,
      color: '#2563eb',
      weight: 7,
      opacity: 0.95,
      lineCap: 'round',
      // Decorative: keeping it out of the canvas hit-test list spares every
      // mousemove over the focused stretch a second path test.
      interactive: false,
    }).addTo(map);
  }

  // Frames a stretch. `animate` is false while a boundary is being dragged and
  // when the user prefers reduced motion.
  function focusRange(coords, { animate = true } = {}) {
    if (!coords || !coords.length) return;
    const bounds = L.latLngBounds(coords.map(toLatLng));
    moveProgrammatically(() => {
      map.fitBounds(bounds, { padding: [48, 48], animate, maxZoom: 13 });
    });
  }

  function fitWholeRoute({ animate = true } = {}) {
    moveProgrammatically(() => {
      map.fitBounds(routeLayer.getBounds(), { padding: [28, 28], animate });
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
  let townMarker = null;

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
        });
        marker.on('drag', (e) => {
          if (typeof onDragBoundary !== 'function') return;
          onDragBoundary(index, [e.latlng.lng, e.latlng.lat], false);
        });
        marker.on('dragend', (e) => {
          // Cleared before the commit: that render is the one meant to rebuild.
          draggingPinIndex = null;
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

  function setTownHighlight(lngLat) {
    if (townMarker) {
      map.removeLayer(townMarker);
      townMarker = null;
    }
    if (!lngLat) return;
    townMarker = L.marker(toLatLng(lngLat), {
      icon: TOWN_ICON,
      interactive: false,
      keyboard: false,
      zIndexOffset: 550,
    }).addTo(map);
  }

  // Same name@km identity convention as ui.js's poiKey/itinerary's breakKey —
  // kept local so map.js stays import-free besides Leaflet.
  function poiMarkerKey(poi) {
    return `${poi.name}@${poi.routeDistanceKm}`;
  }

  let poiMarkerIndex = new Map(); // poiMarkerKey -> marker, for panel-row hover
  let highlightedPoiMarker = null;

  // POIs arrive as records carrying named lat/lng (not [lng, lat] tuples), so
  // the coordinate order still resolves to Leaflet's [lat, lng] right here.
  function setPoiMarkers(pois) {
    poiLayer.clearLayers();
    poiMarkerIndex = new Map();
    highlightedPoiMarker = null;
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
  let tempPoiMarker = null;
  function setPoiHighlight(poi) {
    if (highlightedPoiMarker) {
      highlightedPoiMarker.getElement()?.classList.remove('poi-marker--active');
      highlightedPoiMarker.closeTooltip();
      highlightedPoiMarker = null;
    }
    if (tempPoiMarker) {
      map.removeLayer(tempPoiMarker);
      tempPoiMarker = null;
    }
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
  // from the cursor just as a fit would.
  function invalidate() {
    moveProgrammatically(() => {
      map.invalidateSize();
    });
  }

  return {
    setRouteHighlight,
    setDayPins,
    setBreakMarkers,
    setFavoriteMarkers,
    setTownHighlight,
    setPoiMarkers,
    setPoiHighlight,
    focusRange,
    fitWholeRoute,
    isWellInsideView,
    panTo,
    invalidate,
  };
}
