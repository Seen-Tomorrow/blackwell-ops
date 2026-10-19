/**
 * Launch cockpit state machine — Agents / Memory / Think / Boost + plan apply.
 *
 * Owns product UI state and writes only cockpit-owned keys (+ Boost profile
 * visibility). Header flags (vision / flash_attn / load_mode) are bound here
 * for display but never rewritten by resolveFullAutoPlan.
 *
 * No React panel tree — EngineConfigPanel composes this hook.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ModelEntry,
  ProviderConfig,
  UserEditedTemplateParam,
} from "../lib/types";
import type { ConfigViewMode } from "../lib/types";
import {
  BRAINS_OPTIONS,
  brainsFromKvQuant,
  codingModeFromParallel,
  collectBoostSpecTypes,
  parallelForCodingMode,
  resolveFullAutoPlan,
  type BrainsId,
  type CodingModeId,
  type SpeedBoostId,
  type ThinkId,
} from "../lib/multiAgentBooster";
import {
  filterParamValuesForConfigView,
} from "../lib/launchProfile";
import {
  COCKPIT_FLAG_PARAM_KEYS,
} from "../lib/systemParams";
import {
  providerHasAnyCockpitBinding,
  providerHasParamKey,
} from "../lib/customProvider";
import {
  type SpecBoostMethod,
  DFLASH_DRAFT_MODEL,
  MTP_DRAFT_MODEL,
  activeBoostMethodFromParams,
  cockpitProfileKnobRows,
} from "../lib/specProfiles";
import {
  adapterForMethod,
  cliTypeForMethod,
  normalizeDraftPath,
} from "../lib/spec/adapters";
import type { DraftRole } from "../lib/specDraft";
import { applySpecBoostProfiles } from "../lib/applySpecBoost";
import {
  hasReadyDflashDraft,
  resolveExternalDraftPath,
  resolveDraftPathLabel,
  saveDraftPairing,
  specCapabilitiesForMain,
  type SpecCapability,
} from "../lib/specDraft";
import { mainMaySupportDflash } from "../lib/dflashGetDraft";
import type { CockpitFlagToggle } from "../components/CockpitFlagToolbar";
import type { CockpitSpecDetailParam } from "../components/MultiAgentBooster";

/** Parallel slots from config — local to avoid hooks→components import. */
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

function thinkFromReasoning(value: unknown): ThinkId {
  if (value === "off" || value === 0 || value === "0") return "off";
  if (value === 2000 || value === "2000") return "budget2k";
  if (value === 4000 || value === "4000" || value === 8000 || value === "8000") return "budget";
  return "on";
}

function reasoningForThink(think: ThinkId): string | number {
  if (think === "off") return "off";
  if (think === "budget2k") return 2000;
  if (think === "budget") return 4000;
  return "on";
}

export type ApplyCockpitOpts = {
  powerUser?: boolean;
  rawSpecType?: string | null;
  preferredDraftPath?: string | null;
};

export type UseCockpitOptions = {
  model: ModelEntry | null;
  models: ModelEntry[] | undefined;
  allParamsResolved: UserEditedTemplateParam[];
  config: Record<string, any>;
  updateParam: (key: string, value: unknown) => void;
  clearSpecConfig: () => void;
  effectiveBackendType: string;
  fullAutoMode: boolean;
  powerCockpitMode: boolean;
  configView: ConfigViewMode;
  isCustomProvider: boolean;
  specDecodingGroupVisible: boolean;
  setResolvedProviders: React.Dispatch<React.SetStateAction<ProviderConfig[]>>;
  /**
   * While true, skip model/capability Boost re-snap (seat-edit hydrate).
   * Prevents applyFullAutoCockpit fighting seat bag + endless VRAM re-eval.
   */
  hydrateLockRef?: React.MutableRefObject<boolean>;
};

export function useCockpit({
  model,
  models,
  allParamsResolved,
  config,
  updateParam,
  clearSpecConfig,
  effectiveBackendType,
  fullAutoMode,
  powerCockpitMode,
  configView,
  isCustomProvider,
  specDecodingGroupVisible,
  setResolvedProviders,
  hydrateLockRef,
}: UseCockpitOptions) {
  const cockpitModeKey = fullAutoMode
    ? "full_auto"
    : configView === "full"
      ? "assisted_full"
      : "assisted_essentials";
  const [speedByMode, setSpeedByMode] = useState<Record<string, SpeedBoostId>>({});
  const speedBoost = speedByMode[cockpitModeKey] ?? (fullAutoMode ? "smart" : "off");
  const setSpeedBoost = useCallback(
    (next: SpeedBoostId) => {
      setSpeedByMode((prev) => ({ ...prev, [cockpitModeKey]: next }));
    },
    [cockpitModeKey],
  );
  const setSpeedForMode = useCallback((mode: string, next: SpeedBoostId) => {
    setSpeedByMode((prev) => ({ ...prev, [mode]: next }));
  }, []);
  const [specFlash, setSpecFlash] = useState(false);
  const boosterSeededRef = useRef(false);

  // Agents / Memory / Think are derived from the active mode's config, not
  // shared React state. CTX/batch/header flags already work this way; keeping
  // these three derived removes the cross-mode slider leak at the source.
  const codingMode = useMemo(
    () => codingModeFromParallel(resolveParallelSlots(config, allParamsResolved)),
    [config, allParamsResolved],
  );
  const brains = useMemo(
    () => brainsFromKvQuant(config.kv_quant != null ? String(config.kv_quant) : undefined),
    [config.kv_quant],
  );
  const think = useMemo(() => thinkFromReasoning(config.reasoning), [config.reasoning]);

  const fullAutoFixed = fullAutoMode;

  const specCapabilities = useMemo(
    () =>
      model && models?.length
        ? specCapabilitiesForMain(model, models, effectiveBackendType)
        : ([] as SpecCapability[]),
    [model, models, effectiveBackendType],
  );

  const kvQuantFactoryValues = useMemo(() => {
    const def = allParamsResolved.find((p) => p.key === "kv_quant");
    const user = new Set((def?.userAddedValues || []).map(String));
    const base = (def?.values || []).filter((v) => !user.has(String(v)));
    return base.length > 0 ? base : ["q4_0", "q8_0", "f16", "bf16"];
  }, [allParamsResolved]);

  const kvQuantValues = useMemo(() => {
    const def = allParamsResolved.find((p) => p.key === "kv_quant");
    const seen = new Set<string>();
    const out: (string | number)[] = [];
    for (const v of [...kvQuantFactoryValues, ...(def?.userAddedValues || [])]) {
      const s = String(v);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(v);
    }
    return out;
  }, [allParamsResolved, kvQuantFactoryValues]);

  const parallelFactoryValues = useMemo(() => {
    const def = allParamsResolved.find((p) => p.key === "parallel");
    if (!def) return [];
    const user = new Set((def?.userAddedValues || []).map(String));
    const base = (def?.values || []).filter((v) => !user.has(String(v)));
    if (base.length > 0) return base;
    return isCustomProvider ? [] : [1, 4, 8, 16, 32];
  }, [allParamsResolved, isCustomProvider]);

  const parallelValues = useMemo(() => {
    const def = allParamsResolved.find((p) => p.key === "parallel");
    const seen = new Set<string>();
    const out: (string | number)[] = [];
    for (const v of [...parallelFactoryValues, ...(def?.userAddedValues || [])]) {
      const s = String(v);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(v);
    }
    return out;
  }, [allParamsResolved, parallelFactoryValues]);

  const cockpitValueView: "essentials" | "full" =
    fullAutoFixed || configView === "essentials" ? "essentials" : "full";

  const cockpitKvValues = useMemo(() => {
    const def = allParamsResolved.find((p) => p.key === "kv_quant");
    if (!def) return [];
    const base = fullAutoFixed ? kvQuantFactoryValues : kvQuantValues;
    return filterParamValuesForConfigView(def, base, cockpitValueView);
  }, [allParamsResolved, fullAutoFixed, cockpitValueView, kvQuantFactoryValues, kvQuantValues]);

  const cockpitParallelValues = useMemo(() => {
    const def = allParamsResolved.find((p) => p.key === "parallel");
    if (!def) return [];
    const base = fullAutoFixed ? parallelFactoryValues : parallelValues;
    return filterParamValuesForConfigView(def, base, cockpitValueView);
  }, [allParamsResolved, fullAutoFixed, cockpitValueView, parallelFactoryValues, parallelValues]);

  const cockpitKvValuesBound = useMemo(() => {
    if (!providerHasParamKey(allParamsResolved, "kv_quant")) return [];
    return cockpitKvValues;
  }, [allParamsResolved, cockpitKvValues]);

  const showCockpitSurface = useMemo(
    () => providerHasAnyCockpitBinding(allParamsResolved),
    [allParamsResolved],
  );

  const cockpitShowAgents = providerHasParamKey(allParamsResolved, "parallel");
  const cockpitShowMemory = providerHasParamKey(allParamsResolved, "kv_quant");
  const cockpitShowThink = providerHasParamKey(allParamsResolved, "reasoning");

  const cockpitShowBoost = useMemo(() => {
    if (!isCustomProvider) return true;
    return allParamsResolved.some(
      (p) =>
        p.key.startsWith("mtp_")
        || p.key.startsWith("dflash_")
        || p.key === "spec_type"
        || (p.ui_group && /SPECULATIVE/i.test(p.ui_group)),
    );
  }, [isCustomProvider, allParamsResolved]);

  const cockpitFlagToggles = useMemo((): CockpitFlagToggle[] => {
    const meta: Record<string, { label: string; title: string }> = {
      vision: {
        label: "VISION",
        title: "mmproj / vision projector (auto = scan & load; can be multi-GB)",
      },
      flash_attn: {
        label: "FLASH",
        title: "Flash Attention (--flash-attn)",
      },
      load_mode: {
        label: "LOAD",
        title: "Model load mode (--load-mode): mmap / mlock / dio",
      },
    };
    const out: CockpitFlagToggle[] = [];
    for (const key of COCKPIT_FLAG_PARAM_KEYS) {
      const def = allParamsResolved.find((p) => p.key === key);
      if (!def || def.hidden || def.userHidden) continue;
      const vals = (def.values?.length ? def.values : ["off"]).map(String);
      const raw = config[key];
      const current = raw != null && String(raw).trim() !== "" ? String(raw) : vals[0]!;
      const m = meta[key]!;
      out.push({
        key,
        label: m.label,
        title: m.title,
        values: vals,
        current,
        onChange: (v) => updateParam(key, v),
      });
    }
    return out;
  }, [allParamsResolved, config, updateParam]);

  const specBoostMethod: SpecBoostMethod = useMemo(() => {
    if (speedBoost === "mtp" || speedBoost === "dflash" || speedBoost === "dspark") {
      return speedBoost;
    }
    if (speedBoost === "off" || speedBoost === "smart") return "off";
    return activeBoostMethodFromParams(allParamsResolved);
  }, [speedBoost, allParamsResolved]);

  const cockpitSpecDetailParams = useMemo((): CockpitSpecDetailParam[] => {
    return cockpitProfileKnobRows(
      specBoostMethod,
      allParamsResolved,
      config,
      cockpitValueView,
      updateParam,
    );
  }, [specBoostMethod, allParamsResolved, config, cockpitValueView, updateParam]);

  /**
   * The draft path for the active Boost method — `mtp_draft_model` for MTP,
   * `dflash_draft_model` for DFlash/DSpark. Falls back to the other key only when
   * the active one is unset. `normalizeDraftPath` absorbs the `off`/`none` defaults.
   */
  const activeDraftPath = useMemo(() => {
    const adapter = adapterForMethod(specBoostMethod);
    const activeKey = adapter?.knobs.draftModel;
    const fromActive = activeKey ? normalizeDraftPath(config[activeKey]) : null;
    if (fromActive) return fromActive;
    if (!activeKey) return null;
    const otherKey = activeKey === MTP_DRAFT_MODEL ? DFLASH_DRAFT_MODEL : MTP_DRAFT_MODEL;
    return normalizeDraftPath(config[otherKey]);
  }, [specBoostMethod, config]);

  const dflashLibraryReady = useMemo(() => {
    if (!model || !models?.length) return false;
    return hasReadyDflashDraft(model, models, activeDraftPath);
  }, [model, models, activeDraftPath]);

  const dflashGettable = useMemo(() => mainMaySupportDflash(model), [model]);

  const dflashDraftLabel = useMemo(() => {
    const cur = activeDraftPath;
    if (cur && /\.gguf$/i.test(cur)) {
      return resolveDraftPathLabel(cur);
    }
    if (!model || !models?.length || !dflashLibraryReady) return null;
    const adapter = adapterForMethod(specBoostMethod);
    const draftRole = adapter?.draftRoles.find((r): r is DraftRole => r !== "none");
    if (!adapter || !draftRole) return null;
    const path = resolveExternalDraftPath(model, models, draftRole, {
      currentPath: cur,
      specType: cliTypeForMethod(specBoostMethod) ?? adapter.cliType,
    });
    return path ? resolveDraftPathLabel(path) : null;
  }, [model, models, dflashLibraryReady, activeDraftPath, specBoostMethod]);

  const applyFullAutoCockpit = useCallback(
    async (
      mode: CodingModeId,
      speed: SpeedBoostId,
      brainsPick: BrainsId,
      thinkPick: ThinkId,
      opts?: ApplyCockpitOpts,
    ) => {
      const powerUser = opts?.powerUser ?? false;
      setSpeedBoost(speed);

      const draftReadyMethod: SpecBoostMethod =
        speed === "mtp" || speed === "dflash" || speed === "dspark" ? speed : "off";
      const draftReadyAdapter = adapterForMethod(draftReadyMethod);
      const draftReadyRole = draftReadyAdapter?.draftRoles.find(
        (r): r is DraftRole => r !== "none",
      );
      const draftReadyNow =
        dflashLibraryReady
        || Boolean(
          opts?.preferredDraftPath
          && model
          && models?.length
          && draftReadyRole
          && resolveExternalDraftPath(model, models, draftReadyRole, {
            preferredPath: opts.preferredDraftPath,
            specType:
              cliTypeForMethod(draftReadyMethod) ?? draftReadyAdapter?.cliType,
          }),
        );

      const plan = resolveFullAutoPlan({
        codingMode: mode,
        speed,
        brains: brainsPick,
        think: thinkPick,
        capabilities: specCapabilities,
        dflashLibraryReady: draftReadyNow,
        dflashGettable,
        kvQuantValues,
        powerUser,
      });

      // Only auto-normalize the soft Off/Smart modes. A user-picked MTP/DFlash/
      // DSpark stays selected even when its draft is not ready yet — the strip
      // then asks for the missing draft instead of silently reverting.
      if (
        (speed === "off" || speed === "smart")
        && plan.speed !== speed
      ) {
        setSpeedBoost(plan.speed);
      }

      updateParam("parallel", plan.parallel);
      updateParam("kv_quant", plan.kvQuant);
      // Cockpit-owned only — never vision/flash/load_mode or Smart batch.
      if (plan.reasoning != null && allParamsResolved.some((p) => p.key === "reasoning")) {
        updateParam("reasoning", plan.reasoning);
      }

      // Assisted sliders are explicit user choices. Do not let plan
      // normalization (Smart/safe fallbacks) turn them back into defaults in
      // the profile after the click.
      if (powerUser) {
        if (!plan.forcedSoloForMtp) updateParam("parallel", parallelForCodingMode(mode));
        const kv = BRAINS_OPTIONS.find((b) => b.id === brainsPick)?.kvQuant;
        if (kv && kvQuantValues.some((v) => String(v).toLowerCase() === kv.toLowerCase())) {
          updateParam("kv_quant", kv);
        }
        if (allParamsResolved.some((p) => p.key === "reasoning")) {
          updateParam("reasoning", reasoningForThink(thinkPick));
        }
      }

      const method: SpecBoostMethod =
        plan.speed === "mtp" || plan.speed === "dflash" || plan.speed === "dspark"
          ? plan.speed
          : "off";

      try {
        await applySpecBoostProfiles({
          providerId: effectiveBackendType,
          method,
          setProviders: setResolvedProviders,
        });
        setSpecFlash(true);
        window.setTimeout(() => setSpecFlash(false), 400);
      } catch (err) {
        console.error("[cockpit] applySpecBoostProfiles failed:", err);
      }

      // External draft path — the active method's own key (mtp_draft_model vs
      // dflash_draft_model) → --spec-draft-model.
      const applyAdapter = adapterForMethod(method);
      const applyDraftKey = applyAdapter?.knobs.draftModel;
      if (applyAdapter && applyDraftKey && model && models?.length) {
        const cliType = cliTypeForMethod(method) ?? applyAdapter.cliType;
        const draftRole = applyAdapter.draftRoles.find((r): r is DraftRole => r !== "none");
        const resolved =
          opts?.preferredDraftPath
          || (draftRole
            ? resolveExternalDraftPath(model, models, draftRole, {
                preferredPath: opts?.preferredDraftPath,
                currentPath: normalizeDraftPath(config[applyDraftKey]),
                specType: cliType,
                // MTP never auto-pairs: the head comes from the picker or the saved
                // pairing. Baked-in MTP needs no path at all — the engine builds the
                // draft context from the target model.
                allowAutoPair: method !== "mtp",
              })
            : null);
        if (resolved) {
          updateParam(applyDraftKey, resolved);
          saveDraftPairing(model.path, cliType, resolved);
        } else if (opts?.preferredDraftPath) {
          // Explicit path (Change draft) even if not scored as the method's draft role
          updateParam(applyDraftKey, opts.preferredDraftPath);
          saveDraftPairing(model.path, cliType, opts.preferredDraftPath);
        }
      }

      if (method === "off") {
        clearSpecConfig();
      }
    },
    [
      dflashGettable,
      dflashLibraryReady,
      effectiveBackendType,
      kvQuantValues,
      model,
      models,
      specCapabilities,
      config,
      updateParam,
      clearSpecConfig,
      allParamsResolved,
      setResolvedProviders,
    ],
  );

  const factoryRawSpecTypes = useMemo(() => {
    const def = allParamsResolved.find((p) => p.key === "spec_type");
    if (!def) return [] as string[];
    const merged = collectBoostSpecTypes(def.values, def.userAddedValues);
    return filterParamValuesForConfigView(def, merged, cockpitValueView).map(String);
  }, [allParamsResolved, cockpitValueView]);

  const activeRawSpecType = useMemo(() => {
    if (!specDecodingGroupVisible) return null;
    const st = config.spec_type != null ? String(config.spec_type).trim() : "";
    if (!st) return null;
    const low = st.toLowerCase();
    if (low.includes("mtp") || low === "draft-mtp") return null;
    if (low.includes("dflash") || low === "draft-dflash") return null;
    if (low.includes("dspark") || low === "draft-dspark") return null;
    return st;
  }, [specDecodingGroupVisible, config.spec_type]);

  useEffect(() => {
    boosterSeededRef.current = false;
  }, [effectiveBackendType, model?.path, fullAutoMode, configView]);

  useEffect(() => {
    if (boosterSeededRef.current) return;
    if (!allParamsResolved.length) return;
    if (speedByMode[cockpitModeKey] !== undefined) {
      boosterSeededRef.current = true;
      return;
    }
    if (config.parallel == null && config.kv_quant == null && Object.keys(config).length === 0) {
      return;
    }
    const method = activeBoostMethodFromParams(allParamsResolved);
    if (method === "mtp" || method === "dflash" || method === "dspark") {
      setSpeedBoost(method);
    }
    else setSpeedBoost(fullAutoMode ? "smart" : "off");
    boosterSeededRef.current = true;
  }, [allParamsResolved, config, fullAutoMode, specDecodingGroupVisible, speedByMode, cockpitModeKey]);

  // Model / capability drop → snap Boost (derive agents/memory/think from config).
  useEffect(() => {
    if (hydrateLockRef?.current) return;
    if (!model) return;
    if (!allParamsResolved.length || Object.keys(config).length === 0) return;
    const modeFromCfg = codingModeFromParallel(
      resolveParallelSlots(config, allParamsResolved),
    );
    const brainsFromCfg = brainsFromKvQuant(
      config.kv_quant != null ? String(config.kv_quant) : undefined,
    );
    let thinkFromCfg: ThinkId = "on";
    const r = config.reasoning;
    if (r === "off" || r === 0 || r === "0") thinkFromCfg = "off";
    else if (r === 2000 || r === "2000") thinkFromCfg = "budget2k";
    else if (r === 4000 || r === "4000" || r === 8000 || r === "8000") thinkFromCfg = "budget";

    const plan = resolveFullAutoPlan({
      codingMode: modeFromCfg,
      speed: speedBoost,
      brains: brainsFromCfg,
      think: thinkFromCfg,
      capabilities: specCapabilities,
      dflashLibraryReady,
      dflashGettable,
      kvQuantValues,
      powerUser: powerCockpitMode,
    });
    if (
      (speedBoost === "off" || speedBoost === "smart")
      && plan.speed !== speedBoost
    ) {
      setSpeedBoost(plan.speed);
      void applyFullAutoCockpit(modeFromCfg, plan.speed, brainsFromCfg, thinkFromCfg, {
        powerUser: powerCockpitMode,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-validate on model/caps only
  }, [model?.path, specCapabilities, dflashLibraryReady, dflashGettable]);

  const cockpitOpts = useMemo(
    () => ({ powerUser: powerCockpitMode }),
    [powerCockpitMode],
  );

  return {
    codingMode,
    speedBoost,
    brains,
    think,
    setSpeedBoost,
    setSpeedForMode,
    specFlash,
    applyFullAutoCockpit,
    cockpitOpts,
    specCapabilities,
    specBoostMethod,
    cockpitValueView,
    cockpitKvValues,
    cockpitKvValuesBound,
    cockpitParallelValues,
    kvQuantValues,
    parallelValues,
    showCockpitSurface,
    cockpitShowAgents,
    cockpitShowMemory,
    cockpitShowThink,
    cockpitShowBoost,
    cockpitFlagToggles,
    cockpitSpecDetailParams,
    factoryRawSpecTypes,
    activeRawSpecType,
    dflashLibraryReady,
    dflashGettable,
    dflashDraftLabel,
  };
}
