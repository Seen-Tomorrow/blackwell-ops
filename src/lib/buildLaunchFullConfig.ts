/**
 * @deprecated Prefer `buildLaunchConfig` / `buildLaunchConfigFromUi` from `./buildLaunchConfig`.
 * Kept as a thin adapter so existing call sites keep working during the policy refactor.
 */

import type {
  ConfigViewMode,
  EngineConfig,
  GpuInfo,
  ModelEntry,
  UserEditedTemplateParam,
  VramManifest,
} from "./types";
import { buildLaunchConfigFromUi } from "./buildLaunchConfig";
import type { SpecBoostMethod } from "./specProfiles";
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
  /** When true and Full Auto Smart, inject high batch/ubatch for this launch only. */
  smartBatchPush?: boolean;
};

/** Same EngineConfig payload the app sends to `launch_engine` (port resolved on backend). */
export function buildLaunchFullConfig(input: BuildLaunchFullConfigInput): EngineConfig {
  return buildLaunchConfigFromUi({
    model: input.model,
    finalAlias: input.finalAlias,
    config: input.config,
    effectiveBackendType: input.effectiveBackendType,
    selectedBinaryProfile: input.selectedBinaryProfile,
    fitLaunchSupported: input.fitLaunchSupported,
    fullAutoMode: input.fullAutoMode,
    configView: input.configView,
    essentialFactoryKeys: input.essentialFactoryKeys,
    specMethod: input.specMethod,
    allParamsResolved: input.allParamsResolved,
    gpus: input.gpus,
    runningSlotsForPlan: input.runningSlotsForPlan,
    vramManifest: input.vramManifest,
    testFlagsEnabled: input.testFlagsEnabled,
    testFlags: input.testFlags,
    testFlagsMode: input.testFlagsMode,
    smartBatchPush: input.smartBatchPush,
  });
}
