import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  ConfigViewMode,
  UserEditedTemplateParam,
} from "../lib/types";
import type { SpecCapability } from "../lib/specDraft";
import { filterParamValuesForConfigView } from "../lib/launchProfile";
import { paramValuesMatch } from "../lib/paramConfigResolve";
import { formatCtxChipLabel } from "../lib/sliderParamUtils";
import {
  essentialsSpecChipLabel,
  specTypeNeedsExternalDraft,
} from "../lib/specDraft";
import {
  SPEC_PROFILE_MTP,
  SPEC_PROFILE_DFLASH,
} from "../lib/specProfiles";
import SliderParam from "./SliderParam";

const PARAM_LABEL_CLASS =
  "font-mono w-24 flex-shrink-0 uppercase tracking-wider truncate type-label cfg-mut";

function paramChipClass(active: boolean): string {
  // Segment-rail options (config-value-segment) — same language as cockpit flags / VRAM bezel.
  return `config-value-segment__opt value-chip font-mono focus:outline-none ${
    active ? "value-chip-active" : ""
  }`;
}

/**
 * Engine-config param chip rail — renders value options as one continuous bezel
 * track with a sliding accent thumb, same language as the cockpit VISION/FLASH/LOAD
 * flag segments (no per-value separators). Theme tokens only. Children must be the
 * option buttons (rendered with data-seg-i for measurement).
 */
export function ConfigChipSegment({
  activeIndex,
  ariaLabel,
  children,
}: {
  activeIndex: number;
  ariaLabel: string;
  children: ReactNode[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 2, top: 2, width: 0, height: 0 });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const slot = root.querySelector<HTMLElement>(`[data-seg-i="${activeIndex}"]`);
      if (!slot) return;
      // offset* is relative to the rail — works when chips wrap to a 2nd row
      // (a full-height thumb would paint both rows and look like dual selection).
      setThumb({
        left: slot.offsetLeft,
        top: slot.offsetTop,
        width: slot.offsetWidth,
        height: slot.offsetHeight,
      });
    };
    measure();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(root);
      root.querySelectorAll("[data-seg-i]").forEach((el) => ro!.observe(el));
    }
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeIndex, children.length]);

  return (
    <div
      ref={rootRef}
      className="config-value-segment config-value-segment--rail"
      role="group"
      aria-label={ariaLabel}
      style={
        {
          "--seg-thumb-left": `${thumb.left}px`,
          "--seg-thumb-top": `${thumb.top}px`,
          "--seg-thumb-width": `${thumb.width}px`,
          "--seg-thumb-height": `${thumb.height}px`,
        } as CSSProperties
      }
    >
      <span className="config-value-segment__thumb" aria-hidden />
      {children}
    </div>
  );
}

function paramRowKey(def: UserEditedTemplateParam, idx?: number): string {
  return `${def.key || "param"}-${def.order}-${idx ?? 0}`;
}

const BASE_PORT_CHIP_TOOLTIP = "Set your starting port, we will increment from here";

export const SPEC_DECODING_GROUP = "SPECULATIVE-DECODING"; // legacy label only

function configFlagEnabled(config: Record<string, unknown>, key: string): boolean {
  const v = config[key];
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  return String(v ?? "").trim().toLowerCase() === "true";
}

function resolveParallelSlots(
  config: Record<string, unknown>,
  params: UserEditedTemplateParam[],
): number {
  const raw = config.parallel;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const parallelDef = params.find((p) => p.key === "parallel");
  const fallback = parallelDef?.defaultValue ?? parallelDef?.values?.[0] ?? 1;
  const n = Number(fallback);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** CTX ÷ slots — unified KV uses one pool; otherwise parallel slot count. */
function resolveCtxSlotCount(
  config: Record<string, unknown>,
  params: UserEditedTemplateParam[],
): number {
  if (configFlagEnabled(config, "unified_kv")) return 1;
  return resolveParallelSlots(config, params);
}

const SPEC_TYPE_BY_CAPABILITY: Record<SpecCapability, string> = {
  dflash: "draft-dflash",
  mtp: "draft-mtp",
  eagle3: "draft-eagle3",
};

function filterSpecTypeValues(
  values: (string | number)[],
  caps: SpecCapability[],
  essentialsSimpleMode?: boolean,
): (string | number)[] {
  // draft-mtp is a manual lane: baked-in nextn or a user-picked external head.
  // Detection only labels it; launch validates the head, so never hide the value.
  const allowed = new Set<string>(["draft-mtp"]);
  for (const cap of caps) {
    if (essentialsSimpleMode && cap !== "mtp" && cap !== "dflash") continue;
    allowed.add(SPEC_TYPE_BY_CAPABILITY[cap]);
  }
  return values.filter((v) => {
    const s = String(v).toLowerCase();
    if (essentialsSimpleMode) return allowed.has(s);
    if (s.startsWith("ngram") || s === "draft-simple") return true;
    return allowed.has(s);
  });
}

function applyEssentialsSpecPreset(
  _specType: string,
  _updateParam: (key: string, value: string | number) => void,
): void {
  // Profile templates own defaults — Boost no longer pushes hardcoded presets.
}

const GROUP_LABEL_OVERRIDES: Record<string, string> = {
  "ABOVE-CONFIG-LEFT": "MEMORY",
  "ABOVE-CONFIG-RIGHT": "MEMORY",
};

// Group metadata derived dynamically from template — no hardcoded group names.
export interface ParamGroupMeta { id: string; label: string; alwaysOpen: boolean }
export function deriveParamGroups(groupKeys: string[]): ParamGroupMeta[] {
  return groupKeys.map(id => ({
    id,
    label: GROUP_LABEL_OVERRIDES[id] ?? id.toUpperCase(),
    alwaysOpen: id === 'Core' || id === 'Performance', // Core/Performance always open by convention
  }));
}

export { resolveCtxSlotCount, resolveParallelSlots };

/**
 * Shared read-only state the param-group render helpers need. The orchestrator
 * builds this once (useMemo) and passes it down — no prop-drilling through the
 * section tree.
 */
export interface ParamGroupsCtx {
  config: Record<string, any>;
  fullAutoFixed: boolean;
  configView: ConfigViewMode;
  specCapabilities: SpecCapability[];
  specSimpleMode: boolean;
  providerDefaultKeys: Set<string>;
  updateParam: (key: string, value: string | number) => void;
  allParamsResolved: UserEditedTemplateParam[];
  groupedParams: Record<string, UserEditedTemplateParam[]>;
  collapsedGroups: Set<string>;
  toggleGroup: (groupId: string) => void;
}

/** Param row renderer (chip or slider). Pure — reads state from `ctx`. */
export function renderParamRow(
  ctx: ParamGroupsCtx,
  def: UserEditedTemplateParam,
  isLocked?: boolean,
  rowIdx?: number,
): ReactNode {
  const { config, fullAutoFixed, configView, specCapabilities, specSimpleMode, providerDefaultKeys, updateParam, allParamsResolved } = ctx;
  // Merge values + userAddedValues (user-added params from ConfigPage admin edit)
  const seenVals = new Set((def.values || []).map(v => String(v)));
  const allValues = [...(def.values || []), ...(def.userAddedValues || []).filter(v => !seenVals.has(String(v)))];
  // Full Auto hides the chip matrix; if chips ever show, use essentials filter
  // (not "full") so essentialsHiddenValues still apply.
  let baseValues = filterParamValuesForConfigView(
    def,
    allValues,
    fullAutoFixed ? "essentials" : configView,
  );
  if (def.key === "spec_type" && specCapabilities.length > 0) {
    baseValues = filterSpecTypeValues(baseValues, specCapabilities, specSimpleMode);
  }
  const currentValue = config[def.key];

  // Yellow accent: user-added params (not in provider default params, not system-injected via dock)
  const isUserAdded = providerDefaultKeys.size > 0 && !providerDefaultKeys.has(def.key) && !def.dock;

  // ── Slider ptype — render range input instead of value chips ───────────
  if (def.ptype === 'slider') {
    const ctxNumeric =
      def.key === "ctx"
        ? (typeof currentValue === "number" ? currentValue : parseInt(String(currentValue), 10))
        : 0;
    const ctxSlotCount = def.key === "ctx" ? resolveCtxSlotCount(config, allParamsResolved) : 1;
    const ctxPerSlot =
      def.key === "ctx" && ctxSlotCount > 1 && Number.isFinite(ctxNumeric) && ctxNumeric > 0
        ? Math.floor(ctxNumeric / ctxSlotCount)
        : 0;
    return (
      <div
        key={paramRowKey(def, rowIdx)}
        data-param-row
        className={`ctx-slider-param-row flex items-start min-h-[22px] ${isLocked ? "opacity-50" : ""}`}
      >
        {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 cfg-fill--warn--a40 mr-1.5 mt-0.5" />}
        {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5 mt-0.5" />}
        <span
          className={`ctx-slider-param-label ${PARAM_LABEL_CLASS} mt-0.5 ${def.key === "ctx" && ctxPerSlot > 0 ? "!w-auto max-w-[40%]" : ""} ${isUserAdded ? "cfg-warn--a80" : ""}`}
          title={def.key === "ctx" && ctxPerSlot > 0
            ? `${formatCtxChipLabel(ctxNumeric)} (${ctxNumeric}) ÷ ${ctxSlotCount} slots = ${formatCtxChipLabel(ctxPerSlot)} per slot`
            : def.label}
        >
          {def.label}
        </span>
        <div className="ctx-slider-field flex-1 min-w-0 min-h-[18px] flex items-center">
          <SliderParam
            paramKey={def.key}
            currentValue={currentValue}
            defaultValue={def.defaultValue}
            onChange={(v) => updateParam(def.key, v)}
            step={def.step ?? 1024}
            values={baseValues}
            perSlotReserve={ctxSlotCount > 1}
            perSlotTokens={ctxPerSlot > 0 ? ctxPerSlot : undefined}
            perSlotTitle={
              ctxPerSlot > 0
                ? `Per slot: ${formatCtxChipLabel(ctxNumeric)} (${ctxNumeric}) ÷ ${ctxSlotCount}`
                : undefined
            }
          />
        </div>
      </div>
    );
  }

  const renderedValues = baseValues.filter((v: any) => !(v?._hidden));

  return (
    <div key={paramRowKey(def, rowIdx)} data-param-row className={`flex items-start min-h-[22px] ${isLocked ? 'opacity-50' : ''}`}>
      {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 cfg-fill--warn--a40 mr-1.5 mt-0.5" />}
      {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5 mt-0.5" />}
      <span
        className={`${PARAM_LABEL_CLASS} mt-0.5 ${isUserAdded ? 'cfg-warn--a80' : ''}`}
        title={def.label}
      >
        {specSimpleMode && def.key === "spec_type" ? "MODE" : def.label}
      </span>

      <div className="config-chip-row flex gap-1.5 flex-wrap flex-1 min-w-0 items-center min-h-[18px]">
        <ConfigChipSegment
          activeIndex={Math.max(0, renderedValues.findIndex((v) => paramValuesMatch(currentValue, v)))}
          ariaLabel={`${def.label} values`}
        >
          {renderedValues.map((val, valIdx) => {
            const active = paramValuesMatch(currentValue, val);
            return (
              <button
                key={`${paramRowKey(def, rowIdx)}-val-${valIdx}-${String(val)}`}
                type="button"
                tabIndex={isLocked ? -1 : 0}
                data-seg-i={valIdx}
                data-selected={active ? "1" : undefined}
                title={def.key === "base_port" ? BASE_PORT_CHIP_TOOLTIP : undefined}
                onClick={() => {
                  if (isLocked) return;
                  updateParam(def.key, val);
                  if (def.key === "spec_type") {
                    if (specSimpleMode) {
                      applyEssentialsSpecPreset(String(val), updateParam);
                    }
                    // MTP (and other non-external modes) must not keep a DFlash draft path.
                    if (!specTypeNeedsExternalDraft(String(val))) {
                      updateParam("spec_draft_model", "off");
                    }
                  }
                }}
                className={paramChipClass(active)}
              >
                {specSimpleMode && def.key === "spec_type"
                  ? essentialsSpecChipLabel(String(val))
                  : String(val)}
              </button>
            );
          })}
        </ConfigChipSegment>
      </div>
    </div>
  );
}

/** A single param group tile (header + rows). Pure — reads `ctx`. */
export function renderParamGroup(
  ctx: ParamGroupsCtx,
  group: ParamGroupMeta,
): ReactNode {
  const {
    groupedParams,
    collapsedGroups,
    toggleGroup,
  } = ctx;

  if (
    group.id === SPEC_DECODING_GROUP
    || group.id === SPEC_PROFILE_MTP
    || group.id === SPEC_PROFILE_DFLASH
  ) {
    // Cockpit owns Boost + profile knobs. Classic chip block removed for profile groups.
    return null;
  }

  const groupParams = groupedParams[group.id];

  if (!groupParams || groupParams.length === 0) return null;

  const isCollapsed = collapsedGroups.has(group.id);
  const headerClass =
    "config-group-header flex items-center gap-1.5 type-tiny font-mono tracking-widest uppercase mb-2 pb-1 border-b cfg-bord--a30 w-full";

  return (
    <div key={group.id}>
      {group.alwaysOpen ? (
        <div className={headerClass}>
          <span className="flex-1 min-w-0 truncate">{group.label}</span>
        </div>
      ) : (
        <div className={headerClass}>
          <button
            type="button"
            onClick={() => toggleGroup(group.id)}
            className="flex items-center gap-1.5 flex-1 min-w-0 hover:text-white hover:opacity-100 transition-colors text-left"
          >
            <span className="type-micro">{isCollapsed ? "▶" : "▼"}</span>
            <span className="truncate">{group.label}</span>
            <span className="opacity-40 flex-shrink-0">({groupParams.length})</span>
          </button>
        </div>
      )}

      {!isCollapsed && (
        <div className="space-y-2.5">
          {groupParams.map((def, i) => renderParamRow(ctx, def, false, i))}
        </div>
      )}
    </div>
  );
}
