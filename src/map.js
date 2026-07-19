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

/**
 * Creates and manages the Leaflet map for the planner.
 *
 * @param {Object} opts
 * @param {Feature<LineString>} opts.routeFeature - the route in GeoJSON order.
 * @param {(lngLat: [number, number]) => void} [opts.onRouteClick] - fired when
 *   the user clicks the map; receives the clicked point as [lng, lat].
 * @returns {{
 *   setGhost: (lngLat: [number, number]|null) => void,
 *   setDayPins: (pins: Array<{index: number, coord: [number, number]}>) => void,
 *   setTownHighlight: (lngLat: [number, number]|null) => void,
 *   panTo: (lngLat: [number, number]) => void,
 *   invalidate: () => void,
 * }}
 */
export function createMap({ routeFeature, onRouteClick } = {}) {
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

  function panTo(lngLat) {
    map.panTo(toLatLng(lngLat));
  }

  function invalidate() {
    map.invalidateSize();
  }

  return { setGhost, setDayPins, setTownHighlight, panTo, invalidate };
}
