import type {
  ConfigViewMode,
  EngineConfig,
  GpuInfo,
  ModelEntry,
  UserEditedTemplateParam,
  VramManifest,
} from "./types";
import { buildAutoVramLaunchParams } from "./autoVramLaunch";
import { buildLaunchExtraParams } from "./paramConfigResolve";
import { resolveManualLaunchKeys } from "./launchProfile";
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
import type { RunningSlotInfo } from "../services/vram/scenarios/scenarios_factory";

export type BuildLaunchFullConfigInput = {
  model: ModelEntry;
  finalAlias: string;
  config: Record<string, unknown>;
  effectiveBackendType: string;
  selectedBinaryProfile: string;
  fitLaunchSupported: boolean;
  fullAutoMode: boolean;
  configView: ConfigViewMode;
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

/** Same EngineConfig payload the app sends to `launch_engine` (port resolved on backend). */
export function buildLaunchFullConfig(input: BuildLaunchFullConfigInput): EngineConfig {
  const {
    model,
    finalAlias,
    config,
    effectiveBackendType,
    selectedBinaryProfile,
    fitLaunchSupported,
    fullAutoMode,
    configView,
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

  const method: SpecBoostMethod =
    specMethodIn
    ?? (isAnySpecProfileActive(allParamsResolved)
      ? activeBoostMethodFromParams(allParamsResolved)
      : "off");

  const launchKeys = resolveManualLaunchKeys({
    configView,
    essentialFactoryKeys,
    specActive: method !== "off",
    allParams: allParamsResolved,
  }).filter((k) => !SPEC_CLI_KEYS.has(k) && !k.startsWith("mtp_") && !k.startsWith("dflash_"));

  const extraParams: Record<string, unknown> =
    fitLaunchSupported && model.metadata
      ? buildAutoVramLaunchParams({
          config,
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
          config,
          keys: launchKeys,
          paramDefs: allParamsResolved,
        });

  let launchExtra = stripAllSpecKeys(extraParams);
  if (method !== "off") {
    launchExtra = {
      ...launchExtra,
      ...buildSpecCliExtraParams(method, config, allParamsResolved),
    };
  }

  const parallelRaw = config.parallel ?? launchExtra.parallel ?? 1;
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
