import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, StackEntry } from "../lib/types";

// ── Sentinel Protocol Types ────────────────────────────────────────────

interface SentinelTelemetryPayload {
  timestamp: number;
  tps: number;
  gpu_temp: number[];
  vram_used_mib: number[];
  vram_total_mib: number[];
  model_name: string;
  engine_status: string;
}

interface SentinelHeartbeatPayload {
  timestamp: number;
  status: string;
  uptime_seconds: number;
  connected_clients: number;
}

interface SentinelMessageData {
  type: string;
  payload: SentinelTelemetryPayload | SentinelHeartbeatPayload | Record<string, unknown>;
}

// ── Bridge Status State ────────────────────────────────────────────────

type BridgeStatus = "disconnected" | "connecting" | "connected" | "error";

interface TelemetryHistoryEntry {
  tps: number;
  gpu_temps: number[];
  vram_used: number[];
  timestamp: number;
}

// ── Component ──────────────────────────────────────────────────────────

const BRIDGE_URL = "ws://localhost:3814";

// Detect if running on mobile (external IP) vs desktop (localhost).
// When accessed from phone via LAN, the browser's location.host will be the PC's IP.
function resolveBridgeUrl(): string {
  try {
    const host = window.location?.host || "";
    // If the page is served from an external IP (mobile accessing PC), use that IP for WS.
    if (host && !host.startsWith("127.") && !host.startsWith("0.0.0.0") && host !== "localhost") {
      const ip = host.split(":")[0];
      return `ws://${ip}:3814`;
    }
  } catch {}
  return BRIDGE_URL;
}

const WS_URL = resolveBridgeUrl();
const MAX_HISTORY = 60;
const RECONNECT_INTERVAL = 5000;

interface TelemetryUpdateData {
  tps?: number;
  gpu_temps?: number[];
  vram_used_mib?: number[];
  vram_total_mib?: number[];
  engine_status?: string;
}

export default function MobileSentinelPage({ gpus, stack, onTelemetryUpdate }: { gpus: GpuInfo[]; stack: StackEntry[]; onTelemetryUpdate?: (data: TelemetryUpdateData) => void }) {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>("disconnected");
  const [wsUrl, setWsUrl] = useState(WS_URL);
  const [lastTelemetry, setLastTelemetry] = useState<SentinelTelemetryPayload | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<SentinelHeartbeatPayload | null>(null);
  const [telemetryHistory, setTelemetryHistory] = useState<TelemetryHistoryEntry[]>([]);
  const [bridgeRunning, setBridgeRunning] = useState(false);
  const [wsLog, setWsLog] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Bridge Control ───────────────────────────────────────────────────

  const addLog = useCallback((msg: string) => {
    setWsLog(prev => {
      const next = [...prev, `[${new Date().toLocaleTimeString("en-US", { hour12: false })}] ${msg}`];
      return next.slice(-50);
    });
  }, []);

  const handleStartBridge = useCallback(async () => {
    try {
      addLog("Starting Mobile Sentinel Bridge...");
      const result = await invoke<Record<string, unknown>>("cmd_mobile_bridge_start");
      setWsUrl(String(result.bind_addr || "0.0.0.0:3814"));
      setBridgeRunning(true);
      addLog(`Bridge started — ${result.bind_addr}`);
    } catch (err) {
      const msg = typeof err === "string" ? err : JSON.stringify(err);
      addLog(`Bridge start failed: ${msg}`);
    }
  }, [addLog]);

  const handleStopBridge = useCallback(async () => {
    try {
      addLog("Stopping Mobile Sentinel Bridge...");
      await invoke("cmd_mobile_bridge_stop");
      setBridgeRunning(false);
      addLog("Bridge stopped");
    } catch (err) {
      addLog(`Bridge stop failed: ${typeof err === "string" ? err : JSON.stringify(err)}`);
    }
  }, [addLog]);

  const handleCheckStatus = useCallback(async () => {
    try {
      const result = await invoke<Record<string, unknown>>("cmd_mobile_bridge_status");
      setBridgeRunning(Boolean(result.running));
      addLog(`Bridge status: ${result.running ? "RUNNING" : "STOPPED"} — ${result.bind_addr}`);
    } catch (err) {
      addLog(`Status check failed: ${typeof err === "string" ? err : JSON.stringify(err)}`);
    }
  }, [addLog]);

  // ── WebSocket Connection ─────────────────────────────────────────────

  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    setBridgeStatus("connecting");
    addLog(`Connecting to ${wsUrl}...`);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setBridgeStatus("connected");
      addLog("Sentinel bridge connected");
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const data: SentinelMessageData = JSON.parse(event.data as unknown as string);

        if (data.type === "welcome") {
          addLog(`Welcome: ${(data.payload as Record<string, unknown>).message}`);
          return;
        }

        if (data.type === "telemetry") {
          const tel = data.payload as SentinelTelemetryPayload;
          setLastTelemetry(tel);
          setTelemetryHistory(prev => {
            const entry: TelemetryHistoryEntry = {
              tps: tel.tps,
              gpu_temps: [...tel.gpu_temp],
              vram_used: [...tel.vram_used_mib],
              timestamp: tel.timestamp,
            };
            return [...prev, entry].slice(-MAX_HISTORY);
          });
        }

        if (data.type === "heartbeat") {
          setLastHeartbeat(data.payload as SentinelHeartbeatPayload);
        }

        if (data.type === "shutdown") {
          addLog("Bridge sent shutdown signal");
          ws.close();
        }
      } catch {
        // Non-JSON messages (pong, etc.) — ignore silently.
      }
    };

    ws.onclose = () => {
      setBridgeStatus("disconnected");
      addLog("Sentinel bridge disconnected");
      wsRef.current = null;
      scheduleReconnect();
    };

    ws.onerror = (e) => {
      console.error("[Sentinel] WebSocket ERROR:", e);
      setBridgeStatus("error");
      addLog("WebSocket error — check firewall allows inbound TCP 3814 to blackwell-ops.exe");
    };

    // Connection timeout — if no open event within 5s, abort.
    setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.CONNECTING) {
        console.warn("[Sentinel] WebSocket connection timed out after 5s");
        addLog("Connection timed out — Simplewall may be blocking WS handshake on port 3814");
        wsRef.current?.close();
      }
    }, 5000);
  }, [wsUrl, addLog]);

  const disconnectWebSocket = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setBridgeStatus("disconnected");
    addLog("Manually disconnected");
  }, [addLog]);

  const scheduleReconnect = useCallback(() => {
    reconnectTimerRef.current = setTimeout(() => {
      if (bridgeStatus !== "connected") {
        connectWebSocket();
      }
    }, RECONNECT_INTERVAL);
  }, [connectWebSocket, bridgeStatus]);

  // ── Push Telemetry to Bridge ─────────────────────────────────────────

  const pushLocalTelemetry = useCallback(() => {
    if (!bridgeRunning) return;

    const runningEngines = stack.filter(e => e.status.toLowerCase() === "running" || e.status.toLowerCase() === "serving");
    const avgTps = runningEngines.length > 0 ? 45.0 : 0.0; // Placeholder — real TPS from engine health checks
    const modelNames = runningEngines.map(e => e.model_name).join(", ") || "none";

    if (onTelemetryUpdate) {
      onTelemetryUpdate({
        tps: avgTps,
        gpu_temps: gpus.map(g => g.temperature_gpu as number),
        vram_used_mib: gpus.map(g => Math.round(g.memory_used / (1024 * 1024))),
        vram_total_mib: gpus.map(g => Math.round(g.memory_total / (1024 * 1024))),
        engine_status: runningEngines.length > 0 ? "generating" : "idle",
      });
    } else {
      invoke("cmd_mobile_bridge_push_telemetry", {
        tps: avgTps,
        gpu_temps: gpus.map(g => g.temperature_gpu as number),
        vram_used_mib: gpus.map(g => Math.round(g.memory_used / (1024 * 1024))),
        vram_total_mib: gpus.map(g => Math.round(g.memory_total / (1024 * 1024))),
        model_name: modelNames,
        engine_status: runningEngines.length > 0 ? "generating" : "idle",
      }).catch(() => {});
    }
  }, [bridgeRunning, stack, gpus, onTelemetryUpdate]);

  // ── Heartbeat Loop ───────────────────────────────────────────────────

  useEffect(() => {
    const interval = setInterval(() => {
      if (bridgeStatus === "connected") {
        pushLocalTelemetry();
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [bridgeStatus, pushLocalTelemetry]);

  // ── Cleanup ──────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // ── Derived State ────────────────────────────────────────────────────

  const engineCount = stack.filter(e => e.status.toLowerCase() === "running" || e.status.toLowerCase() === "serving").length;
  const latestTps = lastTelemetry?.tps ?? 0;
  const gpuTemps = gpus.map(g => g.temperature_gpu);
  const vramUsedMib = gpus.map(g => Math.round(g.memory_used / (1024 * 1024)));
  const vramTotalMib = gpus.map(g => Math.round(g.memory_total / (1024 * 1024)));

  // ── Helpers ──────────────────────────────────────────────────────────

  function tempColor(temp: number): string {
    if (temp < 50) return "text-nv-green";
    if (temp < 65) return "text-yellow-400";
    if (temp < 80) return "text-orange-400";
    return "text-red-400";
  }

  function vramHeatColor(pct: number): string {
    if (pct < 50) return "bg-nv-green";
    if (pct < 70) return "bg-yellow-400";
    if (pct < 85) return "bg-orange-400";
    return "bg-red-400";
  }

  function vramHeatText(pct: number): string {
    if (pct < 50) return "text-nv-green";
    if (pct < 70) return "text-yellow-400";
    if (pct < 85) return "text-orange-400";
    return "text-red-400";
  }

  function tpsColor(tps: number): string {
    if (tps > 60) return "text-nv-green";
    if (tps > 30) return "text-yellow-400";
    if (tps > 10) return "text-orange-400";
    return "text-red-400";
  }

  function historyBarColor(idx: number, total: number): string {
    const ratio = idx / total;
    if (ratio < 0.33) return "bg-nv-green/60";
    if (ratio < 0.66) return "bg-yellow-400/60";
    return "bg-red-400/60";
  }

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-stealth-border flex items-center justify-between flex-shrink-0 bg-stealth-dark/50">
        <div>
          <h2 className="text-xs font-mono text-nv-green tracking-wider">&#x2694; MOBILE SENTINEL BRIDGE</h2>
          <p className="text-[9px] font-mono text-stealth-muted mt-0.5">Xiaomi 11 Ultra — WebSocket Command Bridge (Port 3814)</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Bridge Controls */}
          {!bridgeRunning ? (
            <button onClick={handleStartBridge} className="px-3 py-1 text-[9px] font-mono border border-nv-green/40 text-nv-green hover:bg-nv-green/20 transition-colors">
              &#x25B6; START BRIDGE
            </button>
          ) : (
            <button onClick={handleStopBridge} className="px-3 py-1 text-[9px] font-mono border border-red-400/40 text-red-400 hover:bg-red-400/20 transition-colors">
              &#x25A0; STOP BRIDGE
            </button>
          )}
          <button onClick={handleCheckStatus} className="px-3 py-1 text-[9px] font-mono border border-stealth-border/40 text-stealth-muted hover:border-nv-green/30 hover:text-nv-green transition-colors">
            &#x25CC; STATUS
          </button>

          {/* WebSocket Connect */}
          {bridgeRunning && (
            <>
              {bridgeStatus !== "connected" ? (
                <button onClick={connectWebSocket} className="px-3 py-1 text-[9px] font-mono border border-yellow-400/40 text-yellow-400 hover:bg-yellow-400/20 transition-colors">
                  &#x1F517; CONNECT WS
                </button>
              ) : (
                <button onClick={disconnectWebSocket} className="px-3 py-1 text-[9px] font-mono border border-red-400/40 text-red-400 hover:bg-red-400/20 transition-colors">
                  &#x274C; DISCONNECT WS
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* ── Sentinel Status Bar ──────────────────────────────────────── */}
        <div className="mb-4 p-3 border rounded-sm bg-stealth-panel/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[9px] font-mono text-stealth-muted uppercase tracking-wider">BRIDGE STATUS</span>
            <span className={`text-xs font-mono px-2 py-0.5 border rounded-sm ${
              bridgeStatus === "connected" ? "border-nv-green/60 bg-nv-green/10 text-nv-green" :
              bridgeStatus === "connecting" ? "border-yellow-400/60 bg-yellow-400/10 text-yellow-400 animate-pulse" :
              bridgeStatus === "error" ? "border-red-400/60 bg-red-400/10 text-red-400" :
              "border-stealth-border/40 text-stealth-muted"
            }`}>
              {bridgeStatus === "connected" ? "\u2713 ONLINE" :
               bridgeStatus === "connecting" ? "\u25CF CONNECTING..." :
               bridgeStatus === "error" ? "\u2717 ERROR" :
               "\u25EF OFFLINE"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {bridgeRunning && (
              <>
                <span className="text-[9px] font-mono text-stealth-muted">BIND: <span className="text-white">{wsUrl}</span></span>
                <span className="text-[9px] font-mono text-stealth-muted">ENGINES: <span className={engineCount > 0 ? "text-nv-green" : "text-yellow-400/60"}>{engineCount} RUNNING</span></span>
              </>
            )}
          </div>
        </div>

        {/* ── Dual GPU VRAM Heatmaps ───────────────────────────────────── */}
        <div className="mb-4">
          <h3 className="text-[9px] font-mono text-stealth-muted uppercase tracking-wider mb-2">&#x1F5A5; VRAM HEATMAP — DUAL BLACKWELL</h3>
          {gpus.length === 0 ? (
            <div className="p-3 border border-stealth-border/40 rounded-sm bg-stealth-panel/50">
              <p className="text-[10px] font-mono text-stealth-muted/60 italic">NO GPU DATA — TELEMETRY POLLING IN PROGRESS</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {gpus.map((gpu, idx) => {
                const usedPct = gpu.memory_total > 0 ? (gpu.memory_used / gpu.memory_total) * 100 : 0;
                return (
                  <div key={idx} className="p-3 border border-stealth-border rounded-sm bg-stealth-panel/50">
                    <div className="flex items-center justify-between mb-2">
                      <span className={`text-[9px] font-mono ${tempColor(gpu.temperature_gpu)}`}>
                        GPU {idx}: {gpu.name}
                      </span>
                      <span className={`text-[10px] font-mono ${vramHeatText(usedPct)}`}>
                        {vramUsedMib[idx]} / {vramTotalMib[idx]} MiB ({Math.round(usedPct)}%)
                      </span>
                    </div>

                    {/* VRAM Heatmap Bar */}
                    <div className="w-full h-4 bg-stealth-black/80 border border-stealth-border/30 rounded-sm overflow-hidden mb-2">
                      <div
                        className={`h-full ${vramHeatColor(usedPct)} transition-all duration-500`}
                        style={{ width: `${Math.min(100, usedPct)}%` }}
                      />
                    </div>

                    {/* VRAM Segments */}
                    <div className="flex items-center gap-1 mb-2">
                      {Array.from({ length: 32 }).map((_, seg) => {
                        const segUsed = (usedPct / 100) * 32;
                        return (
                          <div
                            key={seg}
                            className={`flex-1 h-2 rounded-sm ${
                              seg < segUsed ? vramHeatColor(usedPct) : "bg-stealth-black/60 border border-stealth-border/20"
                            }`}
                          />
                        );
                      })}
                    </div>

                    {/* GPU Stats */}
                    <div className="grid grid-cols-3 gap-1 text-[8px] font-mono">
                      <div>
                        <span className="text-stealth-muted/50 block">TEMP</span>
                        <span className={tempColor(gpu.temperature_gpu)}>{gpu.temperature_gpu}&#x2109;</span>
                      </div>
                      <div>
                        <span className="text-stealth-muted/50 block">POWER</span>
                        <span className="text-white">{gpu.power_draw.toFixed(0)}W</span>
                      </div>
                      <div>
                        <span className="text-stealth-muted/50 block">UTIL</span>
                        <span className="text-nv-green">{gpu.utilization_gpu}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── TPS Gauge + Engine Status ────────────────────────────────── */}
        <div className="mb-4">
          <h3 className="text-[9px] font-mono text-stealth-muted uppercase tracking-wider mb-2">&#x26A1; TOKENS PER SECOND</h3>
          <div className="grid grid-cols-3 gap-3">
            {/* Main TPS Gauge */}
            <div className="col-span-1 p-4 border border-stealth-border rounded-sm bg-stealth-panel/50 flex flex-col items-center justify-center">
              <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider mb-2">CURRENT TPS</span>
              <span className={`text-3xl font-mono font-bold ${tpsColor(latestTps)}`}>
                {latestTps.toFixed(1)}
              </span>
              <span className="text-[8px] font-mono text-stealth-muted mt-1">TOKENS/SEC</span>
            </div>

            {/* TPS History */}
            <div className="col-span-2 p-3 border border-stealth-border rounded-sm bg-stealth-panel/50">
              <span className="text-[8px] font-mono text-stealth-muted block mb-2">TPS HISTORY (60s)</span>
              {telemetryHistory.length === 0 ? (
                <p className="text-[9px] font-mono text-stealth-muted/50 italic">WAITING FOR TELEMETRY STREAM...</p>
              ) : (
                <div className="flex items-end gap-px h-16">
                  {telemetryHistory.map((entry, idx) => {
                    const maxTps = Math.max(...telemetryHistory.map(e => e.tps), 1);
                    const heightPct = entry.tps > 0 ? (entry.tps / maxTps) * 100 : 2;
                    return (
                      <div
                        key={idx}
                        className={`flex-1 min-w-[2px] rounded-sm ${historyBarColor(idx, telemetryHistory.length)}`}
                        style={{ height: `${Math.max(4, heightPct)}%` }}
                        title={`${entry.tps.toFixed(1)} TPS`}
                      />
                    );
                  })}
                </div>
              )}

              {/* Engine Slots */}
              {stack.length > 0 && (
                <div className="mt-3">
                  <span className="text-[8px] font-mono text-stealth-muted block mb-1.5">ENGINE SLOTS</span>
                  <div className="space-y-1">
                    {stack.map(entry => (
                      <div key={entry.idx} className="flex items-center justify-between p-1.5 border border-stealth-border/30 rounded-sm bg-stealth-black/40">
                        <span className="text-[8px] font-mono text-white truncate max-w-[100px]" title={entry.alias}>{entry.alias}</span>
                        <span className={`text-[8px] font-mono ${
                          entry.status.toLowerCase() === "running" || entry.status.toLowerCase() === "serving" ? "text-nv-green" :
                          entry.status.toLowerCase() === "error" || entry.status.toLowerCase() === "failed" ? "text-red-400" :
                          "text-stealth-muted/50"
                        }`}>
                          {entry.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── GPU Temperature Gauges ───────────────────────────────────── */}
        <div className="mb-4">
          <h3 className="text-[9px] font-mono text-stealth-muted uppercase tracking-wider mb-2">&#x1F321; GPU TEMPERATURE ARRAY</h3>
          {gpuTemps.length === 0 ? (
            <div className="p-3 border border-stealth-border/40 rounded-sm bg-stealth-panel/50">
              <p className="text-[10px] font-mono text-stealth-muted/60 italic">NO TEMPERATURE DATA</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {gpuTemps.map((temp, idx) => (
                <div key={idx} className="p-3 border border-stealth-border rounded-sm bg-stealth-panel/50">
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[9px] font-mono ${tempColor(temp)}`}>GPU {idx}</span>
                    <span className={`text-lg font-mono font-bold ${tempColor(temp)}`}>{temp}&#x2109;</span>
                  </div>
                  {/* Temperature Bar */}
                  <div className="w-full h-3 bg-stealth-black/80 border border-stealth-border/30 rounded-sm overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        temp < 50 ? "bg-nv-green" :
                        temp < 65 ? "bg-yellow-400" :
                        temp < 80 ? "bg-orange-400" :
                        "bg-red-400"
                      }`}
                      style={{ width: `${Math.min(100, (temp / 100) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Sentinel Heartbeat Log ───────────────────────────────────── */}
        <div className="mb-4">
          <h3 className="text-[9px] font-mono text-stealth-muted uppercase tracking-wider mb-2">&#x1F4AC; SENTINEL HEARTBEAT</h3>
          {lastHeartbeat ? (
            <div className="p-3 border border-nv-green/20 rounded-sm bg-nv-green/5">
              <div className="grid grid-cols-4 gap-2 text-[9px] font-mono">
                <div>
                  <span className="text-stealth-muted/50 block">STATUS</span>
                  <span className={lastHeartbeat.status === "nominal" ? "text-nv-green" : lastHeartbeat.status === "thermal" ? "text-red-400" : "text-yellow-400"}>
                    {lastHeartbeat.status.toUpperCase()}
                  </span>
                </div>
                <div>
                  <span className="text-stealth-muted/50 block">UPTIME</span>
                  <span className="text-white">{Math.floor(lastHeartbeat.uptime_seconds / 60)}m {Math.floor(lastHeartbeat.uptime_seconds % 60)}s</span>
                </div>
                <div>
                  <span className="text-stealth-muted/50 block">CLIENTS</span>
                  <span className="text-nv-green">{lastHeartbeat.connected_clients}</span>
                </div>
                <div>
                  <span className="text-stealth-muted/50 block">LAST UPDATE</span>
                  <span className="text-white">{new Date(lastHeartbeat.timestamp).toLocaleTimeString("en-US", { hour12: false })}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 border border-stealth-border/40 rounded-sm bg-stealth-panel/50">
              <p className="text-[10px] font-mono text-stealth-muted/60 italic">NO HEARTBEAT DATA — CONNECT TO BRIDGE</p>
            </div>
          )}
        </div>

        {/* ── WebSocket Event Log ──────────────────────────────────────── */}
        <div>
          <h3 className="text-[9px] font-mono text-stealth-muted uppercase tracking-wider mb-2">&#x1F4DD; EVENT LOG</h3>
          <div className="p-2 border border-stealth-border rounded-sm bg-stealth-black/60 max-h-48 overflow-y-auto">
            {wsLog.length === 0 ? (
              <p className="text-[9px] font-mono text-stealth-muted/50 italic">NO EVENTS YET</p>
            ) : (
              wsLog.map((entry, idx) => (
                <p key={idx} className={`text-[8px] font-mono leading-relaxed ${
                  entry.includes("ERROR") || entry.includes("failed") ? "text-red-400" :
                  entry.includes("connected") || entry.includes("started") ? "text-nv-green" :
                  "text-stealth-muted/70"
                }`}>
                  {entry}
                </p>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-stealth-border flex items-center justify-between flex-shrink-0 bg-stealth-dark/50">
        <div className="flex items-center gap-3">
          <span className="text-[9px] font-mono text-stealth-muted">PROTOCOL: SENTINEL-V1</span>
          <span className="text-[9px] font-mono text-stealth-muted">WS: {wsUrl}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[9px] font-mono ${
            bridgeStatus === "connected" ? "text-nv-green" :
            bridgeStatus === "connecting" ? "text-yellow-400 animate-pulse" :
            "text-stealth-muted/50"
          }`}>
            {bridgeStatus === "connected" ? "\u2713 SENTINEL ACTIVE" :
             bridgeStatus === "connecting" ? "\u25CF SYNCING..." :
             "\u25EF STANDBY"}
          </span>
        </div>
      </div>
    </div>
  );
}
