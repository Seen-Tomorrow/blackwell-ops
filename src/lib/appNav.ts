import type { Tab } from "../App";
import { isDevBuild } from "./build";

/** Top-level header destinations (segment primary rail). */
export type PrimaryNavId = "operations" | "downloads" | "remote" | "config" | "foundry";

/** FOUNDRY page sections. */
export type FoundrySubTab = "build" | "cache" | "log";

export const FOUNDRY_SUB_NAV: { id: FoundrySubTab; label: string }[] = [
  { id: "build", label: "BUILD" },
  { id: "cache", label: "CACHE" },
  { id: "log", label: "LOG" },
];

/** REMOTE page sections — grows as the servicing surface grows. */
export type RemoteSubTab = "status" | "devices";

export const REMOTE_SUB_NAV: { id: RemoteSubTab; label: string }[] = [
  { id: "status", label: "STATUS" },
  { id: "devices", label: "DEVICES" },
];

/** CONFIG page sections (header sub-rail when primary = CONFIG). */
export type DownloadsSubTab = "models" | "software";

/** DOWNLOADS sections (header sub-rail when primary = DOWNLOADS). */
export const DOWNLOADS_SUB_NAV: { id: DownloadsSubTab; label: string }[] = [
  { id: "models", label: "MODELS" },
  { id: "software", label: "SOFTWARE" },
];

export type ConfigSubTab =
  | "providers"
  | "params"
  | "paths"
  | "runtime"
  | "secrets"
  | "recovery"
  | "distribution";

export const PRIMARY_NAV: { id: PrimaryNavId; label: string }[] = [
  { id: "operations", label: "OPERATIONS" },
  { id: "downloads", label: "DOWNLOAD" },
  { id: "remote", label: "REMOTE" },
  { id: "config", label: "CONFIG" },
  { id: "foundry", label: "FOUNDRY" },
];

/** OPERATIONS children — catalog cockpit + engines + logs. */
export const OPS_SUB_NAV: { id: Tab; label: string }[] = [
  { id: "catalog", label: "OPS" },
  { id: "stack", label: "RUNNING" },
  { id: "logs", label: "LOGS" },
];

const CONFIG_SUB_NAV_ALL: {
  id: ConfigSubTab;
  label: string;
  devOnly?: boolean;
  dataOnboarding?: string;
}[] = [
  { id: "providers", label: "ENGINE" },
  { id: "params", label: "PARAMETERS" },
  { id: "paths", label: "PATHS", dataOnboarding: "paths-tab" },
  { id: "runtime", label: "RUNTIME" },
  { id: "distribution", label: "DISTRIBUTION", devOnly: true },
  { id: "secrets", label: "SECRETS" },
  { id: "recovery", label: "RECOVERY" },
];

export function configSubNavOptions(includeDev = isDevBuild()) {
  return CONFIG_SUB_NAV_ALL.filter((o) => includeDev || !o.devOnly);
}

export function isOpsTab(tab: Tab): boolean {
  return tab === "catalog" || tab === "stack" || tab === "logs";
}

export function primaryNavFromTab(tab: Tab): PrimaryNavId {
  if (isOpsTab(tab)) return "operations";
  if (tab === "modelhub") return "downloads";
  if (tab === "remote") return "remote";
  if (tab === "foundry") return "foundry";
  return "config";
}

/** Default leaf tab when entering a primary group. */
export function defaultTabForPrimary(
  primary: PrimaryNavId,
  lastOpsTab: Tab = "catalog",
): Tab {
  switch (primary) {
    case "operations":
      return isOpsTab(lastOpsTab) ? lastOpsTab : "catalog";
    case "downloads":
      return "modelhub";
    case "remote":
      return "remote";
    case "config":
      return "config";
    case "foundry":
      return "foundry";
  }
}
