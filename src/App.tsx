import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { unstable_batchedUpdates } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

import Layout from "./components/Layout";
import ModelCatalog from "./components/ModelCatalog";
const StackView = lazy(() => import("./components/StackView"));
const ConfigPage = lazy(() => import("./components/ConfigPage"));
const Reactor11 = lazy(() => import("./components/Reactor11"));
const ExtrasPage = lazy(() => import("./components/ExtrasPage"));
const ModelHub = lazy(() => import("./components/ModelHub"));
const LogLineText = lazy(() => import("./components/LogLineText"));
const EngineLogsSwitcher = lazy(() => import("./components/EngineLogsSwitcher"));

function TabFallback() {
  return <div className="flex-1 min-h-0" aria-hidden />;
}
import { StatusProvider } from "./context/StatusBarContext";

import { TelemetryProvider, type GpuPollTier } from "./context/TelemetryContext";
import { FusionProvider } from "./context/FusionContext";
import { ThemeProvider } from "./context/ThemeContext";
import { DisplayTextureProvider } from "./context/DisplayTextureContext";
import { IndustrialBezelTextureProvider } from "./context/IndustrialBezelTextureContext";
import { ToastProvider } from "./components/Toast";
import { FoundryProvider } from "./hooks/useBuildDock";
import { useSetupGuide } from "./hooks/useSetupGuide";
import { useTauriListen } from "./hooks/useTauriListen";
import {
  isPowerUserActive,
  loadPowerUserState,
  loadLogSearchBySlot,
  saveLogSearchBySlot,
  loadLogsAnsiEnabled,
  saveLogsAnsiEnabled,
  saveStartupUpdatesCache,
  loadHwMonitorOpen,
} from "./lib/storage";
import { dispatchAppEvent, EVENTS } from "./lib/events";

import { BINARY_UPDATES_ENABLED } from "./lib/foundry_constants";
import { getActiveStackSlots, isActiveEngineSlot } from "./lib/engineStack";
import type { ModelEntry, StackEntry, LogBatch, LogEntry, SystemEvent, ProviderConfig, UpdateOfferings } from "./lib/types";

export type Tab = "catalog" | "stack" | "extras" | "reactor11" | "modelhub" | "logs" | "config" | "sentinel";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("catalog");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [logs, setLogs] = useState<Map<number, LogEntry[]>>(new Map());
  const [systemEvents, setSystemEvents] = useState<Map<number, Array<{ text: string; timestamp: string }>>>(new Map());
  // fusionUpdates removed — managed by useFusionData hook (single listener)

  const [activeLogSlot, setActiveLogSlot] = useState<number | "all">("all");
  const [logSearchBySlot, setLogSearchBySlot] = useState<Record<number, string>>(() => loadLogSearchBySlot());
  const [logsAnsiEnabled, setLogsAnsiEnabled] = useState(() => loadLogsAnsiEnabled());

  const logsScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const flatLogsRef = useRef<Map<number, Array<{ text: string; alias: string }>>>(new Map());
  const logsLengthsRef = useRef<Record<number, number>>({});
  const logSearchHitIndexRef = useRef(0);

  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogHfUpdates] = useState<Set<string>>(() => new Set()); // populated when manual check ships — CATALOG-HF-UPDATES.md
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [batchScanState, setBatchScanState] = useState<{active: boolean; scanned: number; failed: number; total: number}>({ active: false, scanned: 0, failed: 0, total: 0 });

  const clearSlotLogSearch = useCallback((slot: number) => {
    logSearchHitIndexRef.current = 0;
    setLogSearchBySlot((prev) => {
      if (!(slot in prev)) return prev;
      const next = { ...prev };
      delete next[slot];
      saveLogSearchBySlot(next);
      return next;
    });
  }, []);

  const setSlotLogSearch = useCallback((slot: number, query: string) => {
    logSearchHitIndexRef.current = 0;
    setLogSearchBySlot((prev) => {
      const next = { ...prev };
      if (!query.trim()) {
        delete next[slot];
      } else {
        next[slot] = query;
      }
      saveLogSearchBySlot(next);
      return next;
    });
  }, []);

  const scrollToLogSearchHit = useCallback((hitIndex: number, behavior: ScrollBehavior = "smooth") => {
    const root = logsScrollRef.current;
    if (!root) return 0;
    const hits = root.querySelectorAll<HTMLElement>(".log-search-hit");
    if (hits.length === 0) return 0;
    const idx = ((hitIndex % hits.length) + hits.length) % hits.length;
    hits.forEach((el, i) => {
      el.classList.toggle("log-search-hit--current", i === idx);
    });
    hits[idx]?.scrollIntoView({ block: "center", behavior });
    return hits.length;
  }, []);

  const stepLogSearchHit = useCallback(() => {
    const count = scrollToLogSearchHit(logSearchHitIndexRef.current + 1);
    if (count > 0) {
      logSearchHitIndexRef.current = (logSearchHitIndexRef.current + 1) % count;
    }
  }, [scrollToLogSearchHit]);

  const releaseSlotLogCaches = useCallback((slot?: number) => {
    if (slot === undefined) {
      setLogs(new Map());
      setSystemEvents(new Map());
      flatLogsRef.current.clear();
      logsLengthsRef.current = {};
      setLogSearchBySlot({});

      saveLogSearchBySlot({});
      return;
    }
    setLogs((prev) => {
      if (!prev.has(slot)) return prev;
      const next = new Map(prev);
      next.delete(slot);
      return next;
    });
    setSystemEvents((prev) => {
      if (!prev.has(slot)) return prev;
      const next = new Map(prev);
      next.delete(slot);
      return next;
    });
    flatLogsRef.current.delete(slot);
    delete logsLengthsRef.current[slot];
    clearSlotLogSearch(slot);
  }, [clearSlotLogSearch]);
  const [totalParams, setTotalParams] = useState(0);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [isPowerUser, setIsPowerUser] = useState(() => isPowerUserActive(loadPowerUserState()));
  const [hwMonitorOpen, setHwMonitorOpen] = useState(() => loadHwMonitorOpen());

  useEffect(() => {
    const onHwMonitor = (e: Event) => {
      const open = (e as CustomEvent<{ open?: boolean }>).detail?.open;
      setHwMonitorOpen(typeof open === "boolean" ? open : loadHwMonitorOpen());
    };
    window.addEventListener(EVENTS.hwMonitorOpenChanged, onHwMonitor);
    return () => window.removeEventListener(EVENTS.hwMonitorOpenChanged, onHwMonitor);
  }, []);
  const setupGuide = useSetupGuide({ models, catalogLoaded, batchScanState });

  useEffect(() => {
    const handler = () => setIsPowerUser(isPowerUserActive(loadPowerUserState()));
    window.addEventListener("storage", handler);
    const powerUserHandler = () => requestAnimationFrame(handler);
    window.addEventListener(EVENTS.powerUserChanged, powerUserHandler);
    const navHandler = () => setActiveTab("stack");
    const catalogNavHandler = () => setActiveTab("catalog");
    const extrasNavHandler = () => setActiveTab("extras");
    const modelHubNavHandler = () => setActiveTab("modelhub");
    window.addEventListener(EVENTS.navigateStack, navHandler);
    window.addEventListener(EVENTS.navigateCatalog, catalogNavHandler);
    window.addEventListener(EVENTS.navigateExtras, extrasNavHandler);
    window.addEventListener(EVENTS.navigateModelHub, modelHubNavHandler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener(EVENTS.powerUserChanged, powerUserHandler);
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
      const data = await invoke<UpdateOfferings>("get_update_offerings");
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

  // Foundry finished: refresh only that provider's binary metadata (not all 3×N probes).
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

  // Catalog HF update check disabled until catalog UX is ready — see CATALOG-HF-UPDATES.md
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
    const handler = () => setActiveTab("config");
    window.addEventListener(EVENTS.navigateConfig, handler);
    return () => window.removeEventListener(EVENTS.navigateConfig, handler);
  }, []);

  useTauriListen<LogBatch>("engine-log-batch", (payload) => {
    if (payload?.slot !== undefined && payload.entries?.length > 0) {
      unstable_batchedUpdates(() => {
        try {
          setLogs((prev) => {
            const next = new Map(prev);
            const existing = next.get(payload.slot) || [];
            const updated = [...existing, ...payload.entries].slice(-5000);
            next.set(payload.slot, updated);
            if (!prev.has(payload.slot)) {
              setActiveLogSlot(payload.slot);
            }
            return next;
          });
        } catch {}
      });
    }
  });

  useTauriListen<SystemEvent>("engine-system", (payload) => {
    try {
      if (payload?.slot !== undefined && payload.text) {
        unstable_batchedUpdates(() => {
          setSystemEvents((prev) => {
            const next = new Map(prev);
            const existing = next.get(payload.slot) || [];
            const updated = [...existing, { text: payload.text, timestamp: payload.timestamp }].slice(-50);
            next.set(payload.slot, updated);
            return next;
          });
        });
      }
    } catch {}
  });

  useTauriListen<{ slot?: number; alias?: string; reason?: string }>("engine-load-failed", (payload) => {
    if (payload?.reason) {
      dispatchAppEvent(EVENTS.launchError, { message: payload.reason });
    }
    if (payload?.slot !== undefined) {
      dispatchAppEvent(EVENTS.slotCleared, { slot: payload.slot });
    }
  });

  useTauriListen<{ slot: number }>("slot-cleared", (payload) => {
    unstable_batchedUpdates(() => {
      try {
        if (payload?.slot !== undefined) {
          releaseSlotLogCaches(payload.slot);
          setActiveLogSlot((prev) => (prev === payload.slot ? "all" : prev));
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

  useEffect(() => {
    if (activeTab === "sentinel") {
      setActiveTab("catalog");
    }
  }, [activeTab]);

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
      await invoke("stop_all_engines");
      releaseSlotLogCaches();
      dispatchAppEvent(EVENTS.stopAll);
    } catch (err) {
      console.error("Stop all failed:", err);
    }
  }, [releaseSlotLogCaches]);

  // Auto-scroll logs to bottom on new entries
  const prevLogCountRef = useRef(0);
  useEffect(() => {
    if (activeTab !== "logs" || !logsScrollRef.current) return;
    const totalLines = Array.from(logs.values()).reduce((s, e) => s + e.length, 0);
    if (totalLines > prevLogCountRef.current && autoScrollRef.current) {
      logsScrollRef.current.scrollTo({ top: logsScrollRef.current.scrollHeight });
    }
    prevLogCountRef.current = totalLines;
  }, [logs, activeTab]);

  // Track manual scroll to toggle auto-scroll
  const handleLogsScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    autoScrollRef.current = distFromBottom < 80;
  }, []);

  // Clear logs for selected slot
  const handleClearSlotLogs = useCallback((slot: number) => {
    setLogs((prev) => {
      const next = new Map(prev);
      next.set(slot, []);
      return next;
    });
    clearSlotLogSearch(slot);
  }, [clearSlotLogSearch]);

  const handleClearAllLogs = useCallback(() => {
    setLogs((prev) => {
      const next = new Map<number, LogEntry[]>();
      for (const slot of prev.keys()) {
        next.set(slot, []);
      }
      for (const entry of stack) {
        if (isActiveEngineSlot(entry) && !next.has(entry.idx)) {
          next.set(entry.idx, []);
        }
      }
      return next;
    });
    setSystemEvents((prev) => {
      const next = new Map(prev);
      for (const slot of next.keys()) {
        next.set(slot, []);
      }
      for (const entry of stack) {
        if (isActiveEngineSlot(entry) && !next.has(entry.idx)) {
          next.set(entry.idx, []);
        }
      }
      return next;
    });
    flatLogsRef.current.clear();
    logsLengthsRef.current = {};
    setLogSearchBySlot({});
    saveLogSearchBySlot({});
  }, [stack]);

  const flatLogs = useMemo(() => {
    const result = new Map();
    for (const [slot, entries] of logs.entries()) {
      const len = entries.length;
      // Only recompute slice+map when entry count changed by 10+ — avoids expensive allocation on every log append.
      if (logsLengthsRef.current[slot] !== undefined && Math.abs(len - logsLengthsRef.current[slot]) < 1) {
        result.set(slot, flatLogsRef.current.get(slot) || []);
      } else {
        const sliced = entries.slice(-500).map((e) => ({ text: e.text, alias: e.alias }));
        result.set(slot, sliced);
        flatLogsRef.current.set(slot, sliced);
      }
      logsLengthsRef.current[slot] = len;
    }
    return result;
  }, [logs]);

  const activeLogSearchQuery = useMemo(() => {
    if (typeof activeLogSlot !== "number") return "";
    return logSearchBySlot[activeLogSlot]?.trim() ?? "";
  }, [activeLogSlot, logSearchBySlot]);

  useEffect(() => {
    if (activeTab !== "logs") return;
    logSearchHitIndexRef.current = 0;
    if (!activeLogSearchQuery) {
      logsScrollRef.current
        ?.querySelectorAll(".log-search-hit--current")
        .forEach((el) => el.classList.remove("log-search-hit--current"));
      return;
    }
    autoScrollRef.current = false;
    const frame = requestAnimationFrame(() => {
      scrollToLogSearchHit(0, "auto");
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, activeLogSearchQuery, activeLogSlot, flatLogs, scrollToLogSearchHit]);

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

  const gpuPollTier = useMemo((): GpuPollTier => {
    if (hwMonitorOpen) return "fast";
    if (activeTab === "catalog" || hasLiveEngines) return "normal";
    return "idle";
  }, [activeTab, hasLiveEngines, hwMonitorOpen]);

  return (
    <FusionProvider stack={stack}>
    <ToastProvider>
      <ThemeProvider>
        <DisplayTextureProvider>
        <IndustrialBezelTextureProvider>
        <FoundryProvider>
          <TelemetryProvider pollingActive={hwMonitorOpen || activeTab === "catalog" || hasLiveEngines} gpuPollTier={gpuPollTier}>
            <StatusProvider value={{ totalParams, hiddenCount, onShowAll: handleShowAll }}>
            <Layout activeTab={activeTab} onTabChange={setActiveTab} providers={providers} updateOfferings={updateOfferings} onRefreshUpdateOfferings={refreshUpdateOfferings} hasBinaryUpdates={hasBinaryUpdates}>
        {activeTab === "catalog" && (
              <ModelCatalog models={models} onLaunch={handleLaunchEngine} error={catalogError} onReload={reloadModels} providers={providers} committedVramMib={committedVramMib} scanningPath={scanningPath} setScanningPath={setScanningPath} batchScanState={batchScanState} setBatchScanState={setBatchScanState} stack={stack} setupGuide={setupGuide} catalogHfUpdates={catalogHfUpdates} />
           )}
        {activeTab === "config" && (
          <Suspense fallback={<TabFallback />}>
            <ConfigPage
              providers={providers}
              setupGuide={setupGuide}
              updateOfferings={updateOfferings}
              onRefreshUpdateOfferings={refreshUpdateOfferings}
              onBinaryUpdatesChange={setHasBinaryUpdates}
              hasBinaryUpdates={hasBinaryUpdates}
            />
          </Suspense>
        )}
        {activeTab === "stack" && (
          <Suspense fallback={<TabFallback />}>
            <StackView stack={stack} logs={logs} systemEvents={systemEvents} onStop={handleStopEngine} onStopAll={handleStopAll} />
          </Suspense>
        )}
        {activeTab === "modelhub" && (
          <Suspense fallback={<TabFallback />}>
            <ModelHub />
          </Suspense>
        )}
        {activeTab === "extras" && (
          <Suspense fallback={<TabFallback />}>
            <ExtrasPage stack={stack} models={models} />
          </Suspense>
        )}
        {activeTab === "reactor11" && (
          <Suspense fallback={<TabFallback />}>
            <Reactor11 models={models} />
          </Suspense>
        )}
        {activeTab === "logs" && (
          <div className="h-full flex flex-col min-h-0 overflow-hidden" data-engine-logs>
            <Suspense fallback={<TabFallback />}>
            <EngineLogsSwitcher
              activeLogSlot={activeLogSlot}
              onActiveLogSlotChange={setActiveLogSlot}
              logs={logs}
              stack={stack}
              logSearchBySlot={logSearchBySlot}
              onSlotLogSearchChange={setSlotLogSearch}
              onClearSlotLogSearch={clearSlotLogSearch}
              onLogSearchStep={stepLogSearchHit}
              onClearSlotLogs={handleClearSlotLogs}
              onClearAllLogs={handleClearAllLogs}
              ansiEnabled={logsAnsiEnabled}
              onAnsiEnabledChange={(enabled) => {
                setLogsAnsiEnabled(enabled);
                saveLogsAnsiEnabled(enabled);
              }}
            />
            </Suspense>
            <div
              ref={logsScrollRef}
              className="engine-logs-scroll theme-surface-inset flex-1 overflow-x-hidden overflow-y-auto rounded-sm p-3 min-h-0 mx-4 mb-4"
              onScroll={handleLogsScroll}
            >
              {logs.size === 0 && getActiveStackSlots(stack).length === 0 ? (
                <p className="text-[10px] font-mono text-stealth-muted/50 italic">NO LOGS YET — LAUNCH AN ENGINE TO SEE OUTPUT</p>
              ) : (() => {
                const totalLogLines = Array.from(logs.values()).reduce((sum, entries) => sum + entries.length, 0);
                if (totalLogLines === 0) {
                  return (
                    <p className="text-[10px] font-mono text-stealth-muted/50 italic">
                      LOG BUFFER CLEARED — WAITING FOR OUTPUT
                    </p>
                  );
                }
                return null;
              })() ?? (
                (() => {
                  const slotKeys = activeLogSlot === "all"
                    ? Array.from(logs.keys()).sort((a, b) => a - b)
                    : logs.has(activeLogSlot) ? [activeLogSlot] : [];
                  if (slotKeys.length === 0) return <p className="text-[10px] font-mono text-stealth-muted/50 italic">NO LOGS FOR SELECTED SLOT</p>;
                  return slotKeys.map((slot) => {
                    const entries = flatLogs.get(slot) || [];
                    const stackEntry = stack.find((s) => s.idx === slot);
                    const alias = stackEntry?.alias || entries[0]?.alias || `SLOT ${slot}`;
                    return (
                      <div key={`slot-${slot}`} className="space-y-0.5">
                        {activeLogSlot === "all" && (
                          <div className="mb-2 mt-2 first:mt-0">
                            <div className="text-[10px] font-mono text-nv-green/80 border-b border-stealth-border pb-1">
                              {alias} <span className="text-stealth-muted/40">({entries.length} lines)</span>
                            </div>
                          </div>
                        )}
                        {entries.map((entry, i) => {
                          const slotQuery = logSearchBySlot[slot] ?? "";
                          const lineQuery = activeLogSlot === "all" ? slotQuery : (logSearchBySlot[activeLogSlot] ?? "");
                          return (
                            <p key={i} className="text-[10px] font-mono text-stealth-muted leading-relaxed break-all">
                              {activeLogSlot === "all" && <span className="text-nv-green/60">[{entry.alias}] </span>}
                              <Suspense fallback={<span>{entry.text}</span>}>
                                <LogLineText
                                  text={entry.text}
                                  highlightQuery={lineQuery}
                                  ansiEnabled={logsAnsiEnabled}
                                />
                              </Suspense>
                            </p>
                          );
                        })}
                      </div>
                    );
                  });
                })()
              )}
            </div>
          </div>
        )}

            </Layout>
          </StatusProvider>
        </TelemetryProvider>
      </FoundryProvider>
        </IndustrialBezelTextureProvider>
        </DisplayTextureProvider>
    </ThemeProvider>
    </ToastProvider>
    </FusionProvider>
  );
}

export default App;
