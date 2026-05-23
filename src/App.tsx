import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { unstable_batchedUpdates } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import Layout from "./components/Layout";
import StackView from "./components/StackView";
import ModelCatalog from "./components/ModelCatalog";
import TelemetryPanel from "./components/TelemetryPanel";
import ConfigPage from "./components/ConfigPage";
import MobileSentinelPage from "./components/MobileSentinelPage";
import Reactor11 from "./components/Reactor11";
import ModelHub from "./components/ModelHub";
import AnsiText from "./components/AnsiText";
import { StatusProvider } from "./context/StatusBarContext";
import { DockProvider } from "./context/DockContext";
import { TelemetryProvider } from "./context/TelemetryContext";
import { ToastProvider } from "./components/Toast";
import { KEYS, STORAGE_PREFIX } from "./lib/storage";
import type { ModelEntry, StackEntry, LogBatch, LogEntry, SystemEvent, ProviderConfig, EnginePerfEvent, FusionUpdate } from "./lib/types";

export type Tab = "catalog" | "modelhub" | "stack" | "reactor11" | "telemetry" | "logs" | "config" | "sentinel";

function isMobileDevice(): boolean {
  try {
    const width = window.innerWidth;
    if (width <= 768) return true;
    const ua = navigator.userAgent.toLowerCase();
    return /android|iphone|ipad|ipod|mobi/i.test(ua);
  } catch {
    return false;
  }
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("catalog");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [logs, setLogs] = useState<Map<number, LogEntry[]>>(new Map());
  const [systemEvents, setSystemEvents] = useState<Map<number, Array<{ text: string; timestamp: string }>>>(new Map());
  const [enginePerfEvents, setEnginePerfEvents] = useState<Map<number, EnginePerfEvent>>(new Map());
  const [fusionUpdates, setFusionUpdates] = useState<Map<number, FusionUpdate>>(new Map());

  const [activeLogSlot, setActiveLogSlot] = useState<number | "all">("all");
  const logsScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const prevLogSlotsRef = useRef<Set<number>>(new Set());

  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [batchScanState, setBatchScanState] = useState<{active: boolean; scanned: number; failed: number; total: number}>({ active: false, scanned: 0, failed: 0, total: 0 });
  const [totalParams, setTotalParams] = useState(0);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [lowPower, setLowPower] = useState(() => {
    try { return localStorage.getItem(KEYS.lowPower) === "true"; } catch { return false; }
  });
  const [isAdminUnlocked, setIsAdminUnlockedRaw] = useState(() => {
    try {
      const s = localStorage.getItem(KEYS.adminLock);
      return s === "unlocked" || s === "permanently";
    } catch { return false; }
  });

  useEffect(() => {
    const handler = () => {
      try {
        const s = localStorage.getItem(KEYS.adminLock);
        setIsAdminUnlockedRaw(s === "unlocked" || s === "permanently");
      } catch {}
    };
    window.addEventListener("storage", handler);
    const adminHandler = () => requestAnimationFrame(handler);
    window.addEventListener("admin-lock-changed", adminHandler);
    // Navigate to ENGINES tab from GPU topo engine table clicks
    const navHandler = () => setActiveTab("stack");
    window.addEventListener("blackops-navigate-stack", navHandler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("admin-lock-changed", adminHandler);
      window.removeEventListener("blackops-navigate-stack", navHandler);
    };
  }, []);

  const toggleLowPower = useCallback(() => {
    setLowPower((prev) => {
      const next = !prev;
      try { localStorage.setItem(KEYS.lowPower, String(next)); } catch {}
      return next;
    });
  }, []);

  const handleShowAll = useCallback(() => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(STORAGE_PREFIX)) {
          localStorage.removeItem(key);
        }
      }
      window.dispatchEvent(new CustomEvent("param-config-changed"));
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
            .then((data) => setProviders(prev => {
              if (prev.length === data.length && prev.every((p, i) => p.id === data[i].id)) return prev;
              return data;
            }))
            .catch(() => {});
          pending = false;
        });
      }
    };
    window.addEventListener("param-config-changed", handler);
    return () => window.removeEventListener("param-config-changed", handler);
  }, []);

  useEffect(() => {
    const handler = () => {
      invoke<ModelEntry[]>("list_models")
        .then(data => setModels(data as ModelEntry[]))
        .catch(() => {});
    };
    window.addEventListener("download-completed", handler);
    return () => window.removeEventListener("download-completed", handler);
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

  // Reload providers when nuclear button toggles group hidden state
  const reloadProviders = useCallback(async () => {
    try {
      const data = await invoke<ProviderConfig[]>("list_providers");
      setProviders(data);
    } catch (err) { console.error("Failed to reload providers:", err); }
  }, []);

  useEffect(() => {
    const handler = () => reloadProviders();
    window.addEventListener("blackops-reload-providers", handler);
    return () => window.removeEventListener("blackops-reload-providers", handler);
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
    let unsub: (() => void) | null = null;
    const cleanup = () => { if (unsub) unsub(); };
    listen("engine-log-batch", (e: any) => {
      const payload = e.payload;
      if (payload && payload.slot !== undefined && payload.entries?.length > 0) {
        unstable_batchedUpdates(() => {
          try {
            const batch = payload as LogBatch;
            setLogs((prev) => {
              const next = new Map(prev);
              const existing = next.get(batch.slot) || [];
              const updated = [...existing, ...batch.entries].slice(-5000);
              next.set(batch.slot, updated);
              // Auto-select new slot on first batch
              if (!prev.has(batch.slot)) {
                setActiveLogSlot(batch.slot);
              }
              return next;
            });
          } catch {}
        });
      }
    }).then((u) => { unsub = u; });

    return cleanup;
  }, []);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    const cleanup = () => { if (unsub) unsub(); };
    listen("engine-system", (e: any) => {
      const payload = e.payload as SystemEvent;
      try {
        if (payload && payload.slot !== undefined && payload.text) {
          // Strip ANSI codes before checking prefix — ConPTY may inject them anywhere
          const cleanText = payload.text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\[[0-9;]+[A-Za-z]/g, "");
          if (cleanText.includes("LAUNCH_ERROR:")) {
            const reason = cleanText.split("LAUNCH_ERROR:").slice(1).join(":").trim();
            window.dispatchEvent(new CustomEvent("blackops-launch-error", {
              detail: { message: reason }
            }));
          }
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
    }).then((u) => { unsub = u; });

    return cleanup;
  }, []);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    const cleanup = () => { if (unsub) unsub(); };
    listen("slot-cleared", (e: any) => {
      const payload = e.payload as { slot: number };
      unstable_batchedUpdates(() => {
        try {
          if (payload && payload.slot !== undefined) {
            setLogs((prev) => {
              const next = new Map(prev);
              next.delete(payload.slot);
              return next;
            });
            setSystemEvents((prev) => {
              const next = new Map(prev);
              next.delete(payload.slot);
              return next;
            });
            setEnginePerfEvents((prev) => {
              const next = new Map(prev);
              next.delete(payload.slot);
              return next;
            });
            // Reset active tab if cleared slot was selected
            setActiveLogSlot((prev) => (prev === payload.slot ? "all" : prev));
          }
        } catch {}
      });
    }).then((u) => { unsub = u; });

    return cleanup;
  }, []);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    const cleanup = () => { if (unsub) unsub(); };
    listen("engine-perf", (e: any) => {
      const payload = e.payload as EnginePerfEvent;
      unstable_batchedUpdates(() => {
        try {
          if (payload && payload.slot !== undefined) {
            setEnginePerfEvents((prev) => {
              const existing = prev.get(payload.slot);
              // Skip update if TPS and TTFT haven't changed meaningfully — prevents 5x/sec re-render churn during idle generation.
              if (existing && Math.abs(existing.tps - payload.tps) < 1 && Math.abs((existing.ttft_ms ?? 0) - (payload.ttft_ms ?? 0)) < 5) return prev;
              const next = new Map(prev);
              next.set(payload.slot, payload);
              return next;
            });
          }
        } catch {}
      });
    }).then((u) => { unsub = u; });

    return cleanup;
  }, []);

  // Fusion real-time /slots poller data — source of truth for TG TPS
  useEffect(() => {
    let unsub: (() => void) | null = null;
    const cleanup = () => { if (unsub) unsub(); };
    listen("fusion-update", (e: any) => {
      const payload = e.payload as FusionUpdate;
      try {
        if (payload && payload.slotIdx !== undefined) {
          setFusionUpdates((prev) => {
            const next = new Map(prev);
            next.set(payload.slotIdx, payload);
            return next;
          });
        }
      } catch {}
    }).then((u) => { unsub = u; });

    return cleanup;
  }, []);

  useEffect(() => {
    let unsubProgress: (() => void) | null = null;
    let unsubComplete: (() => void) | null = null;

    listen("gguf-scan-progress", (e: any) => {
      const p = e.payload as { scanned: number; failed: number };
      setBatchScanState(s => ({ ...s, scanned: p.scanned, failed: p.failed }));
    }).then(u => { unsubProgress = u; });

    listen("gguf-scan-complete", (e: any) => {
      const p = e.payload as { scanned: number; failed: number };
      setBatchScanState(s => ({ ...s, active: false, scanned: p.scanned, failed: p.failed }));
      // Reload models after scan completes
      invoke("list_models").then(data => setModels(data as ModelEntry[])).catch(() => {});
    }).then(u => { unsubComplete = u; });

    return () => {
      unsubProgress?.();
      unsubComplete?.();
    };
  }, []);

  useEffect(() => {
    // Push-based stack updates — Rust emits "stack-changed" on every status transition.
    // No polling needed: launch, readiness (LOADING→RUNNING), and stop all emit instantly.
    let unsub: (() => void) | null = null;
    const cleanup = () => { if (unsub) unsub(); };

    listen("stack-changed", (e: any) => {
      setStack(e.payload as StackEntry[]);
    }).then((u) => { unsub = u; });

    // Initial load — fetch current state on mount
    invoke<StackEntry[]>("get_stack_status")
      .then(data => setStack(data))
      .catch(() => {});

    return cleanup;
  }, []);

  const handleLaunchEngine = useCallback(
    async (config: any) => {
      try {
        const result: any = await invoke("launch_engine", { config });
        // Dispatch event for catalog to pick up the launched slot index + model path.
        // Stack update comes via push event from Rust — no manual setStack needed.
        window.dispatchEvent(new CustomEvent("blackops-engine-launched", {
          detail: { slotIdx: result.idx, modelPath: result.model_path }
        }));
      } catch (err) {
        console.error("Launch failed:", err);
      }
    },
    []
  );

  const handleStopEngine = useCallback(async (alias: string) => {
    try {
      await invoke("stop_engine", { alias });
      // Keep logs + system events so shutdown messages stay visible
      setEnginePerfEvents(new Map());
      // Stack update comes via push event from Rust — no manual setStack needed.
    } catch (err) {
      console.error("Stop failed:", err);
    }
  }, []);

  const handleStopAll = useCallback(async () => {
    try {
      await invoke("stop_all_engines");
      // Keep logs + system events so shutdown messages stay visible
      setEnginePerfEvents(new Map());
      // Signal catalog to clear engine selection
      window.dispatchEvent(new CustomEvent("blackops-stop-all"));
      // Stack update comes via push event from Rust — no manual setStack needed.
    } catch (err) {
      console.error("Stop all failed:", err);
    }
  }, []);

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
  }, []);

  const flatLogsRef = useRef<Map<number, Array<{ text: string; alias: string }>>>(new Map());
  const logsLengthsRef = useRef<Record<number, number>>({});

  const flatLogs = useMemo(() => {
    const result = new Map();
    for (const [slot, entries] of logs.entries()) {
      const len = entries.length;
      // Only recompute slice+map when entry count changed by 10+ — avoids expensive allocation on every log append.
      if (logsLengthsRef.current[slot] !== undefined && Math.abs(len - logsLengthsRef.current[slot]) < 10) {
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
    <ToastProvider>
      <DockProvider>
        <TelemetryProvider lowPower={lowPower}>
          <StatusProvider value={{ totalParams, hiddenCount, onShowAll: handleShowAll }}>
            <Layout activeTab={activeTab} onTabChange={setActiveTab} providers={providers}>
        {activeTab === "catalog" && (
              <ModelCatalog models={models} onLaunch={handleLaunchEngine} error={catalogError} onReload={reloadModels} providers={providers} committedVramMib={committedVramMib} isAdminUnlocked={isAdminUnlocked} scanningPath={scanningPath} setScanningPath={setScanningPath} batchScanState={batchScanState} setBatchScanState={setBatchScanState} stack={stack} />
           )}
        {activeTab === "modelhub" && <ModelHub />}
        {activeTab === "config" && <ConfigPage providers={providers} />}
        {activeTab === "stack" && (
          <StackView stack={stack} logs={logs} systemEvents={systemEvents} enginePerfEvents={enginePerfEvents} fusionUpdates={fusionUpdates} onStop={handleStopEngine} onStopAll={handleStopAll} />
        )}
        {activeTab === "reactor11" && (
          <Reactor11 models={models} />
        )}
        {activeTab === "telemetry" && (
          <div className="h-full flex flex-col p-4 gap-3">
            <TelemetryPanel lowPower={lowPower} onToggleLowPower={toggleLowPower} />
          </div>
        )}
        {activeTab === "logs" && (
          <div className="h-full flex flex-col p-4 gap-0">
            <h2 className="text-xs font-mono text-nv-green tracking-wider mb-2 flex-shrink-0">ENGINE LOGS</h2>
            <div className="sticky top-0 z-10 bg-[#0a0f08] flex items-end gap-1 mb-2 flex-shrink-0 pb-2 pl-2 overflow-x-auto">
              <div className="flex flex-col items-start gap-0.5">
                <div className="w-full h-[22px]" />
                <button
                  onClick={() => setActiveLogSlot("all")}
                  className={`px-2 py-0.5 text-[9px] font-mono rounded-sm value-chip whitespace-nowrap focus:outline-none ${activeLogSlot === "all" ? "value-chip-active" : ""}`}
                >
                  ALL
                </button>
              </div>
              {Array.from(logs.entries())
                .sort(([a], [b]) => a - b)
                .map(([slot, entries]) => {
                  const stackEntry = stack.find((s) => s.idx === slot);
                  const label = stackEntry?.alias || `SLOT ${slot}`;
                  const status = stackEntry?.status;
                  const isRunning = status === "RUNNING" || status === "LOADING";
                  return (
                    <div key={slot} className="flex flex-col items-start gap-0.5">
                      <button
                        onClick={() => handleClearSlotLogs(slot)}
                        className="px-2 py-0.5 text-[8px] font-mono rounded-sm border border-red-400/30 text-red-400/60 hover:border-red-400/60 hover:text-red-400 transition-all focus:outline-none whitespace-nowrap"
                      >
                        CLEAR
                      </button>
                      <button
                        onClick={() => setActiveLogSlot(slot)}
                        className={`px-2 py-0.5 text-[9px] font-mono rounded-sm value-chip whitespace-nowrap focus:outline-none ${activeLogSlot === slot ? "value-chip-active" : ""}`}
                      >
                        <span className={`inline-block w-1 h-1 rounded-full mr-1 ${isRunning ? "bg-emerald-400" : "bg-stealth-muted/40"}`} />
                        {label} <span className="opacity-50">({entries.length})</span>
                      </button>
                    </div>
                  );
                })}
            </div>
            <div className="flex items-center justify-end mb-1 flex-shrink-0">
              <button
                onClick={() => setLogs(new Map())}
                className="px-2 py-0.5 text-[9px] font-mono text-stealth-muted hover:text-red-400 transition-colors disabled:opacity-20"
                disabled={logs.size === 0}
              >
                CLEAR ALL
              </button>
            </div>
            <div
              ref={logsScrollRef}
              className="flex-1 overflow-y-auto bg-stealth-panel border border-stealth-border rounded-sm p-3 min-h-0"
              onScroll={handleLogsScroll}
            >
              {logs.size === 0 ? (
                <p className="text-[10px] font-mono text-stealth-muted/50 italic">NO LOGS YET — LAUNCH AN ENGINE TO SEE OUTPUT</p>
              ) : (
                (() => {
                  const slotKeys = activeLogSlot === "all"
                    ? Array.from(logs.keys()).sort((a, b) => a - b)
                    : logs.has(activeLogSlot) ? [activeLogSlot] : [];
                  if (slotKeys.length === 0) return <p className="text-[10px] font-mono text-stealth-muted/50 italic">NO LOGS FOR SELECTED SLOT</p>;
                  return slotKeys.flatMap((slot, si) => {
                    const entries = flatLogs.get(slot) || [];
                    const stackEntry = stack.find((s) => s.idx === slot);
                    const alias = stackEntry?.alias || entries[0]?.alias || `SLOT ${slot}`;
                    return (
                      <>
                        {activeLogSlot === "all" && (
                          <div key={`h-${slot}`} className="mb-2 mt-2 first:mt-0">
                            <div className="text-[10px] font-mono text-nv-green/80 border-b border-stealth-border pb-1">
                              {alias} <span className="text-stealth-muted/40">({entries.length} lines)</span>
                            </div>
                          </div>
                        )}
                        <div key={`e-${slot}`} className="space-y-0.5">
                          {entries.map((entry, i) => (
                            <p key={i} className="text-[10px] font-mono text-stealth-muted leading-relaxed whitespace-nowrap overflow-x-auto">
                              {activeLogSlot === "all" && <span className="text-nv-green/60">[{entry.alias}] </span>}
                              <AnsiText text={entry.text} />
                            </p>
                          ))}
                        </div>
                      </>
                    );
                  });
                })()
              )}
            </div>
          </div>
        )}
        {activeTab === "sentinel" && <MobileSentinelPage stack={stack} />}
            </Layout>
          </StatusProvider>
        </TelemetryProvider>
      </DockProvider>
    </ToastProvider>
  );
}

export default App;
