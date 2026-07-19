// All Leaflet specifics live here. This is the ONLY module that deals with
// Leaflet's [lat, lng] coordinate order; every value crossing this boundary
// (in or out) is GeoJSON-style [lng, lat].

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const ROUTE_STYLE = { color: '#2563eb', weight: 4, opacity: 0.9 };

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

const GHOST_ICON = L.divIcon({
  className: 'ghost-icon',
  html: '<span class="ghost-icon__dot"></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

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

// A committed break: ☕ in a small amber-bordered white circle. Sized between
// the numbered day pin (26px) and the POI dot (14px) so breaks read as
// secondary waypoints on the day.
const BREAK_ICON = L.divIcon({
  className: 'break-marker',
  html: '<span class="break-marker__glyph">☕</span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

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
 * @returns {{
 *   setGhost: (lngLat: [number, number]|null) => void,
 *   setDayPins: (pins: Array<{index: number, coord: [number, number]}>) => void,
 *   setTownHighlight: (lngLat: [number, number]|null) => void,
 *   setPoiMarkers: (pois: Array<object>) => void,
 *   setBreakMarkers: (breaks: Array<object>) => void,
 *   setFavoriteMarkers: (favorites: Array<object>) => void,
 *   panTo: (lngLat: [number, number]) => void,
 *   invalidate: () => void,
 * }}
 */
export function createMap({ routeFeature, onRouteClick, onPoiClick, onPoiHover } = {}) {
  const renderer = L.canvas();
  const map = L.map('map', { renderer, preferCanvas: true });

  L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);

  const routeLayer = L.geoJSON(routeFeature, {
    renderer,
    smoothFactor: 1.5,
    style: () => ROUTE_STYLE,
  }).addTo(map);

  map.fitBounds(routeLayer.getBounds(), { padding: [28, 28] });

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
  let ghostMarker = null;
  let townMarker = null;

  function setGhost(lngLat) {
    if (ghostMarker) {
      map.removeLayer(ghostMarker);
      ghostMarker = null;
    }
    if (!lngLat) return;
    ghostMarker = L.marker(toLatLng(lngLat), {
      icon: GHOST_ICON,
      interactive: false,
      keyboard: false,
      zIndexOffset: 600,
    }).addTo(map);
  }

  function setDayPins(pins) {
    dayPinLayer.clearLayers();
    (pins || []).forEach(({ index, coord }) => {
      L.marker(toLatLng(coord), {
        icon: numberedPinIcon(String(index + 1), 'day'),
        zIndexOffset: 500,
        title: `Day ${index + 1}`,
      }).addTo(dayPinLayer);
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
        icon: BREAK_ICON,
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

  // Same name@km identity convention as ui.js's poiKey/itinerary's poiPinKey —
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
    map.panTo(toLatLng(lngLat));
  }

  function invalidate() {
    map.invalidateSize();
  }

  return {
    setGhost,
    setDayPins,
    setBreakMarkers,
    setFavoriteMarkers,
    setTownHighlight,
    setPoiMarkers,
    setPoiHighlight,
    panTo,
    invalidate,
  };
}
