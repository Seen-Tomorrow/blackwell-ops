import "../styles/config-page.css";
// Config tab shell — content only. Section switching lives in the app header
// sub-rail (Layout). This file keeps the sub-tab body + PATHS panel.

import { useState, useEffect, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig, ModelPathEntry, ModelEntry, PathDiskUsage, SwapStoreInfo } from "../lib/types";
import { hfCooldownMs, noteHfError } from "../lib/hfCache";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import EngineConfig from "./EngineConfig";
import SecretsConfig from "./SecretsConfig";
import RecoveryConfig from "./RecoveryConfig";
import DistributionDevPanel from "./DistributionDevPanel";
import RuntimeConfig from "./RuntimeConfig";
import ParamConfigPanel from "./ParamConfigPanel";
import TabPageHeader from "./TabPageHeader";
import {
  cyclePowerUserState,
  isEditorUnlocked,
  loadPowerUserState,
  savePowerUserState,
  loadConfigDevPreviewAsUser,
  KEYS,
  subscribeStorage,
  type PowerUserState,
} from "../lib/storage";
import {
  dispatchAppEvent,
  EVENTS,
} from "../lib/events";
import type { SetupGuideState } from "../hooks/useSetupGuide";
import { isDevBuild } from "../lib/build";
import {
  resolveConfigActor,
  type ConfigActor,
} from "../lib/systemParams";
import type { ConfigSubTab } from "../lib/appNav";

interface ConfigPageProps {
  providers?: ProviderConfig[];
  setupGuide: SetupGuideState;
  /** Controlled section — header sub-rail owns selection. */
  subTab: ConfigSubTab;
  onSubTabChange: (tab: ConfigSubTab) => void;
}

export default function ConfigPage({
  providers: externalProviders,
  setupGuide,
  subTab,
  onSubTabChange,
}: ConfigPageProps) {
  const [selectedProviderId, setSelectedProviderId] = useState<string>(DEFAULT_PROVIDER_ID);
  const [allProviders, setAllProviders] = useState<ProviderConfig[]>(externalProviders || []);
  // Power-user tri-state — synced with Layout.tsx header toggle
  const [powerUserState, setPowerUserState] = useState<PowerUserState>(loadPowerUserState);
  const editorUnlocked = isEditorUnlocked(powerUserState);
  const factoryExportEnabled = isDevBuild();
  /** DEV: preview CONFIG as user (restricted) vs unrestricted. */
  const [devPreviewAsUser, setDevPreviewAsUser] = useState(loadConfigDevPreviewAsUser);
  const configActor: ConfigActor = useMemo(
    () =>
      resolveConfigActor({
        editorUnlocked,
        isDev: isDevBuild(),
        devPreviewAsUser,
      }),
    [editorUnlocked, devPreviewAsUser],
  );

  // Keep local list aligned with App providers (Foundry + other pages share App state).
  useEffect(() => {
    if (externalProviders && externalProviders.length > 0) {
      setAllProviders(externalProviders);
    }
  }, [externalProviders]);

  useEffect(() => {
    return subscribeStorage(KEYS.powerUser, () => setPowerUserState(loadPowerUserState()));
  }, []);

  useEffect(() => {
    if (setupGuide.active && setupGuide.phase === "paths") {
      onSubTabChange("paths");
    }
  }, [setupGuide.active, setupGuide.phase, onSubTabChange]);

  // Non-dev cannot stay on DISTRIBUTION
  useEffect(() => {
    if (subTab === "distribution" && !factoryExportEnabled) {
      onSubTabChange("providers");
    }
  }, [subTab, factoryExportEnabled, onSubTabChange]);

  const handleEditorToggle = useCallback(() => {
    setPowerUserState(prev => {
      const next = cyclePowerUserState(prev);
      savePowerUserState(next);
      return next;
    });
  }, []);

  const effectiveSub =
    subTab === "distribution" && !factoryExportEnabled ? "providers" : subTab;

  return (
    <div className="h-full flex flex-col overflow-hidden" data-config-page>
      <TabPageHeader title="CONFIG" />

      {effectiveSub === "providers" ? (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <EngineConfig providers={allProviders} onProvidersChange={setAllProviders} />
        </div>
      ) : effectiveSub === "distribution" && factoryExportEnabled ? (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <DistributionDevPanel />
        </div>
      ) : effectiveSub === "paths" ? (
        <ModelPathsPanel />
      ) : effectiveSub === "runtime" ? (
        <RuntimeConfig />
      ) : effectiveSub === "secrets" ? (
        <SecretsConfig />
      ) : effectiveSub === "recovery" ? (
        <RecoveryConfig />
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <ParamConfigPanel
            providers={allProviders}
            selectedProviderId={selectedProviderId}
            setSelectedProviderId={setSelectedProviderId}
            onProvidersChange={setAllProviders}
            editorUnlocked={editorUnlocked}
            configActor={configActor}
            factoryExportEnabled={factoryExportEnabled}
            devPreviewAsUser={devPreviewAsUser}
            setDevPreviewAsUser={setDevPreviewAsUser}
            powerUserState={powerUserState}
            setPowerUserState={setPowerUserState}
            onEditorToggle={handleEditorToggle}
          />
        </div>
      )}
    </div>
  );
}

// ── Model Paths Panel ────────────────────────────────────────────────

function displayModelPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice("\\\\?\\".length);
  }
  return path;
}

function normalizeModelPathKey(path: string): string {
  return displayModelPath(path).replace(/[/\\]+$/, "").toLowerCase();
}

function dedupeModelPaths(paths: ModelPathEntry[]): ModelPathEntry[] {
  const out: ModelPathEntry[] = [];
  for (const entry of paths) {
    const key = normalizeModelPathKey(entry.path);
    const idx = out.findIndex((e) => normalizeModelPathKey(e.path) === key);
    if (idx >= 0) {
      if (entry.isDefault) {
        out[idx] = { ...out[idx], isDefault: true };
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function ModelPathsPanel() {
  const [paths, setPaths] = useState<ModelPathEntry[]>([]);
  const [diskUsage, setDiskUsage] = useState<PathDiskUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [pathError, setPathError] = useState<string | null>(null);
  const [store, setStore] = useState<SwapStoreInfo | null>(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [pairBusy, setPairBusy] = useState(false);
  const [pairReport, setPairReport] = useState<string | null>(null);

  const loadStore = useCallback(async () => {
    try {
      setStore(await invoke<SwapStoreInfo>("swap_store_info"));
    } catch (e) {
      console.error("Failed to read the SWAP store:", e);
    }
  }, []);

  const loadPaths = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        invoke<ModelPathEntry[]>("list_model_paths"),
        invoke<PathDiskUsage[]>("get_disk_usage"),
      ]);
      setPaths(dedupeModelPaths(p));
      setDiskUsage(d);
    } catch (e) {
      console.error("Failed to load model paths:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPaths(); loadStore(); }, [loadPaths, loadStore]);

  const handleAddPath = useCallback(async () => {
    try {
      setPathError(null);
      const selected: string | null = await invoke("open_folder_dialog", { title: "Select Model Folder" });
      if (selected) {
        await invoke("add_model_path", { path: selected, label: null });
        loadPaths();
        dispatchAppEvent(EVENTS.modelPathsChanged);
      }
    } catch (e) {
      console.error("Failed to add model path:", e);
      setPathError(typeof e === "string" ? e : "Failed to add model path");
    }
  }, [loadPaths]);

  const handleRemovePath = useCallback(async (path: string) => {
    if (paths.length <= 1) {
      setPathError("Add another folder before removing the last model path.");
      return;
    }
    try {
      setPathError(null);
      await invoke("remove_model_path", { path });
      loadPaths();
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      const msg = typeof e === "string" ? e : "Failed to remove model path";
      console.error("Failed to remove model path:", msg);
      setPathError(msg);
    }
  }, [loadPaths, paths.length]);

  const handleSetDefault = useCallback(async (path: string) => {
    try {
      await invoke("set_default_model_path", { path });
      loadPaths();
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      console.error("Failed to set default model path:", e);
    }
  }, [loadPaths]);

  const changeStore = useCallback(async () => {
    try {
      setStoreBusy(true);
      setPathError(null);
      const selected: string | null = await invoke("open_folder_dialog", {
        title: "Select the SWAP store folder",
      });
      if (!selected) return;
      setStore(await invoke<SwapStoreInfo>("set_swap_store", { path: selected }));
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      setPathError(typeof e === "string" ? e : "Could not change the SWAP store");
    } finally {
      setStoreBusy(false);
    }
  }, []);

  const moveStore = useCallback(async () => {
    try {
      setStoreBusy(true);
      setPathError(null);
      const selected: string | null = await invoke("open_folder_dialog", {
        title: "Move the SWAP store into…",
      });
      if (!selected) return;
      setStore(await invoke<SwapStoreInfo>("move_swap_store", { target: selected }));
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      setPathError(typeof e === "string" ? e : "Could not move the SWAP store");
    } finally {
      setStoreBusy(false);
    }
  }, []);

  /**
   * One-shot check of the Hub pairings the catalog derives from folder names
   * (author/repo-GGUF/...). Those are trusted without asking the Hub, so a renamed or
   * invented folder looks paired until an update check fails. This walks them
   * sequentially, stops on a quota error, and reports the mismatches.
   */
  const verifyPairings = useCallback(async () => {
    try {
      setPairBusy(true);
      setPairReport(null);
      setPathError(null);
      const report = await invoke<{ models: ModelEntry[] }>("list_models");
      const candidates = (report.models ?? []).filter(
        (m) => m.hfMeta?.hfModelId && m.path,
      );
      let checked = 0;
      let confirmed = 0;
      let mismatched = 0;
      let stopped: string | null = null;
      for (const entry of candidates) {
        if (hfCooldownMs() > 0) {
          stopped = "Hub quota reached — continuing would only deepen it.";
          break;
        }
        if (checked >= 25) {
          stopped = "stopped after 25 models to stay inside the hourly quota";
          break;
        }
        const repoId = entry.hfMeta?.hfModelId ?? "";
        const fileName = entry.path.split(/[\\/]/).pop() ?? "";
        const sizeBytes = entry.metadata?.file_size_bytes ?? 0;
        try {
          const ok = await invoke<boolean>("verify_hf_pairing", {
            modelPath: entry.path,
            repoId,
            fileName,
            sizeBytes,
          });
          checked += 1;
          if (ok) confirmed += 1;
          else mismatched += 1;
        } catch (e) {
          noteHfError(e);
          stopped = typeof e === "string" ? e : "pairing check failed";
          break;
        }
      }
      const unpaired = (report.models ?? []).filter((m) => !m.hfMeta?.hfModelId).length;
      setPairReport(
        `${confirmed}/${checked} confirmed · ${mismatched} mismatched · ${unpaired} without a Hub id${
          stopped ? ` · ${stopped}` : ""
        }`,
      );
    } catch (e) {
      setPathError(typeof e === "string" ? e : "Pairing check failed");
    } finally {
      setPairBusy(false);
    }
  }, []);
  const fmtBytes = (bytes: number): string => {
    if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.round(bytes / 1e3)} KB`;
  };

  const getUsage = useCallback((path: string): PathDiskUsage | undefined => {
    return diskUsage.find(d => d.path === path);
  }, [diskUsage]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="type-body font-mono cfg-mut animate-pulse">LOADING PATHS...</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b cfg-bord flex items-center justify-between">
        <h2 className="text-xs font-mono cfg-acc tracking-wider">MODEL PATHS</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={verifyPairings}
            disabled={pairBusy}
            title="Ask the Hub about each pairing the catalog derived from folder names"
            className="px-3 py-1 type-label font-mono border cfg-bord cfg-mut hover:cfg-fill--a15 transition-colors disabled:opacity-50"
          >
            {pairBusy ? "CHECKING…" : "VERIFY HUB PAIRINGS"}
          </button>
          <button
            onClick={handleAddPath}
            data-onboarding="add-folder"
            className="px-3 py-1 type-label font-mono border cfg-bord--acc--a60 cfg-acc hover:cfg-fill--a15 transition-colors"
          >
            + ADD FOLDER
          </button>
        </div>
      </div>

      {pairReport && (
        <div className="px-4 py-2 border-b cfg-bord type-label font-mono cfg-mut">
          {pairReport}
        </div>
      )}

      {pathError && (
        <div className="px-4 py-2 border-b cfg-bord--dng--a30 cfg-fill--dng--a5 type-label font-mono cfg-dng">
          {pathError}
        </div>
      )}

      {/* SWAP store: one place for every non-quant file. Its own row because it is not
          a model library — it can live on a different drive and hold terabytes. */}
      <div className="px-4 pt-4">
        <div className="industrial-panel-face p-3 cfg-bord--acc--a40">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="px-1.5 py-0.5 type-label font-mono cfg-fill--a15 cfg-acc cfg-bord--acc--a60">
                  SWAP STORE
                </span>
                <span className="type-label font-mono cfg-mut">
                  DRAFT HEADS · MMPROJ · ENGRAM
                </span>
                <span className="type-label font-mono cfg-mut opacity-70">
                  — its own folder, e.g. &lt;library&gt;\model_EXTRAS
                </span>
              </div>
              <div className="type-body font-mono cfg-txt truncate">
                {store?.path || "not created yet — first download creates it"}
              </div>
              <div className="type-label font-mono cfg-mut mt-1">
                {store && store.exists
                  ? `${store.files} FILES · ${fmtBytes(store.bytes)}`
                  : "EMPTY"}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={changeStore}
                disabled={storeBusy}
                className="px-3 py-1 type-label font-mono border cfg-bord--acc--a60 cfg-acc hover:cfg-fill--a15 transition-colors disabled:opacity-50"
              >
                CHANGE
              </button>
              <button
                onClick={moveStore}
                disabled={storeBusy || !store?.exists || store.files === 0}
                title="Move every file to another folder and re-point the setting"
                className="px-3 py-1 type-label font-mono border cfg-bord cfg-mut hover:cfg-fill--a15 transition-colors disabled:opacity-40"
              >
                {storeBusy ? "WORKING…" : "MOVE…"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Path list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {paths.length === 0 && (
          <div className="text-center py-8 type-body font-mono cfg-mut">
            NO PATHS CONFIGURED — ADD A FOLDER TO GET STARTED
          </div>
        )}

        {paths.map((entry) => {
          const usage = getUsage(entry.path);
          return (
            <div key={entry.path}
              className={`industrial-panel-face p-3 transition-colors ${entry.isDefault ? "cfg-bord--acc--a40" : "cfg-bord"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {entry.isDefault && (
                      <span className="type-tiny font-mono cfg-acc cfg-fill--a15 px-1.5 py-0.5 rounded-sm">DEFAULT</span>
                    )}
                    <span className="type-body font-mono text-white truncate">{entry.label || entry.path}</span>
                  </div>
                  <div className="type-label font-mono cfg-mut truncate">{displayModelPath(entry.path)}</div>
                  {usage && (
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="type-tiny font-mono cfg-mut--a70">
                        {usage.fileCount} models · {formatBytes(usage.totalGgufBytes)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {!entry.isDefault && (
                    <button onClick={() => handleSetDefault(entry.path)}
                      title="Set as default for download"
                      className="px-2 py-0.5 type-tiny font-mono border cfg-bord--warn--a30 cfg-warn--a70 hover:cfg-fill--warn--a10 transition-colors">
                      SET AS DEFAULT FOR DOWNLOAD
                    </button>
                  )}
                  <button
                    onClick={() => handleRemovePath(entry.path)}
                    disabled={paths.length <= 1}
                    title={
                      paths.length <= 1
                        ? "Add another folder before removing the last model path"
                        : "Remove this path"
                    }
                    className={`px-2 py-0.5 type-tiny font-mono border cfg-bord--dng--a30 cfg-dng--a70 transition-colors ${
                      paths.length <= 1
                        ? "opacity-30 cursor-not-allowed"
                        : "hover:cfg-fill--dng--a10"
                    }`}
                  >
                    REMOVE
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 border-t cfg-bord type-tiny font-mono cfg-mut--a50">
        {paths.length === 0
          ? "ADD AT LEAST ONE FOLDER — CATALOG STAYS EMPTY UNTIL A PATH IS SET"
          : paths.length === 1
            ? `DOWNLOADS GO TO ${paths.find(p => p.isDefault)?.label || "DEFAULT PATH"} · ADD ANOTHER FOLDER TO ENABLE REMOVE`
            : `DOWNLOADS GO TO ${paths.find(p => p.isDefault)?.label || "DEFAULT PATH"} · CATALOG MERGES ALL PATHS`}
      </div>
    </div>
  );
}

