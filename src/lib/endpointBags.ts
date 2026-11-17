/**
 * Per-endpoint cockpit bag.
 *
 * The endpoint owns the pairing ({id, role, path}); this store owns the knobs
 * the cockpit captured for that endpoint. Keeping the two apart is deliberate:
 * an endpoint stays a pairing, and a bag is keyed by its id rather than joined
 * through a preset.
 */
import { KEYS, readJsonStorage, writeJsonStorage } from "./storage";
import { isLaunchPolicyId } from "./launchPolicy";
import type { LaunchSeat, PortPolicy } from "./launchPlan";
import type { SpecBoostMethod } from "./specProfiles";
import { DEFAULT_PROVIDER_ID } from "./types";

export type EndpointBag = {
  providerId: string;
  binaryProfile?: string;
  policyId: LaunchSeat["policyId"];
  paramOverrides: Record<string, string | number>;
  boostMethod?: SpecBoostMethod;
  modelSpecOverrides?: Record<string, string | number>;
  portPolicy: PortPolicy;
  updatedAt: number;
};

type EndpointBagStore = {
  version: 1;
  bags: Record<string, EndpointBag>;
};

const BAGS_MAX = 64;

function emptyStore(): EndpointBagStore {
  return { version: 1, bags: {} };
}

function normalizePortPolicy(raw: unknown): PortPolicy {
  if (!raw || typeof raw !== "object") return { mode: "auto" };
  const p = raw as Partial<PortPolicy>;
  const mode = p.mode === "prefer" || p.mode === "fixed" ? p.mode : "auto";
  if (mode === "auto") return { mode };
  const port = typeof p.port === "number" && Number.isFinite(p.port) && p.port > 0
    ? Math.floor(p.port)
    : undefined;
  return port ? { mode, port } : { mode: "auto" };
}

function bagValueMap(raw: unknown): Record<string, string | number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || k.startsWith("__")) continue;
    if (typeof v === "string" || typeof v === "number") out[k] = v;
  }
  return out;
}

function normalizeBag(raw: unknown): EndpointBag | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<EndpointBag>;
  const providerId =
    typeof b.providerId === "string" && b.providerId.trim()
      ? b.providerId.trim()
      : DEFAULT_PROVIDER_ID;
  const policyId = isLaunchPolicyId(b.policyId) ? b.policyId : "full_auto";
  const boostMethod =
    b.boostMethod === "mtp" || b.boostMethod === "dflash" || b.boostMethod === "dspark"
      ? b.boostMethod
      : b.boostMethod === "off"
        ? "off"
        : undefined;
  return {
    providerId,
    binaryProfile:
      typeof b.binaryProfile === "string" && b.binaryProfile.trim()
        ? b.binaryProfile.trim()
        : undefined,
    policyId,
    paramOverrides: bagValueMap(b.paramOverrides),
    boostMethod,
    modelSpecOverrides:
      b.modelSpecOverrides && typeof b.modelSpecOverrides === "object"
        ? bagValueMap(b.modelSpecOverrides)
        : undefined,
    portPolicy: normalizePortPolicy(b.portPolicy),
    updatedAt: typeof b.updatedAt === "number" ? b.updatedAt : Date.now(),
  };
}

function readStore(): EndpointBagStore {
  const raw = readJsonStorage<EndpointBagStore>(KEYS.endpointBags);
  if (!raw || raw.version !== 1 || !raw.bags || typeof raw.bags !== "object") {
    return emptyStore();
  }
  const bags: Record<string, EndpointBag> = {};
  for (const [id, value] of Object.entries(raw.bags).slice(0, BAGS_MAX)) {
    if (!id.trim()) continue;
    const bag = normalizeBag(value);
    if (bag) bags[id] = bag;
  }
  return { version: 1, bags };
}

function writeStore(store: EndpointBagStore): void {
  writeJsonStorage(KEYS.endpointBags, {
    version: 1,
    bags: store.bags,
  });
}

export function loadEndpointBag(id: string): EndpointBag | null {
  const bag = readStore().bags[id];
  if (!bag) return null;
  return {
    ...bag,
    paramOverrides: { ...bag.paramOverrides },
    modelSpecOverrides: bag.modelSpecOverrides ? { ...bag.modelSpecOverrides } : undefined,
  };
}

/** Capture the cockpit's current seat into the endpoint's bag. */
export function saveEndpointBag(id: string, seat: LaunchSeat): EndpointBag {
  const store = readStore();
  const bag: EndpointBag = {
    providerId: seat.providerId,
    binaryProfile: seat.binaryProfile,
    policyId: seat.policyId,
    paramOverrides: { ...seat.paramOverrides },
    boostMethod: seat.boostMethod,
    modelSpecOverrides: seat.modelSpecOverrides
      ? { ...seat.modelSpecOverrides }
      : undefined,
    portPolicy: seat.portPolicy,
    updatedAt: Date.now(),
  };
  store.bags[id] = bag;
  writeStore(store);
  return { ...bag };
}

export function deleteEndpointBag(id: string): void {
  const store = readStore();
  if (!(id in store.bags)) return;
  delete store.bags[id];
  writeStore(store);
}

/** Drop bags whose endpoint was removed while the panel was closed. */
export function pruneEndpointBags(validIds: Iterable<string>): void {
  const store = readStore();
  const valid = new Set(validIds);
  let changed = false;
  for (const id of Object.keys(store.bags)) {
    if (valid.has(id)) continue;
    delete store.bags[id];
    changed = true;
  }
  if (changed) writeStore(store);
}
