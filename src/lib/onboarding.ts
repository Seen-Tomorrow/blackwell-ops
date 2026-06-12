/** Library VRAM fit scan parallelism — onboarding + provider SCAN LIBRARY menu. */
export const FIT_SCAN_PARALLEL_OPTIONS = [8, 16] as const;

/** Portable LM Studio models path stored in app_config (expanded by Rust at runtime). */
export const LM_STUDIO_MODEL_PATH_TEMPLATE =
  typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent)
    ? "%USERPROFILE%\\.lmstudio\\models"
    : "~/.lmstudio/models";