import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../App";
import type { ProviderConfig, UpdateOfferings } from "../lib/types";
import type { ConfigSubTab, ExtrasSubTab } from "../lib/appNav";
import HeaderNav from "./HeaderNav";
import { useStatus } from "../context/StatusBarContext";
import { useFoundry, type Env } from "../hooks/useBuildDock";
import FoundryStatusChip from "./FoundryStatusChip";
import BlackwellOutputConsole, {
  type OutputConsoleCategory,
  parseOutputConsoleCategory,
} from "./BlackwellOutputConsole";
import OutputConsoleInlineDock from "./OutputConsoleInlineDock";
import FoundryModal from "./FoundryModal";
import AppearanceControls from "./AppearanceControls";
import BlackwellBrandMark from "./BlackwellBrandMark";
import {
  loadMonitorWindow,
  loadUiDensity,
  loadUiZoom,
  saveMonitorFocusMode,
  saveMonitorWindow,
  saveUiDensity,
  saveUiZoom,
  type MonitorWindowSnap,
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
import {
  loadDevUpdateVersionFake,
  saveDevUpdateVersionFake,
} from "../lib/storage";
import { APP_SHELL_MIN_PX, resolveAppShellWidthPx, resolveChromeScale } from "../lib/uiShell";
import { isMobileDevice } from "../lib/utils";
import IpcMeterFooter from "./IpcMeterFooter";
import AppUpdateMenu from "./AppUpdateMenu";
import DevViewportTool from "./DevViewportTool";
import DevFakeGpuTopoTool from "./DevFakeGpuTopoTool";

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
  updateOfferings?: UpdateOfferings | null;
  onRefreshUpdateOfferings?: () => void;
  hasBinaryUpdates?: boolean;
  /** First-run wizard active — lock ENGINES / LOGS / EXTRAS. */
  setupGuideActive?: boolean;
  /** CONFIG section — header sub-rail. */
  configSubTab: ConfigSubTab;
  onConfigSubTabChange: (tab: ConfigSubTab) => void;
  /** EXTRAS section — header sub-rail. */
  extrasSubTab: ExtrasSubTab;
  onExtrasSubTabChange: (tab: ExtrasSubTab) => void;
}

export default function Layout({
  activeTab,
  onTabChange,
  children,
  providers = [],
  updateOfferings,
  onRefreshUpdateOfferings,
  hasBinaryUpdates,
  setupGuideActive = false,
  configSubTab,
  onConfigSubTabChange,
  extrasSubTab,
  onExtrasSubTabChange,
}: LayoutProps) {
  const [zoom, setZoom] = useState(loadZoom);
  const [uiDensity, setUiDensity] = useState<UiDensity>(loadUiDensity);
  const [monitorFocus, setMonitorFocus] = useState(false);
  const [shellWidthPx, setShellWidthPx] = useState(() =>
    typeof window !== "undefined"
      ? resolveAppShellWidthPx(window.innerWidth, window.innerHeight)
      : APP_SHELL_MIN_PX,
  );
  const [chromeScale, setChromeScale] = useState(() =>
    typeof window !== "undefined"
      ? resolveChromeScale(window.innerWidth, window.innerHeight)
      : 1.12,
  );
  const { totalParams, hiddenCount, onShowAll, flashMessage } = useStatus();
  const {
    buildProgress,
    foundryModal,
    foundryModalVisible,
    openBuildModal,
    minimizeBuildModal,
    restoreBuildModal,
    closeBuildModal,
    attachToActiveBuild,
    buildAttempt,
    compileStartedAt,
  } = useFoundry();
  const resolvedProvider = useMemo(() => {
    if (!foundryModal) return providers?.[0] || {} as ProviderConfig;
    const prov = providers?.find(p => p.id === foundryModal.providerId);
    return prov || providers?.[0] || {} as ProviderConfig;
  }, [foundryModal, providers]);

  const resolvedEnvironment = foundryModal?.environment || "frontier";

  // App.tsx is the sole foundry-progress → refresh_build_info owner.
  // Do not list_providers here — it races and can clobber probed build info.
  const handleFoundryComplete = useCallback((_providerId: string) => {}, []);

  const buildProviderLabel = useMemo(() => {
    if (!buildProgress) return "";
    const match = providers?.find((p) => p.id === buildProgress.providerId);
    return match?.display_name || buildProgress.providerId;
  }, [buildProgress, providers]);

  // Dock slot click: if modal exists and is visible → minimize; if exists but hidden → restore; if no modal but build running → open fresh
  const [showTooltip, setShowTooltip] = useState(false);
  const [isMobile, setIsMobile] = useState(isMobileDevice);
  const [isOutputConsoleExpanded, setIsOutputConsoleExpanded] = useState(false);
  const [isConsoleDetached, setIsConsoleDetached] = useState(false);
  const consoleDockedOpen = isOutputConsoleExpanded && !isConsoleDetached;
  const [lastConsoleLine, setLastConsoleLine] = useState<string>("Ready for telemetry");
  const [lastConsoleCategory, setLastConsoleCategory] = useState<OutputConsoleCategory | null>(null);
  const [activeConsoleCategory, setActiveConsoleCategory] = useState<OutputConsoleCategory>("engines");
  const [updFakeOn, setUpdFakeOn] = useState(false);
  const [updFakeVersion, setUpdFakeVersion] = useState<string | null>(null);

  useEffect(() => {
    const onFocus = (e: Event) => {
      const open = (e as CustomEvent<{ open?: boolean }>).detail?.open;
      if (typeof open === "boolean") setMonitorFocus(open);
    };
    window.addEventListener(EVENTS.monitorFocusChanged, onFocus);
    return () => window.removeEventListener(EVENTS.monitorFocusChanged, onFocus);
  }, []);

  useEffect(() => {
    if (!monitorFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        saveMonitorFocusMode(false);
        setMonitorFocus(false);
        dispatchAppEvent(EVENTS.monitorFocusChanged, { open: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [monitorFocus]);

  // MONITOR window memory (physical px, OUTER frame — inner/client coords
  // mismatch with setPosition, so outer is used for both snapshot + restore).
  // cockpitSnap: session-only ref — HWND geometry when entering monitor.
  // monitorSnap: last geometry while in monitor — persisted across sessions.
  const cockpitSnapRef = useRef<MonitorWindowSnap | null>(null);

  useEffect(() => {
    if (monitorFocus) {
      // Enter: snapshot cockpit once, then restore persisted monitor size (if any).
      if (cockpitSnapRef.current) return;
      // Dynamic import (not static): this file also runs in non-Tauri Vite.
      void (async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          const [size, pos] = await Promise.all([win.outerSize(), win.outerPosition()]);
          cockpitSnapRef.current = {
            w: size.width,
            h: size.height,
            x: pos.x,
            y: pos.y,
          };
          const saved = loadMonitorWindow();
          if (saved) {
            const { PhysicalSize, PhysicalPosition } = await import("@tauri-apps/api/dpi");
            await win.setSize(new PhysicalSize(saved.w, saved.h));
            if (typeof saved.x === "number" && typeof saved.y === "number") {
              await win.setPosition(new PhysicalPosition(saved.x, saved.y));
            }
          }
        } catch {
          // non-Tauri / API failure — no-op, window stays as-is
        }
      })();
      return;
    }

    // Exit: persist current monitor geometry, restore cockpit, keep monitorSnap.
    // First mount (never entered) has no cockpit snap — do nothing.
    const cockpit = cockpitSnapRef.current;
    if (!cockpit) return;
    cockpitSnapRef.current = null;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { PhysicalSize, PhysicalPosition } = await import("@tauri-apps/api/dpi");
        const win = getCurrentWindow();
        const [size, pos] = await Promise.all([win.outerSize(), win.outerPosition()]);
        const monitorSnap: MonitorWindowSnap = {
          w: size.width,
          h: size.height,
          x: pos.x,
          y: pos.y,
        };
        saveMonitorWindow(monitorSnap);
        if (cockpit) {
          await win.setSize(new PhysicalSize(cockpit.w, cockpit.h));
          if (typeof cockpit.x === "number" && typeof cockpit.y === "number") {
            await win.setPosition(new PhysicalPosition(cockpit.x, cockpit.y));
          }
        }
      } catch {
        // non-Tauri / API failure — no-op
      }
    })();
  }, [monitorFocus]);

  useEffect(() => {
    if (__BUILD_MODE__ !== "dev") return;
    const saved = loadDevUpdateVersionFake();
    void (async () => {
      try {
        await invoke("set_dev_update_version_override", { version: saved });
        const status = await invoke<{
          enabled: boolean;
          overrideVersion: string | null;
        }>("get_dev_update_version_override");
        setUpdFakeOn(status.enabled);
        setUpdFakeVersion(status.overrideVersion);
        if (status.enabled) {
          dispatchAppEvent(EVENTS.updateOfferingsRefresh);
        }
      } catch {
        // non-Tauri
      }
    })();
  }, []);

  const toggleUpdFake = useCallback(async () => {
    try {
      const status = await invoke<{
        enabled: boolean;
        overrideVersion: string | null;
        realVersion: string;
        effectiveVersion: string;
      }>("toggle_dev_update_version_fake");
      setUpdFakeOn(status.enabled);
      setUpdFakeVersion(status.overrideVersion);
      saveDevUpdateVersionFake(status.overrideVersion);
      dispatchAppEvent(EVENTS.updateOfferingsRefresh);
      onRefreshUpdateOfferings?.();
    } catch (err) {
      console.error("toggle_dev_update_version_fake failed:", err);
    }
  }, [onRefreshUpdateOfferings]);

  useEffect(() => {
    const check = () => setIsMobile(isMobileDevice());
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const onResize = () => {
      setShellWidthPx(resolveAppShellWidthPx(window.innerWidth, window.innerHeight));
      setChromeScale(resolveChromeScale(window.innerWidth, window.innerHeight));
    };
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

  const qsRef = useRef<HTMLDivElement | null>(null);
  const [qsHeightPx, setQsHeightPx] = useState(0);

  useLayoutEffect(() => {
    const qs = qsRef.current;
    if (!qs) return;
    const measureQs = () => {
      const h = Math.round(qs.getBoundingClientRect().height);
      if (h > 0) setQsHeightPx(h);
    };
    measureQs();
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measureQs) : null;
    ro?.observe(qs);
    window.addEventListener("resize", measureQs);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measureQs);
    };
  }, [chromeScale, uiDensity]);

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
    /** Header/footer density — independent of app zoom (see resolveChromeScale). */
    "--chrome-scale": String(chromeScale),
    "--device-pixel-ratio": String(
      typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    ),
    /** Primary rail height locked to Quick Settings well (measured). */
    ...(qsHeightPx > 0
      ? { "--header-qs-h": `${qsHeightPx}px`, "--header-primary-h": `${qsHeightPx}px` }
      : {}),
  } as CSSProperties;

  return (
    <div
      className={`app-shell flex flex-col h-screen grid-bg relative${consoleDockedOpen ? " app-shell--console-docked" : ""}${monitorFocus ? " app-shell--monitor-focus" : ""}`}
      data-ui-density={uiDensity}
      data-monitor-focus={monitorFocus ? "1" : undefined}
      style={shellStyle}
    >
      {monitorFocus ? (
        <div className="monitor-focus-exit-bar flex items-center justify-between gap-3 px-4 py-1.5 relative z-40">
          <span className="font-mono text-[9px] uppercase tracking-wider text-stealth-muted/70">
            Focus HUD · Esc to exit
          </span>
          <div className="flex items-center gap-1 flex-shrink-0" title="Ctrl+scroll to zoom">
            <span className="font-mono text-[8px] uppercase tracking-wider text-stealth-muted/50">
              Ctrl+scroll to zoom
            </span>
            <button
              type="button"
              onClick={() => adjustZoom(-ZOOM_STEP)}
              className="font-mono text-[9px] leading-none px-1 rounded-sm border border-stealth-border/40 text-stealth-muted/80 hover:text-nv-green"
              title="Decrease zoom (Ctrl+scroll)"
            >
              −
            </button>
            <span
              className="font-mono text-[9px] leading-none w-9 text-center text-stealth-muted/70"
              title="Zoom (Ctrl+scroll)"
            >
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => adjustZoom(ZOOM_STEP)}
              className="font-mono text-[9px] leading-none px-1 rounded-sm border border-stealth-border/40 text-stealth-muted/80 hover:text-nv-green"
              title="Increase zoom (Ctrl+scroll)"
            >
              +
            </button>
          </div>
          <button
            type="button"
            className="font-mono text-[9px] uppercase tracking-wider px-2 py-0.5 rounded-sm border border-stealth-border/50 text-nv-green/90 hover:text-nv-green"
            onClick={() => {
              saveMonitorFocusMode(false);
              setMonitorFocus(false);
              dispatchAppEvent(EVENTS.monitorFocusChanged, { open: false });
            }}
          >
            EXIT FOCUS
          </button>
        </div>
      ) : null}

      {/* Top bar — primary fills free space; sub-rail docks under active parent center */}
      <header className="app-header relative z-30 layout-header-enter min-w-0">
        <div className="app-header__main flex items-start justify-between gap-3 min-w-0 w-full">
          <div className="app-header__start flex items-start gap-4 min-w-0 flex-1">
            <HeaderNav
              activeTab={activeTab}
              onTabChange={onTabChange}
              configSubTab={configSubTab}
              onConfigSubTabChange={onConfigSubTabChange}
              extrasSubTab={extrasSubTab}
              onExtrasSubTabChange={onExtrasSubTabChange}
              setupGuideActive={setupGuideActive}
              chromeScale={chromeScale}
              zoom={zoom}
              shellWidthPx={shellWidthPx}
              qsHeightPx={qsHeightPx}
            />
          </div>

          {/* Admin lock + zoom + appearance */}
          <div className="app-header-actions gap-1.5 flex-shrink-0">
            <div ref={qsRef} className="app-quick-settings flex flex-col items-end gap-px flex-shrink-0">
              <AppearanceControls />
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
                  <AppUpdateMenu
                    offerings={updateOfferings ?? null}
                    hasBinaryUpdates={hasBinaryUpdates}
                    onRefresh={onRefreshUpdateOfferings}
                  />
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
              <div
                className="app-header-dev-tools flex flex-row flex-shrink-0 items-center"
                title="DEV tools — SETUP / CLR / FAKE / VIEW / GPU+"
              >
                <span className="app-header-dev-tools__label font-mono tracking-widest uppercase shrink-0">
                  DEV
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    if (e.shiftKey) {
                      dispatchReplaySetupGuideOnboardingOnly();
                      return;
                    }
                    void dispatchReplaySetupGuide();
                  }}
                  className="app-header-dev-tools__btn app-chrome-control-btn"
                  title="Dev: reset config/ (user provider overrides, caches) + setup guide. Does NOT clear localStorage — use CLR. Optional plugins without binaries stay hidden. Shift+click: onboarding UI only (keeps paths + metadata cache)."
                >
                  SETUP
                </button>
                <button
                  type="button"
                  onClick={() => dispatchClearLocalStorage(true)}
                  className="app-header-dev-tools__btn app-chrome-control-btn"
                  title="Dev: clear BlackOps localStorage only (UI prefs) — does NOT reset config/ or replay setup. Use SETUP for fresh-install test."
                >
                  CLR
                </button>
                <button
                  type="button"
                  onClick={() => { void toggleUpdFake(); }}
                  className="app-header-dev-tools__btn app-chrome-control-btn"
                  title={
                    updFakeOn
                      ? `Updater test ON — fake v${updFakeVersion ?? "?"} (real ${updateOfferings?.currentVersion ?? "?"}) — click to disable`
                      : "Updater test OFF — click to fake patch-1 version so UPDATE menu appears"
                  }
                >
                  {updFakeOn ? `FAKE v${updFakeVersion ?? "?"}` : "FAKE"}
                </button>
                <DevViewportTool />
                <DevFakeGpuTopoTool />
              </div>
            )}
          </div>
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
                isDetached={isConsoleDetached}
                onDetachedChange={setIsConsoleDetached}
                activeCategory={activeConsoleCategory}
                onCategoryChange={setActiveConsoleCategory}
                onClose={() => {
                  setIsConsoleDetached(false);
                  setIsOutputConsoleExpanded(false);
                }}
                compact={true}
              />
            </div>
          </div>
        </div>
      </main>

      {/* Bottom status bar — mini console is fixed chrome (amber header + inset live line) */}
      <footer
        className={`app-footer fixed bottom-0 left-0 right-0 z-20${
          isOutputConsoleExpanded && !isConsoleDetached ? " app-footer--console-expanded" : ""
        }`}
      >
        <OutputConsoleInlineDock
          liveLine={lastConsoleLine}
          activeCategory={activeConsoleCategory}
          onCategoryChange={(cat) => {
            setActiveConsoleCategory(cat);
            setIsOutputConsoleExpanded(true);
          }}
          isExpanded={isOutputConsoleExpanded}
          onToggle={() => {
            if (isOutputConsoleExpanded) {
              setIsConsoleDetached(false);
              setIsOutputConsoleExpanded(false);
            } else {
              if (lastConsoleCategory) setActiveConsoleCategory(lastConsoleCategory);
              setIsOutputConsoleExpanded(true);
            }
          }}
          statusLeft={
            <>
              {__BUILD_MODE__ === "dev" && (
                <span className="app-footer-dev-tag" title="Development build — not a release installer">
                  DEV
                </span>
              )}
              <span>PLATFORM: WINDOWS</span>
              <span className="app-footer-status-sep" aria-hidden>
                ·
              </span>
              <BlackwellBrandMark
                variant="footer"
                packageVersion={updateOfferings?.currentVersion ?? null}
              />
            </>
          }
          foundrySlot={
            buildProgress ? (
              <FoundryStatusChip
                buildProgress={buildProgress}
                providerLabel={buildProviderLabel}
                compileStartedAt={compileStartedAt}
                isMinimized={!!foundryModal && !foundryModalVisible}
                onClick={(e) => {
                  e.stopPropagation();
                  if (foundryModal && foundryModalVisible) minimizeBuildModal();
                  else if (foundryModal) restoreBuildModal();
                  else if (buildProgress) {
                    openBuildModal(buildProgress.providerId, buildProgress.environment.toLowerCase() as Env);
                  } else {
                    attachToActiveBuild();
                  }
                }}
              />
            ) : null
          }
          statusRight={
            <>
              {activeTab === "config" && (
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
        onComplete={handleFoundryComplete}
        visible={foundryModalVisible}
        onMinimize={minimizeBuildModal}
      />

    </div>
  );
}
