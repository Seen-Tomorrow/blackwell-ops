import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, CpuInfo, SystemInfo } from "../lib/types";
import { gpuScanSnapshotEqual } from "../lib/telemetryGpu";
import { useTauriListen } from "../hooks/useTauriListen";
import { frontendPollEnabled } from "../lib/debugFlags";
import {
  KEYS,
  TELEMETRY_POLL,
  loadPcieThroughputEnabled,
  loadTelemetryPollIntervals,
  subscribeStorage,
} from "../lib/storage";
import {
  applyDevGpuTopo,
  subscribeDevFakeGpuExtra,
} from "../lib/devFakeGpuTopo";

interface TelemetryState {
  gpus: GpuInfo[];
  cpu: CpuInfo | null;
  systemInfo: SystemInfo | null;
}

const TelemetryContext = createContext<TelemetryState>({
  gpus: [],
  cpu: null,
  systemInfo: null,
});

export function useTelemetry() {
  return useContext(TelemetryContext);
}

interface GpuFitState {
  gpus: GpuInfo[];
  systemInfo: SystemInfo | null;
}

/**
 * Coarse telemetry for background consumers (catalog, forecast).
 *
 * `useTelemetry` fires on every fast-tier sample (4-10 Hz). The catalog stays mounted while
 * an engine runs (`keepOpsAlive`) and renders hundreds of ModelCards, so subscribing it to
 * the live context cost ~125 ms/s of main-thread JS for data it only uses to bucket VRAM.
 * This slice changes only when fit-relevant numbers move (64 MiB buckets).
 */
const GpuFitContext = createContext<GpuFitState>({ gpus: [], systemInfo: null });

export function useGpuFitTelemetry() {
  return useContext(GpuFitContext);
}

/** NVML can lag CUDA free by 1–2s after engine stop. */
const GPU_POST_STOP_POLL_MS = 2000;
/** Background/idle GPU tiers scale off the fast tier the user tunes in CONFIG → RUNTIME. */
const GPU_BACKGROUND_MIN_MS = 1000;
const GPU_BACKGROUND_FACTOR = 4;
const GPU_IDLE_MIN_MS = 5000;
const GPU_IDLE_FACTOR = 20;
export type GpuPollTier = "fast" | "normal" | "idle";

/**
 * Tier cadences derived from one user-tunable fast interval (CONFIG → RUNTIME).
 * The RUNTIME card renders these same numbers, so keep the single source here.
 */
export function gpuTierIntervalsMs(fastMs: number): Record<GpuPollTier, number> {
  return {
    fast: fastMs,
    normal: Math.max(GPU_BACKGROUND_MIN_MS, fastMs * GPU_BACKGROUND_FACTOR),
    idle: Math.max(GPU_IDLE_MIN_MS, fastMs * GPU_IDLE_FACTOR),
  };
}

function gpuPollIntervalMs(tier: GpuPollTier, fastMs: number): number {
  return gpuTierIntervalsMs(fastMs)[tier];
}

function gpuVramBucketMib(tier: GpuPollTier): number {
  if (tier === "fast") return 64;
  if (tier === "normal") return 128;
  return 256;
}

/**
 * CPU snapshot equality, mirroring `gpuScanSnapshotEqual`.
 *
 * `pollCpu` used to call `setCpu(data)` unconditionally. `scan_cpu` hands back a fresh
 * object every poll, so identity always changed and every `useTelemetry()` consumer —
 * ModelCatalog and, through it, EngineConfigPanel — re-rendered at the poll rate even
 * when every value was identical. GPU polling already dedups; this is the same gate,
 * with no bucketing so no displayed number can go stale.
 */
function cpuSnapshotEqual(a: CpuInfo | null, b: CpuInfo): boolean {
  if (a === null) return false;
  if (
    a.name !== b.name
    || a.cores !== b.cores
    || a.threads !== b.threads
    || a.max_clock_mhz !== b.max_clock_mhz
    || (a.current_clock_mhz ?? null) !== (b.current_clock_mhz ?? null)
    || a.avg_usage_percent !== b.avg_usage_percent
  ) {
    return false;
  }
  if (a.core_usages.length !== b.core_usages.length) return false;
  for (let i = 0; i < a.core_usages.length; i++) {
    if (a.core_usages[i] !== b.core_usages[i]) return false;
  }
  return true;
}

export function TelemetryProvider({
  children,
  pollingActive,
  cpuPollingActive = pollingActive,
  gpuPollTier = "idle",
}: {
  children: React.ReactNode;
  /** Any surface needs GPU/RAM snapshots (catalog, live engine, open HW monitor). */
  pollingActive: boolean;
  /** CPU snapshots are only consumed by the HW monitor; stop them when it is off. */
  cpuPollingActive?: boolean;
  /** fast = HW monitor open; normal = catalog or live engines; idle = no live surface. */
  gpuPollTier?: GpuPollTier;
}) {
  /** Real NVML list only — fakes are merged for consumers in `value`. */
  const [realGpus, setRealGpus] = useState<GpuInfo[]>([]);
  const [cpu, setCpu] = useState<CpuInfo | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [devFakeRev, setDevFakeRev] = useState(0);
  const gpusRef = useRef<GpuInfo[]>([]);
  const gpuPollTierRef = useRef(gpuPollTier);
  gpuPollTierRef.current = gpuPollTier;

  /** User-tunable cadences (CONFIG → RUNTIME); defaults live in storage.ts. */
  const [pollMs, setPollMs] = useState(loadTelemetryPollIntervals);
  useEffect(() => {
    const refresh = () => setPollMs(loadTelemetryPollIntervals());
    const offs = [TELEMETRY_POLL.gpu.key, TELEMETRY_POLL.cpu.key, TELEMETRY_POLL.ram.key].map(
      (key) => subscribeStorage(key, refresh),
    );
    return () => offs.forEach((off) => off());
  }, []);

  // App-wide Rust ticks (fusion render/poll, disk I/O, PCIe counters) follow the same sliders.
  useEffect(() => {
    const push = () => {
      const { fusion, disk } = loadTelemetryPollIntervals();
      void invoke("set_telemetry_timings", {
        tickMs: fusion,
        diskIoMs: disk,
        pcieThroughput: loadPcieThroughputEnabled(),
      }).catch(() => {});
    };
    push();
    const offs = [
      TELEMETRY_POLL.fusion.key,
      TELEMETRY_POLL.disk.key,
      KEYS.telemetryPcieThroughput,
    ].map((key) => subscribeStorage(key, push));
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    return subscribeDevFakeGpuExtra(() => setDevFakeRev((n) => n + 1));
  }, []);

  /**
   * One request in flight per source. Without this a slider below the scan latency just
   * stacks invokes: the old 100 ms setting queued ~135 ms scans and the app stalled.
   */
  const gpuScanInFlight = useRef(false);
  const pollGpu = useCallback(async () => {
    if (!frontendPollEnabled() || gpuScanInFlight.current) return;
    gpuScanInFlight.current = true;
    try {
      const data = await invoke<GpuInfo[]>("scan_gpus");
      const tier = gpuPollTierRef.current;
      // Fast tier = HW monitor open: render EVERY sample — the display is the product, and
      // any tolerance here reads as "the monitor only updates 2-4×/s" however fast it polls.
      // Background tiers keep the coarse filter so the catalog does not churn on NVML drift.
      if (tier !== "fast" && gpuScanSnapshotEqual(gpusRef.current, data, gpuVramBucketMib(tier))) {
        return;
      }
      gpusRef.current = data;
      setRealGpus(data);
    } catch {
      /* keep last */
    } finally {
      gpuScanInFlight.current = false;
    }
  }, []);

  const cpuRef = useRef<CpuInfo | null>(null);
  const cpuScanInFlight = useRef(false);
  const pollCpu = useCallback(async () => {
    if (!frontendPollEnabled() || cpuScanInFlight.current) return;
    cpuScanInFlight.current = true;
    try {
      const data = await invoke<CpuInfo>("scan_cpu");
      if (cpuSnapshotEqual(cpuRef.current, data)) return;
      cpuRef.current = data;
      setCpu(data);
    } catch {
      /* keep last */
    } finally {
      cpuScanInFlight.current = false;
    }
  }, []);

  const postStopPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedulePostStopGpuPoll = useCallback(() => {
    void pollGpu();
    if (postStopPollRef.current) clearTimeout(postStopPollRef.current);
    postStopPollRef.current = setTimeout(() => {
      postStopPollRef.current = null;
      void pollGpu();
    }, GPU_POST_STOP_POLL_MS);
  }, [pollGpu]);

  useEffect(() => {
    return () => {
      if (postStopPollRef.current) clearTimeout(postStopPollRef.current);
    };
  }, []);

  // Refresh NVML soon after engine stop — clears stale "External apps" hatched VRAM on topo.
  useTauriListen<{ slot: number }>("slot-cleared", schedulePostStopGpuPoll, [schedulePostStopGpuPoll]);

  // One-time system info + hardware bootstrap snapshot (catalog / fit / reactor)
  useEffect(() => {
    let cancelled = false;
    invoke<SystemInfo>("scan_system_info")
      .then((data) => {
        if (!cancelled) setSystemInfo(data);
      })
      .catch(console.error);
    void pollGpu();
    pollCpu();

    // Fresh installs can miss the first NVML read — forecast stays empty until restart without retries.
    let attempts = 0;
    const bootstrapGpu = setInterval(() => {
      if (cancelled || gpusRef.current.length > 0 || attempts >= 6) {
        clearInterval(bootstrapGpu);
        return;
      }
      attempts += 1;
      void pollGpu();
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(bootstrapGpu);
    };
  }, [pollGpu, pollCpu]);

  const ramInFlight = useRef(false);
  const pollRam = useCallback(async () => {
    if (!frontendPollEnabled() || ramInFlight.current) return;
    ramInFlight.current = true;
    try {
      const data = await invoke<SystemInfo>("scan_system_info");
      setSystemInfo((prev) => {
        if (
          prev
          && prev.total_memory_mib === data.total_memory_mib
          && prev.available_memory_mib === data.available_memory_mib
          && prev.total_memory_manufactured_mib === data.total_memory_manufactured_mib
        ) {
          return prev;
        }
        return data;
      });
    } catch {
      /* keep last */
    } finally {
      ramInFlight.current = false;
    }
  }, []);

  /**
   * One clock for every polled source.
   *
   * They used to run on three independent `setInterval`s, so the CPU and GPU ticks drifted
   * out of phase and their bar tweens never overlapped: a 120 ms tween at each of 250 ms
   * kept the compositor busy ~100 % of the time (measured via CDP duty cycle). Firing all
   * due sources from one timer makes the tweens share a single window per cycle, which
   * halves compositor time with no visual change. Sources with different intervals still
   * fire when their own accumulator is due.
   */
  useEffect(() => {
    if (!pollingActive && !cpuPollingActive) return;
    const gpuMs = gpuPollIntervalMs(gpuPollTier, pollMs.gpu);
    const sources: Array<{ ms: number; acc: number; run: () => void }> = [];
    if (pollingActive) sources.push({ ms: gpuMs, acc: 0, run: () => void pollGpu() });
    if (cpuPollingActive) sources.push({ ms: pollMs.cpu, acc: 0, run: () => void pollCpu() });
    if (pollingActive) sources.push({ ms: pollMs.ram, acc: 0, run: () => void pollRam() });
    if (sources.length === 0) return;

    let paused = document.visibilityState !== "visible";
    let last = performance.now();
    const runAll = () => {
      for (const source of sources) {
        source.acc = 0;
        source.run();
      }
    };

    runAll();
    const step = Math.max(10, Math.min(...sources.map((s) => s.ms)));
    const timer = window.setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (paused) return;
      for (const source of sources) {
        source.acc += dt;
        if (source.acc >= source.ms) {
          source.acc = 0;
          source.run();
        }
      }
    }, step);

    const handleVisibility = () => {
      paused = document.visibilityState !== "visible";
      last = performance.now();
      if (!paused) runAll();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [
    pollingActive,
    cpuPollingActive,
    gpuPollTier,
    pollMs.gpu,
    pollMs.cpu,
    pollMs.ram,
    pollGpu,
    pollCpu,
    pollRam,
  ]);

  const gpus = useMemo(() => {
    return applyDevGpuTopo(realGpus);
    // devFakeRev forces re-merge when the DEV plan changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realGpus, devFakeRev]);

  const value = useMemo(
    () => ({ gpus, cpu, systemInfo }),
    [gpus, cpu, systemInfo],
  );

  /** Fit-relevant fingerprint — 64 MiB buckets, so bar jitter cannot re-render the catalog. */
  const fitKey = useMemo(() => {
    const gpuKey = gpus
      .map(
        (g) =>
          `${g.index}:${g.name}:${g.memory_total_manufactured || g.memory_total}:${Math.round(g.memory_used / 64)}`,
      )
      .join("|");
    const ramKey = systemInfo
      ? `${systemInfo.total_memory_mib}:${Math.round(systemInfo.available_memory_mib / 64)}:${systemInfo.total_memory_manufactured_mib}`
      : "none";
    return `${gpuKey}#${ramKey}`;
  }, [gpus, systemInfo]);

  const fitValue = useMemo<GpuFitState>(
    () => ({ gpus, systemInfo }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fitKey],
  );

  return (
    <TelemetryContext.Provider value={value}>
      <GpuFitContext.Provider value={fitValue}>{children}</GpuFitContext.Provider>
    </TelemetryContext.Provider>
  );
}