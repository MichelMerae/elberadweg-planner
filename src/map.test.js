// @vitest-environment jsdom
//
// map.js against a real Leaflet, in jsdom. These cover the guards whose failure
// symptoms are QUIET — a drag that dies mid-stroke, a camera that stops
// following, a marker whose row never renders — rather than anything that throws.
// Promoted from the probe suite Task 13's review ran. The probes that EXISTED to
// characterise Leaflet's internals were deliberately left behind — they asserted on
// `_panAnim` and friends, so a Leaflet bump would fail them with no regression
// behind it.
//
// Not a clean line, and worth saying: the recovery block below does reach into
// Draggable internals (`beginRealDrag` sets `_moved`/`_moving`/`_startPos`/
// `_newPos`), because staging a half-finished drag is the one thing jsdom cannot
// produce for us. The difference is what they are for — those are SETUP, and every
// assertion around them is on the app's own behaviour instead. The single exception
// is `L.Draggable._dragging`, asserted because that static IS the symptom: while it
// stays set, Leaflet blocks map panning and every later drag.
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

// Comfortably beyond both of map.js's deadlines, whatever it has them tuned to,
// so these tests don't sit on the boundary the next tuning pass moves.
const WELL_PAST_WINDOW = 30000;

// A driveable performance.now(), because every deadline in map.js is measured
// against it. The tests that only need "long afterwards" pin the clock with a
// plain mockReturnValue; the attribution ones below have to step it.
function fakeClock() {
  let now = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return (ms) => {
    now += ms;
  };
}

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

// The only marker wearing the start variant — the day pins carry 'day' and the
// POIs are not pin icons at all. `createdMarkers` never forgets one, so this finds
// the FIRST ever built; the tests that re-set the pin filter for the live one instead.
function startPin() {
  return createdMarkers.find((m) =>
    (m.options.icon?.options?.className || '').includes('pin-icon--start'),
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

  // Arrow keys reach Leaflet's own keyboard handler on the container, and fire
  // neither dragend nor zoomend — so without this, a keyboard user's pan was the
  // one pan the app did not hand the camera over for, and the next focus change
  // pulled the view back out from under them.
  it('hands the camera over for a keyboard pan', () => {
    const onUserMove = vi.fn();
    createMap({ routeFeature: ROUTE, onUserMove });

    capturedMap
      .getContainer()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  it('ignores a key that pans nothing', () => {
    const onUserMove = vi.fn();
    createMap({ routeFeature: ROUTE, onUserMove });

    capturedMap
      .getContainer()
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

    expect(onUserMove).not.toHaveBeenCalled();
  });

  // The deliberate exclusion, pinned: moveend must NOT be read as the user taking
  // over. Gating it on the settle window is the tempting version and loses a race
  // it runs on every single fit — a pan's moveend was measured landing 700ms into a
  // 1000ms window — and losing it once kills camera-follow for the session. autoPan
  // fires ~60 moveend/s during a pin drag with the window never re-armed, which is
  // the same failure at sixty times the rate.
  it('never mistakes a moveend for the user, however late it lands', () => {
    const onUserMove = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onUserMove });
    api.setDayPins(PINS, { draggable: true, onDragBoundary: () => {} });
    const base = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(base + WELL_PAST_WINDOW);

    api.focusRange(HAMBURG_END); // a real fit, and a real moveend with it
    capturedMap.fire('moveend'); // and one arriving long after any window
    dayPins()[1].fire('dragstart');
    capturedMap.panBy([40, 0], { animate: false }); // autoPan's storm, in miniature
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

// The measured production failure: adding a second day fired zoomstart 967ms
// after the fitBounds call — the same tick's render work starved the main thread
// before Leaflet's animation could start — and the zoomend at 1228ms landed past a
// window armed when the call was MADE. The app read its own fit as the user's and
// camera-follow went off for the rest of the session, silently.
describe('createMap - a programmatic zoom whose animation starts late', () => {
  // Arms the deadlines and emits nothing, which is what a real fit does in a
  // browser: the animation starts a frame or more after the call. jsdom runs the
  // fit synchronously instead, so its zoomstart would land INSIDE
  // moveProgrammatically — the one timing production never produces, and the only
  // one the single-window code survived.
  function programmaticFit(api) {
    vi.spyOn(capturedMap, 'fitBounds').mockImplementation(() => {});
    expect(api.focusRange(HAMBURG_END)).toBe(true);
  }

  it('counts the zoom as ours when the animation only started 967ms after the fit', () => {
    const onUserMove = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onUserMove });
    const advance = fakeClock();
    advance(WELL_PAST_WINDOW); // the constructor's own fit is long settled

    programmaticFit(api);
    advance(967);
    capturedMap.fire('zoomstart'); // the animation, at last
    advance(261);
    capturedMap.fire('zoomend'); // 1228ms after the call, and still ours

    expect(onUserMove).not.toHaveBeenCalled();
  });

  // The other direction, which is the one a re-arm can quietly break: a zoom with
  // no programmatic move behind it is the user's, whether or not it announces
  // itself with a zoomstart first.
  it('hands the camera over for a zoom with no move of ours behind it', () => {
    const onUserMove = vi.fn();
    createMap({ routeFeature: ROUTE, onUserMove });
    const advance = fakeClock();
    advance(WELL_PAST_WINDOW);

    capturedMap.fire('zoomstart');
    capturedMap.fire('zoomend');

    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  // A fit that produced no zoom at all leaves the start deadline unspent. It must
  // expire on its own, or every later user zoom would spring a re-arm that was
  // never meant for it.
  it('stops waiting for an animation that never came', () => {
    const onUserMove = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onUserMove });
    const advance = fakeClock();
    advance(WELL_PAST_WINDOW);

    programmaticFit(api);
    advance(4000); // past any wait for our animation to start
    capturedMap.fire('zoomstart');
    advance(100);
    capturedMap.fire('zoomend');

    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  // One-shot: the first zoomstart IS our animation, so it consumes the wait. A
  // second one is a new gesture, and only a fresh programmatic move can cover it.
  it('re-arms for the first zoomstart only', () => {
    const onUserMove = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onUserMove });
    const advance = fakeClock();
    advance(WELL_PAST_WINDOW);

    programmaticFit(api);
    advance(500);
    capturedMap.fire('zoomstart'); // ours
    advance(100);
    capturedMap.fire('zoomend');
    expect(onUserMove).not.toHaveBeenCalled();

    advance(1400); // the re-armed settle window has expired
    capturedMap.fire('zoomstart'); // the user's, inside the old start deadline
    advance(100);
    capturedMap.fire('zoomend');

    expect(onUserMove).toHaveBeenCalledTimes(1);
  });

  // A pan is unambiguous, and it says the wait is over: whatever our fit was going
  // to animate, it isn't going to now.
  it.each([
    ['a drag', () => capturedMap.fire('dragend')],
    [
      'a pan key',
      () =>
        capturedMap
          .getContainer()
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    ],
  ])('drops the wait when the user takes the camera with %s', (_label, takeCamera) => {
    const onUserMove = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onUserMove });
    const advance = fakeClock();
    advance(WELL_PAST_WINDOW);

    programmaticFit(api);
    takeCamera();
    expect(onUserMove).toHaveBeenCalledTimes(1);

    advance(1500); // the settle window is gone; nothing may re-arm it now
    capturedMap.fire('zoomstart');
    advance(100);
    capturedMap.fire('zoomend');

    expect(onUserMove).toHaveBeenCalledTimes(2);
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
  // The first 150 of the order they were HANDED IN, which is the same 150 places.js's
  // ROW_CAP keeps, because a marker hover highlights a panel row BY KEY: a marker whose
  // row was never rendered highlights nothing. These POIs have the detour shrinking as
  // the km rises, so "the first 150" and "the 150 nearest the route" are different sets —
  // the criterion is what these pin, not the number.
  const DENSE = Array.from({ length: 155 }, (_, i) => ({
    name: `Food ${i}`,
    kind: 'food',
    routeDistanceKm: 100 + i,
    offsetKm: 155 - i,
    lat: 53 + i * 0.01,
    lng: 10 + i * 0.01,
  }));

  it('keeps the first 150 of a kind in the order they arrive', () => {
    const api = createMap({ routeFeature: ROUTE });

    api.setPoiMarkers(DENSE);

    const names = poiMarkers().map(tooltipText);
    expect(names).toHaveLength(150);
    expect(names[0]).toBe('Food 0');
    expect(names[149]).toBe('Food 149');
  });

  // The other half of that contract, and the half an ascending fixture cannot see.
  // main.js hands the panel and the map ONE list, in the rider's direction of travel
  // (poisInRange returns a stretch in the order its span was asked in), and each caps
  // it to a prefix — so the map must keep a prefix of what it was given and impose no
  // order of its own. A map that re-sorted by absolute km passed every test in this
  // file, because on an ascending list "the order it arrived in" and "sorted by km" are
  // the same answer. Downstream they are opposite ends of the day: the panel would list
  // the cafés the rider reaches first while the map pinned the ones they reach last,
  // and not one visible row would have a pin.
  it('keeps a descending ride order as given, so its 150 are the panel’s 150', () => {
    const api = createMap({ routeFeature: ROUTE });

    api.setPoiMarkers([...DENSE].reverse()); // a downstream day's stretch, first met first

    const names = poiMarkers().map(tooltipText);
    expect(names).toHaveLength(150);
    expect(names[0]).toBe('Food 154'); // km 254 — where this rider starts the day
    expect(names[149]).toBe('Food 5');
    expect(names).not.toContain('Food 0'); // km 100 — met last, and past the cap
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

describe('createMap - picking mode', () => {
  function clickAt(lat, lng) {
    capturedMap.fire('click', { latlng: L.latLng(lat, lng) });
  }

  it('sends a click to onRouteClick when nothing is armed', () => {
    const onRouteClick = vi.fn();
    const onPickPoint = vi.fn();
    createMap({ routeFeature: ROUTE, onRouteClick, onPickPoint });

    clickAt(53.3, 10.5);

    expect(onRouteClick).toHaveBeenCalledWith([10.5, 53.3]);
    expect(onPickPoint).not.toHaveBeenCalled();
  });

  // The exclusivity IS the feature: a route click already means "add a custom stop to
  // the focused day", so an armed click that also did that would drop a 📌 on the plan
  // every time the rider chose where to begin.
  it('sends an armed click to onPickPoint INSTEAD, never to onRouteClick', () => {
    const onRouteClick = vi.fn();
    const onPickPoint = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onRouteClick, onPickPoint });

    api.setPickingMode('start');
    clickAt(53.3, 10.5);

    expect(onPickPoint).toHaveBeenCalledWith([10.5, 53.3], 'start');
    expect(onRouteClick).not.toHaveBeenCalled();
  });

  it('reports the end it was armed for, not a fixed one', () => {
    const onPickPoint = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onPickPoint });

    api.setPickingMode('destination');
    clickAt(53.3, 10.5);

    expect(onPickPoint).toHaveBeenCalledWith([10.5, 53.3], 'destination');
  });

  // main.js owns the mode (it holds the prompt, the two controls' pressed state and
  // the Escape path), so nothing here disarms itself — and a mode that could be armed
  // and not cleared would leave every later click picking instead of adding stops.
  it('stays armed until it is disarmed, and then routes clicks normally again', () => {
    const onRouteClick = vi.fn();
    const onPickPoint = vi.fn();
    const api = createMap({ routeFeature: ROUTE, onRouteClick, onPickPoint });

    api.setPickingMode('start');
    clickAt(53.3, 10.5);
    clickAt(53.0, 11.4);
    expect(onPickPoint).toHaveBeenCalledTimes(2);
    expect(onRouteClick).not.toHaveBeenCalled();

    api.setPickingMode(null);
    clickAt(52.5, 12.3);
    expect(onPickPoint).toHaveBeenCalledTimes(2);
    expect(onRouteClick).toHaveBeenCalledTimes(1);
  });

  it('marks the container while armed and unmarks it after', () => {
    const api = createMap({ routeFeature: ROUTE });
    const container = capturedMap.getContainer();

    api.setPickingMode('start');
    expect(container.classList.contains('map--picking')).toBe(true);
    api.setPickingMode(null);
    expect(container.classList.contains('map--picking')).toBe(false);
  });
});

// The pin used to be built once, at construction, from the ROUTE's first coordinate:
// the ROAD's origin. On a downstream trip that is the rider's DESTINATION, wearing the
// origin's name; on any offset trip it is road they never ride. So it stops being a
// fact about the road and becomes trip state, set from main.js — which is why all
// three of the cases below moved from `createMap(...)` to `api.setStartPin(...)`.
describe('createMap - the start pin follows the trip', () => {
  const HAMBURG = [9.99, 53.55];
  const PRAGUE = [13.74, 51.05];

  it('draws no start pin until it is told where the rider starts', () => {
    createMap({ routeFeature: ROUTE });

    expect(startPin()).toBeUndefined();
  });

  it('names the rider’s own start, which downstream is the road’s far end', () => {
    const api = createMap({ routeFeature: ROUTE });

    api.setStartPin({ coord: PRAGUE, name: 'Prague' });

    expect(startPin().options.title).toBe('Start — Prague');
    expect(startPin().options.icon.options.html).toContain('P');
    expect(startPin().getLatLng().lng).toBeCloseTo(13.74, 6);
  });

  it('claims nothing for a start that has no name', () => {
    const api = createMap({ routeFeature: ROUTE });

    api.setStartPin({ coord: HAMBURG, name: null });

    expect(startPin().options.title).toBe('Start');
    expect(startPin().options.icon.options.html).not.toContain('H'); // no stale initial
  });

  // The pin MOVES rather than multiplying. Every render calls this, so a missing
  // clearLayers leaves one pin per render standing on the map — each with the name it
  // had at the time, which is a trip's whole history drawn at once.
  it('keeps exactly one pin across renders, at the newest position', () => {
    const api = createMap({ routeFeature: ROUTE });

    api.setStartPin({ coord: PRAGUE, name: 'Prague' });
    api.setStartPin({ coord: HAMBURG, name: 'Hamburg' });

    const pins = createdMarkers.filter((m) =>
      (m.options.icon?.options?.className || '').includes('pin-icon--start'),
    );
    const live = pins.filter((m) => capturedMap.hasLayer(m) || m._map);
    expect(live).toHaveLength(1);
    expect(live[0].options.title).toBe('Start — Hamburg');
  });
});
