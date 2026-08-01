import { favKey } from './favorites.js';

const PLANS_KEY = 'elberadweg-plans';
const LEGACY_KEY = 'elberadweg-itinerary';
const FAVORITES_KEY = 'elberadweg-favorites';
const SCHEMA_VERSION = 3;
// Schema 2 blobs are still readable; they simply record no routeId, which the
// corridor check in load() treats as "a different corridor".
const PREVIOUS_SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const FAVORITES_SCHEMA_VERSION = 1;
// Suffix for archives of a blob that records no corridor at all.
const NO_ROUTE_ID_SUFFIX = 'v2';
// Upper bound on the `-2`, `-3`, ... search for a free backup name. Only a
// pathological storage reaches it; hitting it keeps the original in place
// rather than overwriting somebody's backup.
const BACKUP_KEY_LIMIT = 100;

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
 * Creates the multi-plan storage layer for the Elberadweg planner. Owns the
 * `elberadweg-plans` blob (schema 3, schema 2 still readable) and the one-time
 * migration from the v1 `elberadweg-itinerary` payload. All reads/writes are
 * guarded: a corrupted or wrong-schema blob starts a fresh store (one empty
 * "My plan") rather than throwing, and a failing setItem (quota/denied) is
 * swallowed so the in-memory plan and the render that follows a mutation are
 * never broken.
 *
 * Every mutating method persists immediately. Methods that take an id return
 * null (a no-op) for an unknown id.
 *
 * @param {Object} opts
 * @param {{getItem(key: string): string|null, setItem(key: string, value: string): void, removeItem?(key: string): void}} opts.storage
 *   - injected storage (e.g. `localStorage`).
 * @param {string} [opts.routeVersion] - current route version (e.g.
 *   `meta.builtAt`), stamped onto freshly created plans and onto the active
 *   plan whenever it is saved.
 * @param {string} [opts.routeId] - current corridor id (`meta.routeId`),
 *   stamped into the stored blob. Stored plans measured against a different
 *   corridor - or against none at all, which predates the id being recorded -
 *   are archived instead of read, because every stored km would be counted
 *   from a different origin. A mere rebuild of the same corridor keeps its
 *   routeId and is read normally (`routeVersion` is what changes there). Omit
 *   to disable the check entirely and keep the module usable standalone.
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
export function createPlanStore({ storage, routeVersion, routeId } = {}) {
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
        JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          routeId: routeId ?? null,
          activePlanId: state.activePlanId,
          plans: state.plans,
        }),
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
          // favKey is the favorites store's identity — using it here guarantees
          // migration-written entries stay readable if the convention changes.
          const key = favKey(pin);
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

  // Parses the stored plans blob (schema 3, or schema 2 which predates
  // routeId); returns `{routeId, state}` - the corridor the plans were measured
  // against, null when the blob records none, next to the normalized state - or
  // null on any problem (missing key, invalid JSON, unknown schema, empty plans
  // list).
  function readPlans() {
    try {
      const raw = storage.getItem(PLANS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        (parsed.schemaVersion !== SCHEMA_VERSION && parsed.schemaVersion !== PREVIOUS_SCHEMA_VERSION) ||
        !Array.isArray(parsed.plans) ||
        parsed.plans.length === 0
      ) {
        return null;
      }
      const plans = parsed.plans.map(normalizePlan);
      let activePlanId = parsed.activePlanId;
      if (!plans.some((plan) => plan.id === activePlanId)) {
        activePlanId = mostRecentlyUpdated(plans).id;
      }
      return { routeId: parsed.routeId ?? null, state: { activePlanId, plans } };
    } catch {
      return null;
    }
  }

  // First unoccupied `<base>`, `<base>-2`, `<base>-3`, ... so a second rebuild
  // against the same old routeId can never destroy the first backup. Returns
  // null when every candidate is taken - the caller then archives nothing
  // rather than overwriting an existing backup.
  function freeBackupKey(base) {
    for (let attempt = 1; attempt <= BACKUP_KEY_LIMIT; attempt += 1) {
      const key = attempt === 1 ? base : `${base}-${attempt}`;
      if (!storage.getItem(key)) return key;
    }
    return null;
  }

  // Moves `key` aside to `<key>-backup-<suffix>` and drops the original. Both
  // halves are best-effort: a throwing setItem/removeItem (quota, private mode,
  // storage disabled) must never break boot, and removeItem may be absent on an
  // injected fake, hence the optional call. The original is only removed once
  // the copy has gone through.
  function archiveKey(key, suffix) {
    try {
      const raw = storage.getItem(key);
      if (!raw) return;
      const backupKey = freeBackupKey(`${key}-backup-${suffix}`);
      if (!backupKey) return;
      storage.setItem(backupKey, raw);
      storage.removeItem?.(key);
    } catch {
      // Swallow - a key we cannot archive must not stop the store from booting.
    }
  }

  function load() {
    // A readable plans blob wins outright - unless it was measured against a
    // different corridor, in which case every stored km (day endKm, break
    // routeDistanceKm, the name@km favorite keys) counts from a different
    // origin and there is no honest migration: archive both keys and start
    // fresh. A blob recording no corridor at all counts as different too.
    // Archiving deliberately skips migrateV1() as well - a v1 payload predates
    // the corridor change and is just as wrong as the blob we just moved aside.
    //
    // Otherwise (absent/corrupt/unknown schema) migrate the legacy payload if
    // present and valid, else start fresh. The migrateV1() call is guarded
    // independently of its own internal try/catch so that even an unforeseen
    // failure mode falls through to a fresh store rather than throwing out of
    // boot. The result is always persisted so the store is consistent on the
    // next load.
    const stored = readPlans();
    let next = null;
    if (stored && routeId && stored.routeId !== routeId) {
      const suffix = stored.routeId ?? NO_ROUTE_ID_SUFFIX;
      archiveKey(PLANS_KEY, suffix);
      archiveKey(FAVORITES_KEY, suffix);
    } else if (stored) {
      next = stored.state;
    } else {
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
