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
  /** Engine `--parallel` slot count (concurrent subagent capacity). */
  parallel?: number;
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
  "Blackwell installs the binary under external-tools/pi/ (~46 MB) — not npm, not on PATH.",
  "Config is isolated under config/external-tools/pi-home via PI_CODING_AGENT_DIR (not ~/.pi, not ~/.config/pi).",
  "Multi-agent (SOLO ×N or TWIN BRAIN+WORKER) uses the bundled pi-subagents package shipped as app pi-ext/ — synced into pi-home on connect.",
  "It can read/write files and run shell commands inside the project folder you choose. Local engines only; no cloud keys.",
].join("\n\n");
