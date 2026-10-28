import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Tab } from "../App";
import { isSetupNavTabAllowed } from "../lib/setupGuide";
import type { SetupPhase } from "../lib/setupGuide";
import {
  PRIMARY_NAV,
  OPS_SUB_NAV,
  configSubNavOptions,
  DOWNLOADS_SUB_NAV,
  FOUNDRY_SUB_NAV,
  defaultTabForPrimary,
  isOpsTab,
  primaryNavFromTab,
  type ConfigSubTab,
  type DownloadsSubTab,
  type FoundrySubTab,
  type PrimaryNavId,
} from "../lib/appNav";
import HeaderNavSegment from "./HeaderNavSegment";
import FoundryNavBadge from "./FoundryNavBadge";

interface HeaderNavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  /** CONFIG section — header sub-rail. */
  configSubTab: ConfigSubTab;
  onConfigSubTabChange: (tab: ConfigSubTab) => void;
  /** DOWNLOADS section — header sub-rail. */
  downloadsSubTab: DownloadsSubTab;
  onDownloadsSubTabChange: (tab: DownloadsSubTab) => void;
  /** FOUNDRY section — BUILD / CACHE sub-rail. */
  foundrySubTab: FoundrySubTab;
  onFoundrySubTabChange: (tab: FoundrySubTab) => void;
  /** FOUNDRY click: navigate to the page (the nav badge is the background monitor). */
  onFoundrySelect: () => void;
  /** First-run wizard active — lock ENGINES / LOGS. */
  setupGuideActive?: boolean;
  /** Wizard phase — a CONFIG visit during `paths` is the step, not a detour. */
  setupGuidePhase?: SetupPhase;
  /**
   * Sub-rail anchor re-measure triggers. The ResizeObserver on the cluster
   * and primary switch already catches most resizes; these explicit values
   * keep the anchor in sync when chrome scale / app zoom / shell width /
   * quick-settings height change the switch geometry.
   */
  chromeScale: number;
  zoom: number;
  shellWidthPx: number;
  qsHeightPx: number;
}

/**
 * Header navigation rail — primary segmented switch plus the sub-rail docked
 * under the horizontal midpoint of the active parent option.
 */
function HeaderNav({
    activeTab,
    onTabChange,
    configSubTab,
    onConfigSubTabChange,
    downloadsSubTab,
    onDownloadsSubTabChange,
    foundrySubTab,
    onFoundrySubTabChange,
    onFoundrySelect,
    setupGuideActive = false,
    setupGuidePhase,
    chromeScale,
    zoom,
    shellWidthPx,
    qsHeightPx,
  }: HeaderNavProps,
) {
  const clusterRef = useRef<HTMLDivElement | null>(null);
  const lastOpsTabRef = useRef<Tab>("catalog");
  useEffect(() => {
    if (isOpsTab(activeTab)) lastOpsTabRef.current = activeTab;
  }, [activeTab]);

  const primaryId = primaryNavFromTab(activeTab);
  const showOpsSub = primaryId === "operations";
  const showConfigSub = primaryId === "config";
  const showDownloadsSub = primaryId === "downloads";
  const showFoundrySub = primaryId === "foundry";

  const primaryOptions = useMemo(() => {
    /**
     * Away from the guide with setup unfinished — DOWNLOADS or a non-`paths`
     * CONFIG visit. The way back is highlighted (accent + pulse) so leaving the
     * wizard to fetch a model or a folder never strands the user in a nav rail
     * where the unfinished guide has no visible home. During the `paths` phase
     * CONFIG *is* the destination (it hosts PATHS), so it does not count.
     */
    const awayFromSetup =
      setupGuideActive &&
      !isOpsTab(activeTab) &&
      !(activeTab === "config" && setupGuidePhase === "paths");

    return PRIMARY_NAV.map((p) => {
      const returnToSetup = awayFromSetup && p.id === "operations";
      const dataAttrs: Record<string, string> = {};
      if (p.id === "config") dataAttrs["data-onboarding"] = "config-tab";
      if (returnToSetup) dataAttrs["data-setup-return"] = "1";
      if (p.id === "foundry") {
        return {
          id: p.id,
          className: "app-header__primary-option--foundry",
          label: <FoundryNavBadge />,
          title: "Foundry — click to open the build page",
          disabled: setupGuideActive,
          dataAttrs: Object.keys(dataAttrs).length > 0 ? dataAttrs : undefined,
        };
      }
      return {
        id: p.id,
        label: p.label,
        title: returnToSetup ? "Return to first-run setup" : undefined,
        dataAttrs: Object.keys(dataAttrs).length > 0 ? dataAttrs : undefined,
      };
    });
  }, [setupGuideActive, setupGuidePhase, activeTab]);

  const opsOptions = useMemo(
    () =>
      OPS_SUB_NAV.map((o) => {
        const locked = setupGuideActive && !isSetupNavTabAllowed(o.id);
        return {
          id: o.id,
          label: o.label,
          disabled: locked,
          title: locked
            ? "Finish first-run setup first (OPERATIONS, DOWNLOADS, or CONFIG)"
            : undefined,
        };
      }),
    [setupGuideActive],
  );

  const configOptions = useMemo(
    () =>
      configSubNavOptions().map((o) => ({
        id: o.id,
        label: o.label,
        dataAttrs: o.dataOnboarding
          ? { "data-onboarding": o.dataOnboarding }
          : undefined,
      })),
    [],
  );

  const downloadsOptions = useMemo(
    () => DOWNLOADS_SUB_NAV.map((o) => ({ id: o.id, label: o.label })),
    [],
  );

  const foundryOptions = useMemo(
    () => FOUNDRY_SUB_NAV.map((o) => ({ id: o.id, label: o.label })),
    [],
  );

  const onPrimarySelect = useCallback(
    (id: string) => {
      const primary = id as PrimaryNavId;
      if (primary === "foundry") {
        onFoundrySelect();
        return;
      }
      if (primary === "operations") {
        const last = lastOpsTabRef.current;
        const target =
          setupGuideActive && !isSetupNavTabAllowed(last)
            ? "catalog"
            : defaultTabForPrimary("operations", last);
        onTabChange(target);
        return;
      }
      onTabChange(defaultTabForPrimary(primary));
    },
    [onTabChange, onFoundrySelect, setupGuideActive],
  );

  /**
   * Sub-rail docked under the horizontal midpoint of the active parent option.
   * `left` is clamped so the rail never overflows the cluster's right edge — the
   * right-side chrome (Quick Settings / UPDATE) is always present, so an
   * unclamped anchor would push the last sub-option under it.
   * `shift` slides the whole rail left when clamped, keeping it under its parent.
   */
  const [subAnchor, setSubAnchor] = useState({ left: 0, width: 0, shift: 0 });
  const subRef = useRef<HTMLDivElement | null>(null);
  const showSubRail = showOpsSub || showConfigSub || showDownloadsSub || showFoundrySub;

  useLayoutEffect(() => {
    if (!showSubRail) return;
    const cluster = clusterRef.current;
    if (!cluster) return;

    const measure = () => {
      const primary = cluster.querySelector<HTMLElement>(".app-header__primary-switch");
      const active = primary?.querySelector<HTMLElement>(
        ".segment-switch__option--active",
      );
      const sub = subRef.current;
      if (!primary || !active || !sub) return;
      // Align the sub-rail's left edge with the parent option's midpoint.
      const mid = primary.offsetLeft + active.offsetLeft + active.offsetWidth / 2;
      const natural = sub.scrollWidth;
      const maxLeft = Math.max(0, cluster.clientWidth - natural);
      const left = Math.max(0, Math.min(mid, maxLeft));
      setSubAnchor({
        left,
        width: active.offsetWidth,
        // Slide left so the rail stays under its parent when the anchor was clamped.
        shift: mid > maxLeft ? mid - maxLeft : 0,
      });
    };

    measure();
    const raf = requestAnimationFrame(measure);
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(cluster);
    ro?.observe(subRef.current ?? cluster);
    const primary = cluster.querySelector(".app-header__primary-switch");
    if (primary) ro?.observe(primary);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [showSubRail, primaryId, chromeScale, zoom, shellWidthPx, primaryOptions, qsHeightPx]);

  return (
    <div ref={clusterRef} className="app-header__nav-cluster min-w-0 flex-1">
      <HeaderNavSegment
        ariaLabel="Main navigation"
        size="fit"
        className="app-header__primary-switch"
        options={primaryOptions}
        selectedId={primaryId}
        onSelect={onPrimarySelect}
      />

      {showSubRail && (
        <div
          ref={subRef}
          className="app-header__sub-under"
          style={
            {
              "--sub-left": `${subAnchor.left}px`,
              "--sub-parent-width": `${subAnchor.width}px`,
              // Slide the rail left when the anchor was clamped at the right edge,
              // so it stays under its parent option instead of clipping.
              transform: subAnchor.shift ? `translateX(-${subAnchor.shift}px)` : undefined,
            } as CSSProperties
          }
        >
          {showOpsSub ? (
            <HeaderNavSegment
              ariaLabel="Operations section"
              size="compact"
              className="app-header__sub-switch"
              options={opsOptions}
              selectedId={activeTab}
              onSelect={(id) => onTabChange(id as Tab)}
            />
          ) : showDownloadsSub ? (
            <HeaderNavSegment
              ariaLabel="Downloads section"
              size="compact"
              className="app-header__sub-switch"
              options={downloadsOptions}
              selectedId={downloadsSubTab}
              onSelect={(id) => onDownloadsSubTabChange(id as DownloadsSubTab)}
            />
          ) : showFoundrySub ? (
            <HeaderNavSegment
              ariaLabel="Foundry section"
              size="compact"
              className="app-header__sub-switch"
              options={foundryOptions}
              selectedId={foundrySubTab}
              onSelect={(id) => onFoundrySubTabChange(id as FoundrySubTab)}
            />
          ) : (
            <HeaderNavSegment
              ariaLabel="Config section"
              size="compact"
              className="app-header__sub-switch"
              options={configOptions}
              selectedId={configSubTab}
              onSelect={(id) => onConfigSubTabChange(id as ConfigSubTab)}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default HeaderNav;
