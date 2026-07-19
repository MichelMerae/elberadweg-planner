const PLANS_KEY = 'elberadweg-plans';
const LEGACY_KEY = 'elberadweg-itinerary';
const FAVORITES_KEY = 'elberadweg-favorites';
const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const FAVORITES_SCHEMA_VERSION = 1;

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Deep copy used both for defensive copies of returned records and for the
// deep copy duplicatePlan() demands. structuredClone is available in Node 18+
// and modern browsers; the JSON fallback covers older runtimes and is safe for
// our plain-data records (no functions/dates/cycles).
function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

// A stored day carries only the planning inputs; startKm/endKm are derived by
// itinerary.js on hydrate. townChoice is normalized to null.
function normalizeDay(day) {
  return { targetKm: day?.targetKm, townChoice: day?.townChoice ?? null };
}

function normalizeDays(days) {
  return Array.isArray(days) ? days.map(normalizeDay) : [];
}

// Enforces the plan record shape on data read back from storage so the rest of
// the app can rely on days/breaks being arrays. Unknown fields are dropped.
function normalizePlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    routeVersion: plan.routeVersion,
    days: normalizeDays(plan.days),
    breaks: Array.isArray(plan.breaks) ? plan.breaks : [],
  };
}

/**
 * Creates the multi-plan storage layer for the Elberadweg planner. Owns the v2
 * `elberadweg-plans` blob and the one-time migration from the v1
 * `elberadweg-itinerary` payload. All reads/writes are guarded: a corrupted or
 * wrong-schema blob starts a fresh store (one empty "My plan") rather than
 * throwing, and a failing setItem (quota/denied) is swallowed so the in-memory
 * plan and the render that follows a mutation are never broken.
 *
 * Every mutating method persists immediately. Methods that take an id return
 * null (a no-op) for an unknown id.
 *
 * @param {Object} opts
 * @param {{getItem(key: string): string|null, setItem(key: string, value: string): void}} opts.storage
 *   - injected storage (e.g. `localStorage`).
 * @param {string} [opts.routeVersion] - current route version (e.g.
 *   `meta.builtAt`), stamped onto freshly created plans and onto the active
 *   plan whenever it is saved.
 * @returns {{
 *   load: () => {plans: Array<{id: string, name: string, createdAt: string, updatedAt: string}>, activePlanId: string},
 *   getActivePlan: () => object|null,
 *   setActivePlan: (id: string) => object|null,
 *   createPlan: (name?: string) => object|null,
 *   duplicatePlan: (id: string, name?: string) => object|null,
 *   deletePlan: (id: string) => object|null,
 *   renamePlan: (id: string, name: string) => object|null,
 *   saveActivePlan: (payload: {days: any[], breaks: any[]}) => object|null,
 * }}
 */
export function createPlanStore({ storage, routeVersion } = {}) {
  /** @type {{activePlanId: string, plans: object[]}|null} */
  let state = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function emptyPlan(name) {
    const now = nowIso();
    return { id: newId(), name, createdAt: now, updatedAt: now, routeVersion, days: [], breaks: [] };
  }

  function freshState() {
    const plan = emptyPlan('My plan');
    return { activePlanId: plan.id, plans: [plan] };
  }

  // Persisting is best-effort: a throwing setItem (private mode, quota, storage
  // disabled by policy) must never break the in-memory state.
  function persist() {
    if (!state) return;
    try {
      storage.setItem(
        PLANS_KEY,
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, activePlanId: state.activePlanId, plans: state.plans }),
      );
    } catch {
      // Swallow - the plan lives in memory; persistence just won't survive reload.
    }
  }

  function findPlan(id) {
    return state ? state.plans.find((plan) => plan.id === id) ?? null : null;
  }

  // Reduce to the plan with the lexicographically greatest ISO updatedAt; ISO
  // strings sort chronologically, so this is "most recently updated".
  function mostRecentlyUpdated(plans) {
    return plans.reduce((best, plan) => (plan.updatedAt > best.updatedAt ? plan : best), plans[0]);
  }

  function meta() {
    return {
      plans: state.plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      })),
      activePlanId: state.activePlanId,
    };
  }

  // Whether the favorites key is safe to (over)write: absent, unparseable, or
  // holding an empty favorites list. Migration only writes when this is true.
  function favoritesEmpty() {
    try {
      const raw = storage.getItem(FAVORITES_KEY);
      if (!raw) return true;
      const parsed = JSON.parse(raw);
      return !parsed || !Array.isArray(parsed.favorites) || parsed.favorites.length === 0;
    } catch {
      return true;
    }
  }

  // Reads the legacy v1 payload and, when valid, returns the migrated state
  // (one "My plan"); otherwise null. Collects the days' poiPins into the global
  // favorites store (deduped, written only if the favorites key is empty). The
  // legacy key itself is never modified or removed.
  function migrateV1() {
    let legacy;
    try {
      const raw = storage.getItem(LEGACY_KEY);
      if (!raw) return null;
      legacy = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!legacy || legacy.schemaVersion !== LEGACY_SCHEMA_VERSION || !Array.isArray(legacy.days)) {
      return null;
    }

    const now = nowIso();
    const plan = {
      id: newId(),
      name: 'My plan',
      createdAt: now,
      updatedAt: now,
      routeVersion: legacy.routeVersion,
      days: legacy.days.map(normalizeDay),
      breaks: [],
    };

    if (favoritesEmpty()) {
      const seen = new Set();
      const favorites = [];
      for (const day of legacy.days) {
        const pins = Array.isArray(day?.poiPins) ? day.poiPins : [];
        for (const pin of pins) {
          if (!pin || typeof pin !== 'object') continue; // skip null/garbage entries
          const key = `${pin.kind}:${pin.name}@${pin.routeDistanceKm}`;
          if (seen.has(key)) continue;
          seen.add(key);
          favorites.push(clone(pin));
        }
      }
      try {
        storage.setItem(FAVORITES_KEY, JSON.stringify({ schemaVersion: FAVORITES_SCHEMA_VERSION, favorites }));
      } catch {
        // Best-effort; a failed favorites write must not abort the migration.
      }
    }

    return { activePlanId: plan.id, plans: [plan] };
  }

  // Parses the v2 blob; returns a normalized state or null on any problem
  // (missing key, invalid JSON, wrong schema, empty plans list).
  function readV2() {
    try {
      const raw = storage.getItem(PLANS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.plans) || parsed.plans.length === 0) {
        return null;
      }
      const plans = parsed.plans.map(normalizePlan);
      let activePlanId = parsed.activePlanId;
      if (!plans.some((plan) => plan.id === activePlanId)) {
        activePlanId = mostRecentlyUpdated(plans).id;
      }
      return { activePlanId, plans };
    } catch {
      return null;
    }
  }

  function load() {
    // A valid v2 blob wins outright. Otherwise (absent/corrupt/wrong schema)
    // migrate the legacy payload if present and valid, else start fresh. The
    // migrateV1() call is guarded independently of its own internal try/catch
    // so that even an unforeseen failure mode falls through to a fresh store
    // rather than throwing out of boot. The result is always persisted so the
    // store is consistent on the next load.
    let next = readV2();
    if (!next) {
      try {
        next = migrateV1();
      } catch {
        next = null;
      }
    }
    state = next ?? freshState();
    persist();
    return meta();
  }

  function getActivePlan() {
    const plan = findPlan(state?.activePlanId);
    return plan ? clone(plan) : null;
  }

  function setActivePlan(id) {
    const plan = findPlan(id);
    if (!plan) return null;
    state.activePlanId = id;
    persist();
    return clone(plan);
  }

  function createPlan(name) {
    if (!state) return null;
    const plan = emptyPlan(name ?? `Plan ${state.plans.length + 1}`);
    state.plans.push(plan);
    state.activePlanId = plan.id;
    persist();
    return clone(plan);
  }

  function duplicatePlan(id, name) {
    const source = findPlan(id);
    if (!source) return null;
    const now = nowIso();
    const copy = {
      id: newId(),
      name: name ?? `${source.name} (copy)`,
      createdAt: now,
      updatedAt: now,
      routeVersion: source.routeVersion,
      days: clone(source.days),
      breaks: clone(source.breaks),
    };
    state.plans.push(copy);
    state.activePlanId = copy.id;
    persist();
    return clone(copy);
  }

  function deletePlan(id) {
    if (!state) return null;
    const index = state.plans.findIndex((plan) => plan.id === id);
    if (index < 0) return null;

    const wasActive = state.activePlanId === id;
    state.plans.splice(index, 1);

    if (state.plans.length === 0) {
      const plan = emptyPlan('My plan');
      state.plans.push(plan);
      state.activePlanId = plan.id;
    } else if (wasActive) {
      state.activePlanId = mostRecentlyUpdated(state.plans).id;
    }

    persist();
    return getActivePlan();
  }

  function renamePlan(id, name) {
    const plan = findPlan(id);
    if (!plan) return null;
    plan.name = name;
    persist();
    return clone(plan);
  }

  function saveActivePlan({ days, breaks } = {}) {
    const plan = findPlan(state?.activePlanId);
    if (!plan) return null;
    plan.days = normalizeDays(days);
    plan.breaks = Array.isArray(breaks) ? clone(breaks) : [];
    plan.updatedAt = nowIso();
    plan.routeVersion = routeVersion;
    persist();
    return clone(plan);
  }

  return {
    load,
    getActivePlan,
    setActivePlan,
    createPlan,
    duplicatePlan,
    deletePlan,
    renamePlan,
    saveActivePlan,
  };
}
