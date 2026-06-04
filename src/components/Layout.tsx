import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../App";
import type { ProviderConfig, AppUpdateInfo } from "../lib/types";
import { useStatus } from "../context/StatusBarContext";
import { useDock } from "../context/DockContext";
import { useFoundry, type Env } from "../hooks/useBuildDock";
import BlackwellOutputConsole from "./BlackwellOutputConsole";
import FoundryModal from "./FoundryModal";
import { KEYS } from "../lib/storage";
import { isMobileDevice } from "../lib/utils";

const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.05;

const CONSOLE_ACTIVE_FOOTER_BG = "#0a0a0a";


function loadAdminLock(): string {
  try { return localStorage.getItem(KEYS.adminLock) || "locked"; } catch { return "locked"; }
}

function cycleAdminLockState(current: string): string {
  if (current === "locked") return "unlocked";
  if (current === "unlocked") return "permanently";
  return "locked";
}

const ADMIN_LABELS: Record<string, string> = {
  locked: "POWER USER — LOCKED",
  unlocked: "POWER USER — UNLOCKED",
  permanently: "POWER USER — PERMANENTLY UNLOCKED",
};

const ADMIN_COLORS: Record<string, string> = {
  locked: "text-stealth-muted hover:text-white",
  unlocked: "text-yellow-400",
  permanently: "text-yellow-400",
};

function loadZoom(): number {
  try {
    const stored = localStorage.getItem(KEYS.uiZoom);
    if (stored) {
      const val = parseFloat(stored);
      if (!isNaN(val) && val >= MIN_ZOOM && val <= MAX_ZOOM) return val;
    }
  } catch {}
  return 1.0;
}

function saveZoom(zoom: number): void {
  try { localStorage.setItem(KEYS.uiZoom, String(zoom)); } catch {}
}

interface LayoutProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  children: React.ReactNode;
  providers?: ProviderConfig[];
  appUpdate?: AppUpdateInfo | null;
  hasBinaryUpdates?: boolean;
  onInstallAppUpdate?: () => void;
}

const tabs: { id: Tab; label: string; icon: string; hidden?: boolean }[] = [
  { id: "catalog", label: "MODELS", icon: "\u269B" },
  { id: "modelhub", label: "MODEL HUB", icon: "\uD83DDDC4" },
  { id: "stack", label: "ENGINES", icon: "\uD83D\uDDA4" },
{ id: "reactor11", label: "Reactor11", icon: "\u269B", hidden: true },
  { id: "telemetry", label: "TELEMETRY", icon: "\uD83D\uDCCA" },
  { id: "logs", label: "LOGS", icon: "\uD83D\uDCCD" },
  { id: "config", label: "CONFIG", icon: "\u2699" },
  { id: "sentinel", label: "SENTINEL", icon: "\u2694" },
];

export default function Layout({ activeTab, onTabChange, children, providers = [], appUpdate, hasBinaryUpdates, onInstallAppUpdate }: LayoutProps) {
  const [adminLockState, setAdminLockState] = useState(loadAdminLock);
  const [zoom, setZoom] = useState(loadZoom);
  const { totalParams, hiddenCount, onShowAll, flashMessage } = useStatus();
  const { buildProgress, foundryModal, foundryModalVisible, openBuildModal, minimizeBuildModal, restoreBuildModal, closeBuildModal, attachToActiveBuild, buildAttempt } = useFoundry();
  const { slots, toggleSlot } = useDock();
  const resolvedProvider = useMemo(() => {
    if (!foundryModal) return providers?.[0] || {} as ProviderConfig;
    const prov = providers?.find(p => p.id === foundryModal.providerId);
    return prov || providers?.[0] || {} as ProviderConfig;
  }, [foundryModal, providers]);

  const resolvedEnvironment = foundryModal?.environment || "vanguard";

  // Dock slot click: if modal exists and is visible → minimize; if exists but hidden → restore; if no modal but build running → open fresh
  const [showTooltip, setShowTooltip] = useState(false);
  const [isMobile, setIsMobile] = useState(isMobileDevice);
  const [isOutputConsoleExpanded, setIsOutputConsoleExpanded] = useState(false);
  const [lastConsoleLine, setLastConsoleLine] = useState<string>("Ready for engine & build telemetry");

  // Listen for admin lock changes from other components (ConfigPage)
  useEffect(() => {
    let stale = false;
    const handler = () => requestAnimationFrame(() => {
      if (!stale) setAdminLockState(loadAdminLock());
    });
    window.addEventListener("admin-lock-changed", handler);
    return () => { stale = true; window.removeEventListener("admin-lock-changed", handler); };
  }, []);

  // Persist admin lock state to localStorage and broadcast
  const handleAdminToggle = useCallback(() => {
    setAdminLockState(prev => {
      const next = cycleAdminLockState(prev);
      try { localStorage.setItem(KEYS.adminLock, next); } catch {}
      window.dispatchEvent(new Event("admin-lock-changed"));
      return next;
    });
  }, []);

  useEffect(() => {
    const check = () => setIsMobile(isMobileDevice());
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Live last line for the collapsed output bar (power user only)
  useEffect(() => {
    if (adminLockState === "locked") return;

    const fetchLastLine = async () => {
      try {
        // Prefer engines (most active), fallback to foundry
        const enginesData = await invoke<any[]>("get_blackwell_output_console_buffer_for_category", {
          category: "engines",
          limit: 1,
        });
        if (enginesData && enginesData.length > 0) {
          setLastConsoleLine(enginesData[0].content);
          return;
        }
        const foundryData = await invoke<any[]>("get_blackwell_output_console_buffer_for_category", {
          category: "foundry",
          limit: 1,
        });
        if (foundryData && foundryData.length > 0) {
          setLastConsoleLine(foundryData[0].content);
        }
      } catch (e) {
        // silent
      }
    };

    fetchLastLine();
    const interval = setInterval(fetchLastLine, 4000); // every 4s
    return () => clearInterval(interval);
  }, [adminLockState]);

  const visibleTabs = useMemo(() => {
    return tabs.filter(t => !t.hidden);
  }, []);

  const adjustZoom = useCallback((delta: number) => {
    setZoom(prev => {
      const next = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)) * 100) / 100;
      saveZoom(next);
      return next;
    });
  }, []); // setZoom is stable (React guarantee), functional update ensures latest value

  const isConfigTab = activeTab === "config";

  return (
    <div className="flex flex-col h-screen bg-stealth-black grid-bg relative">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-stealth-border bg-stealth-dark/80 backdrop-blur-sm relative z-10 layout-header-enter">
        <div className="flex items-center gap-4">
          {/* Logo / Brand */}
          <div className="flex items-center gap-2">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" className="flex-shrink-0">
              {/* Ghost silhouette made of PCB traces */}
              <path d="M14 2L6 8v10l8 6 8-6V8L14 2z" stroke="#76B900" strokeWidth="1.5" fill="none" />
              <path d="M14 6v16M10 10h8M10 14h8M10 18h8" stroke="#76B900" strokeWidth="0.75" opacity="0.5" />
              <circle cx="11" cy="12" r="1.5" fill="#76B900" opacity="0.8" />
              <circle cx="17" cy="12" r="1.5" fill="#76B900" opacity="0.8" />
            </svg>
            <div>
              <h1 className="text-sm font-mono font-bold tracking-widest text-white">
                BLACKWELL OPS
              </h1>
              <p className="text-[8px] font-mono text-white/25 tracking-wider">
                v{__TAURI_VERSION__} · BUILD {__APP_VERSION__}
              </p>
            </div>
          </div>

          {/* Nav tabs */}
          <nav className="flex items-center gap-1 ml-8">
            {visibleTabs.map((tab) => (
              <div key={tab.id} className="relative inline-block">
                <button
                  onClick={() => onTabChange(tab.id)}
                  className={`px-4 py-1.5 text-xs font-mono tracking-wider transition-all duration-200 ${
                    activeTab === tab.id
                      ? "bg-nv-green/20 text-nv-green border border-nv-green/40"
                      : "text-stealth-muted hover:text-white hover:bg-white/5 border border-transparent"
                  }`}
                >
                  {/* <span className="mr-1.5">{tab.icon}</span> */}
                  {tab.label}
                </button>
                {/* Binary update badge on CONFIG tab */}
                {tab.id === "config" && hasBinaryUpdates && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-yellow-400 rounded-full animate-pulse" title="Runtime binary updates available" />
                )}
              </div>
            ))}
          </nav>
        </div>

        {/* Admin lock + Zoom controls */}
        <div className="flex flex-col items-end gap-2">
          {/* App update indicator */}
          {appUpdate?.available && (
            <div className="relative inline-block group">
              <button
                onClick={onInstallAppUpdate}
                className="text-[9px] font-mono tracking-wider text-yellow-400 hover:text-yellow-300 transition-colors cursor-pointer"
                title={`New APP version available: ${appUpdate.version}`}
              >
                NEW APP VERSION AVAILABLE
              </button>
              {/* Release notes tooltip on hover */}
              {appUpdate.releaseNotes && (
                <div className="absolute top-full right-0 mt-1 w-[360px] bg-[#0a0a1a] border border-yellow-400/40 rounded-sm p-3 pointer-events-none z-[9999] opacity-0 group-hover:opacity-100 transition-opacity shadow-2xl">
                  <div className="text-[8px] font-mono text-yellow-400 mb-1 tracking-wider">RELEASE NOTES</div>
                  <pre className="text-[8px] font-mono text-white/70 whitespace-pre-wrap leading-relaxed max-h-[200px] overflow-y-auto">{appUpdate.releaseNotes}</pre>
                </div>
              )}
            </div>
          )}
          <button onClick={handleAdminToggle}
            className={`text-[9px] font-mono tracking-wider transition-colors ${ADMIN_COLORS[adminLockState] || ADMIN_COLORS.locked}`}
            title={ADMIN_LABELS[adminLockState] || "LOCKED"}>
            POWER USER {adminLockState === "locked" ? "\u{1F512}" : adminLockState === "unlocked" ? "\u{1F513}" : "\u{1F511}"}
          </button>
          <div className="flex items-center gap-1 border border-stealth-border rounded-sm px-1 py-0.5">
            <button onClick={() => adjustZoom(-ZOOM_STEP)} className="px-1 text-[9px] font-mono text-stealth-muted hover:text-nv-green transition-colors leading-none" title="Decrease font size">−</button>
            <span className="text-[8px] font-mono text-stealth-muted/60 w-8 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => adjustZoom(ZOOM_STEP)} className="px-1 text-[9px] font-mono text-stealth-muted hover:text-nv-green transition-colors leading-none" title="Increase font size">+</button>
          </div>
        </div>
      </header>

      {/* Main content area */}
      <main className="flex-1 overflow-hidden relative z-10">
        <div
          key={activeTab}
          className="h-full overflow-y-auto layout-tab-enter"
        >
          <div style={{ zoom }} className="min-h-full pb-[50px]">
            <div className="max-w-[1280px] mx-auto">{children}</div>
          </div>
        </div>
      </main>

      {/* Bottom status bar — fixed so it's always visible regardless of zoom */}
      <footer className={`fixed bottom-0 left-0 right-0 flex items-center justify-between px-6 py-1.5 text-[10px] font-mono z-20 ${isOutputConsoleExpanded ? "text-white/40" : "border-t-2 border-[#b87a00] bg-[#0a0a0a] text-white/40"}`}
        style={isOutputConsoleExpanded ? { background: CONSOLE_ACTIVE_FOOTER_BG } : undefined}>
        <div className="flex items-center gap-4">
          <span>PLATFORM: WINDOWS</span>
          <span>TOKIO: ACTIVE</span>
        </div>

        {/* Status bar middle — Blackwell Output Console (most space) + Build dock (smaller dedicated area) */}
        <div className="flex items-center gap-2 min-w-0" style={{ flex: "1 1 auto", maxWidth: "65%" }}>
          {/* Blackwell Output Console - Docked (1 line always visible) */}
          <div
            onClick={() => setIsOutputConsoleExpanded(!isOutputConsoleExpanded)}
            className={`min-w-0 flex items-center gap-2 px-3 py-0.5 cursor-pointer transition-all group font-mono bg-[#b87a00]/5 hover:bg-[#b87a00]/10 rounded-sm`}
            style={{ flex: "0.75 1 auto" }}
            title={isOutputConsoleExpanded ? "Click to close" : "Click to expand"}
          >
            <span className="text-[9px] tracking-wider flex-shrink-0 text-[#b87a00]">OUTPUT</span>
            <div className="flex-1 min-w-0 text-[8px] truncate text-[#b87a00]/90">
              {lastConsoleLine}
            </div>
          </div>

          {/* Dedicated small area for Build dock (only Foundry uses this for now) */}
          <div className="flex items-center gap-1 flex-shrink-0">
            {slots.map((slot, i) => (
              slot.occupied && slot.config?.type === 'build' ? (
                <button
                  key={i}
                  onClick={() => {
                    if (foundryModal && foundryModalVisible) minimizeBuildModal();
                    else if (foundryModal) restoreBuildModal();
                    else if (buildProgress) openBuildModal(buildProgress.providerId, buildProgress.environment.toLowerCase() as Env);
                    else attachToActiveBuild();
                  }}
                  className="flex items-center gap-2 px-2.5 py-0.5 border border-yellow-400/40 bg-yellow-400/[0.04] rounded-sm text-[9px] hover:bg-yellow-400/10 transition-all min-w-[110px]"
                  title="Build Progress"
                >
                  <span>{slot.config?.icon || "⚒"}</span>
                  <div className="flex-1 min-w-0 text-left">
                    {slot.config?.inlineContent}
                  </div>
                </button>
              ) : null
            ))}
          </div>
        </div>

        {/* Right group */}
        <div className="flex items-center gap-4 relative">
          {isConfigTab && (
            <>
              <span>TOTAL PARAMS: {totalParams}</span>
              <div className="relative inline-block">
                <span
                  onClick={onShowAll}
                  onMouseEnter={() => setShowTooltip(true)}
                  onMouseLeave={() => setShowTooltip(false)}
                  className={`cursor-pointer hover:text-nv-green transition-colors ${hiddenCount > 0 ? "text-yellow-400" : ""}`}
                >
                  HIDDEN: {hiddenCount}
                </span>
                {showTooltip && (
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-[#1a1a2e] border border-yellow-400/40 text-[9px] font-mono text-yellow-300 whitespace-nowrap rounded-sm pointer-events-none z-[100]">
                    Click to show all hidden values
                  </div>
                )}
              </div>
            </>
          )}
          <span className={`transition-colors ${flashMessage ? "status-flash" : "text-nv-green"}`}>
            {flashMessage || "SYSTEM NOMINAL"}
          </span>
        </div>
      </footer>

      {/* Foundry Build Modal — always mounted, CSS visibility controlled by foundryModalVisible.
          We key it on provider + buildAttempt so that clicking "Build" again for the same provider
          after a cancel or error forces a complete remount + fresh internal state. */}
      <FoundryModal
        key={`${resolvedProvider.id}-${resolvedEnvironment}-${buildAttempt}`}
        provider={resolvedProvider}
        environment={resolvedEnvironment}
        onClose={closeBuildModal}
        visible={foundryModalVisible}
        onMinimize={minimizeBuildModal}
      />

      {/* Blackwell Output Console — power user feature */}
      <BlackwellOutputConsole 
        isPowerUser={adminLockState !== "locked"} 
        isOpen={isOutputConsoleExpanded}
        onClose={() => setIsOutputConsoleExpanded(false)}
        compact={true}
      />
    </div>
  );
}
