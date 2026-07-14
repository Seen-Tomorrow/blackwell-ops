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
import { stripSpecExtraParams } from "./specDraft";
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
  specActive: boolean;
  allParamsResolved: UserEditedTemplateParam[];
  gpus: GpuInfo[];
  runningSlotsForPlan: RunningSlotInfo[];
  vramManifest: VramManifest | null;
  testFlagsEnabled: boolean;
  testFlags: string;
  testFlagsMode: "replace" | "add";
};

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
    specActive,
    allParamsResolved,
    gpus,
    runningSlotsForPlan,
    vramManifest,
    testFlagsEnabled,
    testFlags,
    testFlagsMode,
  } = input;

  const launchKeys = resolveManualLaunchKeys({
    configView,
    essentialFactoryKeys,
    specActive,
    allParams: allParamsResolved,
  });

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

  const launchExtra = specActive
    ? extraParams
    : stripSpecExtraParams(extraParams);

  const fullConfig: EngineConfig = {
    alias: finalAlias,
    model_path: model.path,
    port: 0,
    backend_type: effectiveBackendType,
    binary_profile: selectedBinaryProfile,
    extra_params: {
      ...launchExtra,
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