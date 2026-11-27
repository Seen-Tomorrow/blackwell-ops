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
import { buildLaunchConfigFromUi, type LayerPlacement } from "./buildLaunchConfig";
import type { SpecBoostMethod } from "./specProfiles";
import type { DflashVariant } from "./spec/adapters";
import type { RunningSlotInfo } from "../services/vram/shared";

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
  /** Exact DFlash-family variant auto-detected from the selected draft GGUF. */
  dflashVariant?: DflashVariant;
  allParamsResolved: UserEditedTemplateParam[];
  gpus: GpuInfo[];
  runningSlotsForPlan: RunningSlotInfo[];
  vramManifest: VramManifest | null;
  testFlagsEnabled: boolean;
  testFlags: string;
  testFlagsMode: "replace" | "add";
  /** App-owned layer placement; ignored unless the launch splits layers on 2+ GPUs. */
  placement?: LayerPlacement;
  /** When true and Full Auto Smart, inject high batch/ubatch for this launch only. */
  smartBatchPush?: boolean;
  excludedAutoSplitGpus?: number[];
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
    dflashVariant: input.dflashVariant,
    allParamsResolved: input.allParamsResolved,
    gpus: input.gpus,
    runningSlotsForPlan: input.runningSlotsForPlan,
    vramManifest: input.vramManifest,
    testFlagsEnabled: input.testFlagsEnabled,
    testFlags: input.testFlags,
    testFlagsMode: input.testFlagsMode,
    placement: input.placement,
    smartBatchPush: input.smartBatchPush,
    excludedAutoSplitGpus: input.excludedAutoSplitGpus,
  });
}
