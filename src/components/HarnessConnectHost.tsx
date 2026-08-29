/**
 * Dual harness connect presentation host (bake-off):
 * - strip: ambient panel above Running Engines (collapsible)
 * - veil: overlay on phosphor glass (not a VramBadge face)
 *
 * Either surface can be disabled via prefs without deleting the other.
 * After product pick: delete the losing mount + drop the pref flag.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadCatalogSeats,
  type CatalogSeatsState,
} from "../lib/catalogQuickAccess";
import {
  bindingHasLoading,
  deriveHarnessBinding,
  type HarnessBinding,
} from "../lib/harnessBinding";
import {
  dispatchAppEvent,
  EVENTS,
} from "../lib/events";
import {
  loadHarnessConnectStripCollapsed,
  loadHarnessConnectSurfaces,
  saveHarnessConnectStripCollapsed,
  saveHarnessConnectSurfaces,
  type HarnessConnectSurfaces,
} from "../lib/storage";
import type { StackEntry } from "../lib/types";
import HarnessConnectPanel from "./HarnessConnectPanel";

function hasLiveEngines(stack: StackEntry[]): boolean {
  return stack.some(
    (s) => (s.status === "RUNNING" || s.status === "LOADING") && s.port > 0,
  );
}

export type HarnessConnectHostProps = {
  stack: StackEntry[];
  /** Optional seats override; default loads active catalog set + listens for changes. */
  catalogSeats?: CatalogSeatsState;
  onRelaunchSeat?: (opts: {
    slotIdx: number;
    port: number;
    alias: string;
    parallel: number;
  }) => Promise<void>;
  onSelectEngine?: (slotIdx: number) => void;
  /** Render target inside phosphor (veil layer). */
  renderVeil: (node: React.ReactNode) => void;
  /** Render target above Running Engines (strip). */
  renderStrip: (node: React.ReactNode) => void;
};

/**
 * Headless coordinator — calls render props so EngineGpuForecast owns DOM slots.
 * Also exports a hook-style usage via children? Keep render props for clear slots.
 */
export function useHarnessConnectHost(opts: {
  stack: StackEntry[];
  catalogSeats?: CatalogSeatsState;
  onRelaunchSeat?: HarnessConnectHostProps["onRelaunchSeat"];
  onSelectEngine?: HarnessConnectHostProps["onSelectEngine"];
}): {
  live: boolean;
  binding: HarnessBinding;
  surfaces: HarnessConnectSurfaces;
  setSurfaces: (next: HarnessConnectSurfaces) => void;
  stripCollapsed: boolean;
  toggleStripCollapsed: () => void;
  veilOpen: boolean;
  openVeil: () => void;
  dismissVeil: () => void;
  stripNode: React.ReactNode;
  veilNode: React.ReactNode;
  /** Bezel / external CONNECT affordance when live + veil surface on. */
  showConnectChip: boolean;
} {
  const { stack, onRelaunchSeat, onSelectEngine } = opts;
  const [seats, setSeats] = useState<CatalogSeatsState>(
    () => opts.catalogSeats ?? loadCatalogSeats(),
  );
  const [surfaces, setSurfacesState] = useState<HarnessConnectSurfaces>(
    loadHarnessConnectSurfaces,
  );
  const [stripCollapsed, setStripCollapsed] = useState(
    loadHarnessConnectStripCollapsed,
  );
  const [veilOpen, setVeilOpen] = useState(false);
  const prevLiveRef = useRef(false);
  const autoVeilOnceRef = useRef(false);

  useEffect(() => {
    if (opts.catalogSeats) {
      setSeats(opts.catalogSeats);
      return;
    }
    const reload = () => setSeats(loadCatalogSeats());
    reload();
    window.addEventListener(EVENTS.catalogSeatsChanged, reload);
    return () => window.removeEventListener(EVENTS.catalogSeatsChanged, reload);
  }, [opts.catalogSeats]);

  const live = hasLiveEngines(stack);
  const binding = useMemo(
    () => deriveHarnessBinding(stack, seats),
    [stack, seats],
  );

  const setSurfaces = useCallback((next: HarnessConnectSurfaces) => {
    setSurfacesState(next);
    saveHarnessConnectSurfaces(next);
  }, []);

  const toggleStripCollapsed = useCallback(() => {
    setStripCollapsed((prev) => {
      const next = !prev;
      saveHarnessConnectStripCollapsed(next);
      return next;
    });
  }, []);

  const openVeil = useCallback(() => {
    if (!surfaces.veil) return;
    setVeilOpen(true);
  }, [surfaces.veil]);

  const dismissVeil = useCallback(() => {
    setVeilOpen(false);
  }, []);

  // External CONNECT buttons
  useEffect(() => {
    const onOpen = () => openVeil();
    const onDismiss = () => dismissVeil();
    window.addEventListener(EVENTS.harnessConnectOpen, onOpen);
    window.addEventListener(EVENTS.harnessConnectDismiss, onDismiss);
    return () => {
      window.removeEventListener(EVENTS.harnessConnectOpen, onOpen);
      window.removeEventListener(EVENTS.harnessConnectDismiss, onDismiss);
    };
  }, [openVeil, dismissVeil]);

  // Auto-open veil once when engines become live (catalog ▶ path)
  useEffect(() => {
    const was = prevLiveRef.current;
    prevLiveRef.current = live;
    if (!surfaces.veil) return;
    if (live && !was && !autoVeilOnceRef.current) {
      autoVeilOnceRef.current = true;
      setVeilOpen(true);
    }
    if (!live) {
      autoVeilOnceRef.current = false;
      setVeilOpen(false);
    }
  }, [live, surfaces.veil]);

  // Highlight + data-harness-open while strip visible or veil open
  const highlightOn =
    live
    && (
      (surfaces.strip && !stripCollapsed)
      || (surfaces.veil && veilOpen)
    );

  useEffect(() => {
    const root = document.documentElement;
    if (!highlightOn) {
      delete root.dataset.harnessOpen;
      dispatchAppEvent(EVENTS.harnessHighlight, { open: false });
      return;
    }
    root.dataset.harnessOpen = "1";
    if (binding.mode === "twin") {
      dispatchAppEvent(EVENTS.harnessHighlight, {
        open: true,
        soloPort: null,
        brainPort: binding.brain?.port ?? null,
        workerPort: binding.worker?.port ?? null,
      });
    } else if (binding.mode === "solo") {
      dispatchAppEvent(EVENTS.harnessHighlight, {
        open: true,
        soloPort: binding.brain?.port ?? null,
        brainPort: null,
        workerPort: null,
      });
    } else {
      dispatchAppEvent(EVENTS.harnessHighlight, { open: true });
    }
    return () => {
      delete root.dataset.harnessOpen;
      dispatchAppEvent(EVENTS.harnessHighlight, { open: false });
    };
  }, [highlightOn, binding]);

  const panelProps = {
    binding,
    onRelaunchSeat,
    onSelectEngine,
  };

  const stripNode =
    live && surfaces.strip ? (
      <div className="harness-connect-strip industrial-eject-panel relative flex-shrink-0 min-h-0">
        <div className="harness-connect-strip__chrome">
          <button
            type="button"
            className="harness-connect-strip__toggle font-mono"
            onClick={toggleStripCollapsed}
            title={stripCollapsed ? "Expand harness connect strip" : "Collapse strip"}
          >
            {stripCollapsed ? "HARNESS ▸" : "HARNESS ▾"}
          </button>
          <div
            className="harness-connect-strip__surface-toggles"
            title="Bake-off: turn off the surface you drop after picking"
          >
            <label className="harness-connect-strip__surf">
              <input
                type="checkbox"
                checked={surfaces.strip}
                onChange={(e) => {
                  const strip = e.target.checked;
                  if (!strip && !surfaces.veil) return;
                  setSurfaces({ strip, veil: surfaces.veil });
                }}
              />
              strip
            </label>
            <label className="harness-connect-strip__surf">
              <input
                type="checkbox"
                checked={surfaces.veil}
                onChange={(e) => {
                  const veil = e.target.checked;
                  if (!veil && !surfaces.strip) return;
                  setSurfaces({ strip: surfaces.strip, veil });
                  if (!veil) setVeilOpen(false);
                }}
              />
              veil
            </label>
          </div>
          {surfaces.veil ? (
            <button
              type="button"
              className="harness-connect-strip__veil-btn font-mono"
              onClick={openVeil}
              title="Open glass veil"
            >
              VEIL
            </button>
          ) : null}

        </div>
        {!stripCollapsed ? (
          <HarnessConnectPanel variant="strip" {...panelProps} />
        ) : null}
      </div>
    ) : null;

  const veilDim = bindingHasLoading(binding);
  const veilNode =
    live && surfaces.veil && veilOpen ? (
      <div
        className={`harness-connect-veil${veilDim ? " harness-connect-veil--dim" : " harness-connect-veil--opaque"}`}
        data-harness-veil={veilDim ? "dim" : "opaque"}
        role="dialog"
        aria-label="Harness connect"
      >
        <HarnessConnectPanel
          variant="veil"
          {...panelProps}
          onDismiss={dismissVeil}
          onLaunched={dismissVeil}
        />
      </div>
    ) : null;

  return {
    live,
    binding,
    surfaces,
    setSurfaces,
    stripCollapsed,
    toggleStripCollapsed,
    veilOpen,
    openVeil,
    dismissVeil,
    stripNode,
    veilNode,
    showConnectChip: live && surfaces.veil,
  };
}
