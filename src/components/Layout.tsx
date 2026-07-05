import { useState, useEffect, useCallback, useMemo, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../App";
import type { ProviderConfig, AppUpdateInfo } from "../lib/types";
import { useStatus } from "../context/StatusBarContext";
import { useFoundry, type Env } from "../hooks/useBuildDock";
import { getStepLabel } from "../lib/foundry_constants";
import BlackwellOutputConsole, {
  type OutputConsoleCategory,
  parseOutputConsoleCategory,
} from "./BlackwellOutputConsole";
import OutputConsoleInlineDock from "./OutputConsoleInlineDock";
import FoundryModal from "./FoundryModal";
import AppearanceControls from "./AppearanceControls";
import BlackwellBrandMark from "./BlackwellBrandMark";
import {
  loadUiDensity,
  loadUiZoom,
  saveUiDensity,
  saveUiZoom,
  type UiDensity,
} from "../lib/storage";
import {
  dispatchAppEvent,
  dispatchClearLocalStorage,
  dispatchNavigateRecovery,
  dispatchReplaySetupGuide,
  dispatchReplaySetupGuideOnboardingOnly,
  EVENTS,
} from "../lib/events";
import { resolveAppShellWidthPx } from "../lib/uiShell";
import { isMobileDevice } from "../lib/utils";
import IpcMeterFooter from "./IpcMeterFooter";

const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.05;

function loadZoom(): number {
  return loadUiZoom(1.0, MIN_ZOOM, MAX_ZOOM);
}

function saveZoom(zoom: number): void {
  saveUiZoom(zoom);
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
  { id: "catalog", label: "OPERATIONS", icon: "\u269B" },
  { id: "stack", label: "ENGINES", icon: "\uD83D\uDDA4" },
  { id: "telemetry", label: "TELEMETRY", icon: "\uD83D\uDCCA" },
  { id: "logs", label: "LOGS", icon: "\uD83D\uDCCD" },
  { id: "intel", label: "INTEL", icon: "\uD83D\uDCF0" },
  { id: "config", label: "CONFIG", icon: "\u2699" },
  { id: "extras", label: "EXTRAS", icon: "\u2726" },
  { id: "reactor11", label: "Reactor11", icon: "\u269B", hidden: true },
  { id: "sentinel", label: "SENTINEL", icon: "\u2694", hidden: true },
];

export default function Layout({ activeTab, onTabChange, children, providers = [], appUpdate, hasBinaryUpdates, onInstallAppUpdate }: LayoutProps) {
  const [zoom, setZoom] = useState(loadZoom);
  const [uiDensity, setUiDensity] = useState<UiDensity>(loadUiDensity);
  const [shellWidthPx, setShellWidthPx] = useState(() =>
    typeof window !== "undefined" ? resolveAppShellWidthPx(window.innerWidth) : 1280,
  );
  const { totalParams, hiddenCount, onShowAll, flashMessage } = useStatus();
  const { buildProgress, foundryModal, foundryModalVisible, openBuildModal, minimizeBuildModal, restoreBuildModal, closeBuildModal, attachToActiveBuild, buildAttempt } = useFoundry();
  const resolvedProvider = useMemo(() => {
    if (!foundryModal) return providers?.[0] || {} as ProviderConfig;
    const prov = providers?.find(p => p.id === foundryModal.providerId);
    return prov || providers?.[0] || {} as ProviderConfig;
  }, [foundryModal, providers]);

  const resolvedEnvironment = foundryModal?.environment || "frontier";

  // Dock slot click: if modal exists and is visible → minimize; if exists but hidden → restore; if no modal but build running → open fresh
  const [showTooltip, setShowTooltip] = useState(false);
  const [isMobile, setIsMobile] = useState(isMobileDevice);
  const [isOutputConsoleExpanded, setIsOutputConsoleExpanded] = useState(false);
  const [isConsoleDetached, setIsConsoleDetached] = useState(false);
  const consoleDockedOpen = isOutputConsoleExpanded && !isConsoleDetached;
  const [lastConsoleLine, setLastConsoleLine] = useState<string>("Ready for telemetry");
  const [lastConsoleCategory, setLastConsoleCategory] = useState<OutputConsoleCategory | null>(null);
  const [consoleOpenCategory, setConsoleOpenCategory] = useState<OutputConsoleCategory | null>(null);

  useEffect(() => {
    const check = () => setIsMobile(isMobileDevice());
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const onResize = () => setShellWidthPx(resolveAppShellWidthPx(window.innerWidth));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Docked one-line preview — newest line from any category (expanded console keeps tab filter).
  useEffect(() => {
    const fetchLastLine = async () => {
      try {
        const latest = await invoke<{
          content: string;
          category: string;
        } | null>("get_blackwell_output_console_latest_line");
        if (latest?.content) {
          setLastConsoleLine((prev) => (prev === latest.content ? prev : latest.content));
          const cat = latest.category ? parseOutputConsoleCategory(latest.category) : null;
          if (cat) {
            setLastConsoleCategory((prev) => (prev === cat ? prev : cat));
          }
        }
      } catch {
        // silent
      }
    };

    void fetchLastLine();
    const interval = setInterval(() => { void fetchLastLine(); }, 1000);
    return () => clearInterval(interval);
  }, []);

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

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      adjustZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [adjustZoom]);

  const toggleUiDensity = useCallback(() => {
    setUiDensity(prev => {
      const next: UiDensity = prev === "comfortable" ? "compact" : "comfortable";
      saveUiDensity(next);
      return next;
    });
  }, []);

  const shellStyle = {
    "--ui-text-scale": String(zoom),
    "--app-shell-width-px": `${shellWidthPx}px`,
  } as CSSProperties;

  const isConfigTab = activeTab === "config";

  return (
    <div
      className={`app-shell flex flex-col h-screen grid-bg relative${consoleDockedOpen ? " app-shell--console-docked" : ""}`}
      data-ui-density={uiDensity}
      style={shellStyle}
    >
      {/* Top bar */}
      <header className="app-header flex items-center justify-between gap-3 px-6 py-3 backdrop-blur-sm relative z-30 layout-header-enter min-w-0">
        <div className="app-header__start flex items-center gap-4 min-w-0 flex-1">
          {/* Logo / Brand */}
          <BlackwellBrandMark />

          {/* Nav tabs */}
          <nav className="app-header__nav flex items-stretch min-w-0">
            {visibleTabs.map((tab) => (
              <div key={tab.id} className="app-header__nav-item relative min-w-0">
                <button
                  type="button"
                  onClick={() => onTabChange(tab.id)}
                  {...(tab.id === "config" ? { "data-onboarding": "config-tab" } : {})}
                  className={`app-nav-tab font-mono rounded-sm ${
                    activeTab === tab.id ? "app-nav-tab-active" : ""
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

        {/* Admin lock + zoom + appearance */}
        <div className="app-header-actions flex items-center gap-1.5 flex-shrink-0">
          {appUpdate?.available && (
            <div className="relative inline-block group flex-shrink-0">
              <button
                onClick={onInstallAppUpdate}
                className="app-header-update-btn text-[7px] font-mono tracking-wider text-yellow-400 hover:text-yellow-300 transition-colors cursor-pointer whitespace-nowrap"
                title={`New app version available: ${appUpdate.version}`}
              >
                UPDATE
              </button>
              {appUpdate.releaseNotes && (
                <div className="absolute top-full right-0 mt-1 w-[360px] bg-[#0a0a1a] border border-yellow-400/40 rounded-sm p-3 pointer-events-none z-[9999] opacity-0 group-hover:opacity-100 transition-opacity shadow-2xl">
                  <div className="text-[8px] font-mono text-yellow-400 mb-1 tracking-wider">RELEASE NOTES</div>
                  <pre className="text-[8px] font-mono text-white/70 whitespace-pre-wrap leading-relaxed max-h-[200px] overflow-y-auto">{appUpdate.releaseNotes}</pre>
                </div>
              )}
            </div>
          )}
          <div className="app-quick-settings flex flex-col items-end gap-px flex-shrink-0">
            <AppearanceControls embedded />
            <div className="app-quick-settings__tools app-quick-settings__row flex items-center gap-2">
              <span className="app-quick-settings__title font-mono tracking-widest uppercase shrink-0">
                Quick Settings
              </span>
              <div className="app-quick-settings__tool-group flex items-center gap-1 flex-wrap justify-end min-w-0">
              <div className="app-appearance-inline-group flex items-center gap-0.5 flex-shrink-0">
                <span className="app-appearance-section__label app-appearance-section__label--compact text-[6px] font-mono tracking-widest uppercase">
                  Comfort
                </span>
                <button
                  type="button"
                  onClick={toggleUiDensity}
                  className={`app-chrome-control-btn px-1.5 text-[8px] font-mono transition-colors leading-none ${uiDensity === "compact" ? "text-yellow-400/90" : ""}`}
                  title={uiDensity === "compact" ? "Density: Compact (click for Comfortable)" : "Density: Comfortable (click for Compact)"}
                >
                  {uiDensity === "compact" ? "COMPACT" : "COMFORT"}
                </button>
              </div>
              <span className="app-quick-settings__sep app-chrome-control-btn text-[8px] font-mono opacity-40" aria-hidden>|</span>
              <div className="app-appearance-inline-group flex items-center gap-0.5 flex-shrink-0">
                <span className="app-appearance-section__label app-appearance-section__label--compact text-[6px] font-mono tracking-widest uppercase">
                  Zoom
                </span>
                <button onClick={() => adjustZoom(-ZOOM_STEP)} className="app-chrome-control-btn px-1 text-[9px] font-mono transition-colors leading-none" title="Decrease text scale (Ctrl+scroll)">−</button>
                <span className="app-chrome-control-btn text-[8px] font-mono opacity-60 w-8 text-center" title="Text scale (Ctrl+scroll)">{Math.round(zoom * 100)}%</span>
                <button onClick={() => adjustZoom(ZOOM_STEP)} className="app-chrome-control-btn px-1 text-[9px] font-mono transition-colors leading-none" title="Increase text scale (Ctrl+scroll)">+</button>
              </div>
              <span className="app-quick-settings__sep app-chrome-control-btn text-[8px] font-mono opacity-40" aria-hidden>|</span>
              <button
                type="button"
                onClick={dispatchNavigateRecovery}
                className="app-quick-settings__recovery app-chrome-control-btn px-1.5 text-[8px] font-mono transition-colors leading-none"
                title="CONFIG → RECOVERY — clear local UI prefs or reset portable config/"
              >
                RECOVERY
              </button>
              </div>
            </div>
          </div>
          {__BUILD_MODE__ === "dev" && (
            <div className="app-header-dev-tools flex items-center gap-1 flex-shrink-0">
              <button
                type="button"
                onClick={(e) => {
                  if (e.shiftKey) {
                    dispatchReplaySetupGuideOnboardingOnly();
                    return;
                  }
                  void dispatchReplaySetupGuide();
                }}
                className="app-chrome-control-btn px-1.5 text-[8px] font-mono transition-colors leading-none text-nv-green/70 hover:text-nv-green"
                title="Dev: first-run reset (paths → models/ only, clears meta cache, keeps providers/binaries, replays onboarding). Shift+click: onboarding UI only."
              >
                ↺ SETUP
              </button>
              <button
                type="button"
                onClick={() => dispatchClearLocalStorage(true)}
                className="app-chrome-control-btn px-1.5 text-[8px] font-mono transition-colors leading-none text-yellow-400/70 hover:text-yellow-400"
                title="Dev: clear all BlackOps localStorage and reload"
              >
                CLR LS
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Main content area */}
      <main className="flex-1 min-h-0 overflow-hidden relative z-10">
        <div className="app-main-scroll h-full min-h-0 overflow-hidden">
          <div className="app-main-zoom">
            <div className="app-main-frame">
              {children}
              <BlackwellOutputConsole
                isOpen={isOutputConsoleExpanded}
                openWithCategory={consoleOpenCategory}
                onClose={() => {
                  setIsConsoleDetached(false);
                  setIsOutputConsoleExpanded(false);
                }}
                onDetachedChange={setIsConsoleDetached}
                compact={true}
              />
            </div>
          </div>
        </div>
      </main>

      {/* Bottom status bar — mini console is fixed chrome (amber header + inset live line) */}
      <footer
        className={`app-footer fixed bottom-0 left-0 right-0 z-20 ${isOutputConsoleExpanded ? "app-footer-expanded" : ""}`}
      >
        <OutputConsoleInlineDock
          liveLine={lastConsoleLine}
          liveCategory={lastConsoleCategory}
          isExpanded={isOutputConsoleExpanded}
          onToggle={() => {
            if (isOutputConsoleExpanded) {
              setIsOutputConsoleExpanded(false);
            } else {
              setConsoleOpenCategory(lastConsoleCategory);
              setIsOutputConsoleExpanded(true);
            }
          }}
          onCategoryClick={(cat) => {
            setConsoleOpenCategory(cat);
            setIsOutputConsoleExpanded(true);
          }}
          statusLeft={
            <>
              {__BUILD_MODE__ === "dev" && (
                <span className="app-footer-dev-tag" title="Development build — not a release installer">
                  DEV
                </span>
              )}
              <span>PLATFORM: WINDOWS</span>
              <span>TOKIO: ACTIVE</span>
            </>
          }
          foundrySlot={
            buildProgress ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (foundryModal && foundryModalVisible) minimizeBuildModal();
                  else if (foundryModal) restoreBuildModal();
                  else if (buildProgress) openBuildModal(buildProgress.providerId, buildProgress.environment.toLowerCase() as Env);
                  else attachToActiveBuild();
                }}
                className={`foundry-status-chip${foundryModal && !foundryModalVisible ? " foundry-status-chip--minimized" : ""}`}
                title="Build progress — click to restore or minimize"
              >
                <span className={`foundry-hammer-icon${foundryModal && !foundryModalVisible ? " foundry-hammer-icon--shake" : ""}`}>⚒</span>
                <span className="foundry-status-chip__label" title={buildProgress.logLine || ""}>
                  {getStepLabel(buildProgress.step)}...
                </span>
              </button>
            ) : null
          }
          statusRight={
            <>
              {isConfigTab && (
                <>
                  <span>TOTAL PARAMS: {totalParams}</span>
                  <div className="relative inline-block">
                    <span
                      onClick={onShowAll}
                      onMouseEnter={() => setShowTooltip(true)}
                      onMouseLeave={() => setShowTooltip(false)}
                      className={`cursor-pointer app-footer-stat-link transition-colors ${hiddenCount > 0 ? "text-yellow-400" : ""}`}
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
              <span className={`transition-colors ${flashMessage ? "status-flash" : "app-status-nominal"}`}>
                {flashMessage || "SYSTEM NOMINAL"}
              </span>
              <IpcMeterFooter />
            </>
          }
        />
      </footer>

      {/* Foundry Build Modal — always mounted, CSS visibility controlled by foundryModalVisible.
          Key uses buildAttempt only (stable for the whole attempt). Do NOT include buildId here —
          changing key mid-build remounts the modal and wipes configure logs. HMR reattach uses hydration. */}
      <FoundryModal
        key={`${resolvedProvider.id}-${resolvedEnvironment}-${buildAttempt}`}
        provider={resolvedProvider}
        environment={resolvedEnvironment}
        onClose={closeBuildModal}
        onComplete={() => dispatchAppEvent(EVENTS.reloadProviders)}
        visible={foundryModalVisible}
        onMinimize={minimizeBuildModal}
      />

    </div>
  );
}
