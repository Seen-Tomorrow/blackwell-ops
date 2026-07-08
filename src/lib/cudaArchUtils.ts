import type { BuildInfo, ProviderConfig } from "./types";

/** Foundry build targets — matches shipping sm_86 / sm_89 / sm_120 matrix. */
export const CUDA_ARCH_BUILD_OPTIONS = [
  { code: "86", label: "Ampere", hint: "RTX 30xx · A100 · A40" },
  { code: "89", label: "Ada Lovelace", hint: "RTX 40xx · L40 · L4" },
  { code: "120", label: "Blackwell", hint: "RTX 50xx · RTX PRO 6000" },
] as const;

/** Default when factory build_profile omits CMAKE_CUDA_ARCHITECTURES (full ship matrix). */
export const DEFAULT_CUDA_ARCH_CODES = CUDA_ARCH_BUILD_OPTIONS.map((o) => o.code);

/** Provider cmake base — no CMAKE_CUDA_ARCHITECTURES (selected in Foundry modal). */
export const DEFAULT_FOUNDRY_CMAKE_BASE = [
  "-DGGML_CUDA=ON",
  "-DGGML_CUDA_PEER_TO_PEER=ON",
  "-DGGML_CUDA_FA_ALL_QUANTS=ON",
  "-DGGML_AVX512=ON",
  "-DGGML_NATIVE=ON",
  '-DCMAKE_CUDA_FLAGS="-Xcompiler /wd4056 -Xcompiler /wd4756 --diag-suppress 221"',
  "-Wno-dev",
].join("\n");

/** NVIDIA GPU generation labels for CMAKE_CUDA_ARCHITECTURES codes. */
const CUDA_ARCH_FAMILY: Record<string, string> = {
  "70": "TURING",
  "72": "TURING",
  "75": "TURING",
  "80": "AMPERE",
  "86": "AMPERE",
  "87": "AMPERE",
  "89": "ADA",
  "90": "HOPPER",
  "100": "BLACKWELL",
  "101": "BLACKWELL",
  "103": "BLACKWELL",
  "120": "BLACKWELL",
};

export function stripCudaArchitecturesFromCmake(flags: string): string {
  return flags
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/-D\s*CMAKE_CUDA_ARCHITECTURES\s*=/i.test(line))
    .join("\n")
    .trim();
}

export function formatCudaArchitecturesCmakeLine(codes: string[]): string {
  const ordered = orderCudaArchCodes(codes);
  if (ordered.length === 0) return "";
  return `-DCMAKE_CUDA_ARCHITECTURES="${ordered.join(";")}"`;
}

/** Insert arch line immediately after `-DGGML_CUDA=ON` when present. */
export function mergeBuildProfileWithArchitectures(baseFlags: string, archCodes: string[]): string {
  const archLine = formatCudaArchitecturesCmakeLine(archCodes);
  const stripped = stripCudaArchitecturesFromCmake(baseFlags.trim());
  if (!archLine) return stripped;

  const lines = stripped.split("\n").map((l) => l.trim()).filter(Boolean);
  const cudaIdx = lines.findIndex((l) => /-D\s*GGML_CUDA\s*=\s*ON/i.test(l));
  if (cudaIdx >= 0) {
    lines.splice(cudaIdx + 1, 0, archLine);
  } else {
    lines.unshift("-DGGML_CUDA=ON", archLine);
  }
  return lines.join("\n");
}

export function orderCudaArchCodes(codes: string[]): string[] {
  const set = new Set(codes.map((c) => c.trim()).filter(Boolean));
  return CUDA_ARCH_BUILD_OPTIONS.map((o) => o.code).filter((c) => set.has(c));
}

export function resolveSelectedCudaArchitectures(flags: string): string[] {
  const parsed = orderCudaArchCodes(parseCudaArchitecturesFromCmake(flags));
  return parsed.length > 0 ? parsed : [...DEFAULT_CUDA_ARCH_CODES];
}

export function parseCudaArchitecturesFromCmake(flags: string): string[] {
  if (!flags.trim()) return [];
  const match =
    flags.match(/-D\s*CMAKE_CUDA_ARCHITECTURES\s*=\s*"([^"]+)"/i) ??
    flags.match(/-D\s*CMAKE_CUDA_ARCHITECTURES\s*=\s*([^\s\\]+)/i);
  if (!match?.[1]) return [];
  return match[1]
    .split(";")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

export function cudaArchFamily(code: string): string {
  const normalized = code.trim().toLowerCase();
  const numeric = normalized.replace(/[^0-9]/g, "");
  return CUDA_ARCH_FAMILY[normalized] ?? CUDA_ARCH_FAMILY[numeric] ?? "CUDA";
}

/** Unique generation names in cmake order — e.g. ["AMPERE", "ADA", "BLACKWELL"]. */
export function cudaArchFamilies(codes: string[]): string[] {
  const seen = new Set<string>();
  const families: string[] = [];
  for (const code of codes) {
    const family = cudaArchFamily(code);
    if (!seen.has(family)) {
      seen.add(family);
      families.push(family);
    }
  }
  return families;
}

/** Inline nerd hint — "optimized for AMPERE/ADA/BLACKWELL", or null if unknown. */
export function cudaArchOptimizedLabel(codes: string[]): string | null {
  const families = cudaArchFamilies(codes);
  if (families.length === 0) return null;
  return `optimized for ${families.join("/")}`;
}

/** Stored per-profile arch list, else parse from provider cmake flags. */
export function resolveProfileCudaArchitectures(
  provider: ProviderConfig,
  buildInfo?: BuildInfo,
): string[] {
  const stored = buildInfo?.cudaArchitectures?.filter(Boolean);
  if (stored && stored.length > 0) return stored;
  return parseCudaArchitecturesFromCmake(provider.build_profile ?? "");
}