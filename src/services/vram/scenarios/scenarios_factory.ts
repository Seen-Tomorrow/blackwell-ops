/**
 * Compat surface — implementation lives in ../shared + ../forecast.
 * Formula scenarios archived under tmp/archive_vram_formula/.
 *
 * NOTE: Do not mix `type` keywords inside value `export { ... } from` lists —
 * Vite/Rolldown can emit an empty module (black screen / Invalid token).
 */
export {
  CUDA_RUNTIME_OVERHEAD_CAP_MIB,
  isVramCommittedSlot,
  committedSlotsFromStack,
  committedStackKey,
  parseCtx,
  kvBytesForQuant,
  adjustMeasuredGbForCtx,
  interpolateLearnedCurveGb,
  gpuManufacturedMib,
  getRunningEnginesOnGpu,
  splitGpuTopoBarUsage,
  computeGpuAvailableList,
  findFitPoint,
  extrapolateVramFromPoints,
  round2,
  cfgStr,
  buildGpuAllocations,
  FREE_POOL_OOM_CAUTION,
  FREE_POOL_OOM_WARN,
  freePoolHeadroomGb,
  freePoolUtil,
  freePoolOomTier,
  launchPaintFromGate,
  needToneFromLaunchPaint,
  barStyleFromNeedTone,
} from "../shared";

export type {
  FitPoint,
  RunningSlotInfo,
  ForecastLaunchPaint,
  ForecastNeedTone,
} from "../shared";
export type { ForecastInput as ScenarioInput } from "../forecast/types";
export { evaluate } from "../forecast/evaluate";
