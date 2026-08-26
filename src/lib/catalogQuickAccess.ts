/**
 * Catalog quick-access: pins, recents, sticky seats (BRAIN / WORKER / DRAFT).
 * Path-only memory — does not touch launch presets or forecast.
 *
 * Three independent seat *sets* (1/2/3) for quick twin-stack switching.
 */
import { KEYS, readJsonStorage, writeJsonStorage } from "./storage";

export type CatalogSeatRole = "brain" | "worker" | "draft";

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

const PINS_MAX = 12;
const RECENTS_MAX = 8;

function emptySeats(): CatalogSeatsState {
  return {};
}

function emptySeatSets(): CatalogSeatSets {
  return [emptySeats(), emptySeats(), emptySeats()];
}

function emptyStore(): CatalogQuickStoreV2 {
  return {
    version: 2,
    pins: [],
    recents: [],
    activeSeatSet: 0,
    seatSets: emptySeatSets(),
  };
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

function readStore(): CatalogQuickStoreV2 {
  const raw = readJsonStorage<CatalogQuickStoreV2 | CatalogQuickStoreV1>(KEYS.catalogQuickAccess);
  if (!raw) return emptyStore();

  // v1 → v2 migration (single seats bag → set 0)
  if ((raw as CatalogQuickStoreV1).version === 1) {
    const v1 = raw as CatalogQuickStoreV1;
    const sets = emptySeatSets();
    sets[0] = sanitizeSeats(v1.seats);
    return {
      version: 2,
      pins: Array.isArray(v1.pins)
        ? v1.pins.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, PINS_MAX)
        : [],
      recents: Array.isArray(v1.recents)
        ? v1.recents
            .filter(
              (r): r is CatalogRecentEntry =>
                !!r && typeof r.path === "string" && typeof r.at === "number",
            )
            .slice(0, RECENTS_MAX)
        : [],
      activeSeatSet: 0,
      seatSets: sets,
    };
  }

  if ((raw as CatalogQuickStoreV2).version !== 2) return emptyStore();
  const v2 = raw as CatalogQuickStoreV2;
  const sets = emptySeatSets();
  if (Array.isArray(v2.seatSets)) {
    for (let i = 0; i < CATALOG_SEAT_SET_COUNT; i++) {
      sets[i as CatalogSeatSetIndex] = sanitizeSeats(v2.seatSets[i]);
    }
  }
  return {
    version: 2,
    pins: Array.isArray(v2.pins)
      ? v2.pins.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, PINS_MAX)
      : [],
    recents: Array.isArray(v2.recents)
      ? v2.recents
          .filter(
            (r): r is CatalogRecentEntry =>
              !!r && typeof r.path === "string" && typeof r.at === "number",
          )
          .slice(0, RECENTS_MAX)
      : [],
    activeSeatSet: clampSetIndex(v2.activeSeatSet),
    seatSets: sets,
  };
}

function writeStore(store: CatalogQuickStoreV2): void {
  writeJsonStorage(KEYS.catalogQuickAccess, {
    version: 2,
    pins: store.pins.slice(0, PINS_MAX),
    recents: store.recents.slice(0, RECENTS_MAX),
    activeSeatSet: clampSetIndex(store.activeSeatSet),
    seatSets: store.seatSets,
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
  if (idx >= 0) store.pins.splice(idx, 1);
  else store.pins = [path, ...store.pins.filter((p) => normalizePath(p) !== n)].slice(0, PINS_MAX);
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
  const store = readStore();
  const i = store.activeSeatSet;
  const seats: CatalogSeatsState = {
    ...store.seatSets[i],
    [role]: { path, updatedAt: Date.now() },
  };
  // A path can only occupy one seat role within the active set.
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

export function seatRoleForPath(
  path: string,
  seats: CatalogSeatsState = loadCatalogSeats(),
): CatalogSeatRole | null {
  const n = normalizePath(path);
  for (const role of CATALOG_SEAT_ROLES) {
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
