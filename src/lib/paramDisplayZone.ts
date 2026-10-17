/** Params rendered outside the scroll groups (GpuAssignPanel, launch dock, MOE badge). */
export const PANEL_CHROME_PARAM_KEYS = new Set([
  "device",
  "split",
  "base_port",
  "offload_mode",
  /** CTX is cockpit strip / dock — not a group chip. */
  "ctx",
]);
