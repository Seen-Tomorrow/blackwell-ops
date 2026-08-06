/**
 * Pure launch builder — template + profile + policy + FIT snapshot → EngineConfig.
 *
 * No React. No EngineConfigPanel. Covered by unit tests (leakage cases).
 *
 * Convergence point for former buildLaunchFullConfig + key filter + Smart batch inject.
 */

import type {
  ConfigViewMode,
  EngineConfig,
  GpuInfo,
  ModelEntry,
  UserEditedTemplateParam,
  VramManifest,
} from "./types";
import { buildAutoVramLaunchParams } from "./autoVramLaunch";
import { buildLaunchExtraParams, resolveParamDefaultValue } from "./paramConfigResolve";
import {
  type LaunchPolicy,
  type LaunchPolicyId,
  filterValuesToKeySet,
  getLaunchPolicy,
  mergeLaunchValues,
  applyBatchPolicy,
  resolveLaunchKeySet,
  resolveLaunchPolicyId,
  resolveSmartBatchPush,
} from "./launchPolicy";
import {
  type SpecBoostMethod,
  buildSpecCliExtraParams,
  activeBoostMethodFromParams,
  isAnySpecProfileActive,
  SPEC_CLI_TYPE,
  SPEC_CLI_N_MAX,
  SPEC_CLI_N_MIN,
  SPEC_CLI_P_MIN,
  SPEC_CLI_DRAFT,
  SPEC_PROFILE_PARAM_KEYS,
} from "./specProfiles";
import { pickHighNumeric } from "./multiAgentBooster";
import type { RunningSlotInfo } from "../services/vram/scenarios/scenarios_factory";

const SPEC_CLI_KEYS = new Set([
  SPEC_CLI_TYPE,
  SPEC_CLI_N_MAX,
  SPEC_CLI_N_MIN,
  SPEC_CLI_P_MIN,
  SPEC_CLI_DRAFT,
  ...SPEC_PROFILE_PARAM_KEYS,
]);

function stripAllSpecKeys(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (SPEC_CLI_KEYS.has(k) || k.startsWith("mtp_") || k.startsWith("dflash_")) continue;
    if (k === "spec_type" || k.startsWith("spec_draft")) continue;
    out[k] = v;
  }
  return out;
}

/** Factory default map from template rows (key → defaultValue / first value). */
export function factoryDefaultsFromParams(
  params: UserEditedTemplateParam[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    if (p.hidden && !p.key.startsWith("mtp_") && !p.key.startsWith("dflash_")) continue;
    const d = resolveParamDefaultValue(p);
    if (d !== undefined) out[p.key] = d;
  }
  return out;
}

export type BuildLaunchConfigInput = {
  model: ModelEntry;
  finalAlias: string;
  /** Mode-specific durable profile values (not another mode's bag). */
  profileValues: Record<string, unknown>;
  /**
   * Live merged config from the panel (profile + cockpit UI).
   * Used as profileValues when profileValues omitted, and for cockpitLive.
   */
  config?: Record<string, unknown>;
  policy: LaunchPolicy;
  /** When true and policy.batch=smart_push, inject high batch/ubatch for this launch only. */
  smartBatchPush?: boolean;
  effectiveBackendType: string;
  selectedBinaryProfile: string;
  /** Provider supports FIT/auto-vram path. */
  fitLaunchSupported: boolean;
  essentialFactoryKeys: Set<string>;
  /** Product Boost method; if omitted, derived from visible profile groups. */
  specMethod?: SpecBoostMethod;
  allParamsResolved: UserEditedTemplateParam[];
  gpus: GpuInfo[];
  runningSlotsForPlan: RunningSlotInfo[];
  vramManifest: VramManifest | null;
  testFlagsEnabled: boolean;
  testFlags: string;
  testFlagsMode: "replace" | "add";
};

/**
 * Build the EngineConfig payload sent to `launch_engine` (port resolved on backend).
 */
export function buildLaunchConfig(input: BuildLaunchConfigInput): EngineConfig {
  const {
    model,
    finalAlias,
    policy,
    smartBatchPush = false,
    effectiveBackendType,
    selectedBinaryProfile,
    fitLaunchSupported,
    essentialFactoryKeys,
    specMethod: specMethodIn,
    allParamsResolved,
    gpus,
    runningSlotsForPlan,
    vramManifest,
    testFlagsEnabled,
    testFlags,
    testFlagsMode,
  } = input;

  const factoryDefaults = factoryDefaultsFromParams(allParamsResolved);
  const profileValues = input.profileValues ?? input.config ?? {};
  const cockpitLive = input.config ?? profileValues;

  const method: SpecBoostMethod =
    specMethodIn
    ?? (isAnySpecProfileActive(allParamsResolved)
      ? activeBoostMethodFromParams(allParamsResolved)
      : "off");

  // 1–4. Merge layers (factory → Joe fallbacks → profile → cockpit)
  let merged = mergeLaunchValues({
    policy,
    factoryDefaults,
    profileValues,
    cockpitLive,
  });

  // batch/ubatch policy: factory (Joe Smart safe) | profile | smart_push (future)
  merged = applyBatchPolicy({ policy, merged, factoryDefaults });
  if (policy.batch === "smart_push" && smartBatchPush) {
    const batchDef = allParamsResolved.find((p) => p.key === "batch");
    const ubatchDef = allParamsResolved.find((p) => p.key === "ubatch");
    const push = resolveSmartBatchPush({
      policy,
      pushBatch: true,
      batchValues: batchDef?.values,
      ubatchValues: ubatchDef?.values,
      pickHigh: pickHighNumeric,
    });
    if (push.batch != null) merged.batch = push.batch;
    if (push.ubatch != null) merged.ubatch = push.ubatch;
  }

  const launchKeys = resolveLaunchKeySet({
    policy,
    essentialFactoryKeys,
    specActive: method !== "off",
    allParams: allParamsResolved,
  }).filter((k) => !SPEC_CLI_KEYS.has(k) && !k.startsWith("mtp_") && !k.startsWith("dflash_"));

  // Only emit allowed keys from the merged bag
  const filteredConfig = filterValuesToKeySet(merged, launchKeys);
  // Keep full merged for FIT topology reads when user_chrome (device/split from profile)
  const fitConfig =
    policy.topology === "fit_owned"
      ? { ...filteredConfig, offload_mode: "regular" }
      : { ...merged, ...filteredConfig };

  const fullAutoMode = policy.id === "full_auto";

  const extraParams: Record<string, unknown> =
    fitLaunchSupported && model.metadata
      ? buildAutoVramLaunchParams({
          config: fitConfig,
          launchKeys,
          paramDefs: allParamsResolved,
          gpus,
          runningSlots: runningSlotsForPlan,
          manifest: vramManifest,
          weightGb: model.metadata.file_size_bytes / 1024 ** 3,
          fullAutoMode,
          memoryMode: fullAutoMode ? "full_auto" : "assisted",
        })
      : buildLaunchExtraParams({
          config: filteredConfig,
          keys: launchKeys,
          paramDefs: allParamsResolved,
        });

  let launchExtra = stripAllSpecKeys(extraParams);
  if (method !== "off") {
    launchExtra = {
      ...launchExtra,
      ...buildSpecCliExtraParams(method, { ...merged, ...filteredConfig }, allParamsResolved),
    };
  }

  const parallelRaw = filteredConfig.parallel ?? launchExtra.parallel ?? merged.parallel ?? 1;
  const parallelN = Math.max(1, Number(parallelRaw) || 1);

  const fullConfig: EngineConfig = {
    alias: finalAlias,
    model_path: model.path,
    port: 0,
    backend_type: effectiveBackendType,
    binary_profile: selectedBinaryProfile,
    extra_params: {
      ...launchExtra,
      parallel: parallelN,
      __memory_mode: fullAutoMode ? "full_auto" : "assisted",
      __launch_policy: policy.id,
    },
  };

  if (testFlagsEnabled && testFlags.trim()) {
    const testArgs = testFlags.trim().split(/\s+/).filter(Boolean);
    fullConfig.extra_params =
      testFlagsMode === "replace"
        ? { __test_args: testArgs }
        : { ...fullConfig.extra_params, __test_args_add: testArgs };
  }

  return fullConfig;
}

// ── Convenience: resolve policy from UI flags + build ───────────────────────

export type BuildLaunchConfigFromUiInput = Omit<BuildLaunchConfigInput, "policy" | "profileValues"> & {
  fullAutoMode: boolean;
  configView: ConfigViewMode;
  /** Live panel config (active profile + cockpit). */
  config: Record<string, unknown>;
  policyId?: LaunchPolicyId;
  smartBatchPush?: boolean;
};

/** Thin adapter for call sites that still pass fullAutoMode + configView. */
export function buildLaunchConfigFromUi(input: BuildLaunchConfigFromUiInput): EngineConfig {
  const policyId =
    input.policyId
    ?? resolveLaunchPolicyId({
      fullAutoMode: input.fullAutoMode,
      configView: input.configView,
    });
  const policy = getLaunchPolicy(policyId);
  return buildLaunchConfig({
    ...input,
    policy,
    profileValues: input.config,
    smartBatchPush: input.smartBatchPush,
  });
}
