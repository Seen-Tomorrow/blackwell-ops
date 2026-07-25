/** AtomCode external coding harness — thin client types for Tauri commands. */

export interface AtomcodeStatus {
  installed: boolean;
  exePath: string;
  homePath: string;
  version: string | null;
  pinnedVersion: string;
  disclaimerAccepted: boolean;
  lastProject: string | null;
}

export interface AtomcodeEngineRef {
  port: number;
  /** Must match engine launch alias (OpenAI /v1 model id). */
  model: string;
  contextWindow?: number;
}

export interface AtomcodeLaunchRequest {
  mode: "solo" | "brain_workers";
  primary: AtomcodeEngineRef;
  worker?: AtomcodeEngineRef;
  maxConcurrent: number;
  projectDir: string;
}

export interface AtomcodeLaunchResult {
  exePath: string;
  configPath: string;
  projectDir: string;
  mode: string;
}

export const ATOMCODE_DISCLAIMER = [
  "AtomCode is a third-party coding agent (Rust binary).",
  "Blackwell downloads it into the app tools folder (~30 MB) — separate from any AtomCode you installed yourself.",
  "It can read/write files and run shell commands inside the project folder you choose.",
  "Telemetry is disabled on our launches; we do not auto-update the tool without your action.",
  "Never runs with auto-approve permissions from this app.",
].join("\n\n");

/** Weights label only (no .gguf, no ENGINE-N). Backend still re-formats as BRAIN · … */
export function atomcodeWeightsLabel(
  modelName?: string | null,
  modelPath?: string | null,
  fallback?: string | null,
): string {
  const raw = (modelName || modelPath || fallback || "").trim();
  if (!raw) return "";
  const base = raw.replace(/^.*[/\\]/, "");
  const bare = base.replace(/\.gguf$/i, "").trim();
  const upper = bare.toUpperCase();
  if (
    !bare ||
    upper === "BRAIN" ||
    upper === "WORKER" ||
    upper === "NONE" ||
    upper === "LOCAL-MODEL" ||
    /^ENGINE-\d+$/i.test(bare) ||
    /^SLOT-\d+$/i.test(bare)
  ) {
    return "";
  }
  return bare;
}
