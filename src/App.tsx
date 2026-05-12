import { useState, useEffect, useCallback, useMemo } from "react";
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
import { StatusProvider } from "./context/StatusBarContext";
import { ToastProvider } from "./components/Toast";
// SANITY-BOX — SanityEntry added to import
import type { GpuInfo, ModelEntry, StackEntry, LogBatch, LogEntry, SystemEvent, ProviderConfig, CpuInfo, SystemInfo, EnginePerfEvent, SanityEntry } from "./lib/types";

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
  const [gpus, setGpus] = useState<GpuInfo[]>([]);
  const [cpu, setCpu] = useState<CpuInfo | null>(null);
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [logs, setLogs] = useState<Map<number, LogEntry[]>>(new Map());
  const [systemEvents, setSystemEvents] = useState<Map<number, Array<{ text: string; timestamp: string }>>>(new Map());
  const [enginePerfEvents, setEnginePerfEvents] = useState<Map<number, EnginePerfEvent>>(new Map());

  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [scanningPath, setScanningPath] = useState<string | null>(null);
  const [batchScanState, setBatchScanState] = useState<{active: boolean; scanned: number; failed: number; total: number}>({ active: false, scanned: 0, failed: 0, total: 0 });
  const [totalParams, setTotalParams] = useState(0);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [lowPower, setLowPower] = useState(() => {
    try { return localStorage.getItem("BlackOps-low-power") === "true"; } catch { return false; }
  });
  const [isAdminUnlocked, setIsAdminUnlockedRaw] = useState(() => {
    try {
      const s = localStorage.getItem("BlackOps-admin-lock");
      return s === "unlocked" || s === "permanently";
    } catch { return false; }
  });

  // SANITY-BOX — captured console + Rust log entries
  const [sanityLog, setSanityLog] = useState<SanityEntry[]>([]);

  // Keep in sync with ConfigPage's cycleAdminLock
  useEffect(() => {
    const handler = () => {
      try {
        const s = localStorage.getItem("BlackOps-admin-lock");
        setIsAdminUnlockedRaw(s === "unlocked" || s === "permanently");
      } catch {}
    };
    window.addEventListener("storage", handler);
    // Also listen for custom event for same-tab updates — defer to avoid setState during render
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

  // SANITY-BOX — capture console.error / console.warn into state
  useEffect(() => {
    const origError = console.error;
    const origWarn = console.warn;

    const pushEntry = (level: 'error' | 'warn', args: unknown[]) => {
      const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      setSanityLog(prev => [...prev, {
        source: 'js' as const,
        level,
        text,
        timestamp: new Date().toISOString().substring(11, 20).replace('T', ''),
      }].slice(-500));
    };

    console.error = ((...args: unknown[]) => { pushEntry('error', args); origError.apply(console, args); }) as any;
    console.warn = ((...args: unknown[]) => {
      const text = args.map(a => String(a)).join(' ');
      pushEntry('warn', args);
      // Suppress [SCENARIO] logs from browser console — they're visible in SANITY box already
      if (!text.startsWith('[SCENARIO]')) {
        origWarn.apply(console, args);
      }
    }) as any;

    return () => {
      console.error = origError;
      console.warn = origWarn;
    };
  }, []);

  // SANITY-BOX — listen for Rust-side sanity log events
  useEffect(() => {
    let unsub: (() => void) | null = null;
    const cleanup = () => { if (unsub) unsub(); };
    listen("sanity-log", (e: any) => {
      const p = e.payload as SanityEntry;
      if (p && p.text) {
        setSanityLog(prev => [...prev, p].slice(-500));
      }
    }).then((u) => { unsub = u; });
    return cleanup;
  }, []);

  const toggleLowPower = useCallback(() => {
    setLowPower((prev) => {
      const next = !prev;
      try { localStorage.setItem("BlackOps-low-power", String(next)); } catch {}
      return next;
    });
  }, []);

  // Show all hidden values — clears ALL BlackOps-* keys from localStorage
  const handleShowAll = useCallback(() => {
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("BlackOps-")) {
          localStorage.removeItem(key);
        }
      }
      window.dispatchEvent(new CustomEvent("param-config-changed"));
    } catch {}
  }, []);

  // Listen for param config changes from ConfigPage to update status bar counts and re-fetch providers
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
    window.addEventListener("param-config-changed", handler);
    return () => window.removeEventListener("param-config-changed", handler);
  }, []);

  // Reload models when a download completes
  useEffect(() => {
    const handler = () => {
      invoke<ModelEntry[]>("list_models")
        .then(data => setModels(data as ModelEntry[]))
        .catch(() => {});
    };
    window.addEventListener("download-completed", handler);
    return () => window.removeEventListener("download-completed", handler);
  }, []);

  // Load models on mount
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

  // Load providers on mount
  useEffect(() => {
    invoke<ProviderConfig[]>("list_providers")
      .then((data) => setProviders(data))
      .catch(console.error);
  }, []);

  // Load system info once (static, not polled)
  useEffect(() => {
    invoke<SystemInfo>("scan_system_info")
      .then((data) => setSystemInfo(data))
      .catch(console.error);
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
    }
  }, []);

  // Consolidated telemetry polling — GPU + CPU with configurable intervals
  useEffect(() => {
    const gpuInterval = lowPower ? 2000 : 250;
    const cpuInterval = lowPower ? 5000 : 500;

    let gpuTimer: ReturnType<typeof setInterval> | null = null;
    let cpuTimer: ReturnType<typeof setInterval> | null = null;
    let paused = false;

    const pollGpu = async () => {
      if (paused) return;
      try { setGpus(await invoke<GpuInfo[]>("scan_gpus")); } catch {}
    };
    const pollCpu = async () => {
      if (paused) return;
      try { setCpu(await invoke<CpuInfo>("scan_cpu")); } catch {}
    };

    const startPolling = async () => {
      paused = false;
      pollGpu();
      pollCpu();
      gpuTimer = setInterval(pollGpu, gpuInterval);
      cpuTimer = setInterval(pollCpu, cpuInterval);
    };

    const stopPolling = async () => {
      paused = true;
      if (gpuTimer) clearInterval(gpuTimer);
      if (cpuTimer) clearInterval(cpuTimer);
      gpuTimer = null;
      cpuTimer = null;
    };

    startPolling();

    const handleVisibility = async () => {
      if (document.visibilityState === "visible") {
        await startPolling();
      } else {
        await stopPolling();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (gpuTimer) clearInterval(gpuTimer);
      if (cpuTimer) clearInterval(cpuTimer);
    };
  }, [lowPower]);

  // Listen for batched log events (throttled at 100ms from Rust LogHub)
  useEffect(() => {
    let unsub: (() => void) | null = null;
    const cleanup = () => { if (unsub) unsub(); };
    console.log("[APP] engine-log-batch listener registered");
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
              return next;
            });
          } catch {}
        });
      }
    }).then((u) => { unsub = u; });

    return cleanup;
  }, []);

  // Listen for system events (launch debug, errors) from Rust LogHub
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

  // Listen for slot-cleared events — clear only the stopped slot's logs (no race condition)
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
          }
        } catch {}
      });
    }).then((u) => { unsub = u; });

    return cleanup;
  }, []);

  // Listen for Engine Performance Pulse events (TPS, TTFT, FuelTank KV cache %)
  useEffect(() => {
    let unsub: (() => void) | null = null;
    const cleanup = () => { if (unsub) unsub(); };
    console.log("[APP] engine-perf listener registered");
    listen("engine-perf", (e: any) => {
      const payload = e.payload as EnginePerfEvent;
      console.log("[APP] received engine-perf event:", payload?.slot, "tps:", payload?.tps);
      unstable_batchedUpdates(() => {
        try {
          if (payload && payload.slot !== undefined) {
            setEnginePerfEvents((prev) => {
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

  // GGUF scan progress listeners — persist across tab switches
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

  // Poll stack status periodically (2s interval)
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await invoke<StackEntry[]>("get_stack_status");
        setStack(data);
      } catch {}
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleLaunchEngine = useCallback(
    async (config: any) => {
      try {
        await invoke("launch_engine", { config });
        if (activeTab === "stack") {
          const data = await invoke<StackEntry[]>("get_stack_status");
          setStack(data);
        }
      } catch (err) {
        console.error("Launch failed:", err);
      }
    },
    [activeTab]
  );

  const handleStopEngine = useCallback(async (alias: string) => {
    try {
      await invoke("stop_engine", { alias });
      // Clear AFTER backend returns — processes are dead, no late arrivals possible
      setLogs(new Map());
      setSystemEvents(new Map());
      setEnginePerfEvents(new Map());
      const data = await invoke<StackEntry[]>("get_stack_status");
      setStack(data);
    } catch (err) {
      console.error("Stop failed:", err);
    }
  }, []);

  const handleStopAll = useCallback(async () => {
    try {
      await invoke("stop_all_engines");
      // Clear AFTER backend returns — processes are dead, no late arrivals possible
      setLogs(new Map());
      setSystemEvents(new Map());
      setEnginePerfEvents(new Map());
      setStack([]);
    } catch (err) {
      console.error("Stop all failed:", err);
    }
  }, []);

  // Logs are already flat — just add alias for display (cap at 500 per slot for performance)
  const flatLogs = useMemo(() => {
    const result: Map<number, Array<{ text: string; timestamp: string; alias: string }>> = new Map();
    for (const [slot, entries] of logs.entries()) {
      result.set(slot, entries.slice(-500).map((e) => ({ text: e.text, timestamp: e.timestamp, alias: e.alias })));
    }
    return result;
  }, [logs]);

  // Committed VRAM from running engines + OS overhead per GPU
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
      <StatusProvider value={{ totalParams, hiddenCount, onShowAll: handleShowAll }}>
        <Layout activeTab={activeTab} onTabChange={setActiveTab}>
        {activeTab === "catalog" && (
              <ModelCatalog models={models} gpus={gpus} onLaunch={handleLaunchEngine} error={catalogError} onReload={reloadModels} providers={providers} committedVramMib={committedVramMib} isAdminUnlocked={isAdminUnlocked} systemInfo={systemInfo} scanningPath={scanningPath} setScanningPath={setScanningPath} batchScanState={batchScanState} setBatchScanState={setBatchScanState} stack={stack} /* SANITY-BOX */ sanityLog={sanityLog} />
           )}
        {activeTab === "modelhub" && <ModelHub />}
        {activeTab === "config" && <ConfigPage providers={providers} />}
        {activeTab === "stack" && (
          <StackView stack={stack} logs={logs} systemEvents={systemEvents} enginePerfEvents={enginePerfEvents} onStop={handleStopEngine} onStopAll={handleStopAll} />
        )}
        {activeTab === "reactor11" && (
          <Reactor11 gpus={gpus} models={models} />
        )}
        {activeTab === "telemetry" && (
          <div className="h-full flex flex-col p-4 gap-3">
            <TelemetryPanel gpus={gpus} cpu={cpu} systemInfo={systemInfo} lowPower={lowPower} onToggleLowPower={toggleLowPower} />
          </div>
        )}
        {activeTab === "logs" && (
          <div className="h-full flex flex-col p-4">
            <h2 className="text-xs font-mono text-nv-green tracking-wider mb-3">ENGINE LOGS</h2>
            <div className="flex-1 overflow-y-auto bg-stealth-panel border border-stealth-border rounded-sm p-3">
              {flatLogs.size === 0 ? (
                <p className="text-[10px] font-mono text-stealth-muted/50 italic">NO LOGS YET — LAUNCH AN ENGINE TO SEE OUTPUT</p>
              ) : (
                Array.from(flatLogs.entries())
                  .sort(([a], [b]) => a - b)
                  .map(([slot, entries]) => (
                    <div key={slot} className="mb-4">
                      <h3 className="text-[10px] font-mono text-nv-green/80 mb-1 border-b border-stealth-border pb-1">
                        SLOT {slot} ({entries.length} lines)
                      </h3>
                      <div className="space-y-0.5">
                        {entries.map((entry, i) => (
                          <p key={i} className="text-[10px] font-mono text-stealth-muted leading-relaxed">
                            <span className="text-stealth-muted/40">{entry.timestamp}</span>{" "}
                            <span className="text-nv-green/60">[{entry.alias}]</span>{" "}
                            {entry.text}
                          </p>
                        ))}
                      </div>
                    </div>
                  ))
              )}
            </div>
          </div>
        )}
        {activeTab === "sentinel" && <MobileSentinelPage gpus={gpus} stack={stack} />}
      </Layout>
    </StatusProvider>
    </ToastProvider>
  );
}

export default App;
