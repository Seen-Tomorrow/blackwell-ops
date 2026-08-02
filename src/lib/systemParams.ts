import { isNumericLiteral, sortParamValues } from "./paramValueSort";
import { normalizeUiGroup, paramUiGroup } from "./storage";

/** CONFIG catalog bucket for engine chrome params (placement fixed in engine panel). */
export const SYSTEM_UI_GROUP = "SYSTEM";

/** Spec profiles — template-owned groups (seeded as protected; Boost selects profile). */
export const SPEC_PROFILE_MTP_GROUP = "SPECULATIVE-MTP";
export const SPEC_PROFILE_DFLASH_GROUP = "SPECULATIVE-DFLASH";

/**
 * Factory default protected groups when JSON has no `protectedGroups` yet.
 * Policy is flag-driven; this list is only a migration seed.
 */
export const DEFAULT_PROTECTED_GROUPS = [
  SYSTEM_UI_GROUP,
  SPEC_PROFILE_MTP_GROUP,
  SPEC_PROFILE_DFLASH_GROUP,
] as const;

/** Topology-owned — engine injects from GPU scan; never shown in CONFIG catalog. */
export const ENGINE_ONLY_PARAM_KEYS = new Set(["device"]);

/** User-editable in catalog; values/defaults apply — group/reorder/hide do not. */
export const SYSTEM_CATALOG_PARAM_KEYS = new Set([
  "split",
  "offload_mode",
  "base_port",
  /** CTX lives in CockpitCtxStrip / docked cockpit — never chip rows. */
  "ctx",
]);

/**
 * Cockpit-owned knobs (shared across llama forks). Rendered only via the Launch cockpit —
 * never as free chip rows. Pinned to SYSTEM like chrome — not deletable / not re-groupable;
 * values + custom user values still editable in Config.
 * Spec knobs live in SPECULATIVE-MTP / SPECULATIVE-DFLASH template groups (Boost selects profile).
 */
export const COCKPIT_OWNED_PARAM_KEYS = new Set([
  "parallel",
  "kv_quant",
  "reasoning",
  "reasoning_preserve",
  "ctx",
]);

export function isCockpitOwnedParam(key: string): boolean {
  return COCKPIT_OWNED_PARAM_KEYS.has(key);
}

export const SYSTEM_CATALOG_PARAM_TOOLTIP =
  "Fixed position in engine panel — edit values and defaults only; group and reorder have no effect.";

export const PROTECTED_GROUP_TOOLTIP =
  "Protected factory group — expand values and hide options; structure locked unless DEV unrestricted.";

export function isCatalogVisibleParam(def: { key: string }): boolean {
  return !ENGINE_ONLY_PARAM_KEYS.has(def.key);
}

// ── Axis A: protected groups (flag, not name) ───────────────────────────

/** Normalize and dedupe a protected-groups list. */
export function normalizeProtectedGroups(groups: string[] | undefined | null): string[] {
  if (!groups?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    const n = normalizeUiGroup(g);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Resolve effective protected groups for a provider.
 * Prefer persisted/factory list; if empty, seed defaults that appear in the catalog.
 */
export function resolveProtectedGroups(
  protectedGroups: string[] | undefined | null,
  presentGroups?: Iterable<string>,
): string[] {
  const fromStore = normalizeProtectedGroups(protectedGroups);
  if (fromStore.length > 0) return fromStore;

  const present = presentGroups
    ? new Set([...presentGroups].map((g) => normalizeUiGroup(g)))
    : null;
  return DEFAULT_PROTECTED_GROUPS.filter((g) => !present || present.has(g));
}

export function isProtectedGroup(
  groupName: string | undefined | null,
  protectedGroups: string[],
): boolean {
  if (!groupName) return false;
  const g = normalizeUiGroup(groupName);
  return protectedGroups.some((p) => normalizeUiGroup(p) === g);
}

/** Pin all protected groups after non-protected (relative order preserved within each). */
export function pinProtectedGroupsLast(order: string[], protectedGroups: string[]): string[] {
  const prot = new Set(normalizeProtectedGroups(protectedGroups));
  const normal: string[] = [];
  const locked: string[] = [];
  const seen = new Set<string>();
  for (const raw of order) {
    const g = normalizeUiGroup(raw);
    if (!g || seen.has(g)) continue;
    seen.add(g);
    if (prot.has(g)) locked.push(g);
    else normal.push(g);
  }
  // Append any protected ids missing from order (e.g. empty seed groups).
  for (const p of prot) {
    if (!seen.has(p)) locked.push(p);
  }
  return [...normal, ...locked];
}


// ── Axis B: placement chrome (engine panel) — key-based ─────────────────

/**
 * Engine placement chrome — fixed in Launch panel; not free chip tiles.
 * Orthogonal to protected groups (Spec profiles are protected but not chrome).
 */
export function isPlacementChromeParam(def: {
  key: string;
  dock?: string | null;
  ui_group?: string;
}): boolean {
  if (ENGINE_ONLY_PARAM_KEYS.has(def.key)) return false;
  // Profile knobs must NOT be treated as chrome — they live in Spec profile groups.
  if (def.key.startsWith("mtp_") || def.key.startsWith("dflash_")) return false;
  const g = def.ui_group ? normalizeUiGroup(def.ui_group) : "";
  // Product chrome keys only lock when in SYSTEM (or docked). Custom essentials pack
  // lives in PERFORMANCE and stays fully user-editable / deletable.
  if (SYSTEM_CATALOG_PARAM_KEYS.has(def.key) || COCKPIT_OWNED_PARAM_KEYS.has(def.key)) {
    return g === SYSTEM_UI_GROUP || Boolean(def.dock);
  }
  if (g === SYSTEM_UI_GROUP) {
    return true;
  }
  return Boolean(def.dock);
}


/** Canonical group for profile keys (repairs bad SYSTEM migration). */
export function profileGroupForParamKey(key: string): string | null {
  if (key.startsWith("mtp_")) return SPEC_PROFILE_MTP_GROUP;
  if (key.startsWith("dflash_")) return SPEC_PROFILE_DFLASH_GROUP;
  return null;
}

// ── Actor + capabilities ────────────────────────────────────────────────

/** Who is editing CONFIG parameters. */
export type ConfigActor = "locked" | "user" | "dev";

/**
 * Resolve actor for CONFIG editor.
 * DEV builds can preview user restrictions via `devPreviewAsUser`.
 */
export function resolveConfigActor(opts: {
  editorUnlocked: boolean;
  isDev: boolean;
  /** When true, DEV build applies user restrictions (preview). */
  devPreviewAsUser?: boolean;
}): ConfigActor {
  if (!opts.editorUnlocked) return "locked";
  if (opts.isDev && !opts.devPreviewAsUser) return "dev";
  return "user";
}

export type ParamEditCaps = {
  /** Structural row drag / ESS / meta / regroup. */
  structure: boolean;
  /** Edit flag / ptype / label meta (E). */
  editMeta: boolean;
  /** Remove factory param (D on factory row). */
  deleteFactoryParam: boolean;
  /** Remove user-added param. */
  deleteUserParam: boolean;
  /** Delete factory value chip (×). User may only hide. */
  deleteFactoryValue: boolean;
  /** Delete user-added value chip. */
  deleteUserValue: boolean;
  /** Hide individual value chips (eye). */
  hideValue: boolean;
  /** Hide entire param row (circle) — off for protected groups (users). */
  hideParam: boolean;
  /** Set default (*) / select overrides. */
  setDefault: boolean;
  /** Add value chips. */
  addValue: boolean;
  /** Restore row to factory (R). */
  restore: boolean;
};

/**
 * Capability matrix for a param row.
 * Protected group → users expand/hide only; DEV unrestricted.
 * Placement chrome → same structural lock for users (even if group flag missing).
 */
export function paramEditCaps(
  actor: ConfigActor,
  opts: {
    protectedGroup: boolean;
    placementChrome: boolean;
    userAddedParam: boolean;
  },
): ParamEditCaps {
  if (actor === "locked") {
    return {
      structure: false,
      editMeta: false,
      deleteFactoryParam: false,
      deleteUserParam: false,
      deleteFactoryValue: false,
      deleteUserValue: false,
      hideValue: false,
      hideParam: false,
      setDefault: false,
      addValue: false,
      restore: false,
    };
  }

  if (actor === "dev") {
    return {
      structure: true,
      editMeta: true,
      deleteFactoryParam: true,
      deleteUserParam: true,
      deleteFactoryValue: true,
      deleteUserValue: true,
      hideValue: true,
      hideParam: true,
      setDefault: true,
      addValue: true,
      restore: true,
    };
  }

  // user
  const locked = opts.protectedGroup || opts.placementChrome;
  if (locked) {
    return {
      structure: false,
      editMeta: false,
      deleteFactoryParam: false,
      deleteUserParam: true,
      deleteFactoryValue: false,
      deleteUserValue: true,
      hideValue: true,
      // Protected / chrome: values can be hidden; whole param rows stay (Boost/layout).
      hideParam: false,
      setDefault: true,
      addValue: true,
      restore: true,
    };
  }

  return {
    structure: true,
    editMeta: true,
    deleteFactoryParam: true,
    deleteUserParam: true,
    deleteFactoryValue: true,
    deleteUserValue: true,
    hideValue: true,
    hideParam: true,
    setDefault: true,
    addValue: true,
    restore: true,
  };
}

export type GroupEditCaps = {
  rename: boolean;
  deleteEmpty: boolean;
  reorder: boolean;
  toggleProtected: boolean;
  pinDisplay: boolean;
};

export function groupEditCaps(
  actor: ConfigActor,
  opts: { protectedGroup: boolean },
): GroupEditCaps {
  if (actor === "locked") {
    return {
      rename: false,
      deleteEmpty: false,
      reorder: false,
      toggleProtected: false,
      pinDisplay: false,
    };
  }
  if (actor === "dev") {
    return {
      rename: true,
      deleteEmpty: true,
      reorder: true, // pin still forces protected section last on save
      toggleProtected: true,
      pinDisplay: true,
    };
  }
  // user
  return {
    rename: !opts.protectedGroup,
    deleteEmpty: !opts.protectedGroup,
    reorder: !opts.protectedGroup,
    toggleProtected: false,
    pinDisplay: !opts.protectedGroup,
  };
}

type MigratableParam = {
  key: string;
  ui_group?: string;
  dock?: string | null;
  hidden?: boolean;
  userHidden?: boolean;
  values?: (string | number)[];
};

function sortedValuesIfNeeded(values: (string | number)[] | undefined): {
  values: (string | number)[] | undefined;
  changed: boolean;
} {
  if (!values || values.length < 2 || !values.every(isNumericLiteral)) {
    return { values, changed: false };
  }
  const sorted = sortParamValues(values);
  const changed = sorted.some((v, i) => String(v) !== String(values[i]));
  return { values: sorted, changed };
}

/** Normalize persisted rows: drop device, pin chrome + cockpit keys to SYSTEM, unhide system rows, sort values. */
export function migrateCatalogParams<T extends MigratableParam>(
  params: T[],
): { params: T[]; changed: boolean } {
  let changed = false;
  const next: T[] = [];
  for (const p of params) {
    if (ENGINE_ONLY_PARAM_KEYS.has(p.key)) {
      changed = true;
      continue;
    }

    let row: T = p;

    // Repair: profile knobs must sit in SPECULATIVE-MTP / SPECULATIVE-DFLASH (not SYSTEM).
    const profileGroup = profileGroupForParamKey(p.key);
    if (profileGroup && paramUiGroup(p.ui_group) !== profileGroup) {
      row = { ...row, ui_group: profileGroup };
      changed = true;
    }

    // SYSTEM chrome / cockpit: only re-pin when already in chrome bucket (or empty/legacy).
    // Do NOT steal PERFORMANCE / user groups (custom essentials pack stays editable).
    const gNow = paramUiGroup(p.ui_group);
    const chromeKey =
      !profileGroup
      && (SYSTEM_CATALOG_PARAM_KEYS.has(p.key) || COCKPIT_OWNED_PARAM_KEYS.has(p.key));
    const alreadyChromeBucket =
      gNow === SYSTEM_UI_GROUP
      || gNow === "MULTI-GPU"
      || gNow === ""
      || gNow === "RUNTIME-CONFIG";
    if (chromeKey && alreadyChromeBucket) {
      let rowChanged = false;
      if (gNow !== SYSTEM_UI_GROUP) {
        row = { ...row, ui_group: SYSTEM_UI_GROUP };
        rowChanged = true;
      }
      if (p.hidden || p.userHidden) {
        row = { ...row, hidden: false, userHidden: false };
        rowChanged = true;
      }
      if (rowChanged) {
        changed = true;
      }
    }

    const { values: sortedVals, changed: sortChanged } = sortedValuesIfNeeded(row.values);
    if (sortChanged && sortedVals) {
      row = { ...row, values: sortedVals };
      changed = true;
    }

    next.push(row);
  }
  return { params: next, changed };
}
