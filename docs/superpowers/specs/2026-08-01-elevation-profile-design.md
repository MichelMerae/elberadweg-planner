# Elevation profile: what the day costs, not just how long it is

**Date:** 2026-08-01
**Status:** designed and built without a review gate — Michel asked for it explicitly and delegated the visual decisions while asleep. **Everything under "Decisions I made on your behalf" needs a look.**
**Depends on:** `2026-07-31-cuxhaven-prague-route-design.md` (the profile is sampled from the finished route geometry)

## Problem

The planner measures a day in kilometres and nothing else. Two 80 km days are presented as identical, and they are not: one along the Altmark dikes is flat, one from Bad Schandau into the Czech Central Highlands is not. A rider choosing where to stop has no way to see that.

Michel's ask, verbatim: *"that will give the user better idea to plan the distances, when they know the elevation of that distance, and maybe where to have a break."* Two distinct needs in that sentence — **how hard is this day** (a number per day) and **where does it get hard** (a shape along the route) — and they want different treatments.

## The honesty problem, up front

This route is nearly flat. Cuxhaven is at sea level, Prague at 184 m, and the Elbe descends the whole way in between. Over 1026 km that is a gradient you cannot see on a 100 px strip without exaggerating the vertical scale by roughly 500:1.

Michel's mock-up shows a jagged line, which is what min–max autoscaling produces — and that jaggedness is real relief, honestly drawn, at a scale that flatters it enormously. **An exaggerated profile with no scale label is a lie**, because it invites reading a 30 m river-terrace bump as a climb. So the design labels the vertical range wherever the profile appears. That is not decoration; it is the thing that makes the exaggeration legitimate.

Second honesty problem: **cumulative ascent is an artefact of sampling interval and DEM noise.** Sample a flat road every 10 m against a ±3 m DEM and you can manufacture hundreds of metres of "climbing". Any ascent figure shown must be computed with a threshold and described as approximate.

## Decisions I made on your behalf

| Decision | Choice | Why |
| --- | --- | --- |
| Data source | **Open-Meteo elevation API** | No API key, Copernicus DEM GLO-90, 10k requests/day. Verified: Hamburg 5 m, Dresden 115 m, Prague 184 m, Bad Schandau 176 m — all plausible. |
| Sampling | **every 250 m**, 4,106 points | Set by the provider's quota, not by taste — see below. 100 m would match the DEM's ~90 m resolution, but costs an entire day's allowance. |
| Batch size | **100 coordinates per request**, 42 requests | Measured, not assumed: 101 returns `must not exceed 100 coordinates`. |
| Pacing | **12 s between requests** | Open-Meteo weights its allowance by *number of locations*, not requests. Six consecutive 100-location batches returned HTTP 429 — ~600 locations, exactly their per-minute ceiling. |
| Optional-data loading | **`import.meta.glob`**, not a bare dynamic import | A `try/catch` around `await import('./data/elevation.json')` only *looks* like it degrades: Vite resolves the specifier at transform time, so a missing file is a build error before any catch runs. |
| When it runs | **A separate `scripts/build-elevation.mjs`** | Different upstream from Overpass, and a towns refresh should not re-fetch 103 elevation requests. |
| Colour | **A new muted `--terrain` token, not red** | Red is already the day-boundary colour (`--day`, mirroring the map's numbered pins). A red profile would read as a boundary. |
| Layer position | **Over the day blocks, under the handles, `pointer-events: none`** | Blocks are opaque (`background: var(--surface)`), so a profile behind them would only show in the gaps. This is the same axis-level layer pattern the break glyphs already use. |
| Vertical scale | **Whole-route min–max, labelled** | Per-day autoscaling would make every day look equally hilly. One scale across the route makes days comparable, and the label makes the exaggeration readable. |
| Ascent figure | **Hysteresis threshold of 5 m, labelled approximate** | Without a threshold the number is DEM noise. With one it is stable and roughly comparable to what a bike computer reports. |

## Design

### 1. `src/data/elevation.json`

```json
{
  "routeId": "cuxhaven-prague-ev7-v1",
  "spacingM": 250,
  "count": 4106,
  "minM": -1,
  "maxM": 205,
  "source": "Open-Meteo elevation API (Copernicus DEM GLO-90)",
  "elevationsM": [3, 3, 4, 4, 5, "…"]
}
```

A flat array of integers, index `i` ↔ km `i × 0.25`. Integers because the DEM's vertical accuracy does not support decimals, and because floats would triple the file for no information.

**The cost of 250 m, stated plainly:** a climb shorter than 250 m gets averaged away. On this corridor that is acceptable — the Czech-section climbs that matter are kilometre-scale, and the 5 m ascent threshold already discards features of that size — but it is a real loss, forced by the quota rather than chosen. A self-hosted DEM would lift it.

`routeId` is the safety catch: elevation sampled from a different corridor is meaningless. The app checks it and degrades rather than drawing a profile that belongs to another road.

### 2. `scripts/build-elevation.mjs`

Reads `route.json` and `route.meta.json`, samples every 100 m with `turf.along`, batches 100 coordinates per request, caches raw responses (keyed by routeId) so a re-run is free, and writes `elevation.json`. Rate-limited to one request per second with the same retry/backoff shape `build-data.mjs` uses for Overpass.

Validation before writing, all fatal:
- the sample count matches `ceil(totalKm × 10) + 1`
- no `null` elevations survive
- min ≥ −10 m and max ≤ 400 m (this corridor is a river valley; anything outside that means the sampling walked off the route)
- the endpoints read within 15 m of Cuxhaven ≈ 3 m and Prague ≈ 184 m
- `routeId` matches `route.meta.json`

### 3. `src/elevation.js` — pure functions, fully tested

| Function | Contract |
| --- | --- |
| `loadElevation()` | Dynamic import, mirroring `pois.js`. Resolves `null` on failure so a missing file never sinks boot. |
| `elevationAtKm(profile, km)` | Linear interpolation between samples; clamps outside the route. |
| `profilePoints(profile, {startKm, endKm, width, height, minM, maxM})` | Sample positions → SVG coordinates for a stretch. Pure, so the whole visual layer is testable without a DOM. |
| `ascentBetween(profile, startKm, endKm, {thresholdM})` | `{ascentM, descentM, minM, maxM}` with hysteresis: accumulate only once a monotonic run exceeds the threshold. |

### 4. The strip layer

A single `<svg class="strip__elevation" preserveAspectRatio="none">` inside the axis, holding one filled area path and one stroked top line. Rebuilt in the same `render()` pass as everything else, from the same `axisOpts()` width, so it cannot drift from the blocks.

Under the axis, the scale line gains the vertical range — `↕ 0–205 m` — which is what stops the exaggeration from misleading.

### 5. The day panel

The focused day gains one line: `↑ 240 m · ↓ 180 m ≈` with the `≈` carrying a tooltip explaining the threshold and that DEM-derived ascent is approximate. This is the number that answers "how hard is this day", and it belongs next to the day's distance rather than on the strip.

### 6. Degradation

`elevation.json` missing, unparseable, or carrying a different `routeId` → no SVG layer, no day-panel line, no scale-line range, and one `console.warn`. Exactly how `pois.json` already degrades. The app must never require the elevation build to have been run.

## Testing

`src/elevation.test.js` covers: interpolation at, between and outside samples; `profilePoints` mapping a known synthetic profile to known SVG coordinates at a given width and height; ascent with a flat profile (zero), a single climb, a sawtooth below threshold (zero, the point of the threshold), and a sawtooth above it; `routeId` mismatch rejection; and `loadElevation` resolving null on a failed import.

`src/strip.test.js` gains: the layer renders with a profile, is absent without one, sits under the handles in paint order, and carries `pointer-events: none`.

## Out of scope

A hover readout of elevation at the pointer; gradient-coloured steepness; per-break elevation; elevation on the map; smoothing controls; and using ascent to *suggest* day boundaries. The last is the interesting one and should be its own spec — it is the difference between showing effort and planning around it.

## Known limitation worth recording

The two ferry bridges (2.25 km at Finkenwerder, 3.26 km at the border) are straight lines across water. Sampling them yields water-surface elevations, which is harmless, but the profile will draw a flat run there as if it were road. `route.meta.json` records both bridge positions, so a later pass can mark them — noted rather than solved.
