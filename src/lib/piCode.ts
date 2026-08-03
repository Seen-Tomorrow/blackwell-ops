/** pi coding agent external harness — thin client types for Tauri commands. */

export interface PiCodeStatus {
  installed: boolean;
  launcherPath: string;
  homePath: string;
  version: string | null;
  pinnedVersion: string;
  disclaimerAccepted: boolean;
  lastProject: string | null;
}

export interface PiEngineRef {
  port: number;
  /** Must match engine launch alias (OpenAI /v1 model id). */
  model: string;
  contextWindow?: number;
}

export interface PiLaunchRequest {
  mode: "solo" | "brain_workers";
  primary: PiEngineRef;
  worker?: PiEngineRef;
  projectDir: string;
}

export interface PiLaunchResult {
  launcherPath: string;
  modelsPath: string;
  projectDir: string;
  mode: string;
  homePath: string;
}

export const PI_CODE_DISCLAIMER = [
  "pi is a third-party coding agent (Bun-compiled standalone Windows binary).",
  "Blackwell installs it under external-tools/pi/ (pi-windows-x64.zip, ~46 MB download) — not npm, not on PATH.",
  "It can read/write files and run shell commands inside the project folder you choose.",
  "Config is isolated under config/external-tools/pi-home (PI_CODING_AGENT_DIR) — never your global ~/.pi unless you opt in later.",
  "Local-only: points at your Blackwell engines (BRAIN/WORKER); no cloud keys.",
].join("\n\n");
