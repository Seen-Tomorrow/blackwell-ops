import type { Tab } from "../App";
import { isDevBuild } from "./build";
import type { ExtrasSubTab } from "./storage";

/** Top-level header destinations (segment primary rail). */
export type PrimaryNavId = "operations" | "downloads" | "extras" | "config";

/** CONFIG page sections (header sub-rail when primary = CONFIG). */
export type ConfigSubTab =
  | "providers"
  | "params"
  | "paths"
  | "secrets"
  | "recovery"
  | "updates"
  | "distribution";

export type { ExtrasSubTab };

export const PRIMARY_NAV: { id: PrimaryNavId; label: string }[] = [
  { id: "operations", label: "OPERATIONS" },
  { id: "config", label: "CONFIG" },
  { id: "downloads", label: "DOWNLOADS" },
  { id: "extras", label: "EXTRAS" },
];

/** OPERATIONS children — catalog cockpit + engines + logs. */
export const OPS_SUB_NAV: { id: Tab; label: string }[] = [
  { id: "catalog", label: "OPS" },
  { id: "stack", label: "ENGINES" },
  { id: "logs", label: "LOGS" },
];

/** EXTRAS children — header sub-rail. */
export const EXTRAS_SUB_NAV: { id: ExtrasSubTab; label: string }[] = [
  { id: "intel", label: "INTEL" },
  { id: "playground", label: "PLAYGROUND" },
];

const CONFIG_SUB_NAV_ALL: {
  id: ConfigSubTab;
  label: string;
  devOnly?: boolean;
  dataOnboarding?: string;
}[] = [
  { id: "providers", label: "PROVIDERS" },
  { id: "params", label: "PARAMETERS" },
  { id: "paths", label: "PATHS", dataOnboarding: "paths-tab" },
  { id: "updates", label: "UPDATES" },
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
  if (tab === "extras") return "extras";
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
    case "extras":
      return "extras";
    case "config":
      return "config";
  }
}
