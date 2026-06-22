import { invoke } from "@tauri-apps/api/core";

export interface DebugFlags {
  disableFusionPoll: boolean;
  disableIpcEmit: boolean;
  disableFrontendPoll: boolean;
  disableDiskIo: boolean;
  telemetryTickMs: number;
  fusionIdlePollMs: number;
}

const DEFAULT_FLAGS: DebugFlags = {
  disableFusionPoll: false,
  disableIpcEmit: false,
  disableFrontendPoll: false,
  disableDiskIo: false,
  telemetryTickMs: 25,
  fusionIdlePollMs: 2500,
};

let cached: DebugFlags = DEFAULT_FLAGS;
let loaded = false;

export async function initDebugFlags(): Promise<DebugFlags> {
  if (loaded) return cached;
  try {
    cached = await invoke<DebugFlags>("get_debug_flags");
  } catch {
    cached = DEFAULT_FLAGS;
  }
  loaded = true;
  if (cached.disableFrontendPoll || cached.disableIpcEmit || cached.disableFusionPoll) {
    console.warn("[debug] bisect flags", cached);
  }
  return cached;
}

export function getDebugFlags(): DebugFlags {
  return cached;
}

export function frontendPollEnabled(): boolean {
  return !cached.disableFrontendPoll;
}