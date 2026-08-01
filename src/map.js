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
// dashed lines, so a grey dashed route reads as map furniture — 570 km of unplanned
// route disappeared into the state boundary it happened to run along. Blue is the
// one hue these tiles reserve for water, and water is drawn as filled area, never
// as a dashed line.
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

// How long a camera move of our own stays attributable to us, in two parts,
// because a move has two gaps that can each run long and only one of them is the
// animation.
//
// PROGRAMMATIC_SETTLE_MS is the settling gap. Leaflet's pan/zoom animations run
// 250ms with a late-scheduled 250ms fallback timer, but the measured number is
// what this is set from: fitBounds to zoomend in Chromium, with a full render pass
// in between, came in at 2, 209, 305, 311, 319 and 374ms — and once past 400,
// which read our own fit as the user's and left camera-follow off for the rest of
// the session. Re-measured in Task 14's verification pass in an automated Chromium
// with a busy main thread: zoomend arrived with 497-997ms of the window left, and
// a plain animated PAN's moveend landed 700ms in — which is why moveend is not a
// signal here (see the listener note below).
//
// PROGRAMMATIC_START_MS is the gap the single-window version never accounted for,
// and it is the one that shipped the bug. Measured on a production build with
// fresh storage: adding the second day called fitBounds at t and Leaflet fired
// zoomstart at t+967 — the same tick was rebuilding ~600 place rows and up to 80
// POI markers, and the main thread never reached the animation — so zoomend landed
// at t+1228, 228ms outside a window armed when the call was MADE. Camera-follow
// went off silently for the session, and only "⤢ this day" could get it back. That
// delay is main-thread starvation, not animation: it has no natural bound, so it
// cannot be covered by widening the settle window (which would trade this failure
// for its opposite — a real user zoom inside a much longer window that never hands
// the camera over). Instead the first zoomstart inside the start deadline is taken
// as our animation finally beginning, and re-arms the settle window from there.
//
// Three seconds is generous for a render that has to finish first, and short
// enough to bound the residual: a programmatic move that produces no zoom at all
// leaves the deadline unspent, so a user zoom that begins inside those 3s is
// swallowed ONCE — the same harmless direction the settle window already fails in
// (the next step of the gesture reports it), where the failure it replaces was
// silent and permanent. The unambiguous user signals clear the deadline early
// (dragend and the pan keys, below), so an idle map cannot sit on one.
//
// The second residual is the one these two deadlines do NOT close, and it is worth
// being plain about: the settle window can still be outrun by the animation itself.
// PROGRAMMATIC_START_MS covers the wait BEFORE the zoom begins; once it begins, the
// old 1000ms is all there is. On a uniformly slow machine that is not enough —
// measured at 1089ms from zoomstart to zoomend under 8x CPU throttling, and
// reproduced independently by blocking the main thread mid-animation (zoomstart at
// 62ms, thread held to 1362ms), which killed camera-follow permanently and stranded
// the pins at the same off-screen coordinates as the bug above. So a slow enough
// device still loses the camera the old way. Widening the settle window is not the
// answer for the reason given above, which leaves only the real one:
//
// The honest fix is still a positive signal — counting the settle events a move is
// expected to produce — and still needs more design than a pair of constants. Both
// residuals above are its case; neither deadline can be tuned into covering them.
const PROGRAMMATIC_SETTLE_MS = 1000;
const PROGRAMMATIC_START_MS = 3000;

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
// POI_MAP_CAP of a kind IN THE ORDER THEY ARRIVE — a prefix, and no order of its own.
//
// The criterion matters more than the number, and it has to be the same one
// places.js's ROW_CAP uses (also 40, also a prefix of the same list). It used to keep
// the 40 NEAREST by offsetKm instead, which on a dense stretch is a different set from
// the panel's first 40: hovering a marker then highlighted nothing, because that
// POI's row was never rendered. Taking a prefix makes the two sets identical by
// construction, so every marker has a row to light up.
//
// Which is why re-sorting here would be a bug and not a tidy-up, however harmless a
// sort looks: the list arrives in the RIDER's direction of travel (see poisInRange),
// which on a downstream trip descends by route km. Imposing ascending km would pin the
// 40 places the rider reaches LAST while the panel listed the 40 they reach first.
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
 * @param {string} [opts.originName] - the place km 0 sits in, named on the start
 *   pin. Omitted, the pin reads just "Start" (see below).
 * @param {(lngLat: [number, number]) => void} [opts.onRouteClick] - fired when
 *   the user clicks the map; receives the clicked point as [lng, lat].
 * @param {(poi: object) => void} [opts.onPoiClick] - fired when the user clicks
 *   a POI marker; receives the POI record.
 * @param {(poi: object|null) => void} [opts.onPoiHover] - fired when the pointer
 *   enters a POI marker (with the POI record) and again with null when it leaves.
 * @param {() => void} [opts.onUserMove] - fired when the user pans or zooms the
 *   map themselves. A pan is always theirs; a zoom is attributed to the app for
 *   PROGRAMMATIC_SETTLE_MS after any move the app made — measured from the move's
 *   own zoomstart if one arrives within PROGRAMMATIC_START_MS, since that
 *   animation can start long after the call that asked for it. So a user zoom
 *   inside either window is missed rather than a settling animation being
 *   mistaken for one.
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
  originName,
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

  // How long we are still willing to believe that the last move of ours has an
  // animation coming. One-shot: the first zoomstart inside it is that animation
  // (see the listener), and spends it.
  let programmaticStartUntil = 0;

  // Reports whether the move ran. A caller that records "this stretch is framed"
  // off a refused move would never ask for that frame again — it has to hear the
  // refusal, not infer it.
  function moveProgrammatically(fn) {
    // The dragged pin owns the map pane: Leaflet only compensates for the pans it
    // makes itself (Marker's autoPan), so any camera move of ours would desync
    // the pin from the cursor and skew the km it reports. Wait for the release.
    if (draggingPinIndex !== null) return false;
    // A second move before the first one's animation started re-arms both: the
    // suppression extends rather than ending, same as it does for the settle
    // window on an interrupting move.
    const now = performance.now();
    programmaticUntil = now + PROGRAMMATIC_SETTLE_MS;
    programmaticStartUntil = now + PROGRAMMATIC_START_MS;
    fn();
    return true;
  }

  // The map fires dragend from one place only — the user finishing a pan — so it
  // never needs the window. Nothing programmatic can produce it.
  map.on('dragend', () => {
    // Also ends the wait for our own animation. A fit that panned without zooming
    // leaves that deadline unspent, and a pan says plainly that the camera is the
    // user's now — leaving it live would hand them a re-arm for their next
    // wheel-zoom to spring.
    programmaticStartUntil = 0;
    if (typeof onUserMove === 'function') onUserMove();
  });

  // Our own move's animation, starting at last. The settle window was armed when
  // the move was CALLED, and on a busy main thread the animation can start after
  // it has already expired (967ms, measured — see PROGRAMMATIC_START_MS), so
  // re-arm it from where the animation really begins. One-shot: the deadline is
  // spent here, so the next zoomstart with no move of ours behind it is the
  // user's and its zoomend says so.
  map.on('zoomstart', () => {
    if (performance.now() >= programmaticStartUntil) return;
    programmaticUntil = performance.now() + PROGRAMMATIC_SETTLE_MS;
    programmaticStartUntil = 0;
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
    programmaticStartUntil = 0; // as unambiguous as a drag: same reason as dragend
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

  // Static start pin at km 0 — the first route coordinate.
  //
  // The place name comes in from the route data rather than being spelled out
  // here: which town km 0 is in is a fact about the route, and the module has no
  // business knowing it. With no name given the pin claims nothing — a wrong
  // fallback town would be worse than an unnamed pin, and this module has to stay
  // mountable on its own.
  // The glyph followed the same rule as the title, and for the same reason: it used
  // to be a hardcoded "H" for Hamburg, which silently became wrong the moment km 0
  // moved to Cuxhaven. An initial derived from the name cannot go stale that way.
  const startCoord = routeFeature.geometry.coordinates[0];
  L.marker(toLatLng(startCoord), {
    icon: numberedPinIcon(originName ? originName.trim().charAt(0).toUpperCase() : '•', 'start'),
    zIndexOffset: 400,
    title: originName ? `Start — ${originName}` : 'Start',
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
