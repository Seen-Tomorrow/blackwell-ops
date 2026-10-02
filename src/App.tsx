import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { unstable_batchedUpdates } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

import Layout from "./components/Layout";
import HarnessVeilPreview from "./components/HarnessVeilPreview";
import ModelCatalog from "./components/ModelCatalog";
const StackView = lazy(() => import("./components/StackView"));
const ConfigPage = lazy(() => import("./components/ConfigPage"));
const ExtrasPage = lazy(() => import("./components/ExtrasPage"));
const ModelHub = lazy(() => import("./components/ModelHub"));
const LogsPanel = lazy(() => import("./components/LogsPanel"));

function TabFallback() {
  return <div className="flex-1 min-h-0" aria-hidden />;
}
import { StatusProvider } from "./context/StatusBarContext";

import { TelemetryProvider, type GpuPollTier } from "./context/TelemetryContext";
import { FusionProvider } from "./context/FusionContext";
import { ThemeProvider } from "./context/ThemeContext";
import { DisplayTextureProvider } from "./context/DisplayTextureContext";
import DisplayFaceSync from "./context/DisplayFaceSync";
import { IndustrialBezelTextureProvider } from "./context/IndustrialBezelTextureContext";
import { ToastProvider } from "./components/Toast";
import { FoundryProvider } from "./hooks/useBuildDock";
import { useSetupGuide } from "./hooks/useSetupGuide";
import { useTauriListen } from "./hooks/useTauriListen";
import {
  isPowerUserActive,
  loadPowerUserState,
  saveStartupUpdatesCache,
  loadHwMonitorOpen,
  loadExtrasSubTab,
  KEYS,
  subscribeStorage,
  type ExtrasSubTab,
} from "./lib/storage";
import { dispatchAppEvent, EVENTS, consumePendingConfigSubTab, consumePendingExtrasSubTab, type NavigateConfigDetail, type NavigateExtrasDetail } from "./lib/events";
import type { ConfigSubTab } from "./lib/appNav";
import { isSetupNavTabAllowed } from "./lib/setupGuide";

import { BINARY_UPDATES_ENABLED } from "./lib/foundry_constants";
import { isActiveEngineSlot, stopAllEngines } from "./lib/engineStack";
import type { ModelEntry, StackEntry, LogBatch, SystemEvent, ProviderConfig, UpdateOfferings, CatalogUpdateEntry } from "./lib/types";
import {
  appendLogBatch,
  appendSystemEvent,
  releaseAllLogs,
  releaseSlotLogs,
} from "./lib/logSlotStore";

export type Tab = "catalog" | "stack" | "extras" | "modelhub" | "logs" | "config";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("catalog");
  const [configSubTab, setConfigSubTab] = useState<ConfigSubTab>(
    () => consumePendingConfigSubTab() ?? "providers",
  );
  const [extrasSubTab, setExtrasSubTab] = useState<ExtrasSubTab>(
    () => consumePendingExtrasSubTab() ?? loadExtrasSubTab(),
  );
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [stack, setStack] = useState<StackEntry[]>([]);
  // Engine logs live in `logSlotStore`, not in App state. They used to be held here,
  // which meant every 25 ms `engine-log-batch` created a new Map, re-rendered App, and
  // reconciled the entire mounted tree — with the LOGS tab closed. See logSlotStore.ts.
  // fusionUpdates removed — managed by useFusionData hook (single listener)

  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogHfUpdates, setCatalogHfUpdates] = useState<CatalogUpdateEntry[]>([]);
  const [catalogUpdatesBusy, setCatalogUpdatesBusy] = useState(false);
  // Transient per-path result of the most recent check — drives the card bubble
  // (UP TO DATE / NOT PAIRED / update found). Expires so it isn't sticky forever.
  const [catalogCheckVerdicts, setCatalogCheckVerdicts] = useState<Record<string, CatalogUpdateEntry>>({});
  const checkVerdictTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [batchScanState, setBatchScanState] = useState<{active: boolean; scanned: number; failed: number; total: number}>({ active: false, scanned: 0, failed: 0, total: 0 });

  const releaseSlotLogCaches = useCallback((slot?: number) => {
    if (slot === undefined) releaseAllLogs();
    else releaseSlotLogs(slot);
  }, []);
  const [totalParams, setTotalParams] = useState(0);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [isPowerUser, setIsPowerUser] = useState(() => isPowerUserActive(loadPowerUserState()));
  const [hwMonitorOpen, setHwMonitorOpen] = useState(() => loadHwMonitorOpen());

  useEffect(() => {
    return subscribeStorage(KEYS.hwMonitorOpen, () => {
      setHwMonitorOpen(loadHwMonitorOpen());
    });
  }, []);
  const setupGuide = useSetupGuide({ models, catalogLoaded, batchScanState });
  const setupActiveRef = useRef(setupGuide.active);
  setupActiveRef.current = setupGuide.active;

  const handleTabChange = useCallback((tab: Tab) => {
    if (setupActiveRef.current && !isSetupNavTabAllowed(tab)) return;
    setActiveTab(tab);
  }, []);

  // Bounce off locked tabs if setup becomes active (or is already active).
  useEffect(() => {
    if (setupGuide.active && !isSetupNavTabAllowed(activeTab)) {
      setActiveTab("catalog");
    }
  }, [setupGuide.active, activeTab]);

  useEffect(() => {
    const handler = () => setIsPowerUser(isPowerUserActive(loadPowerUserState()));
    const navHandler = () => {
      if (setupActiveRef.current) return;
      setActiveTab("stack");
    };
    const catalogNavHandler = () => setActiveTab("catalog");
    const extrasNavHandler = (e: Event) => {
      if (setupActiveRef.current) return;
      setActiveTab("extras");
      const detail = (e as CustomEvent<NavigateExtrasDetail>).detail;
      const pending = consumePendingExtrasSubTab();
      const sub = detail?.subTab ?? pending;
      if (sub) setExtrasSubTab(sub);
    };
    const modelHubNavHandler = () => setActiveTab("modelhub");
    const unsubPowerUser = subscribeStorage(KEYS.powerUser, () => requestAnimationFrame(handler));
    window.addEventListener(EVENTS.navigateStack, navHandler);
    window.addEventListener(EVENTS.navigateCatalog, catalogNavHandler);
    window.addEventListener(EVENTS.navigateExtras, extrasNavHandler);
    window.addEventListener(EVENTS.navigateModelHub, modelHubNavHandler);
    return () => {
      unsubPowerUser();
      window.removeEventListener(EVENTS.navigateStack, navHandler);
      window.removeEventListener(EVENTS.navigateCatalog, catalogNavHandler);
      window.removeEventListener(EVENTS.navigateExtras, extrasNavHandler);
      window.removeEventListener(EVENTS.navigateModelHub, modelHubNavHandler);
    };
  }, []);

  const handleShowAll = useCallback(() => {
    dispatchAppEvent(EVENTS.showAllHiddenParams);
  }, []);

  useEffect(() => {
    let pending = false;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail.totalParams === "number") {
        setTotalParams(detail.totalParams);
        setHiddenCount(detail.hiddenCount || 0);
      }
      // Throttle re-fetch to once per tick
      if (!pending) {
        pending = true;
        requestAnimationFrame(() => {
          invoke<ProviderConfig[]>("list_providers")
            .then((data) => setProviders(data))
            .catch(() => {});
          pending = false;
        });
      }
    };
    window.addEventListener(EVENTS.paramConfigChanged, handler);
    return () => window.removeEventListener(EVENTS.paramConfigChanged, handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    invoke<ProviderConfig[]>("list_providers")
      .then((data) => {
        if (!cancelled) setProviders(data);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Startup update check (app + binary updates) ──────────────────────
  const [updateOfferings, setUpdateOfferings] = useState<UpdateOfferings | null>(null);
  const [hasBinaryUpdates, setHasBinaryUpdates] = useState(false);

  const refreshUpdateOfferings = useCallback(async () => {
    if (!BINARY_UPDATES_ENABLED) return;
    try {
      const data = await invoke<UpdateOfferings>("get_update_offerings", { force: false });
      // Always keep catalog (not only when anyAvailable) so header UPDATE stays usable
      setUpdateOfferings(data);
    } catch {
      /* offline / rate limit */
    }
  }, []);

  useEffect(() => {
    const handler = () => { void refreshUpdateOfferings(); };
    window.addEventListener(EVENTS.updateOfferingsRefresh, handler);
    return () => window.removeEventListener(EVENTS.updateOfferingsRefresh, handler);
  }, [refreshUpdateOfferings]);

  useEffect(() => {
    if (!BINARY_UPDATES_ENABLED) return;
    invoke<any>("get_startup_updates")
      .then((data) => {
        if (data.updateOfferings) {
          setUpdateOfferings(data.updateOfferings);
        }
        const binaryPending = (data.binaryUpdates || []).some((bu: { updates?: { available?: boolean }[] }) =>
          (bu.updates || []).some((u) => u.available),
        );
        setHasBinaryUpdates(binaryPending || !!data.updateOfferings?.anyAvailable);
        saveStartupUpdatesCache({
          timestamp: Date.now(),
          binaryUpdates: data.binaryUpdates || [],
        });
      })
      .catch(() => {});
  }, []);

  // Config/list only — do NOT re-run --version on every app reload (Providers page owns that).
  const reloadProviders = useCallback(async () => {
    try {
      const data = await invoke<ProviderConfig[]>("list_providers");
      setProviders(data);
    } catch (err) { console.error("Failed to reload providers:", err); }
  }, []);

  useEffect(() => {
    const handler = () => { void reloadProviders(); };
    window.addEventListener(EVENTS.reloadProviders, handler);
    return () => window.removeEventListener(EVENTS.reloadProviders, handler);
  }, [reloadProviders]);

  // Sole owner: foundry Complete → refresh_build_info (probe + inventory). Do not
  // also refresh from Layout/ProvidersConfig — duplicate callers race list_providers.
  useTauriListen<{ phase: string; provider_id?: string }>("foundry-progress", (payload) => {
    if (payload.phase !== "Complete" || !payload.provider_id) return;
    void (async () => {
      try {
        const updated = await invoke<ProviderConfig[]>("refresh_build_info", {
          providerId: payload.provider_id,
        });
        if (updated.length > 0) setProviders(updated);
      } catch (err) {
        console.error("Failed to refresh build info after foundry:", err);
      }
    })();
  });

  const checkCatalogHfUpdates = useCallback(async (onlyPath?: string) => {
    setCatalogUpdatesBusy(true);
    try {
      const rows = await invoke<CatalogUpdateEntry[]>("check_catalog_hf_updates", {
        onlyPath: onlyPath ?? null,
      });
      const list = rows || [];
      const fresh = list.filter((r) => r.hasUpdate && r.kind !== "current");
      if (onlyPath) {
        setCatalogHfUpdates((prev) => {
          const rest = prev.filter((r) => r.path !== onlyPath);
          return [...rest, ...fresh];
        });
      } else {
        setCatalogHfUpdates(fresh);
      }
      // Bubble: every checked path gets a transient verdict for a few seconds.
      const BUBBLE_MS = 6000;
      setCatalogCheckVerdicts((prev) => {
        const next = { ...prev };
        for (const r of list) {
          next[r.path] = r;
          clearTimeout(checkVerdictTimers.current[r.path]);
          checkVerdictTimers.current[r.path] = setTimeout(() => {
            setCatalogCheckVerdicts((cur) => {
              if (!cur[r.path]) return cur;
              const cleared = { ...cur };
              delete cleared[r.path];
              return cleared;
            });
            delete checkVerdictTimers.current[r.path];
          }, BUBBLE_MS);
        }
        return next;
      });
    } catch (err) {
      console.error("Catalog HF update check failed:", err);
    } finally {
      setCatalogUpdatesBusy(false);
    }
  }, []);

  const dismissCatalogCheckVerdict = useCallback((path: string) => {
    clearTimeout(checkVerdictTimers.current[path]);
    delete checkVerdictTimers.current[path];
    setCatalogCheckVerdicts((cur) => {
      if (!cur[path]) return cur;
      const cleared = { ...cur };
      delete cleared[path];
      return cleared;
    });
  }, []);

  const reloadModels = useCallback(async () => {
    try {
      setCatalogError(null);
      const data = await invoke<ModelEntry[]>("list_models");
      setModels(data);
    } catch (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.error("Failed to reload models:", msg);
      setCatalogError(msg);
    } finally {
      setCatalogLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reloadModels();
  }, [reloadModels]);

  useEffect(() => {
    const handler = () => { void reloadModels(); };
    window.addEventListener(EVENTS.downloadCompleted, handler);
    window.addEventListener(EVENTS.modelPathsChanged, handler);
    return () => {
      window.removeEventListener(EVENTS.downloadCompleted, handler);
      window.removeEventListener(EVENTS.modelPathsChanged, handler);
    };
  }, [reloadModels]);

  // Onboarding exit — refresh catalog + binary probes (Config tab is often skipped on first run).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ active?: boolean }>).detail;
      if (detail?.active !== false) return;
      void reloadModels();
      void reloadProviders();
    };
    window.addEventListener(EVENTS.setupGuideChanged, handler);
    return () => window.removeEventListener(EVENTS.setupGuideChanged, handler);
  }, [reloadModels, reloadProviders]);

  useEffect(() => {
    const handler = (e: Event) => {
      setActiveTab("config");
      const detail = (e as CustomEvent<NavigateConfigDetail>).detail;
      const pending = consumePendingConfigSubTab();
      const sub = detail?.subTab ?? pending;
      if (sub) setConfigSubTab(sub);
    };
    window.addEventListener(EVENTS.navigateConfig, handler);
    return () => window.removeEventListener(EVENTS.navigateConfig, handler);
  }, []);

  // Both handlers write straight to the store — no setState here, so a log burst
  // never re-renders the shell. LogsPanel / SlotLogPanel subscribe per slot.
  useTauriListen<LogBatch>("engine-log-batch", (payload) => {
    if (payload?.slot !== undefined && payload.entries?.length > 0) {
      appendLogBatch(payload.slot, payload.entries);
    }
  });

  useTauriListen<SystemEvent>("engine-system", (payload) => {
    if (payload?.slot !== undefined && payload.text) {
      appendSystemEvent(payload.slot, payload);
    }
  });

  useTauriListen<{ slot?: number; alias?: string; reason?: string }>("engine-load-failed", (payload) => {
    if (payload?.reason) {
      const raw = payload.reason;
      const isOom =
        /out of memory|cudamalloc failed|cuda error|failed to allocate/i.test(raw);
      const alias = payload.alias ? `[${payload.alias}] ` : "";
      const message = isOom
        ? `${alias}OOM — ${raw.replace(/\s+/g, " ").trim().slice(0, 280)}`
        : raw;
      dispatchAppEvent(EVENTS.launchError, { message, durationMs: isOom ? 14000 : undefined });
    }
    if (payload?.slot !== undefined) {
      dispatchAppEvent(EVENTS.slotCleared, { slot: payload.slot });
    }
  });

  // CloseRequested → backend teardowns engines (can take several seconds on large models).
  const [shuttingDown, setShuttingDown] = useState(false);
  const [shutdownMessage, setShutdownMessage] = useState(
    "Shutting down — stopping engines and releasing GPU memory…",
  );
  useTauriListen<{ message?: string }>("app-shutting-down", (payload) => {
    setShuttingDown(true);
    if (payload?.message) setShutdownMessage(payload.message);
  });

  useTauriListen<{ slot: number }>("slot-cleared", (payload) => {
    unstable_batchedUpdates(() => {
      try {
        if (payload?.slot !== undefined) {
          releaseSlotLogCaches(payload.slot);
          dispatchAppEvent(EVENTS.slotCleared, payload);
          void invoke("emit_to_blackwell_console", {
            category: "engines",
            content: `[SLOT-CLEARED] Slot ${payload.slot}`,
            style: "Warning",
          });
        }
      } catch {}
    });
  }, [releaseSlotLogCaches]);

  useTauriListen<{ scanned: number; failed: number }>("gguf-scan-progress", (payload) => {
    setBatchScanState((s) => ({ ...s, scanned: payload.scanned, failed: payload.failed }));
    void invoke("emit_to_blackwell_console", {
      category: "utils",
      content: `[GGUF-SCAN] Progress: ${payload.scanned} scanned, ${payload.failed} failed`,
      style: "Normal",
    });
  });

  useTauriListen<{ scanned: number; failed: number; total?: number }>("gguf-scan-complete", (payload) => {
    setBatchScanState((s) => ({
      ...s,
      active: false,
      scanned: payload.scanned,
      failed: payload.failed,
      total: payload.total ?? s.total ?? payload.scanned + payload.failed,
    }));
    invoke("list_models").then((data) => setModels(data as ModelEntry[])).catch(() => {});
  });

  useTauriListen<StackEntry[]>("stack-changed", (payload) => {
    setStack(payload);
  });

  useEffect(() => {
    invoke<StackEntry[]>("get_stack_status")
      .then((data) => setStack(data))
      .catch(() => {});
  }, []);

  const handleLaunchEngine = useCallback(
    async (config: any) => {
      try {
        const result: any = await invoke("launch_engine", { config });
        // Dispatch event for catalog to pick up the launched slot index + model path.
        // Stack update comes via push event from Rust — no manual setStack needed.
        dispatchAppEvent(EVENTS.engineLaunched, {
          slotIdx: result.idx,
          modelPath: result.model_path,
        });
        return result;
      } catch (err) {
        console.error("Launch failed:", err);
        throw err;
      }
    },
    []
  );

  const handleStopEngine = useCallback(async (slotIdx: number) => {
    try {
      await invoke("stop_engine_slot", { slotIdx });
      // slot-cleared from Rust also clears this slot; stack-changed via push event.
    } catch (err) {
      console.error("Stop failed:", err);
    }
  }, []);

  const handleStopAll = useCallback(async () => {
    try {
      await stopAllEngines();
      releaseSlotLogCaches();
    } catch (err) {
      console.error("Stop all failed:", err);
    }
  }, [releaseSlotLogCaches]);

  const committedVramMib = useMemo(() => {
    return stack.reduce((sum, s) => {
      if (s.status === "RUNNING" && s.vram_mib) {
        return sum + s.vram_mib;
      }
      return sum;
    }, 0);
  }, [stack]);

  const hasLiveEngines = useMemo(
    () => stack.some(isActiveEngineSlot),
    [stack],
  );
  /** Fusion overlay + VramBadge stay mounted across tab switches while an engine is up. */
  const keepOpsAlive = useMemo(
    () => stack.some((s) => s.status === "RUNNING" || s.status === "LOADING"),
    [stack],
  );


  const gpuPollTier = useMemo((): GpuPollTier => {
    if (hwMonitorOpen) return "fast";
    if (activeTab === "catalog" || hasLiveEngines) return "normal";
    return "idle";
  }, [activeTab, hasLiveEngines, hwMonitorOpen]);

  // Stable context value: a fresh object literal here re-rendered every useTelemetry()
  // / status-bar consumer on each App render, twice a second from the CPU poll alone.
  const statusValue = useMemo(
    () => ({ totalParams, hiddenCount, onShowAll: handleShowAll }),
    [totalParams, hiddenCount, handleShowAll],
  );

  return (
    <FusionProvider stack={stack}>
    <ToastProvider>
      {shuttingDown && (
        <div
          className="fixed inset-0 z-[99999] flex flex-col items-center justify-center gap-4"
          style={{
            background: "color-mix(in srgb, #000 78%, transparent)",
            pointerEvents: "all",
          }}
          role="alertdialog"
          aria-live="assertive"
          aria-busy="true"
        >
          <p className="shell-shutdown-title font-mono font-bold tracking-widest uppercase text-center px-6">
            {shutdownMessage}
          </p>
          <p className="shell-shutdown-sub type-sm font-mono tracking-wider text-center px-6 max-w-md">
            Large models can take several seconds to release VRAM. Please wait — do not force-kill.
          </p>
          <div className="shell-shutdown-track w-48 h-1 rounded-full overflow-hidden">
            <div className="shell-shutdown-fill h-full w-1/3 animate-pulse" style={{ animationDuration: "1.2s" }} />
          </div>
        </div>
      )}
      <ThemeProvider>
        <DisplayTextureProvider>
        <DisplayFaceSync>
        <IndustrialBezelTextureProvider>
        <FoundryProvider>
          <TelemetryProvider pollingActive={hwMonitorOpen || activeTab === "catalog" || hasLiveEngines} gpuPollTier={gpuPollTier}>
            <StatusProvider value={statusValue}>
            <HarnessVeilPreview />
            <Layout
              activeTab={activeTab}
              onTabChange={handleTabChange}
              providers={providers}
              updateOfferings={updateOfferings}
              onRefreshUpdateOfferings={refreshUpdateOfferings}
              hasBinaryUpdates={hasBinaryUpdates}
              setupGuideActive={setupGuide.active}
              configSubTab={configSubTab}
              onConfigSubTabChange={setConfigSubTab}
              extrasSubTab={extrasSubTab}
              onExtrasSubTabChange={setExtrasSubTab}
            >
        {(activeTab === "catalog" || keepOpsAlive) && (
          <div
            className={activeTab === "catalog" ? "h-full min-h-0" : "hidden"}
            aria-hidden={activeTab !== "catalog"}
            inert={activeTab !== "catalog" ? true : undefined}
          >
            <ModelCatalog models={models} onLaunch={handleLaunchEngine} error={catalogError} onReload={reloadModels} providers={providers} committedVramMib={committedVramMib} scanningPath={scanningPath} setScanningPath={setScanningPath} batchScanState={batchScanState} setBatchScanState={setBatchScanState} stack={stack} setupGuide={setupGuide} catalogHfUpdates={catalogHfUpdates} catalogUpdatesBusy={catalogUpdatesBusy} onCheckCatalogUpdates={checkCatalogHfUpdates} onClearCatalogUpdate={(path) => setCatalogHfUpdates((prev) => prev.filter((r) => r.path !== path))} catalogCheckVerdicts={catalogCheckVerdicts} onDismissCheckVerdict={dismissCatalogCheckVerdict} />
          </div>
        )}

        {activeTab === "config" && (
          <Suspense fallback={<TabFallback />}>
            <ConfigPage
              providers={providers}
              setupGuide={setupGuide}
              updateOfferings={updateOfferings}
              onRefreshUpdateOfferings={refreshUpdateOfferings}
              onBinaryUpdatesChange={setHasBinaryUpdates}
              subTab={configSubTab}
              onSubTabChange={setConfigSubTab}
            />
          </Suspense>
        )}
        {activeTab === "stack" && (
          <Suspense fallback={<TabFallback />}>
            <StackView stack={stack} onStop={handleStopEngine} onStopAll={handleStopAll} />
          </Suspense>
        )}
        {activeTab === "modelhub" && (
          <Suspense fallback={<TabFallback />}>
            <ModelHub />
          </Suspense>
        )}
        {activeTab === "extras" && (
          <Suspense fallback={<TabFallback />}>
            <ExtrasPage
              stack={stack}
              models={models}
              subTab={extrasSubTab}
            />
          </Suspense>
        )}
        {activeTab === "logs" && (
          <Suspense fallback={<TabFallback />}>
            <LogsPanel stack={stack} />
          </Suspense>
        )}

            </Layout>
          </StatusProvider>
        </TelemetryProvider>
      </FoundryProvider>
        </IndustrialBezelTextureProvider>
        </DisplayFaceSync>
        </DisplayTextureProvider>
    </ThemeProvider>
    </ToastProvider>
    </FusionProvider>
  );
}

export default App;
