/**
 * Boost → template profile visibility (absolute, not toggle).
 * One profile on at a time; Off hides both.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig } from "./types";
import {
  type SpecBoostMethod,
  SPEC_PROFILE_DFLASH,
  SPEC_PROFILE_MTP,
  groupForBoostMethod,
} from "./specProfiles";
import { dispatchAppEvent, EVENTS } from "./events";

export async function applySpecBoostProfiles(opts: {
  providerId: string;
  method: SpecBoostMethod;
  setProviders?: (p: ProviderConfig[]) => void;
}): Promise<void> {
  const { providerId, method, setProviders } = opts;
  const active = groupForBoostMethod(method);

  // Absolute hide/show — no toggle race.
  await invoke("set_group_hidden", {
    providerId,
    groupId: SPEC_PROFILE_MTP,
    hidden: active !== SPEC_PROFILE_MTP,
  });
  await invoke("set_group_hidden", {
    providerId,
    groupId: SPEC_PROFILE_DFLASH,
    hidden: active !== SPEC_PROFILE_DFLASH,
  });

  try {
    const data = await invoke<ProviderConfig[]>("list_providers");
    if (data.length > 0) setProviders?.(data);
  } catch {
    /* event fallback */
  }
  dispatchAppEvent(EVENTS.reloadProviders);
  dispatchAppEvent(EVENTS.paramConfigChanged);
}
