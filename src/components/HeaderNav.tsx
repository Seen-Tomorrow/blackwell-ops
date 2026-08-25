import {
  forwardRef,
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
import {
  PRIMARY_NAV,
  OPS_SUB_NAV,
  EXTRAS_SUB_NAV,
  configSubNavOptions,
  defaultTabForPrimary,
  isOpsTab,
  primaryNavFromTab,
  type ConfigSubTab,
  type ExtrasSubTab,
  type PrimaryNavId,
} from "../lib/appNav";
import SegmentSwitch from "./SegmentSwitch";

export interface HeaderNavProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
  /** CONFIG section — header sub-rail. */
  configSubTab: ConfigSubTab;
  onConfigSubTabChange: (tab: ConfigSubTab) => void;
  /** EXTRAS section — header sub-rail. */
  extrasSubTab: ExtrasSubTab;
  onExtrasSubTabChange: (tab: ExtrasSubTab) => void;
  /** First-run wizard active — lock ENGINES / LOGS / EXTRAS. */
  setupGuideActive?: boolean;
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
 *
 * The parent (Layout) forwards a ref to the cluster element so its
 * logo-hide (`navTight`) hysteresis can read the cluster's scroll metrics.
 */
const HeaderNav = forwardRef<HTMLDivElement, HeaderNavProps>(function HeaderNav(
  {
    activeTab,
    onTabChange,
    configSubTab,
    onConfigSubTabChange,
    extrasSubTab,
    onExtrasSubTabChange,
    setupGuideActive = false,
    chromeScale,
    zoom,
    shellWidthPx,
    qsHeightPx,
  },
  ref,
) {
  const clusterRef = useRef<HTMLDivElement | null>(null);
  const setClusterRef = useCallback(
    (node: HTMLDivElement | null) => {
      clusterRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as React.RefObject<HTMLDivElement>).current = node;
    },
    [ref],
  );
  const lastOpsTabRef = useRef<Tab>("catalog");
  useEffect(() => {
    if (isOpsTab(activeTab)) lastOpsTabRef.current = activeTab;
  }, [activeTab]);

  const primaryId = primaryNavFromTab(activeTab);
  const showOpsSub = primaryId === "operations";
  const showConfigSub = primaryId === "config";
  const showExtrasSub = primaryId === "extras";

  const primaryOptions = useMemo(
    () =>
      PRIMARY_NAV.map((p) => {
        const extrasLocked = setupGuideActive && p.id === "extras";
        return {
          id: p.id,
          label: p.label,
          disabled: extrasLocked,
          title: extrasLocked
            ? "Finish first-run setup first (OPERATIONS, DOWNLOADS, or CONFIG)"
            : undefined,
          dataAttrs:
            p.id === "config" ? { "data-onboarding": "config-tab" } : undefined,
        };
      }),
    [setupGuideActive],
  );

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

  const extrasOptions = useMemo(
    () => EXTRAS_SUB_NAV.map((o) => ({ id: o.id, label: o.label })),
    [],
  );

  const onPrimarySelect = useCallback(
    (id: string) => {
      const primary = id as PrimaryNavId;
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
    [onTabChange, setupGuideActive],
  );

  /** Sub-rail starts at horizontal midpoint of active primary option. */
  const [subAnchor, setSubAnchor] = useState({ left: 0, width: 0 });
  const showSubRail = showOpsSub || showConfigSub || showExtrasSub;

  useLayoutEffect(() => {
    if (!showSubRail) return;
    const cluster = clusterRef.current;
    if (!cluster) return;

    const measure = () => {
      const primary = cluster.querySelector<HTMLElement>(".app-header__primary-switch");
      const active = primary?.querySelector<HTMLElement>(
        ".segment-switch__option--active",
      );
      if (!primary || !active) return;
      const parentLeft = primary.offsetLeft + active.offsetLeft;
      setSubAnchor({
        left: Math.max(0, parentLeft + active.offsetWidth / 2),
        width: active.offsetWidth,
      });
    };

    measure();
    const raf = requestAnimationFrame(measure);
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(cluster);
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
    <div ref={setClusterRef} className="app-header__nav-cluster min-w-0 flex-1">
      <SegmentSwitch
        ariaLabel="Main navigation"
        size="fit"
        tone="accent"
        className="app-header__primary-switch"
        options={primaryOptions}
        selectedId={primaryId}
        onSelect={onPrimarySelect}
      />

      {showSubRail && (
        <div
          className="app-header__sub-under"
          style={
            {
              "--sub-left": `${subAnchor.left}px`,
              "--sub-parent-width": `${subAnchor.width}px`,
            } as CSSProperties
          }
        >
          {showOpsSub ? (
            <SegmentSwitch
              ariaLabel="Operations section"
              size="compact"
              tone="accent"
              className="app-header__sub-switch"
              options={opsOptions}
              selectedId={activeTab}
              onSelect={(id) => onTabChange(id as Tab)}
            />
          ) : showConfigSub ? (
            <SegmentSwitch
              ariaLabel="Config section"
              size="compact"
              tone="accent"
              className="app-header__sub-switch"
              options={configOptions}
              selectedId={configSubTab}
              onSelect={(id) => onConfigSubTabChange(id as ConfigSubTab)}
            />
          ) : (
            <SegmentSwitch
              ariaLabel="Extras section"
              size="compact"
              tone="accent"
              className="app-header__sub-switch"
              options={extrasOptions}
              selectedId={extrasSubTab}
              onSelect={(id) => onExtrasSubTabChange(id as ExtrasSubTab)}
            />
          )}
        </div>
      )}
    </div>
  );
});

export default HeaderNav;
