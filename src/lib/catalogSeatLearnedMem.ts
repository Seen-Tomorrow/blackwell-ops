/**
 * Re-read measured LEARNED VRAM/RAM for a catalog seat bag.
 * Spec identity follows Boost (MTP → draft-mtp) — bag often omits spec_type.
 */
import { invoke } from "@tauri-apps/api/core";
import { boostMethodFromSeat, type LaunchSeat } from "./launchPresets";
import { cliSpecTypeForMethod } from "./specProfiles";
import { DEFAULT_PROVIDER_ID } from "./types";

export type LearnedMemGb = {
  vramGb: number;
  ramGb: number;
};

type LearnedHit = {
  vram_mib?: number;
  host_mib?: number;
  launch_snapshot?: { vram_mib?: number; host_mib?: number };
};

/** Numeric part of the VRAM chip; the unit word is rendered in JSX. */
export function vramValueText(m: LearnedMemGb | null | undefined): string {
  return m ? m.vramGb.toFixed(1) : "—";
}

/** Numeric part of the RAM chip; null when host RAM is negligible (chip hidden). */
export function ramValueText(m: LearnedMemGb | null | undefined): string | null {
  if (!m || m.ramGb <= 0.05) return null;
  return m.ramGb.toFixed(1);
}

export function sumLearnedMem(
  a: LearnedMemGb | null | undefined,
  b: LearnedMemGb | null | undefined,
): LearnedMemGb | null {
  if (!a && !b) return null;
  return {
    vramGb: (a?.vramGb ?? 0) + (b?.vramGb ?? 0),
    ramGb: (a?.ramGb ?? 0) + (b?.ramGb ?? 0),
  };
}

function specTypeForSeat(seat: LaunchSeat): string {
  const raw = String(seat.paramOverrides?.spec_type ?? "").trim().toLowerCase();
  if (raw && raw !== "none" && raw !== "off") return raw;
  return cliSpecTypeForMethod(boostMethodFromSeat(seat)) ?? "";
}

export async function fetchLearnedMemForSeat(seat: LaunchSeat): Promise<LearnedMemGb | null> {
  const o = seat.paramOverrides ?? {};
  const specType = specTypeForSeat(seat);
  const draft = String(o.dflash_draft_model || o.spec_draft_model || "").trim() || null;
  try {
    const entry = await invoke<LearnedHit | null>("get_learned_vram", {
      modelPath: seat.modelPath,
      providerId: seat.providerId || DEFAULT_PROVIDER_ID,
      ctx: String(o.ctx ?? "32768"),
      kvQuant: String(o.kv_quant ?? "f16"),
      device: String(o.device ?? "GPU-0"),
      split: String(o.split ?? "none"),
      memoryMode: seat.policyId === "full_auto" ? "full_auto" : "assisted",
      offloadMode: String(o.offload_mode ?? "regular"),
      specType,
      cacheRam: String(o.cache_ram ?? "0"),
      draftModel: draft,
      vramTopo: null,
    });
    const vram = entry?.vram_mib ?? entry?.launch_snapshot?.vram_mib;
    if (vram == null || vram <= 0) return null;
    const host = entry?.host_mib ?? entry?.launch_snapshot?.host_mib ?? 0;
    return { vramGb: vram / 1024, ramGb: Math.max(0, host) / 1024 };
  } catch {
    return null;
  }
}
