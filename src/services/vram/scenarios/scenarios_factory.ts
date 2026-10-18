/**
 * Compat surface — implementation lives in ../shared + ../forecast.
 * Formula scenarios archived under tmp/archive_vram_formula/.
 *
 * NOTE: Do not mix `type` keywords inside value `export { ... } from` lists —
 * Vite/Rolldown can emit an empty module (black screen / Invalid token).
 */
export {
  isVramCommittedSlot,
  committedSlotsFromStack,
  committedStackKey,
  parseCtx,
  splitGpuTopoBarUsage,
  computeGpuAvailableList,
} from "../shared";

export type {
  FitPoint,
  RunningSlotInfo,
} from "../shared";
export type { ForecastInput as ScenarioInput } from "../forecast/types";
export { evaluate } from "../forecast/evaluate";
