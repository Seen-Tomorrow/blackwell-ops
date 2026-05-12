import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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

  // Mouse-based drag state (ConfigPage pattern)
  const [isDragging, setIsDragging] = useState(false);
  const hasMovedRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const pendingModelRef = useRef<ModelEntry | null>(null);
  const insertModelRef = useRef<(model: ModelEntry) => Promise<void>>();

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

  const insertModel = useCallback(async (model: ModelEntry) => {
    try {
      const config = {
        alias: `${model.name} (${model.quant})`,
        model_path: model.path,
        port: 0,
        device: "GPU-0",
        kv_quant: model.quant.toLowerCase().includes("q4") ? "q4_0" : "f16",
        ctx_size: "32K",
        batch: 2048,
        ubatch: 512,
        parallel: 1,
        offload: "all",
        offload_mode: "regular",
        split_mode: "",
        vision: model.vision ? "auto" : "off",
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

  // Keep ref in sync for use inside mouse event listeners
  insertModelRef.current = insertModel;

  // Mouse-down on a model card — record position and pending model
  const handleDragStart = useCallback((model: ModelEntry, e: React.MouseEvent) => {
    console.log("[R11] handleDragStart called for", model.name);
    e.preventDefault();
    startPosRef.current = { x: e.clientX, y: e.clientY };
    hasMovedRef.current = false;
    pendingModelRef.current = model;
    setIsDragging(true);
  }, []);

  // Global mousemove — detect movement past dead zone to activate drag
  useEffect(() => {
    if (!isDragging) return;

    const handleMove = (e: MouseEvent) => {
      const dx = Math.abs(e.clientX - startPosRef.current.x);
      const dy = Math.abs(e.clientY - startPosRef.current.y);
      if (!hasMovedRef.current && (dx > 3 || dy > 3)) {
        hasMovedRef.current = true;
        console.log("[R11] mousemove: drag activated, model =", pendingModelRef.current?.name);
        // Activate drag — set the model so ghost liquid preview appears
        if (pendingModelRef.current) {
          setDraggedModel(pendingModelRef.current);
        }
      }
    };

    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
  }, [isDragging]);

  // Global mouseup — finalize drag or cancel
  useEffect(() => {
    if (!isDragging) return;

    const handleUp = (e: MouseEvent) => {
      console.log("[R11] mouseup fired, hasMoved =", hasMovedRef.current);
      setIsDragging(false);

      if (!hasMovedRef.current) {
        pendingModelRef.current = null;
        hasMovedRef.current = false;
        return;
      }

      // Check if dropped on the core area (not over sidebar)
      const el = document.elementFromPoint(e.clientX, e.clientY);
      console.log("[R11] elementFromPoint =", el?.tagName, el?.className);
      if (el && pendingModelRef.current && insertModelRef.current) {
        console.log("[R11] inserting model:", pendingModelRef.current.name);
        insertModelRef.current(pendingModelRef.current);
      }

      setDraggedModel(null);
      setPredictiveFit(null);
      pendingModelRef.current = null;
      hasMovedRef.current = false;
    };

    window.addEventListener("mouseup", handleUp, { once: true });
    return () => window.removeEventListener("mouseup", handleUp);
  }, [isDragging]);

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

  // Predictive fit on drag
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

      {/* Dragging overlay — captures cursor visually */}
      {draggedModel && (
        <div className="absolute inset-0 z-40 pointer-events-none" />
      )}
    </div>
  );
}
