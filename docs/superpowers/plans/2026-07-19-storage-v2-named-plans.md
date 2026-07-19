# Storage v2 + Named Plans Implementation Plan (Sub-project 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Read the spec first:** `docs/superpowers/specs/2026-07-19-storage-v2-named-plans-design.md` — it is the authority on requirements; this plan is the execution recipe.

**Goal:** Multi-plan persistence (named plans: create/rename/duplicate/delete/switch) in a new `storage.js`, with `itinerary.js` reduced to pure trip math and automatic v1→v2 migration (old pins → favorites data).

**Architecture:** `createPlanStore({storage, routeVersion})` owns the `elberadweg-plans` key (schema v2) and the migration; `itinerary.js` loses save/load/poiPins and gains `hydrate(dayEntries)`; `main.js` wires store↔itinerary and saves after every mutation; a plans bar renders in the right panel.

**Tech Stack:** existing only (vanilla JS, Vitest). No new deps.

**Sequencing:** Task 1 and Task 2 touch disjoint files and may run in parallel. Task 3 integrates (requires 1+2).

---

### Task 1: `src/storage.js` + tests

**Files:** Create `src/storage.js`, `src/storage.test.js`. Touch nothing else.

- [ ] **Step 1: TDD storage.test.js first** with a fake storage (`{store:{}, getItem, setItem}` — same fixture style as itinerary.test.js has today). Cover every case in the spec's Testing section: fresh start (no keys) → one empty plan "My plan" active; v1 migration (seed `elberadweg-itinerary` with `{schemaVersion:1, routeVersion:'v0', days:[{targetKm:80, townChoice:{name:'Lauenburg'}, poiPins:[{name:'Café X', kind:'food', routeDistanceKm:42, offsetKm:0.2, lat:53, lng:10}]}]}` → plan "My plan" with days minus poiPins, favorites key written `{schemaVersion:1, favorites:[...]}` deduped, v1 key untouched, second load() doesn't re-migrate or overwrite an existing favorites key); CRUD (createPlan auto-names "Plan 2", activates; renamePlan; duplicatePlan deep copy — mutate copy's days, original unchanged; deletePlan non-active; delete ACTIVE → most-recently-updated remaining becomes active; delete LAST → fresh "My plan"); saveActivePlan updates days/breaks/updatedAt/routeVersion; corrupted v2 JSON → fresh store, no throw; setItem that throws → save() best-effort no-crash; activePlanId persists across a second load() on the same storage.

- [ ] **Step 2: Run tests** — fail on missing module.

- [ ] **Step 3: Implement `src/storage.js`** per the spec API. Skeleton:

```js
const PLANS_KEY = 'elberadweg-plans';
const LEGACY_KEY = 'elberadweg-itinerary';
const FAVORITES_KEY = 'elberadweg-favorites';
const SCHEMA_VERSION = 2;

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createPlanStore({ storage, routeVersion } = {}) {
  let state = null; // { activePlanId, plans: [...] }

  function emptyPlan(name) {
    const now = new Date().toISOString();
    return { id: newId(), name, createdAt: now, updatedAt: now, routeVersion, days: [], breaks: [] };
  }
  function persist() { /* try { storage.setItem(PLANS_KEY, JSON.stringify({schemaVersion: SCHEMA_VERSION, ...state})) } catch {} */ }
  function migrateV1() { /* read LEGACY_KEY; on valid v1: return plan 'My plan' + write favorites (only if FAVORITES_KEY absent/empty), dedupe pins by `${kind}:${name}@${routeDistanceKm}`; never touch LEGACY_KEY */ }
  function load() { /* parse PLANS_KEY; wrong schema/corrupt/missing -> migrateV1() ?? fresh 'My plan'; always persist result; return {plans: metas, activePlanId} */ }
  // getActivePlan, setActivePlan, createPlan, duplicatePlan, deletePlan, renamePlan, saveActivePlan per spec
  return { load, getActivePlan, setActivePlan, createPlan, duplicatePlan, deletePlan, renamePlan, saveActivePlan };
}
```
Deep-copy on duplicate AND on getActivePlan's returned record where the spec demands defensiveness (`structuredClone` is available in Node 24 + browsers). `createPlan` auto-name: "Plan N" where N = plans.length + 1 (collisions acceptable).

- [ ] **Step 4:** `npx vitest run src/storage.test.js` → green. (Coordinator commits.)

### Task 2: Slim `src/itinerary.js` to pure math + `hydrate`

**Files:** Modify `src/itinerary.js`, `src/itinerary.test.js`. Touch nothing else. NOTE: main.js will temporarily break (it still calls itinerary save/load) — that's fixed in Task 3; do NOT edit main.js in this task; `npm run build` is expected to still pass (imports resolve) but the app is integration-broken until Task 3.

- [ ] **Step 1: Update tests first**: delete the persistence describe blocks (save/load/round-trip/contract/backward-compat) and ALL poiPins/togglePoiPin tests; add `hydrate` tests: `hydrate([{targetKm:80, townChoice:{name:'A'}}, {targetKm:80, townChoice:null}])` → days chained 0→80→160 with towns; hydrate replays clamp vs totalKm; `hydrate` with a malformed entry (negative targetKm) → days empty, no throw; hydrate replaces any existing days.

- [ ] **Step 2: Implement**: remove `save`, `load`, `poiPinKey`, `togglePoiPin`, `poiPins` from day records/`toPublicDay`/`addDay`, and the `storage`/`routeVersion` options + STORAGE_KEY/SCHEMA_VERSION constants. Add:

```js
// Replaces all days by replaying persisted entries through the same
// chain/clamp math. Malformed input hydrates to an empty itinerary.
function hydrate(entries) {
  try {
    if (!Array.isArray(entries)) throw new Error('not an array');
    const restored = entries.map((e) => {
      assertValidTargetKm(e.targetKm);
      return { targetKm: e.targetKm, startKm: 0, endKm: 0, townChoice: e.townChoice ?? null };
    });
    days = restored;
    recomputeFrom(0);
  } catch {
    days = [];
  }
}
```
`createItinerary({ totalKm })` only. Export `hydrate` in the API object; update the factory JSDoc.

- [ ] **Step 3:** `npx vitest run src/itinerary.test.js` → green.

### Task 3: Integration — main.js wiring + plans bar UI (requires Tasks 1–2)

**Files:** Modify `src/main.js`, `src/ui.js`, `index.html`, `src/style.css`.

- [ ] **Step 1: index.html** — add `<div id="plans"></div>` between `#panel-header` and `#banner` in the right panel.

- [ ] **Step 2: ui.js** — add `plansEl` option + `renderPlans({plans, activePlanId})` + callbacks `onSelectPlan(id)`, `onRenamePlan(name)`, `onNewPlan()`, `onDuplicatePlan()`, `onDeletePlan()`. Markup: `<select>` (options = plans, active selected), `<input type="text">` with active plan name (change → onRenamePlan; empty value → reset input to current name, no callback), buttons New/Duplicate/Delete (Delete inside `confirm('Delete plan "<name>"? ...')`). Event delegation on `#plans`. REMOVE pin-related UI: `poi--pinned` rendering path stays harmless but `pinnedKeys` handling and day-card `day-card__pins` chips are deleted (breaks/favorites re-add row actions in later sub-projects); POI row click now only fires a highlight/pan callback (`onSelectPoi(poi)` replacing `onTogglePoi`).

- [ ] **Step 3: main.js** — replace itinerary persistence wiring:
```js
const store = createPlanStore({ storage: window.localStorage, routeVersion: meta.builtAt });
store.load();
const itinerary = createItinerary({ totalKm });
itinerary.hydrate(store.getActivePlan().days);
// banner: if (store.getActivePlan().routeVersion !== meta.builtAt) showBanner(...)
function persistPlan() {
  store.saveActivePlan({
    days: itinerary.getDays().map((d) => ({ targetKm: d.targetKm, townChoice: d.townChoice })),
    breaks: [], // sub-project 2 fills this
  });
}
```
Call `persistPlan()` after every mutation (commit/edit/remove/reset/town-select). Plan callbacks: select → `setActivePlan` + re-hydrate + reset pending state + renderAll; new/duplicate/delete/rename → store call + renderPlans (+ re-hydrate when the active plan changed). Remove `pendingPoiPins` and pin semantics from `handleTogglePoi` (rename to `handleSelectPoi`: highlight/pan only); marker click same.

- [ ] **Step 4: style.css** — plans bar styling in the panel's design language (compact row: select grows, name input, three small buttons).

- [ ] **Step 5: Verify.** `npx vitest run` green; `npm run build` green; Playwright: seed a legacy v1 payload via `localStorage.setItem('elberadweg-itinerary', ...)` + reload → plan "My plan" appears with its days and `elberadweg-favorites` populated; commit days; New plan → empty itinerary, switch back restores; Duplicate + edit copy → original intact after switching; Delete active → graceful fallback; rename persists; reload restores active plan; zero console errors; clear localStorage; stop server.

### Final: full suite + build; coordinator commits and pushes.

## Self-review notes (done)
- Spec coverage: §1→Task 1, §2→Task 2, §3+§4→Task 3, error handling→Tasks 1–3 steps, testing→each task. No gaps.
- Consistency: `hydrate(entries)` array signature matches spec SP1 (SP2 extends it later); `saveActivePlan({days, breaks})` matches storage API; `onSelectPoi` naming consistent between ui/main steps.
- No placeholders: code skeletons given where implementation is non-obvious; the rest names exact existing patterns/files.
