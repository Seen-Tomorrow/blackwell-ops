import type { BuildInfo, ProviderConfig } from "./types";

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