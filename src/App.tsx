import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { unstable_batchedUpdates } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

import Layout from "./components/Layout";
import StackView from "./components/StackView";
import ModelCatalog from "./components/ModelCatalog";
import TelemetryPanel from "./components/TelemetryPanel";
import TelemetryLab from "./components/telemetry-lab/TelemetryLab";
import TelemetryViewToggle from "./components/TelemetryViewToggle";
import IntelPage from "./components/IntelPage";
import ConfigPage from "./components/ConfigPage";
import Reactor11 from "./components/Reactor11";
import ModelHub from "./components/ModelHub";
import LogLineText from "./components/LogLineText";
import EngineLogsSwitcher from "./components/EngineLogsSwitcher";
import { StatusProvider } from "./context/StatusBarContext";

import { TelemetryProvider } from "./context/TelemetryContext";
import { FusionProvider } from "./context/FusionContext";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./components/Toast";
import { FoundryProvider } from "./hooks/useBuildDock";
import { useSetupGuide } from "./hooks/useSetupGuide";
import { useTauriListen } from "./hooks/useTauriListen";
import {
  isPowerUserActive,
  loadPowerUserState,
  STORAGE_PREFIX,
  loadLogSearchBySlot,
  saveLogSearchBySlot,
  loadLogsAnsiEnabled,
  saveLogsAnsiEnabled,
  saveStartupUpdatesCache,
  loadTelemetryViewMode,
  saveTelemetryViewMode,
  type TelemetryViewMode,
} from "./lib/storage";
import { dispatchAppEvent, EVENTS } from "./lib/events";
import { getActiveStackSlots, isActiveEngineSlot } from "./lib/engineStack";
import type { ModelEntry, StackEntry, LogBatch, LogEntry, SystemEvent, ProviderConfig, AppUpdateInfo } from "./lib/types";

export type Tab = "catalog" | "modelhub" | "stack" | "reactor11" | "telemetry" | "intel" | "logs" | "config" | "sentinel";

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("catalog");
  const [models, setModels] = useState<ModelEntry[]>([]);
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

  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [batchScanState, setBatchScanState] = useState<{active: boolean; scanned: number; failed: number; total: number}>({ active: false, scanned: 0, failed: 0, total: 0 });

  const clearSlotLogSearch = useCallback((slot: number) => {
    setLogSearchBySlot((prev) => {
      if (!(slot in prev)) return prev;
      const next = { ...prev };
      delete next[slot];
      saveLogSearchBySlot(next);
      return next;
    });
  }, []);

  const setSlotLogSearch = useCallback((slot: number, query: string) => {
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
  const [telemetryViewMode, setTelemetryViewModeState] = useState<TelemetryViewMode>(() => loadTelemetryViewMode());
  const setupGuide = useSetupGuide({ models });

  const setTelemetryViewMode = useCallback((mode: TelemetryViewMode) => {
    setTelemetryViewModeState(mode);
    saveTelemetryViewMode(mode);
    dispatchAppEvent(EVENTS.telemetryViewChanged);
  }, []);

  useEffect(() => {
    const handler = () => setIsPowerUser(isPowerUserActive(loadPowerUserState()));
    const telemetryHandler = () => setTelemetryViewModeState(loadTelemetryViewMode());
    window.addEventListener("storage", handler);
    const powerUserHandler = () => requestAnimationFrame(handler);
    window.addEventListener(EVENTS.powerUserChanged, powerUserHandler);
    window.addEventListener(EVENTS.telemetryViewChanged, telemetryHandler);
    const navHandler = () => setActiveTab("stack");
    window.addEventListener(EVENTS.navigateStack, navHandler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener(EVENTS.powerUserChanged, powerUserHandler);
      window.removeEventListener(EVENTS.telemetryViewChanged, telemetryHandler);
      window.removeEventListener(EVENTS.navigateStack, navHandler);
    };
  }, []);

  const handleShowAll = useCallback(() => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(STORAGE_PREFIX)) {
          localStorage.removeItem(key);
        }
      }
      dispatchAppEvent(EVENTS.paramConfigChanged);
    } catch {}
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
    invoke<ModelEntry[]>("list_models")
      .then((data) => {
        setModels(data);
        setCatalogError(null);
      })
      .catch((err) => {
        const msg = typeof err === "string" ? err : JSON.stringify(err);
        console.error("Failed to load models:", msg);
        setCatalogError(msg);
      });
  }, []);

  useEffect(() => {
    invoke<ProviderConfig[]>("list_providers")
      .then((data) => setProviders(data))
      .catch(console.error);
  }, []);

  // ── Startup update check (app + binary updates) ──────────────────────
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [hasBinaryUpdates, setHasBinaryUpdates] = useState(false);

  useEffect(() => {
    invoke<any>("get_startup_updates")
      .then((data) => {
        if (data.appUpdate?.available) {
          setAppUpdate({
            available: true,
            version: data.appUpdate.version,
            currentVersion: data.appUpdate.current_version || "",
            releaseNotes: data.appUpdate.release_notes || null,
          });
        }
        if (data.binaryUpdates && data.binaryUpdates.length > 0) {
          setHasBinaryUpdates(true);
        }
        // Cache binary updates for ProvidersConfig expanded section (avoids duplicate API calls)
        saveStartupUpdatesCache({
          timestamp: Date.now(),
          binaryUpdates: data.binaryUpdates || [],
        });
      })
      .catch(() => {}); // Silently ignore — don't block startup
  }, []);

  const handleInstallAppUpdate = useCallback(async () => {
    try {
      await invoke("install_app_update");
    } catch (err) {
      console.error("App update install failed:", err);
    }
  }, []);

  // Reload providers when nuclear button toggles group hidden state
  const reloadProviders = useCallback(async () => {
    try {
      const data = await invoke<ProviderConfig[]>("list_providers");
      setProviders(data);
    } catch (err) { console.error("Failed to reload providers:", err); }
  }, []);

  useEffect(() => {
    const handler = () => reloadProviders();
    window.addEventListener(EVENTS.reloadProviders, handler);
    return () => window.removeEventListener(EVENTS.reloadProviders, handler);
  }, [reloadProviders]);

  useTauriListen<{ phase: string }>("foundry-progress", (payload) => {
    if (payload.phase === "Complete") {
      void reloadProviders();
    }
  }, [reloadProviders]);

  const reloadModels = useCallback(async () => {
    try {
      setCatalogError(null);
      const data = await invoke<ModelEntry[]>("list_models");
      setModels(data);
    } catch (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      console.error("Failed to reload models:", msg);
      setCatalogError(msg);
    }
  }, []);

  useEffect(() => {
    const handler = () => { void reloadModels(); };
    window.addEventListener(EVENTS.downloadCompleted, handler);
    window.addEventListener(EVENTS.modelPathsChanged, handler);
    return () => {
      window.removeEventListener(EVENTS.downloadCompleted, handler);
      window.removeEventListener(EVENTS.modelPathsChanged, handler);
    };
  }, [reloadModels]);

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

  useTauriListen<{ scanned: number; failed: number }>("gguf-scan-complete", (payload) => {
    setBatchScanState((s) => ({ ...s, active: false, scanned: payload.scanned, failed: payload.failed }));
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

  const committedVramMib = useMemo(() => {
    return stack.reduce((sum, s) => {
      if (s.status === "RUNNING" && s.vram_mib) {
        return sum + s.vram_mib;
      }
      return sum;
    }, 0);
  }, [stack]);

  return (
    <FusionProvider stack={stack}>
    <ToastProvider>
      <ThemeProvider>
        <FoundryProvider>
          <TelemetryProvider pollingActive={activeTab === "telemetry"}>
            <StatusProvider value={{ totalParams, hiddenCount, onShowAll: handleShowAll }}>
            <Layout activeTab={activeTab} onTabChange={(tab) => { setActiveTab(tab); if (tab === "config") setHasBinaryUpdates(false); }} providers={providers} appUpdate={appUpdate} hasBinaryUpdates={hasBinaryUpdates} onInstallAppUpdate={handleInstallAppUpdate}>
        {activeTab === "catalog" && (
              <ModelCatalog models={models} onLaunch={handleLaunchEngine} error={catalogError} onReload={reloadModels} providers={providers} committedVramMib={committedVramMib} isPowerUser={isPowerUser} scanningPath={scanningPath} setScanningPath={setScanningPath} batchScanState={batchScanState} setBatchScanState={setBatchScanState} stack={stack} setupGuide={setupGuide} />
           )}
        <div className={`h-full min-h-0 flex flex-col ${activeTab === "modelhub" ? "" : "hidden"}`}>
          <ModelHub />
        </div>
        {activeTab === "config" && <ConfigPage providers={providers} setupGuide={setupGuide} />}
        {activeTab === "stack" && (
          <StackView stack={stack} logs={logs} systemEvents={systemEvents} onStop={handleStopEngine} onStopAll={handleStopAll} />
        )}
        {activeTab === "reactor11" && (
          <Reactor11 models={models} />
        )}
        {activeTab === "telemetry" && (
          <div className="h-full flex flex-col p-4 gap-3 min-h-0" data-telemetry-page>
            <TelemetryViewToggle mode={telemetryViewMode} onChange={setTelemetryViewMode} />
            <div className="flex-1 min-h-0">
              {telemetryViewMode === "lab" ? <TelemetryLab stack={stack} /> : <TelemetryPanel />}
            </div>
          </div>
        )}
        {activeTab === "intel" && <IntelPage />}
        {activeTab === "logs" && (
          <div className="h-full flex flex-col p-4 gap-0" data-engine-logs>
            <EngineLogsSwitcher
              activeLogSlot={activeLogSlot}
              onActiveLogSlotChange={setActiveLogSlot}
              logs={logs}
              stack={stack}
              logSearchBySlot={logSearchBySlot}
              onSlotLogSearchChange={setSlotLogSearch}
              onClearSlotLogSearch={clearSlotLogSearch}
              onClearSlotLogs={handleClearSlotLogs}
              onClearAllLogs={handleClearAllLogs}
              ansiEnabled={logsAnsiEnabled}
              onAnsiEnabledChange={(enabled) => {
                setLogsAnsiEnabled(enabled);
                saveLogsAnsiEnabled(enabled);
              }}
            />
            <div
              ref={logsScrollRef}
              className="engine-logs-scroll theme-surface-inset flex-1 overflow-x-hidden overflow-y-auto rounded-sm p-3 min-h-0"
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
                              <LogLineText
                                text={entry.text}
                                highlightQuery={lineQuery}
                                ansiEnabled={logsAnsiEnabled}
                              />
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
    </ThemeProvider>
    </ToastProvider>
    </FusionProvider>
  );
}

export default App;
