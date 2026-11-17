/**
 * Catalog quick-access: pins, recents, and the five ENDPOINT sets.
 *
 * An endpoint is one model path plus its role. The pairing a set describes is
 * only that: models, not saved launch bags. Every knob a launch needs comes
 * from the cockpit at launch time, which is why this store has no `comboIds`
 * and no write-through into a preset store.
 *
 * Shape is v4. There is no migration: a store that is not v4 is stale and is
 * discarded (local storage, owner resets it for free).
 */
import { KEYS, readJsonStorage, writeJsonStorage } from "./storage";

export const CATALOG_SET_COUNT = 5;
export const CATALOG_ENDPOINTS_MAX = 6;

export type CatalogSetIndex = 0 | 1 | 2 | 3 | 4;

export const ENDPOINT_ROLES = ["brain", "worker"] as const;
export type EndpointRole = (typeof ENDPOINT_ROLES)[number];

export const ENDPOINT_ROLE_LABEL: Record<EndpointRole, string> = {
  brain: "BRAIN",
  worker: "WORKER",
};

export type Endpoint = {
  /** Stable for the life of the endpoint; generated on add. */
  id: string;
  role: EndpointRole;
  /** Model GGUF. */
  path: string;
};

/** 0..CATALOG_ENDPOINTS_MAX endpoints, at most one of them BRAIN. */
export type EndpointSet = Endpoint[];

export type CatalogRecentEntry = {
  path: string;
  at: number;
};

type CatalogQuickStore = {
  version: 4;
  pins: string[];
  recents: CatalogRecentEntry[];
  activeSet: CatalogSetIndex;
  sets: EndpointSet[];
};

/** Four keeps FAVORITE at two rows; a sixth chip squeezed the endpoints block. */
export const CATALOG_PINS_MAX = 4;
const PINS_MAX = CATALOG_PINS_MAX;
const RECENTS_MAX = 8;

function emptyStore(): CatalogQuickStore {
  return {
    version: 4,
    pins: [],
    recents: [],
    activeSet: 0,
    sets: emptySets(),
  };
}

function emptySets(): EndpointSet[] {
  return Array.from({ length: CATALOG_SET_COUNT }, () => [] as EndpointSet);
}

function sanitizePins(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, PINS_MAX)
    : [];
}

function sanitizeRecents(raw: unknown): CatalogRecentEntry[] {
  return Array.isArray(raw)
    ? raw
        .filter(
          (r): r is CatalogRecentEntry =>
            !!r && typeof r.path === "string" && typeof r.at === "number",
        )
        .slice(0, RECENTS_MAX)
    : [];
}

function normalizePath(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

export function clampSetIndex(n: unknown): CatalogSetIndex {
  const i = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 0;
  if (i <= 0) return 0;
  if (i >= CATALOG_SET_COUNT - 1) return (CATALOG_SET_COUNT - 1) as CatalogSetIndex;
  return i as CatalogSetIndex;
}

/**
 * The invariant gate. Everything that reads a persisted store goes through
 * here, so a hand-edited or torn store degrades to fewer endpoints instead of
 * throwing or showing an illegal pairing.
 *
 * - malformed entries are dropped
 * - duplicate paths inside a set keep the first
 * - only the first BRAIN survives; later BRAIN entries collapse to WORKER
 * - a set never exceeds CATALOG_ENDPOINTS_MAX
 * - a set with no BRAIN is legal but incomplete (it cannot launch as a set)
 */
export function sanitizeCatalogStore(raw: unknown): CatalogQuickStore {
  if (!raw || typeof raw !== "object") return emptyStore();
  const v = raw as Partial<CatalogQuickStore>;
  if (v.version !== 4) return emptyStore();

  const sets = emptySets();
  if (Array.isArray(v.sets)) {
    for (let i = 0; i < CATALOG_SET_COUNT; i++) {
      sets[i] = sanitizeEndpointSet(v.sets[i]);
    }
  }

  return {
    version: 4,
    pins: sanitizePins(v.pins),
    recents: sanitizeRecents(v.recents),
    activeSet: clampSetIndex(v.activeSet),
    sets,
  };
}

function sanitizeEndpointSet(raw: unknown): EndpointSet {
  if (!Array.isArray(raw)) return [];
  const out: EndpointSet = [];
  const seenPaths = new Set<string>();
  let brainSeen = false;

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Partial<Endpoint>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const path = typeof e.path === "string" ? e.path.trim() : "";
    const role = e.role === "brain" || e.role === "worker" ? e.role : null;
    if (!id || !path || !role) continue;

    const key = normalizePath(path);
    if (seenPaths.has(key)) continue;
    if (out.length >= CATALOG_ENDPOINTS_MAX) break;

    // Two BRAIN entries are the illegal shape: collapse the extras to WORKER
    // so the user keeps both models and the set stays launchable.
    let nextRole: EndpointRole = role;
    if (nextRole === "brain") {
      if (brainSeen) nextRole = "worker";
      else brainSeen = true;
    }

    seenPaths.add(key);
    out.push({ id, role: nextRole, path });
  }
  return out;
}

function readStore(): CatalogQuickStore {
  return sanitizeCatalogStore(readJsonStorage<unknown>(KEYS.catalogQuickAccess));
}

function writeStore(store: CatalogQuickStore): void {
  const clean = sanitizeCatalogStore(store);
  writeJsonStorage(KEYS.catalogQuickAccess, {
    version: 4,
    pins: clean.pins.slice(0, PINS_MAX),
    recents: clean.recents.slice(0, RECENTS_MAX),
    activeSet: clean.activeSet,
    sets: clean.sets,
  });
}

function newEndpointId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `endpoint-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function loadCatalogPins(): string[] {
  return readStore().pins.slice();
}

export function loadCatalogRecents(): CatalogRecentEntry[] {
  return readStore().recents.slice();
}

export function loadCatalogActiveSet(): CatalogSetIndex {
  return readStore().activeSet;
}

/** Active set's endpoints (what the UI edits). */
export function loadCatalogEndpoints(): EndpointSet {
  const s = readStore();
  return s.sets[s.activeSet].map((e) => ({ ...e }));
}

/** All five sets, copied — used where a set is not the active one. */
export function loadCatalogSets(): EndpointSet[] {
  return readStore().sets.map((set) => set.map((e) => ({ ...e })));
}

function setEndpointsAt(index: CatalogSetIndex, endpoints: EndpointSet): EndpointSet {
  const store = readStore();
  store.sets[clampSetIndex(index)] = endpoints;
  writeStore(store);
  return endpoints.map((e) => ({ ...e }));
}

export function setCatalogActiveSet(index: CatalogSetIndex): {
  activeSet: CatalogSetIndex;
  endpoints: EndpointSet;
} {
  const store = readStore();
  store.activeSet = clampSetIndex(index);
  writeStore(store);
  return {
    activeSet: store.activeSet,
    endpoints: store.sets[store.activeSet].map((e) => ({ ...e })),
  };
}

export type EndpointWriteReason = "limit" | "duplicate";

export type EndpointWriteResult = {
  ok: boolean;
  endpoints: EndpointSet;
  reason?: EndpointWriteReason;
};

/**
 * Assign a model path to a role. BRAIN replaces the set's brain (keeping its
 * id); WORKER appends. Returns why a write was refused so the UI can say so.
 */
export function putCatalogEndpoint(
  index: CatalogSetIndex,
  role: EndpointRole,
  path: string,
): EndpointWriteResult {
  const trimmed = path.trim();
  if (!trimmed) return { ok: false, endpoints: loadCatalogSets()[clampSetIndex(index)], reason: "duplicate" };

  const store = readStore();
  const set = store.sets[clampSetIndex(index)];
  const key = normalizePath(trimmed);
  const at = set.findIndex((e) => normalizePath(e.path) === key);

  if (role === "brain") {
    const brainIdx = set.findIndex((e) => e.role === "brain");
    if (brainIdx < 0 && set.length >= CATALOG_ENDPOINTS_MAX && at < 0) {
      return { ok: false, endpoints: set.map((e) => ({ ...e })), reason: "limit" };
    }
    if (brainIdx >= 0) {
      // The path is on another endpoint: move it up to BRAIN rather than
      // leaving two endpoints with the same model in one set.
      if (at >= 0 && at !== brainIdx) set.splice(at, 1);
      const idx = set.findIndex((e) => e.role === "brain");
      if (idx >= 0) set[idx] = { ...set[idx], role: "brain", path: trimmed };
    } else {
      if (at >= 0) set.splice(at, 1);
      set.unshift({ id: newEndpointId(), role: "brain", path: trimmed });
    }
    return { ok: true, endpoints: setEndpointsAt(index, set) };
  }

  if (at >= 0) {
    return { ok: false, endpoints: loadCatalogSets()[clampSetIndex(index)], reason: "duplicate" };
  }
  if (set.length >= CATALOG_ENDPOINTS_MAX) {
    return { ok: false, endpoints: loadCatalogSets()[clampSetIndex(index)], reason: "limit" };
  }
  set.push({ id: newEndpointId(), role: "worker", path: trimmed });
  return { ok: true, endpoints: setEndpointsAt(index, set) };
}

/** Replace one endpoint's model path, keeping its id and role. */
export function replaceCatalogEndpoint(
  index: CatalogSetIndex,
  id: string,
  path: string,
): EndpointWriteResult {
  const trimmed = path.trim();
  const store = readStore();
  const set = store.sets[clampSetIndex(index)];
  const target = set.find((e) => e.id === id);
  if (!target || !trimmed) {
    return { ok: false, endpoints: set.map((e) => ({ ...e })), reason: "duplicate" };
  }
  const key = normalizePath(trimmed);
  if (set.some((e) => e.id !== id && normalizePath(e.path) === key)) {
    return { ok: false, endpoints: set.map((e) => ({ ...e })), reason: "duplicate" };
  }
  target.path = trimmed;
  return { ok: true, endpoints: setEndpointsAt(index, set) };
}

export function removeCatalogEndpoint(index: CatalogSetIndex, id: string): EndpointSet {
  const store = readStore();
  const set = store.sets[clampSetIndex(index)];
  return setEndpointsAt(
    index,
    set.filter((e) => e.id !== id),
  );
}

export function isCatalogPinned(path: string, pins: string[] = loadCatalogPins()): boolean {
  const n = normalizePath(path);
  return pins.some((p) => normalizePath(p) === n);
}

export function toggleCatalogPin(path: string): string[] {
  const store = readStore();
  const n = normalizePath(path);
  const idx = store.pins.findIndex((p) => normalizePath(p) === n);
  if (idx >= 0) {
    store.pins.splice(idx, 1);
  } else {
    // Full — cannot pin more until the user unpins an existing one (no silent eviction).
    if (store.pins.length >= PINS_MAX) return store.pins.slice();
    store.pins = [path, ...store.pins.filter((p) => normalizePath(p) !== n)].slice(0, PINS_MAX);
  }
  writeStore(store);
  return store.pins.slice();
}

/** Record a launch (or intentional use) — newest first, de-duped. */
export function pushCatalogRecent(path: string): CatalogRecentEntry[] {
  if (!path) return loadCatalogRecents();
  const store = readStore();
  const n = normalizePath(path);
  const next: CatalogRecentEntry = { path, at: Date.now() };
  store.recents = [
    next,
    ...store.recents.filter((r) => normalizePath(r.path) !== n),
  ].slice(0, RECENTS_MAX);
  writeStore(store);
  return store.recents.slice();
}

/** Role of a model path inside the active set, if any. */
export function endpointRoleForPath(
  path: string,
  endpoints: EndpointSet = loadCatalogEndpoints(),
): EndpointRole | null {
  const n = normalizePath(path);
  return endpoints.find((e) => normalizePath(e.path) === n)?.role ?? null;
}

export function brainEndpoint(endpoints: EndpointSet): Endpoint | null {
  return endpoints.find((e) => e.role === "brain") ?? null;
}

export function workerEndpoints(endpoints: EndpointSet): Endpoint[] {
  return endpoints.filter((e) => e.role === "worker");
}

/** Short chip label from a model path. */
export function catalogPathChipLabel(path: string, name?: string): string {
  if (name && name.trim()) {
    const t = name.trim();
    return t.length > 22 ? `${t.slice(0, 20)}…` : t;
  }
  const base = path.split(/[/\\]/).pop()?.replace(/\.gguf$/i, "") || path;
  return base.length > 22 ? `${base.slice(0, 20)}…` : base;
}
