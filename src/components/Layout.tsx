import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "../App";
import type { ProviderConfig, UpdateOfferings } from "../lib/types";
import { isSetupNavTabAllowed } from "../lib/setupGuide";
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
import { APP_BRAND_LOGO_SIZE, brandLogoDisplaySize } from "../lib/brandLogos";

const MIN_ZOOM = 0.7;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.05;

/**
 * Logo hide/show for tight nav — must account for the *full slot* reclaimed when
 * the brand is display:none. A small overflow hysteresis (e.g. 8 vs 60px) is
 * smaller than the logo (~171px + gap), so hide→space→show→overflow loops and
 * the logo flashes during resize.
 */
const NAV_BRAND_GAP_PX = 16; // .app-header__start gap-4
const NAV_LOGO_HIDE_OVERFLOW_PX = 8; // hide when tabs overflow by this much
const NAV_LOGO_SHOW_SPARE_PX = 32; // keep spare after restoring logo
const NAV_LOGO_FALLBACK_W = brandLogoDisplaySize(APP_BRAND_LOGO_SIZE).width;

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
}

const tabs: { id: Tab; label: string; icon: string; hidden?: boolean }[] = [
  { id: "catalog", label: "OPERATIONS", icon: "\u269B" },
  { id: "stack", label: "ENGINES", icon: "\uD83D\uDDA4" },
  { id: "logs", label: "LOGS", icon: "\uD83D\uDCCD" },
  { id: "modelhub", label: "MODEL HUB", icon: "\u2B21" },
  { id: "extras", label: "EXTRAS", icon: "\u2726" },
  { id: "config", label: "CONFIG", icon: "\u2699" },
];

export default function Layout({
  activeTab,
  onTabChange,
  children,
  providers = [],
  updateOfferings,
  onRefreshUpdateOfferings,
  hasBinaryUpdates,
  setupGuideActive = false,
}: LayoutProps) {
  const [zoom, setZoom] = useState(loadZoom);
  const [uiDensity, setUiDensity] = useState<UiDensity>(loadUiDensity);
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

  // Nav tab horizontal scrolling (chevrons only when the tabs overflow).
  const navRef = useRef<HTMLElement | null>(null);
  const brandRef = useRef<HTMLDivElement | null>(null);
  const [navCanScrollLeft, setNavCanScrollLeft] = useState(false);
  const [navCanScrollRight, setNavCanScrollRight] = useState(false);
  // True when the nav needs more width than it has (measured in CSS px —
  // DPI-independent). Hides the logo so tabs get room; restore only when
  // there is room for the *full* brand slot (see NAV_LOGO_* constants).
  const [navTight, setNavTight] = useState(false);
  const navTightRef = useRef(false);
  /** Last measured brand width while visible (display:none → offsetWidth 0). */
  const brandWidthRef = useRef(NAV_LOGO_FALLBACK_W);

  const updateNavScrollState = useCallback(() => {
    const el = navRef.current;
    if (!el) return;
    setNavCanScrollLeft(el.scrollLeft > 2);
    setNavCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);

    const brand = brandRef.current;
    const measured = brand?.offsetWidth ?? 0;
    if (measured > 0) brandWidthRef.current = measured;
    const brandW = brandWidthRef.current || NAV_LOGO_FALLBACK_W;
    // Slot reclaimed when logo is hidden: brand + flex gap between brand and nav.
    const logoSlot = brandW + NAV_BRAND_GAP_PX;

    let tight: boolean;
    if (navTightRef.current) {
      // Logo already hidden — only restore when spare space covers the full
      // logo slot + spare (prevents hide/show feedback loops on resize).
      const needToRestore = logoSlot + NAV_LOGO_SHOW_SPARE_PX;
      tight = el.scrollWidth + needToRestore > el.clientWidth;
    } else {
      // Logo visible — hide on real overflow (tabs need more room).
      tight = el.scrollWidth > el.clientWidth + NAV_LOGO_HIDE_OVERFLOW_PX;
    }

    if (tight !== navTightRef.current) {
      navTightRef.current = tight;
      setNavTight(tight);
    }
  }, []);

  const scrollNav = useCallback(
    (dir: -1 | 1) => {
      const el = navRef.current;
      if (!el) return;
      el.scrollBy({ left: dir * 220, behavior: "smooth" });
      // Reflect the new scroll position shortly after the smooth scroll settles.
      window.setTimeout(updateNavScrollState, 260);
    },
    [updateNavScrollState],
  );

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

  // Chevron + logo-tight: re-evaluate on resize, scroll, and after tight toggles
  // (layout changes when logo is display:none).
  useEffect(() => {
    updateNavScrollState();
    const el = navRef.current;
    if (el) el.addEventListener("scroll", updateNavScrollState, { passive: true });
    window.addEventListener("resize", updateNavScrollState);
    return () => {
      if (el) el.removeEventListener("scroll", updateNavScrollState);
      window.removeEventListener("resize", updateNavScrollState);
    };
  }, [updateNavScrollState]);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => updateNavScrollState());
    return () => window.cancelAnimationFrame(id);
  }, [navTight, updateNavScrollState]);

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
    /** Header/footer density — independent of app zoom (see resolveChromeScale). */
    "--chrome-scale": String(chromeScale),
  } as CSSProperties;

  const isConfigTab = activeTab === "config";

  return (
    <div
      className={`app-shell flex flex-col h-screen grid-bg relative${consoleDockedOpen ? " app-shell--console-docked" : ""}${navTight ? " app-shell--nav-tight" : ""}`}
      data-ui-density={uiDensity}
      style={shellStyle}
    >
      {/* Top bar */}
      <header className="app-header flex items-center justify-between gap-3 px-6 py-3 backdrop-blur-sm relative z-30 layout-header-enter min-w-0">
        <div className="app-header__start flex items-center gap-4 min-w-0 flex-1">
          {/* Logo only — version lives in footer after PLATFORM.
              Wrapper keeps a stable measure target for nav-tight hysteresis. */}
          <div ref={brandRef} className="app-header-brand-slot flex-shrink-0">
            <BlackwellBrandMark
              showVersion={false}
              packageVersion={updateOfferings?.currentVersion ?? null}
            />
          </div>

          {/* Nav tabs — chevrons appear only when the tabs overflow (no wrap). */}
          <div className="app-header__nav-wrap">
            <button
              type="button"
              aria-label="Scroll tabs left"
              onClick={() => scrollNav(-1)}
              className={`app-header__nav-chev app-header__nav-chev--left${navCanScrollLeft ? " is-visible" : ""}`}
              tabIndex={navCanScrollLeft ? 0 : -1}
            >
              ‹
            </button>
            <nav
              ref={navRef}
              className="app-header__nav flex items-stretch min-w-0"
              onScroll={updateNavScrollState}
            >
              {visibleTabs.map((tab) => {
                const lockedBySetup =
                  setupGuideActive && !isSetupNavTabAllowed(tab.id);
                return (
                  <div key={tab.id} className="app-header__nav-item relative">
                    <button
                      type="button"
                      onClick={() => {
                        if (lockedBySetup) return;
                        onTabChange(tab.id);
                      }}
                      disabled={lockedBySetup}
                      title={
                        lockedBySetup
                          ? "Finish first-run setup first (OPERATIONS, MODEL HUB, or CONFIG)"
                          : undefined
                      }
                      {...(tab.id === "config" ? { "data-onboarding": "config-tab" } : {})}
                      className={`app-nav-tab font-mono rounded-sm ${
                        activeTab === tab.id ? "app-nav-tab-active" : ""
                      }${lockedBySetup ? " app-nav-tab-disabled" : ""}`}
                    >
                      {/* <span className="mr-1.5">{tab.icon}</span> */}
                      {tab.label}
                    </button>
                  </div>
                );
              })}
            </nav>
            <button
              type="button"
              aria-label="Scroll tabs right"
              onClick={() => scrollNav(1)}
              className={`app-header__nav-chev app-header__nav-chev--right${navCanScrollRight ? " is-visible" : ""}`}
              tabIndex={navCanScrollRight ? 0 : -1}
            >
              ›
            </button>
          </div>
        </div>

        {/* Admin lock + zoom + appearance */}
        <div className="app-header-actions flex items-stretch gap-1.5 flex-shrink-0">
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
              className="app-header-dev-tools flex flex-row flex-shrink-0"
              title="DEV tools — SETUP / CLR / FAKE / VIEW / GPU+"
            >
              <button
                type="button"
                onClick={(e) => {
                  if (e.shiftKey) {
                    dispatchReplaySetupGuideOnboardingOnly();
                    return;
                  }
                  void dispatchReplaySetupGuide();
                }}
                className="app-header-dev-tools__btn app-chrome-control-btn text-nv-green/70 hover:text-nv-green"
                title="Dev: reset config/ (user provider overrides, caches) + setup guide. Does NOT clear localStorage — use CLR. Optional plugins without binaries stay hidden. Shift+click: onboarding UI only (keeps paths + metadata cache)."
              >
                SETUP
              </button>
              <button
                type="button"
                onClick={() => dispatchClearLocalStorage(true)}
                className="app-header-dev-tools__btn app-chrome-control-btn text-yellow-400/70 hover:text-yellow-400"
                title="Dev: clear BlackOps localStorage only (UI prefs) — does NOT reset config/ or replay setup. Use SETUP for fresh-install test."
              >
                CLR
              </button>
              <button
                type="button"
                onClick={() => { void toggleUpdFake(); }}
                className={`app-header-dev-tools__btn app-chrome-control-btn ${
                  updFakeOn
                    ? "text-orange-300 hover:text-orange-200"
                    : "text-white/40 hover:text-white/65"
                }`}
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
