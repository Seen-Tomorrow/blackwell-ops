import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IpcMeterSnapshot } from "../lib/types";

const EMPTY: IpcMeterSnapshot = {
  totalPerSec: 0,
  fusionPerSec: 0,
  logBatchPerSec: 0,
  otherPerSec: 0,
  peakPerSec: 0,
  tier: "green",
};

const POLL_MS = 1000;

export default function IpcMeterFooter() {
  const [stats, setStats] = useState<IpcMeterSnapshot>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const snap = await invoke<IpcMeterSnapshot>("get_ipc_meter_stats");
        if (!cancelled) setStats(snap);
      } catch {
        // Older backend during dev — hide meter quietly
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const tier = stats.tier ?? "green";
  const total = stats.totalPerSec ?? 0;
  const fusion = stats.fusionPerSec ?? 0;
  const logs = stats.logBatchPerSec ?? 0;
  const peak = stats.peakPerSec ?? 0;

  return (
    <span
      className={`app-footer-ipc app-footer-ipc--${tier}`}
      title={`IPC bridge load (1s window). Peak session: ${peak}/s. Thresholds: green <50, yellow <300, orange <800, red ≥800.`}
    >
      IPC {total}/s
      <span className="app-footer-ipc__detail">
        F{fusion} L{logs}
        {peak > total ? ` P${peak}` : ""}
      </span>
    </span>
  );
}