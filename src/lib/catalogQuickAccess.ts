/**
 * Catalog quick-access: pins, recents, sticky seats (BRAIN / WORKER / DRAFT).
 * Path-only memory — does not touch launch presets or forecast.
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

export type CatalogSeatSlot = {
  path: string;
  updatedAt: number;
};

export type CatalogSeatsState = Partial<Record<CatalogSeatRole, CatalogSeatSlot>>;

export type CatalogRecentEntry = {
  path: string;
  at: number;
};

type CatalogQuickStoreV1 = {
  version: 1;
  pins: string[];
  recents: CatalogRecentEntry[];
  seats: CatalogSeatsState;
};

const PINS_MAX = 12;
const RECENTS_MAX = 8;

function emptyStore(): CatalogQuickStoreV1 {
  return { version: 1, pins: [], recents: [], seats: {} };
}

function normalizePath(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

function readStore(): CatalogQuickStoreV1 {
  const raw = readJsonStorage<CatalogQuickStoreV1>(KEYS.catalogQuickAccess);
  if (!raw || raw.version !== 1) return emptyStore();
  return {
    version: 1,
    pins: Array.isArray(raw.pins)
      ? raw.pins.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, PINS_MAX)
      : [],
    recents: Array.isArray(raw.recents)
      ? raw.recents
          .filter(
            (r): r is CatalogRecentEntry =>
              !!r && typeof r.path === "string" && typeof r.at === "number",
          )
          .slice(0, RECENTS_MAX)
      : [],
    seats: raw.seats && typeof raw.seats === "object" ? raw.seats : {},
  };
}

function writeStore(store: CatalogQuickStoreV1): void {
  writeJsonStorage(KEYS.catalogQuickAccess, {
    version: 1,
    pins: store.pins.slice(0, PINS_MAX),
    recents: store.recents.slice(0, RECENTS_MAX),
    seats: store.seats,
  });
}

export function loadCatalogPins(): string[] {
  return readStore().pins.slice();
}

export function loadCatalogRecents(): CatalogRecentEntry[] {
  return readStore().recents.slice();
}

export function loadCatalogSeats(): CatalogSeatsState {
  return { ...readStore().seats };
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

export function assignCatalogSeat(role: CatalogSeatRole, path: string): CatalogSeatsState {
  const store = readStore();
  store.seats = {
    ...store.seats,
    [role]: { path, updatedAt: Date.now() },
  };
  // A path can only occupy one seat role.
  for (const r of CATALOG_SEAT_ROLES) {
    if (r === role) continue;
    const slot = store.seats[r];
    if (slot && normalizePath(slot.path) === normalizePath(path)) {
      delete store.seats[r];
    }
  }
  writeStore(store);
  return { ...store.seats };
}

export function clearCatalogSeat(role: CatalogSeatRole): CatalogSeatsState {
  const store = readStore();
  const next = { ...store.seats };
  delete next[role];
  store.seats = next;
  writeStore(store);
  return { ...store.seats };
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
