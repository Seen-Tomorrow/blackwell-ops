/** Qwen Code external coding harness — thin client types for Tauri commands. */

export interface QwenCodeStatus {
  installed: boolean;
  launcherPath: string;
  homePath: string;
  version: string | null;
  pinnedVersion: string;
  disclaimerAccepted: boolean;
  lastProject: string | null;
}

export interface QwenEngineRef {
  port: number;
  /** Must match engine launch alias (OpenAI /v1 model id). */
  model: string;
  contextWindow?: number;
}

export interface QwenLaunchRequest {
  mode: "solo" | "brain_workers";
  primary: QwenEngineRef;
  worker?: QwenEngineRef;
  projectDir: string;
}

export interface QwenLaunchResult {
  launcherPath: string;
  settingsPath: string;
  projectDir: string;
  mode: string;
  homePath: string;
}

export const QWEN_CODE_DISCLAIMER = [
  "Qwen Code is a third-party coding agent (Node standalone pack with embedded runtime).",
  "Blackwell installs it under external-tools/qwen-code/ (~180 MB) — not npm, not on PATH.",
  "It can read/write files and run shell commands inside the project folder you choose.",
  "Config is isolated under config/external-tools/qwencode-home (QWEN_HOME) — never your global ~/.qwen unless you opt in later.",
  "Native multimodal (image paste) is enabled when pointing at vision-capable local engines.",
].join("\n\n");
