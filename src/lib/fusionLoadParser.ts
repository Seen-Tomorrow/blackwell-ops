export type LoadPhaseId = "spawn" | "weights" | "kv" | "server" | "ready";

export const LOAD_PHASE_ORDER: LoadPhaseId[] = ["spawn", "weights", "kv", "server", "ready"];

export const LOAD_PHASE_LABELS: Record<LoadPhaseId, string> = {
  spawn: "SPAWN",
  weights: "WEIGHTS",
  kv: "KV CACHE",
  server: "HTTP",
  ready: "READY",
};

export interface LoadParseResult {
  phase?: LoadPhaseId;
  layerCurrent?: number;
  layerTotal?: number;
  gpuIndex?: number;
  tickerLine?: string;
}

function sanitizeTicker(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, "").trim().slice(0, 120);
}

export function parseGpuMask(gpu: string): number[] {
  return gpu
    .split(/[,\s|]+/)
    .map((s) => parseInt(s.replace(/\D/g, ""), 10))
    .filter((n) => !Number.isNaN(n));
}

export function parseLoadLogLine(line: string): LoadParseResult {
  const lower = line.toLowerCase();
  const clean = sanitizeTicker(line);
  const result: LoadParseResult = {};

  if (clean.length > 0) {
    result.tickerLine = clean;
  }

  if (
    lower.includes("load_tensors")
    || lower.includes("loading model")
    || lower.includes("loading tensor")
    || lower.includes("llama_model_load")
    || lower.includes("offload")
    || lower.includes("tensor")
    || lower.includes("ggml_cuda")
  ) {
    result.phase = "weights";
  }

  const layerSlash = line.match(/(?:layer|blck)[^\d]*(\d+)\s*\/\s*(\d+)/i)
    ?? line.match(/(\d+)\s*\/\s*(\d+)\s*(?:layers|layer)/i);
  if (layerSlash) {
    result.layerCurrent = parseInt(layerSlash[1], 10);
    result.layerTotal = parseInt(layerSlash[2], 10);
    result.phase = "weights";
  } else {
    const blck = line.match(/blck\.(\d+)/i);
    if (blck) {
      result.layerCurrent = parseInt(blck[1], 10) + 1;
      result.phase = "weights";
    }
  }

  if (
    lower.includes("kv cache")
    || lower.includes("llama_kv")
    || lower.includes("cache init")
    || lower.includes("kv_cache")
  ) {
    result.phase = "kv";
  }

  if (
    lower.includes("http server listening")
    || lower.includes("server is listening")
    || lower.includes("http server is listening")
  ) {
    result.phase = "server";
  }

  if (lower.includes("readiness=") || lower.includes("engine ready")) {
    result.phase = "ready";
  }

  const cudaDev =
    line.match(/cuda[:\s]*(\d+)/i)
    ?? line.match(/gpu\s*(\d+)/i)
    ?? line.match(/device\s*(\d+)/i)
    ?? line.match(/offload.*?(\d+)/i);
  if (cudaDev) {
    result.gpuIndex = parseInt(cudaDev[1], 10);
  }

  const tensorGpu = line.match(/tensor.*?cuda:(\d+)/i);
  if (tensorGpu) {
    result.gpuIndex = parseInt(tensorGpu[1], 10);
  }

  if (!result.phase && clean.length > 8) {
    result.phase = "spawn";
  }

  return result;
}

export function maxPhase(a: LoadPhaseId, b: LoadPhaseId): LoadPhaseId {
  return LOAD_PHASE_ORDER.indexOf(a) >= LOAD_PHASE_ORDER.indexOf(b) ? a : b;
}