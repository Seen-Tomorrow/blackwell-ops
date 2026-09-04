/**
 * Catalog quick-access: pins, recents, sticky seats (BRAIN / WORKER).
 * Path pins + optional linked launch-preset combo id per set (knobs live on ComboPreset).
 * Draft/Boost stays on the cockpit — not a catalog seat.
 *
 * Three independent seat *sets* (1/2/3) for quick twin-stack switching.
 */
import { KEYS, readJsonStorage, writeJsonStorage } from "./storage";

export type CatalogSeatRole = "brain" | "worker" | "draft";

/** Engine seats shown in the catalog strip (DRAFT is storage-only legacy). */
export const CATALOG_ENGINE_SEAT_ROLES = ["brain", "worker"] as const;
export type CatalogEngineSeatRole = (typeof CATALOG_ENGINE_SEAT_ROLES)[number];

export const CATALOG_SEAT_ROLES: readonly CatalogSeatRole[] = [
  "brain",
  "worker",
  "draft",
] as const;

export const CATALOG_SEAT_LABEL: Record<CatalogSeatRole, string> = {
  brain: "BRAIN",
  worker: "WORKER",
  draft: "DRAFT",
};

/** How many named twin seat sets the catalog keeps. */
export const CATALOG_SEAT_SET_COUNT = 3 as const;
export type CatalogSeatSetIndex = 0 | 1 | 2;

export type CatalogSeatSlot = {
  path: string;
  updatedAt: number;
};

export type CatalogSeatsState = Partial<Record<CatalogSeatRole, CatalogSeatSlot>>;

export type CatalogRecentEntry = {
  path: string;
  at: number;
};

type CatalogSeatSets = [CatalogSeatsState, CatalogSeatsState, CatalogSeatsState];
type CatalogComboIds = [string | null, string | null, string | null];

type CatalogQuickStoreV3 = {
  version: 3;
  pins: string[];
  recents: CatalogRecentEntry[];
  activeSeatSet: CatalogSeatSetIndex;
  seatSets: CatalogSeatSets;
  /** Linked twin ComboPreset id per set (launchPresets store). */
  comboIds: CatalogComboIds;
};

type CatalogQuickStoreV2 = {
  version: 2;
  pins: string[];
  recents: CatalogRecentEntry[];
  activeSeatSet: CatalogSeatSetIndex;
  seatSets: CatalogSeatSets;
};

/** Legacy v1 shape (single seats bag). */
type CatalogQuickStoreV1 = {
  version: 1;
  pins: string[];
  recents: CatalogRecentEntry[];
  seats: CatalogSeatsState;
};

const PINS_MAX = 6;
const RECENTS_MAX = 8;

function emptySeats(): CatalogSeatsState {
  return {};
}

function emptySeatSets(): CatalogSeatSets {
  return [emptySeats(), emptySeats(), emptySeats()];
}

function emptyComboIds(): CatalogComboIds {
  return [null, null, null];
}

function emptyStore(): CatalogQuickStoreV3 {
  return {
    version: 3,
    pins: [],
    recents: [],
    activeSeatSet: 0,
    seatSets: emptySeatSets(),
    comboIds: emptyComboIds(),
  };
}

function sanitizeComboIds(raw: unknown): CatalogComboIds {
  const out = emptyComboIds();
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < CATALOG_SEAT_SET_COUNT; i++) {
    const v = raw[i];
    out[i as CatalogSeatSetIndex] = typeof v === "string" && v.trim() ? v.trim() : null;
  }
  return out;
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

function clampSetIndex(n: unknown): CatalogSeatSetIndex {
  const i = typeof n === "number" ? Math.floor(n) : 0;
  if (i <= 0) return 0;
  if (i >= 2) return 2;
  return i as CatalogSeatSetIndex;
}

function sanitizeSeats(raw: unknown): CatalogSeatsState {
  if (!raw || typeof raw !== "object") return emptySeats();
  const out: CatalogSeatsState = {};
  for (const role of CATALOG_SEAT_ROLES) {
    const slot = (raw as CatalogSeatsState)[role];
    if (slot && typeof slot.path === "string" && slot.path && typeof slot.updatedAt === "number") {
      out[role] = { path: slot.path, updatedAt: slot.updatedAt };
    }
  }
  return out;
}

function readStore(): CatalogQuickStoreV3 {
  const raw = readJsonStorage<CatalogQuickStoreV3 | CatalogQuickStoreV2 | CatalogQuickStoreV1>(
    KEYS.catalogQuickAccess,
  );
  if (!raw) return emptyStore();

  // v1 → v3 migration (single seats bag → set 0)
  if ((raw as CatalogQuickStoreV1).version === 1) {
    const v1 = raw as CatalogQuickStoreV1;
    const sets = emptySeatSets();
    sets[0] = sanitizeSeats(v1.seats);
    return {
      version: 3,
      pins: sanitizePins(v1.pins),
      recents: sanitizeRecents(v1.recents),
      activeSeatSet: 0,
      seatSets: sets,
      comboIds: emptyComboIds(),
    };
  }

  // v2 → v3 (add comboIds)
  if ((raw as CatalogQuickStoreV2).version === 2) {
    const v2 = raw as CatalogQuickStoreV2;
    const sets = emptySeatSets();
    if (Array.isArray(v2.seatSets)) {
      for (let i = 0; i < CATALOG_SEAT_SET_COUNT; i++) {
        sets[i as CatalogSeatSetIndex] = sanitizeSeats(v2.seatSets[i]);
      }
    }
    return {
      version: 3,
      pins: sanitizePins(v2.pins),
      recents: sanitizeRecents(v2.recents),
      activeSeatSet: clampSetIndex(v2.activeSeatSet),
      seatSets: sets,
      comboIds: emptyComboIds(),
    };
  }

  if ((raw as CatalogQuickStoreV3).version !== 3) return emptyStore();
  const v3 = raw as CatalogQuickStoreV3;
  const sets = emptySeatSets();
  if (Array.isArray(v3.seatSets)) {
    for (let i = 0; i < CATALOG_SEAT_SET_COUNT; i++) {
      sets[i as CatalogSeatSetIndex] = sanitizeSeats(v3.seatSets[i]);
    }
  }
  return {
    version: 3,
    pins: sanitizePins(v3.pins),
    recents: sanitizeRecents(v3.recents),
    activeSeatSet: clampSetIndex(v3.activeSeatSet),
    seatSets: sets,
    comboIds: sanitizeComboIds(v3.comboIds),
  };
}

function writeStore(store: CatalogQuickStoreV3): void {
  writeJsonStorage(KEYS.catalogQuickAccess, {
    version: 3,
    pins: store.pins.slice(0, PINS_MAX),
    recents: store.recents.slice(0, RECENTS_MAX),
    activeSeatSet: clampSetIndex(store.activeSeatSet),
    seatSets: store.seatSets,
    comboIds: store.comboIds,
  });
}

export function loadCatalogPins(): string[] {
  return readStore().pins.slice();
}

export function loadCatalogRecents(): CatalogRecentEntry[] {
  return readStore().recents.slice();
}

export function loadCatalogActiveSeatSet(): CatalogSeatSetIndex {
  return readStore().activeSeatSet;
}

/** Active set's seats (what the UI edits). */
export function loadCatalogSeats(): CatalogSeatsState {
  const s = readStore();
  return { ...s.seatSets[s.activeSeatSet] };
}

export function loadCatalogSeatSets(): CatalogSeatSets {
  const s = readStore();
  return [
    { ...s.seatSets[0] },
    { ...s.seatSets[1] },
    { ...s.seatSets[2] },
  ];
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

export function setCatalogActiveSeatSet(index: CatalogSeatSetIndex): {
  activeSeatSet: CatalogSeatSetIndex;
  seats: CatalogSeatsState;
} {
  const store = readStore();
  store.activeSeatSet = clampSetIndex(index);
  writeStore(store);
  return {
    activeSeatSet: store.activeSeatSet,
    seats: { ...store.seatSets[store.activeSeatSet] },
  };
}

export function assignCatalogSeat(role: CatalogSeatRole, path: string): CatalogSeatsState {
  return assignCatalogSeatAt(loadCatalogActiveSeatSet(), role, path);
}

/** Assign path on a specific set (seat-edit write-through). */
export function assignCatalogSeatAt(
  index: CatalogSeatSetIndex,
  role: CatalogSeatRole,
  path: string,
): CatalogSeatsState {
  const store = readStore();
  const i = clampSetIndex(index);
  const seats: CatalogSeatsState = {
    ...store.seatSets[i],
    [role]: { path, updatedAt: Date.now() },
  };
  for (const r of CATALOG_SEAT_ROLES) {
    if (r === role) continue;
    const slot = seats[r];
    if (slot && normalizePath(slot.path) === normalizePath(path)) {
      delete seats[r];
    }
  }
  store.seatSets[i] = seats;
  writeStore(store);
  return { ...seats };
}

export function clearCatalogSeat(role: CatalogSeatRole): CatalogSeatsState {
  const store = readStore();
  const i = store.activeSeatSet;
  const seats = { ...store.seatSets[i] };
  delete seats[role];
  store.seatSets[i] = seats;
  writeStore(store);
  return { ...seats };
}

export function loadCatalogSetComboId(index?: CatalogSeatSetIndex): string | null {
  const s = readStore();
  const i = index != null ? clampSetIndex(index) : s.activeSeatSet;
  return s.comboIds[i];
}

export function loadCatalogComboIds(): CatalogComboIds {
  return [...readStore().comboIds] as CatalogComboIds;
}

export function setCatalogSetComboId(
  index: CatalogSeatSetIndex,
  comboId: string | null,
): void {
  const store = readStore();
  const i = clampSetIndex(index);
  store.comboIds[i] = comboId && comboId.trim() ? comboId.trim() : null;
  writeStore(store);
}

export function seatRoleForPath(
  path: string,
  seats: CatalogSeatsState = loadCatalogSeats(),
): CatalogEngineSeatRole | null {
  const n = normalizePath(path);
  for (const role of CATALOG_ENGINE_SEAT_ROLES) {
    const slot = seats[role];
    if (slot && normalizePath(slot.path) === n) return role;
  }
  return null;
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

/** True if a set has at least BRAIN + WORKER filled (twin-launchable). */
export function seatSetCanTwin(seats: CatalogSeatsState): boolean {
  return Boolean(seats.brain?.path && seats.worker?.path);
}
