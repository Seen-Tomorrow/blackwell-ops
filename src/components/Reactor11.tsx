import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, ModelEntry } from "../lib/types";
import type { R11Status, R11RodHandle, R11PredictiveFit } from "../lib/reactor11";
import R11_Core from "./R11_Core";
import R11_CoreGemini from "./R11_CoreGemini";
import R11_Sidebar from "./R11_Sidebar";
import R11_Wells from "./R11_Wells";
import R11_DiagnosticOverlay from "./R11_DiagnosticOverlay";

interface Props {
  gpus: GpuInfo[];
  models: ModelEntry[];
}

export default function Reactor11({ gpus, models }: Props) {
  const [rods, setRods] = useState<R11RodHandle[]>([]);
  const [tierEnabled, setTierEnabled] = useState(false);
  const [diagnosticMode, setDiagnosticMode] = useState(false);
  const [coreDesign, setCoreDesign] = useState<"lattice" | "gemini">("lattice");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [draggedModel, setDraggedModel] = useState<ModelEntry | null>(null);
  const [predictiveFit, setPredictiveFit] = useState<R11PredictiveFit | null>(null);

  // Mock simulation sliders
  const [mockTempEnabled, setMockTempEnabled] = useState(false);
  const [mockTemp, setMockTemp] = useState(30);
  const [mockLevelEnabled, setMockLevelEnabled] = useState(false);
  const [mockLevel, setMockLevel] = useState(50);

  // Compute thermal criticality
  const isCritical = useMemo(() => {
    if (gpus.length === 0) return false;
    const maxTemp = Math.max(...gpus.map(g => g.temperature_gpu || 30));
    const hotSpotMax = Math.max(...gpus.map(g => (g.temperature_hot_spot ?? g.temperature_gpu) || 30));
    return Math.max(maxTemp, hotSpotMax) >= 80;
  }, [gpus]);

  // Load reactor state on mount
  useEffect(() => {
    invoke<R11Status>("r11_get_status")
      .then((s) => {
        setRods(s.rods);
        setTierEnabled(s.tier_enabled);
      })
      .catch(console.error);
  }, []);

  const totalVramUsed = rods.reduce((sum, r) => sum + (r.vram_mib || 0), 0);
  const maxTotalVram = gpus.length > 0 ? gpus.reduce((sum, g) => sum + g.memory_total, 0) : 196608;

  // Auto-retract sidebar on drag start
  const handleDragStart = useCallback((model: ModelEntry) => {
    setDraggedModel(model);
    setSidebarCollapsed(true);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedModel(null);
    setPredictiveFit(null);
  }, []);

  const insertModel = useCallback(async (model: ModelEntry) => {
    try {
      const config = {
        alias: `${model.name} (${model.quant})`,
        model_path: model.path,
        port: 0,
        device: "GPU-0",
        kv_quant: model.quant.toLowerCase().includes("q4") ? "Q4_K" : "F16",
        ctx_size: "32K",
        batch: 2048,
        ubatch: 512,
        parallel: 1,
        offload: "ALL",
        offload_mode: "REGULAR",
        split_mode: "",
        vision: model.vision ? "AUTO" : "OFF",
        flash_attn: true,
        jinja: false,
        cont_batching: true,
        metrics: false,
        reasoning: false,
        mmap: true,
        extra_params: {},
      };

      const rod = await invoke<R11RodHandle>("r11_insert_rod", { config, gpus });
      setRods((prev) => [...prev, rod]);
    } catch (err) {
      console.error("Insert failed:", err);
    }
  }, [gpus]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    if (!draggedModel) return;
    await insertModel(draggedModel);
    setDraggedModel(null);
    setPredictiveFit(null);
  }, [draggedModel, insertModel]);

  const handleRemoveRod = useCallback(async (rodId: string) => {
    try {
      await invoke("r11_remove_rod", { rodId });
      setRods((prev) => prev.filter((r) => r.id !== rodId));
    } catch (err) {
      console.error("Remove failed:", err);
    }
  }, []);

  const handleToggleTier = useCallback(async () => {
    try {
      const enabled = await invoke<boolean>("r11_toggle_tier");
      setTierEnabled(enabled);
    } catch (err) {
      console.error("Toggle tier failed:", err);
    }
  }, []);

  // Poll reactor status
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await invoke<R11Status>("r11_get_status");
        setRods(data.rods);
        setTierEnabled(data.tier_enabled);
      } catch {}
    };

    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, []);

  // Predictive fit on hover
  useEffect(() => {
    if (draggedModel) {
      invoke<R11PredictiveFit>("r11_predict_fit", { modelPath: draggedModel.path, gpus })
        .then(setPredictiveFit)
        .catch(() => setPredictiveFit(null));
    } else {
      setPredictiveFit(null);
    }
  }, [draggedModel, gpus]);

  return (
    <div className="h-full flex bg-stealth-black relative overflow-hidden">
      {/* Grid background */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: `linear-gradient(#76B900 1px, transparent 1px), linear-gradient(90deg, #76B900 1px, transparent 1px)`,
        backgroundSize: '40px 40px'
      }} />

      {/* Model rack sidebar — LEFT side */}
      <R11_Sidebar
        models={models}
        onInsertModel={insertModel}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        gpus={gpus}
        dragging={draggedModel !== null}
      />

      {/* Reactor core area — fills remaining space (75% width) */}
      <div className="flex-1 flex flex-col relative">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-stealth-border bg-stealth-dark/60 backdrop-blur-sm z-10">
          <div>
            <h2 className="text-xs font-mono text-nv-green tracking-widest flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-nv-green animate-pulse" />
              REACTOR 11 — CORE CONTAINMENT
            </h2>
            <p className="text-[9px] font-mono text-stealth-muted/50 mt-0.5">
              {rods.filter(r => r.status === "running").length} RODS ACTIVE — {(totalVramUsed / 1024).toFixed(1)}GB VRAM — {gpus.length} GPU(S)
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Diagnostic toggle */}
            <button
              onClick={() => setDiagnosticMode(!diagnosticMode)}
              className={`px-3 py-1 text-[9px] font-mono tracking-wider border transition-colors ${
                diagnosticMode
                  ? "border-telemetry-cyan/50 text-telemetry-cyan bg-telemetry-cyan/10"
                  : "border-stealth-border text-stealth-muted hover:border-telemetry-cyan/30"
              }`}
            >
              DIAGNOSTIC OVERRIDE
            </button>

            {/* Tier-1 toggle */}
            <button
              onClick={handleToggleTier}
              className={`px-3 py-1 text-[9px] font-mono tracking-wider border transition-colors ${
                tierEnabled
                  ? "border-red-500/50 text-red-400 bg-red-500/10"
                  : "border-stealth-border text-stealth-muted hover:border-orange-500/30"
              }`}
            >
              TIER-{tierEnabled ? "1" : "0"} {tierEnabled ? "ON" : "OFF"}
            </button>

            {/* Core design toggle buttons */}
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setCoreDesign("lattice")}
                className={`px-3 py-1 text-[9px] font-mono tracking-wider border transition-colors ${
                  coreDesign === "lattice"
                    ? "border-nv-green/60 text-nv-green bg-nv-green/10"
                    : "border-stealth-border text-stealth-muted hover:border-nv-green/30"
                }`}
              >
                LATTICE
              </button>
              <button
                onClick={() => setCoreDesign("gemini")}
                className={`px-3 py-1 text-[9px] font-mono tracking-wider border transition-colors ${
                  coreDesign === "gemini"
                    ? "border-cyan-400/60 text-cyan-400 bg-cyan-400/10"
                    : "border-stealth-border text-stealth-muted hover:border-cyan-400/30"
                }`}
              >
                CRITICALITY
              </button>
            </div>

            {/* Mock simulation sliders */}
            <div className="flex items-center gap-2 pl-2 border-l border-stealth-border">
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setMockTempEnabled(!mockTempEnabled)}
                  className={`text-[7px] font-mono px-1 py-0.5 border transition-colors ${
                    mockTempEnabled ? "border-nv-green/60 text-nv-green" : "border-stealth-border text-stealth-muted/40"
                  }`}
                >
                  TEMP
                </button>
                <input
                  type="range"
                  min={20}
                  max={100}
                  value={mockTempEnabled ? mockTemp : 30}
                  onChange={(e) => setMockTemp(Number(e.target.value))}
                  disabled={!mockTempEnabled}
                  className="w-16 h-0.5 accent-nv-green cursor-pointer"
                />
                <span className={`text-[7px] font-mono w-8 text-right ${mockTempEnabled ? "text-stealth-muted" : "text-stealth-muted/30"}`}>
                  {mockTempEnabled ? `${mockTemp}°` : "---"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setMockLevelEnabled(!mockLevelEnabled)}
                  className={`text-[7px] font-mono px-1 py-0.5 border transition-colors ${
                    mockLevelEnabled ? "border-telemetry-cyan/60 text-telemetry-cyan" : "border-stealth-border text-stealth-muted/40"
                  }`}
                >
                  LEVEL
                </button>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={mockLevelEnabled ? mockLevel : 50}
                  onChange={(e) => setMockLevel(Number(e.target.value))}
                  disabled={!mockLevelEnabled}
                  className="w-16 h-0.5 accent-telemetry-cyan cursor-pointer"
                />
                <span className={`text-[7px] font-mono w-8 text-right ${mockLevelEnabled ? "text-stealth-muted" : "text-stealth-muted/30"}`}>
                  {mockLevelEnabled ? `${mockLevel}%` : "---"}
                </span>
              </div>
            </div>

            {/* Core pulse indicator */}
            <div className={`w-2 h-2 rounded-full ${
              rods.some(r => r.status === "running") ? "bg-nv-green animate-pulse" : "bg-stealth-border/40"
            }`} />
          </div>
        </div>

        {/* SVG Core + Wells */}
        <div className="flex-1 relative overflow-hidden">
          {coreDesign === "lattice" ? (
            <R11_Core
              gpus={gpus}
              totalVramUsedMib={totalVramUsed}
              maxTotalVramMib={maxTotalVram}
              diagnosticMode={diagnosticMode}
              draggedModel={draggedModel?.path ?? null}
              predictiveVramMib={predictiveFit?.estimated_vram_mib ?? 0}
              mockTempEnabled={mockTempEnabled}
              mockTemp={mockTemp}
              mockLevelEnabled={mockLevelEnabled}
              mockLevel={mockLevel}
            />
          ) : (
            <R11_CoreGemini
              gpus={gpus}
              totalVramUsedMib={totalVramUsed}
              maxTotalVramMib={maxTotalVram}
              diagnosticMode={diagnosticMode}
              draggedModel={draggedModel?.path ?? null}
              predictiveVramMib={predictiveFit?.estimated_vram_mib ?? 0}
              mockTempEnabled={mockTempEnabled}
              mockTemp={mockTemp}
              mockLevelEnabled={mockLevelEnabled}
              mockLevel={mockLevel}
            />
          )}

          {/* Wells overlay */}
          <R11_Wells
            rods={rods}
            onRemoveRod={handleRemoveRod}
            draggedModelPath={draggedModel?.path ?? null}
            predictiveFit={predictiveFit}
            isCritical={isCritical}
          />

          {/* Diagnostic overlay */}
          {diagnosticMode && <R11_DiagnosticOverlay rods={rods} />}

          {/* Drop zone highlight */}
          {draggedModel && (
            <div className="absolute inset-0 border-2 border-nv-green/20 pointer-events-none animate-pulse-slow" />
          )}
        </div>

        {/* Bottom status bar */}
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-stealth-border bg-stealth-dark/60 text-[8px] font-mono text-stealth-muted/40">
          <span>CORE TEMP: {gpus.length > 0 ? Math.max(...gpus.map(g => g.temperature_gpu || 30)) : "--"}°C</span>
          <span>HEADROOM: {Math.max(0, maxTotalVram - totalVramUsed) / 1024}GB</span>
          <span className={rods.length >= 8 ? "text-red-400" : ""}>
            WELLS: {rods.length}/8 OCCUPIED
          </span>
        </div>
      </div>

      {/* Drop overlay when dragging */}
      {draggedModel && (
        <div
          className="absolute inset-0 z-40 cursor-none"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        />
      )}
    </div>
  );
}
