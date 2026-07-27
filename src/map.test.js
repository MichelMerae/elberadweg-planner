// @vitest-environment jsdom
//
// map.js against a real Leaflet, in jsdom. These cover the guards whose failure
// symptoms are QUIET — a drag that dies mid-stroke, a camera that stops
// following, a marker whose row never renders — rather than anything that throws.
// Promoted from the probe suite Task 13's review ran; the probes that reached into
// Leaflet internals (`_moved`, `_panAnim`) were deliberately left behind, because
// they would break on a Leaflet bump without a real regression behind it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import L from 'leaflet';
import { createMap } from './map.js';

const ROUTE = {
  type: 'Feature',
  geometry: {
    type: 'LineString',
    coordinates: [
      [9.99, 53.55],
      [10.5, 53.3],
      [11.4, 53.0],
      [12.3, 52.5],
      [13.74, 51.05],
    ],
  },
};

const HAMBURG_END = [
  [9.99, 53.55],
  [10.5, 53.3],
];
const DRESDEN_END = [
  [12.3, 52.5],
  [13.74, 51.05],
];

const PINS = [
  { index: 0, coord: [10.5, 53.3] },
  { index: 1, coord: [11.4, 53.0] },
  { index: 2, coord: [12.3, 52.5] },
];

// jsdom has no 2D context, and Leaflet's canvas renderer only ever calls into it.
const noopCtx = new Proxy(
  {},
  {
    get: (t, p) => (p in t ? t[p] : () => {}),
    set: (t, p, v) => {
      t[p] = v;
      return true;
    },
  },
);

// Comfortably beyond PROGRAMMATIC_SETTLE_MS, whatever map.js has it tuned to, so
// these tests don't sit on the boundary the next tuning pass moves.
const WELL_PAST_WINDOW = 30000;

// Two permanent mutations of shared state, both deliberate:
//
//   the init hooks   the only way to reach the map and the markers map.js builds
//                    privately. They are registered on Leaflet's prototypes for
//                    the lifetime of the module, which is fine because Vitest
//                    isolates modules per test FILE — no other suite imports
//                    Leaflet, and nothing here leaks into one that might.
//   getContext       replaced on HTMLCanvasElement.prototype (below), for the same
//                    per-file reason.
let capturedMap = null;
const createdMarkers = [];
L.Map.addInitHook(function () {
  capturedMap = this;
});
L.Marker.addInitHook(function () {
  createdMarkers.push(this);
});

function mount() {
  document.body.innerHTML = '<div id="map"></div>';
  const el = document.getElementById('map');
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  HTMLCanvasElement.prototype.getContext = () => noopCtx;
  capturedMap = null;
  createdMarkers.length = 0;
}

function dayPins() {
  return createdMarkers.filter((m) => m.options.title?.startsWith('Day '));
}

function poiMarkers() {
  return createdMarkers.filter((m) =>
    (m.options.icon?.options?.className || '').includes('poi-marker'),
  );
}

function tooltipText(marker) {
  return marker.getTooltip()?.getContent();
}

beforeEach(mount);
afterEach(() => {
  vi.restoreAllMocks();
});

describe('createMap - a pin drag holds everything else still', () => {
  // Removing the dragged marker makes Leaflet unsubscribe MarkerDrag's handlers
  // and only then disable the Draggable, so the drag it ends fires into nothing:
  // the gesture dies mid-stroke and its dragend — the commit — never arrives.
  it('does not rebuild the pins under an in-flight drag', () => {
    const onDragBoundary = vi.fn();
    const api = createMap({ routeFeature: ROUTE });
    api.setDayPins(PINS, { draggable: true, onDragBoundary });
    const built = dayPins();
    expect(built).toHaveLength(3);

    built[1].fire('dragstart');
    api.setDayPins(PINS, { draggable: true, onDragBoundary }); // a preview render

    expect(capturedMap.hasLayer(built[1])).toBe(true); // same marker, drag alive
    expect(built[1].dragging.enabled()).toBe(true);

    built[1].fire('dragend');
    expect(onDragBoundary).toHaveBeenCalledWith(1, [11.4, 53.0], true);

    api.setDayPins(PINS, { draggable: true, onDragBoundary }); // the commit render
    expect(capturedMap.hasLayer(built[1])).toBe(false); // now it IS replaced
  });

  // Our own camera moving during a pin drag slides the icon out from under the
  // cursor: Leaflet compensates only for the pans it makes itself.
  it('refuses every camera move while a pin is being dragged', () => {
    const api = createMap({ routeFeature: ROUTE });
    api.setDayPins(PINS, { draggable: true, onDragBoundary: () => {} });
    const pin = dayPins()[1];

    // Park the camera off the whole-route framing, so every call below would be a
    // visible move if it went through.
    api.focusRange(HAMBURG_END);
    const parked = capturedMap.getCenter();

    pin.fire('dragstart');
    expect(api.fitWholeRoute({ animate: false })).toBe(false);
    expect(capturedMap.getCenter()).toEqual(parked);
    expect(api.focusRange(DRESDEN_END)).toBe(false);
    expect(capturedMap.getCenter()).toEqual(parked);
    // panTo's refusal cannot be seen in the centre: it animates, and jsdom runs no
    // animation, so the centre is byte-identical whether the call went through or
    // not. Watch the forwarding instead.
    const panned = vi.spyOn(capturedMap, 'panTo');
    api.panTo([13.74, 51.05]);
    expect(panned).not.toHaveBeenCalled();

    pin.fire('dragend');
    api.focusRange(DRESDEN_END);
    expect(capturedMap.getCenter()).not.toEqual(parked);
  });

  it('defers an invalidate that lands mid-drag until the pin is released', () => {
    const api = createMap({ routeFeature: ROUTE });
    api.setDayPins(PINS, { draggable: true, onDragBoundary: () => {} });
    const pin = dayPins()[1];
    const el = document.getElementById('map');

    pin.fire('dragstart');
    Object.defineProperty(el, 'clientWidth', { value: 500, configurable: true });
    api.invalidate();
    expect(capturedMap.getSize().x).toBe(800); // dropped for now: the pane must hold still

    pin.fire('dragend');
    expect(capturedMap.getSize().x).toBe(500); // ...but not forgotten
  });
});

describe('createMap - who moved the camera', () => {
  // A pan is always the user's; nothing programmatic produces dragend.
  it('never attributes a map dragend to the app, however recent our move was', () => {
    const onUserMove = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onUserMove });
    api.focusRange(HAMBURG_END);

    capturedMap.fire('dragend');

    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  it('attributes zoomend to the app inside the settle window and to the user after it', () => {
    const onUserMove = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onUserMove });

    capturedMap.fire('zoomend'); // the constructor's own fit is still settling
    expect(onUserMove).not.toHaveBeenCalled();

    const base = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(base + WELL_PAST_WINDOW);
    capturedMap.fire('zoomend');
    expect(onUserMove).toHaveBeenCalledTimes(1); // the window has expired

    onUserMove.mockClear();
    api.fitWholeRoute({ animate: false }); // re-arms it
    capturedMap.fire('zoomend');
    expect(onUserMove).not.toHaveBeenCalled();
  });

  // Arrow keys go through Leaflet's panBy: no dragend, no zoomend. Without moveend
  // this was the one pan the app did not hand the camera over for, so the next
  // focus change pulled the view back out from under a keyboard user.
  it('hands the camera over for a keyboard pan', () => {
    const onUserMove = vi.fn();
    createMap({ routeFeature: ROUTE, onUserMove });
    const base = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(base + WELL_PAST_WINDOW);

    capturedMap.panBy([120, 0], { animate: false });

    expect(onUserMove).toHaveBeenCalled();
  });

  it('keeps a moveend of its own to itself', () => {
    const onUserMove = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onUserMove });

    api.focusRange(HAMBURG_END); // a real fit, and a real moveend with it

    expect(onUserMove).not.toHaveBeenCalled();
  });

  // autoPan re-schedules itself every frame while a dragged pin sits near the
  // viewport edge, and moveProgrammatically is held off for the whole drag — so
  // the settle window is never re-armed and all ~60 moveend/s would otherwise read
  // as the user taking over, switching camera-follow off mid-drag.
  it('ignores the moveend storm autoPan makes during a pin drag', () => {
    const onUserMove = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onUserMove });
    api.setDayPins(PINS, { draggable: true, onDragBoundary: () => {} });
    const base = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(base + WELL_PAST_WINDOW);

    dayPins()[1].fire('dragstart');
    capturedMap.panBy([40, 0], { animate: false });
    capturedMap.panBy([40, 0], { animate: false });

    expect(onUserMove).not.toHaveBeenCalled();
  });

  // renderCamera records "this stretch is framed" and skips the fit next time the
  // key matches, so a refused fit that got recorded anyway strands the map on the
  // old day forever — only "⤢ this day" could break the tie.
  it('reports a refused fit, so a caller cannot book a frame that never drew', () => {
    const api = createMap({ routeFeature: ROUTE });
    api.setDayPins(PINS, { draggable: true, onDragBoundary: () => {} });
    const pin = dayPins()[1];

    let framedKey = null;
    const frameStretch = (key, coords) => {
      if (key === framedKey) return;
      if (api.focusRange(coords)) framedKey = key;
    };

    pin.fire('dragstart');
    const held = capturedMap.getCenter();
    frameStretch('2:160:240', HAMBURG_END); // focus moves mid-drag
    expect(framedKey).toBeNull(); // nothing booked...
    expect(capturedMap.getCenter()).toEqual(held); // ...because nothing moved

    pin.fire('dragend');
    frameStretch('2:160:240', HAMBURG_END); // the next render catches up
    expect(framedKey).toBe('2:160:240');
    expect(capturedMap.getCenter()).not.toEqual(held);
  });

  it('reports a fit refused for want of coordinates', () => {
    const api = createMap({ routeFeature: ROUTE });
    expect(api.focusRange([])).toBe(false);
    expect(api.focusRange(null)).toBe(false);
    expect(api.fitWholeRoute({ animate: false })).toBe(true);
  });
});

describe('createMap - a pin drag the page never saw the end of', () => {
  // Leaflet ends a marker drag on a document-level mouseup. A pointer released
  // where the page cannot see it leaves the gesture half alive: the pin follows the
  // bare cursor, rewriting the plan on hover, and no dragend ever arrives.
  //
  // Puts Leaflet's Draggable into the state a real in-flight drag leaves it, then
  // fires the marker's dragstart so map.js latches on alongside it.
  function beginRealDrag(pin) {
    const draggable = pin.dragging._draggable;
    draggable._moved = true;
    draggable._moving = true;
    draggable._startPos = L.point(0, 0);
    draggable._newPos = L.point(24, 0);
    L.Draggable._dragging = draggable;
    pin.fire('dragstart');
    return draggable;
  }

  // The first move back over the page carries no button.
  function pointerDiesUnseen() {
    window.dispatchEvent(new MouseEvent('pointermove', { buttons: 0 }));
  }

  it('commits it once, where the pin sits, and releases every guard', () => {
    const onDragBoundary = vi.fn();
    const api = createMap({ routeFeature: ROUTE });
    api.setDayPins(PINS, { draggable: true, onDragBoundary });
    const pin = dayPins()[1];
    beginRealDrag(pin);

    pointerDiesUnseen();

    // Committed where the pin sits, exactly once, through the ordinary path.
    expect(onDragBoundary).toHaveBeenCalledTimes(1);
    expect(onDragBoundary).toHaveBeenCalledWith(1, [11.4, 53.0], true);
    // Leaflet's own gesture is over too — while Draggable._dragging stays set it
    // blocks map panning and every later drag.
    expect(L.Draggable._dragging).toBe(false);
    api.setDayPins(PINS, { draggable: true, onDragBoundary });
    expect(capturedMap.hasLayer(pin)).toBe(false); // pins rebuild again
    const before = capturedMap.getCenter();
    api.focusRange(HAMBURG_END);
    expect(capturedMap.getCenter()).not.toEqual(before); // and the camera moves again
  });

  it('runs an invalidate the drag deferred', () => {
    const api = createMap({ routeFeature: ROUTE });
    api.setDayPins(PINS, { draggable: true, onDragBoundary: () => {} });
    const el = document.getElementById('map');
    beginRealDrag(dayPins()[1]);

    Object.defineProperty(el, 'clientWidth', { value: 500, configurable: true });
    api.invalidate();
    expect(capturedMap.getSize().x).toBe(800); // deferred

    pointerDiesUnseen();
    expect(capturedMap.getSize().x).toBe(500); // flushed by the recovery
  });

  it('leaves a live drag alone and stops watching once it ends', () => {
    const onDragBoundary = vi.fn();
    const api = createMap({ routeFeature: ROUTE });
    api.setDayPins(PINS, { draggable: true, onDragBoundary });
    const pin = dayPins()[1];
    beginRealDrag(pin);

    window.dispatchEvent(new MouseEvent('pointermove', { buttons: 1 }));
    expect(onDragBoundary).not.toHaveBeenCalled(); // button still down: not ours

    pin.fire('dragend');
    expect(onDragBoundary).toHaveBeenCalledTimes(1);

    pointerDiesUnseen(); // the watchers must be gone — no second commit
    expect(onDragBoundary).toHaveBeenCalledTimes(1);
  });
});

describe('createMap - POI markers', () => {
  // Route order, and the same 40 places.js's ROW_CAP keeps, because a marker hover
  // highlights a panel row BY KEY: a marker whose row was never rendered
  // highlights nothing. These POIs run in route order with the detour shrinking
  // along the way, so "the first 40" and "the 40 nearest the route" are different
  // sets — the criterion is what this pins, not the number.
  const DENSE = Array.from({ length: 45 }, (_, i) => ({
    name: `Food ${i}`,
    kind: 'food',
    routeDistanceKm: 100 + i,
    offsetKm: 45 - i,
    lat: 53 + i * 0.01,
    lng: 10 + i * 0.01,
  }));

  it('keeps the first 40 of a kind in route order', () => {
    const api = createMap({ routeFeature: ROUTE });

    api.setPoiMarkers(DENSE);

    const names = poiMarkers().map(tooltipText);
    expect(names).toHaveLength(40);
    expect(names[0]).toBe('Food 0');
    expect(names[39]).toBe('Food 39');
  });

  // The temporary marker for a capped-out POI is added to the map, not to the POI
  // layer, so clearing that layer does not take it with it: a re-render under a
  // stationary cursor stranded a highlighted dot and an open tooltip on the map.
  it('clears a temporary highlight marker when the markers are rebuilt', () => {
    const api = createMap({ routeFeature: ROUTE });
    api.setPoiMarkers([]);

    api.setPoiHighlight(DENSE[0]);
    const temp = poiMarkers().at(-1);
    expect(capturedMap.hasLayer(temp)).toBe(true);

    api.setPoiMarkers(DENSE);

    expect(capturedMap.hasLayer(temp)).toBe(false);
  });
});
