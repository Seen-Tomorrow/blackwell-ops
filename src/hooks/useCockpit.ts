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
  brainsFromKvQuant,
  codingModeFromParallel,
  collectBoostSpecTypes,
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
  activeBoostMethodFromParams,
  cockpitProfileKnobRows,
} from "../lib/specProfiles";
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
  const [codingMode, setCodingMode] = useState<CodingModeId>("solo");
  const [speedBoost, setSpeedBoost] = useState<SpeedBoostId>("off");
  const [brains, setBrains] = useState<BrainsId>("solid");
  const [think, setThink] = useState<ThinkId>("on");
  const [specFlash, setSpecFlash] = useState(false);
  const boosterSeededRef = useRef(false);

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

  const dflashLibraryReady = useMemo(() => {
    if (!model || !models?.length) return false;
    const cur =
      config[DFLASH_DRAFT_MODEL] != null ? String(config[DFLASH_DRAFT_MODEL]) : null;
    return hasReadyDflashDraft(model, models, cur);
  }, [model, models, config]);

  const dflashGettable = useMemo(() => mainMaySupportDflash(model), [model]);

  const dflashDraftLabel = useMemo(() => {
    const cur =
      config[DFLASH_DRAFT_MODEL] != null ? String(config[DFLASH_DRAFT_MODEL]) : "";
    if (cur.trim() && /\.gguf$/i.test(cur.trim())) {
      return resolveDraftPathLabel(cur.trim());
    }
    if (!model || !models?.length || !dflashLibraryReady) return null;
    const cliType =
      speedBoost === "dspark" ? "draft-dspark" : "draft-dflash";
    const path = resolveExternalDraftPath(model, models, "external_dflash", {
      currentPath: cur || null,
      specType: cliType,
    });
    return path ? resolveDraftPathLabel(path) : null;
  }, [model, models, dflashLibraryReady, config, speedBoost]);

  const applyFullAutoCockpit = useCallback(
    async (
      mode: CodingModeId,
      speed: SpeedBoostId,
      brainsPick: BrainsId,
      thinkPick: ThinkId,
      opts?: ApplyCockpitOpts,
    ) => {
      const powerUser = opts?.powerUser ?? false;
      setCodingMode(mode);
      setSpeedBoost(speed);
      setBrains(brainsPick);
      setThink(thinkPick);

      const draftReadyNow =
        dflashLibraryReady
        || Boolean(
          opts?.preferredDraftPath
          && model
          && models?.length
          && resolveExternalDraftPath(model, models, "external_dflash", {
            preferredPath: opts.preferredDraftPath,
            specType: "draft-dflash",
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

      if (plan.forcedSoloForMtp) setCodingMode("solo");
      if (plan.speed !== speed) setSpeedBoost(plan.speed);

      updateParam("parallel", plan.parallel);
      updateParam("kv_quant", plan.kvQuant);
      // Cockpit-owned only — never vision/flash/load_mode or Smart batch.
      if (plan.reasoning != null && allParamsResolved.some((p) => p.key === "reasoning")) {
        updateParam("reasoning", plan.reasoning);
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

      // External draft path (DFlash + DSpark share dflash_draft_model key → --spec-draft-model)
      if ((method === "dflash" || method === "dspark") && model && models?.length) {
        const cliType = method === "dspark" ? "draft-dspark" : "draft-dflash";
        const resolved =
          opts?.preferredDraftPath
          || resolveExternalDraftPath(model, models, "external_dflash", {
            preferredPath: opts?.preferredDraftPath,
            currentPath:
              config[DFLASH_DRAFT_MODEL] != null
              && String(config[DFLASH_DRAFT_MODEL]).toLowerCase() !== "off"
                ? String(config[DFLASH_DRAFT_MODEL])
                : null,
            specType: cliType,
          });
        if (resolved) {
          updateParam(DFLASH_DRAFT_MODEL, resolved);
          saveDraftPairing(model.path, cliType, resolved);
        } else if (opts?.preferredDraftPath) {
          // Explicit path (Change draft) even if not scored as dflash role
          updateParam(DFLASH_DRAFT_MODEL, opts.preferredDraftPath);
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

  // Hydrate Agents / Memory / Think from resolved profile (not one-shot seed).
  useEffect(() => {
    if (!allParamsResolved.length) return;
    if (config.parallel == null && config.kv_quant == null && config.reasoning == null) {
      return;
    }
    const par = resolveParallelSlots(config, allParamsResolved);
    setCodingMode(codingModeFromParallel(par));
    setBrains(brainsFromKvQuant(config.kv_quant != null ? String(config.kv_quant) : undefined));
    const r = config.reasoning;
    if (r === "off" || r === 0 || r === "0") setThink("off");
    else if (r === 2000 || r === "2000") setThink("budget2k");
    else if (r === 4000 || r === "4000") setThink("budget");
    else if (r === 8000 || r === "8000") setThink("budget");
    else setThink("on");
  }, [allParamsResolved, config.parallel, config.kv_quant, config.reasoning]);

  useEffect(() => {
    boosterSeededRef.current = false;
  }, [effectiveBackendType, model?.path]);

  useEffect(() => {
    if (boosterSeededRef.current) return;
    if (!allParamsResolved.length) return;
    if (config.parallel == null && config.kv_quant == null && Object.keys(config).length === 0) {
      return;
    }
    const method = activeBoostMethodFromParams(allParamsResolved);
    if (method === "mtp" || method === "dflash" || method === "dspark") {
      setSpeedBoost(method);
    }
    else setSpeedBoost(fullAutoMode ? "smart" : "off");
    boosterSeededRef.current = true;
  }, [allParamsResolved, config, fullAutoMode, specDecodingGroupVisible]);

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
    if (plan.speed !== speedBoost) {
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
    setCodingMode,
    setSpeedBoost,
    setBrains,
    setThink,
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
