/**
 * Harness connect veil — phosphor overlay, not a VramBadge face.
 * Shown only for catalog BRAIN/WORKER seats once they are RUNNING.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadCatalogSeats,
  type CatalogSeatsState,
} from "../lib/catalogQuickAccess";
import {
  bindingReadyToOpen,
  deriveHarnessBinding,
  type HarnessBinding,
} from "../lib/harnessBinding";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import type { StackEntry } from "../lib/types";
import HarnessConnectPanel from "./HarnessConnectPanel";

export type HarnessConnectRelaunch = (opts: {
  slotIdx: number;
  port: number;
  alias: string;
  parallel: number;
}) => Promise<void>;

export function useHarnessConnectHost(opts: {
  stack: StackEntry[];
  catalogSeats?: CatalogSeatsState;
  onRelaunchSeat?: HarnessConnectRelaunch;
  onSelectEngine?: (slotIdx: number) => void;
}): {
  binding: HarnessBinding;
  veilOpen: boolean;
  openVeil: () => void;
  dismissVeil: () => void;
  veilNode: React.ReactNode;
  showConnectChip: boolean;
  connectReady: boolean;
} {
  const { stack, onRelaunchSeat, onSelectEngine } = opts;
  const [seats, setSeats] = useState<CatalogSeatsState>(
    () => opts.catalogSeats ?? loadCatalogSeats(),
  );
  const [veilOpen, setVeilOpen] = useState(false);

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

  const binding = useMemo(
    () => deriveHarnessBinding(stack, seats),
    [stack, seats],
  );
  const tagged = binding.mode !== "none";
  const ready = tagged && bindingReadyToOpen(binding);

  const openVeil = useCallback(() => {
    if (!ready) return;
    setVeilOpen(true);
  }, [ready]);

  const dismissVeil = useCallback(() => {
    setVeilOpen(false);
  }, []);

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

  const prevReadyRef = useRef(false);
  useEffect(() => {
    const was = prevReadyRef.current;
    prevReadyRef.current = ready;
    if (ready && !was) setVeilOpen(true);
    if (!tagged) setVeilOpen(false);
  }, [ready, tagged]);

  const highlightOn = tagged && veilOpen;
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

  const veilNode =
    ready && veilOpen ? (
      <div
        className="harness-connect-veil harness-connect-veil--opaque"
        data-harness-veil="opaque"
        role="dialog"
        aria-label="Harness connect"
      >
        <div className="harness-connect-veil__fx" aria-hidden>
          <span className="harness-connect-veil__grid" />
          <span className="harness-connect-veil__scan" />
          <span className="harness-connect-veil__sweep" />
          <span className="harness-connect-veil__corners" />
        </div>
        <HarnessConnectPanel
          binding={binding}
          onRelaunchSeat={onRelaunchSeat}
          onSelectEngine={onSelectEngine}
          onDismiss={dismissVeil}
          onLaunched={dismissVeil}
        />
      </div>
    ) : null;

  return {
    binding,
    veilOpen,
    openVeil,
    dismissVeil,
    veilNode,
    showConnectChip: tagged,
    connectReady: ready,
  };
}
