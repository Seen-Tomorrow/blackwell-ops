import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { presetsForApply, syncGroupFor } from "../lib/gpuControlPresets";
import {
  loadGpuControlState,
  saveGpuControlState,
  type GpuControlSavedState,
} from "../lib/storage";
import type {
  GpuControlApplyResult,
  GpuControlDeviceInfo,
  GpuControlOcMode,
  GpuControlPreset,
  GpuControlSharedPreset,
} from "../lib/types";

const CLOCK_POLL_MS = 2500;

function defaultPowerFor(dev: GpuControlDeviceInfo): number {
  return Math.round(dev.powerLimitW > 0 ? dev.powerLimitW : dev.powerDefaultW);
}

function mergeIndividualPresets(
  devices: GpuControlDeviceInfo[],
  saved: GpuControlPreset[],
): GpuControlPreset[] {
  return devices.map((d) => {
    const hit = saved.find((p) => p.gpuIndex === d.index);
    return {
      gpuIndex: d.index,
      powerLimitW: hit?.powerLimitW ?? defaultPowerFor(d),
      coreOffsetMhz: hit?.coreOffsetMhz ?? 0,
      memOffsetMhz: hit?.memOffsetMhz ?? 0,
    };
  });
}

function presetIsNonDefault(
  dev: GpuControlDeviceInfo,
  preset: GpuControlSharedPreset,
): boolean {
  const defaultW = Math.round(dev.powerDefaultW);
  return (
    preset.coreOffsetMhz > 0 ||
    preset.memOffsetMhz > 0 ||
    preset.powerLimitW !== defaultW
  );
}

function isGpuOcActive(
  devices: GpuControlDeviceInfo[],
  individualPresets: GpuControlPreset[],
  sharedPreset: GpuControlSharedPreset,
  ocMode: GpuControlOcMode,
  selectedGpuIndex: number,
): boolean {
  if (devices.length === 0) return false;
  const syncGroup = syncGroupFor(devices, selectedGpuIndex);
  for (const dev of devices) {
    const preset =
      ocMode === "sync" && syncGroup.some((g) => g.index === dev.index)
        ? sharedPreset
        : individualPresets.find((p) => p.gpuIndex === dev.index);
    if (preset && presetIsNonDefault(dev, preset)) return true;
  }
  return false;
}

function defaultSharedPreset(devices: GpuControlDeviceInfo[]): GpuControlSharedPreset {
  const first = devices[0];
  if (!first) {
    return { powerLimitW: 0, coreOffsetMhz: 0, memOffsetMhz: 0 };
  }
  return {
    powerLimitW: defaultPowerFor(first),
    coreOffsetMhz: 0,
    memOffsetMhz: 0,
  };
}

export const UAC_DENIED_MESSAGE = "USER did not approve the UAC prompt";

function isUacFailure(detail?: string): boolean {
  if (!detail) return false;
  const d = detail.toLowerCase();
  return (
    d.includes("exit 999") ||
    d.includes("exit 1223") ||
    d.includes("canceled by the user") ||
    d.includes(UAC_DENIED_MESSAGE.toLowerCase())
  );
}

export function formatGpuControlMessage(result: GpuControlApplyResult): string {
  const failed = result.steps.filter((s) => !s.ok);
  if (failed.length > 0) {
    if (failed.some((s) => isUacFailure(s.detail))) return UAC_DENIED_MESSAGE;
    return failed.map((s) => `GPU${s.gpuIndex} ${s.step}: ${s.detail ?? "failed"}`).join(" · ");
  }
  if (result.ok) return "Profile applied.";
  return "Apply finished with warnings.";
}

export function formatGpuControlError(err: unknown): string {
  const msg = String(err);
  if (isUacFailure(msg)) return UAC_DENIED_MESSAGE;
  return msg;
}

export interface GpuOcOverlay {
  coreClockMhz: number;
  memClockMhz: number;
  coreOffsetMhz: number;
  memOffsetMhz: number;
  configPowerLimitW: number;
  /** True when preset differs from driver defaults (offsets / power). */
  profileActive: boolean;
}

export function useGpuControl() {
  const [devices, setDevices] = useState<GpuControlDeviceInfo[]>([]);
  const [individualPresets, setIndividualPresets] = useState<GpuControlPreset[]>([]);
  const [sharedPreset, setSharedPreset] = useState<GpuControlSharedPreset>({
    powerLimitW: 0,
    coreOffsetMhz: 0,
    memOffsetMhz: 0,
  });
  const [ocMode, setOcMode] = useState<GpuControlOcMode>("sync");
  const [selectedGpuIndex, setSelectedGpuIndex] = useState(0);
  const [initialLoading, setInitialLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [elevated, setElevated] = useState<boolean | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hydrateFromDevices = useCallback((list: GpuControlDeviceInfo[], saved: GpuControlSavedState) => {
    setDevices(list);
    setOcMode(saved.ocMode);
    const sel =
      list.some((d) => d.index === saved.selectedGpuIndex)
        ? saved.selectedGpuIndex
        : (list[0]?.index ?? 0);
    setSelectedGpuIndex(sel);
    setIndividualPresets(mergeIndividualPresets(list, saved.presets));
    const shared =
      saved.sharedPreset.powerLimitW > 0
        ? saved.sharedPreset
        : { ...defaultSharedPreset(list), ...saved.sharedPreset };
    if (shared.powerLimitW <= 0 && list[0]) {
      shared.powerLimitW = defaultPowerFor(list[0]);
    }
    setSharedPreset(shared);
  }, []);

  const pollClocks = useCallback(async () => {
    try {
      const list = await invoke<GpuControlDeviceInfo[]>("get_gpu_control_devices");
      setDevices(list);
    } catch {
      /* keep last readings */
    }
  }, []);

  const loadInitial = useCallback(async () => {
    setInitialLoading(true);
    setError(null);
    try {
      const list = await invoke<GpuControlDeviceInfo[]>("get_gpu_control_devices");
      hydrateFromDevices(list, loadGpuControlState());
    } catch (e) {
      setError(String(e));
      setDevices([]);
      setIndividualPresets([]);
    } finally {
      setInitialLoading(false);
    }
  }, [hydrateFromDevices]);

  useEffect(() => {
    void loadInitial();
    invoke<boolean>("is_gpu_control_elevated")
      .then(setElevated)
      .catch(() => setElevated(null));
  }, [loadInitial]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      void pollClocks();
    }, CLOCK_POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pollClocks]);

  const burstPollClocks = useCallback(() => {
    void pollClocks();
    window.setTimeout(() => void pollClocks(), 600);
    window.setTimeout(() => void pollClocks(), 1500);
  }, [pollClocks]);

  const deviceByIndex = useMemo(() => {
    const map = new Map<number, GpuControlDeviceInfo>();
    for (const d of devices) map.set(d.index, d);
    return map;
  }, [devices]);

  const syncGroup = useMemo(
    () => syncGroupFor(devices, selectedGpuIndex),
    [devices, selectedGpuIndex],
  );

  const ocTargetIndices = useMemo(() => {
    if (ocMode === "sync") {
      return new Set(syncGroup.map((d) => d.index));
    }
    return new Set([selectedGpuIndex]);
  }, [ocMode, syncGroup, selectedGpuIndex]);

  const isOcTarget = useCallback(
    (gpuIndex: number) => ocTargetIndices.has(gpuIndex),
    [ocTargetIndices],
  );

  const sliderDevice = useMemo(() => {
    if (ocMode === "sync") {
      return syncGroup[0] ?? devices[0] ?? null;
    }
    return deviceByIndex.get(selectedGpuIndex) ?? devices[0] ?? null;
  }, [ocMode, syncGroup, devices, deviceByIndex, selectedGpuIndex]);

  const activePreset = useMemo((): GpuControlSharedPreset => {
    if (ocMode === "sync") return sharedPreset;
    const hit = individualPresets.find((p) => p.gpuIndex === selectedGpuIndex);
    return hit ?? sharedPreset;
  }, [ocMode, sharedPreset, individualPresets, selectedGpuIndex]);

  const persistState = useCallback(
    (
      nextIndividual: GpuControlPreset[],
      nextShared: GpuControlSharedPreset,
      nextMode: GpuControlOcMode,
      nextSelected: number,
    ) => {
      saveGpuControlState({
        reapplyOnLaunch: false,
        ocMode: nextMode,
        selectedGpuIndex: nextSelected,
        sharedPreset: nextShared,
        presets: nextIndividual,
      });
    },
    [],
  );

  const patchActivePreset = useCallback(
    (patch: Partial<GpuControlSharedPreset>) => {
      if (ocMode === "sync") {
        setSharedPreset((prev) => {
          const next = { ...prev, ...patch };
          persistState(individualPresets, next, ocMode, selectedGpuIndex);
          return next;
        });
        return;
      }
      setIndividualPresets((prev) => {
        const next = prev.map((p) =>
          p.gpuIndex === selectedGpuIndex ? { ...p, ...patch } : p,
        );
        persistState(next, sharedPreset, ocMode, selectedGpuIndex);
        return next;
      });
    },
    [ocMode, individualPresets, sharedPreset, selectedGpuIndex, persistState],
  );

  const handleModeChange = useCallback(
    (mode: GpuControlOcMode) => {
      setOcMode(mode);
      persistState(individualPresets, sharedPreset, mode, selectedGpuIndex);
    },
    [individualPresets, sharedPreset, selectedGpuIndex, persistState],
  );

  const handleSelectGpu = useCallback(
    (gpuIndex: number) => {
      const nextMode: GpuControlOcMode =
        devices.length > 1 && ocMode === "sync" ? "individual" : ocMode;
      if (nextMode !== ocMode) setOcMode(nextMode);
      setSelectedGpuIndex(gpuIndex);
      persistState(individualPresets, sharedPreset, nextMode, gpuIndex);
    },
    [devices.length, individualPresets, sharedPreset, ocMode, persistState],
  );

  const handleApply = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    setError(null);
    const toApply = presetsForApply(
      devices,
      ocMode,
      sharedPreset,
      individualPresets,
      selectedGpuIndex,
    );
    try {
      const result = await invoke<GpuControlApplyResult>("apply_gpu_control_presets", {
        presets: toApply,
      });
      const presetsToSave = ocMode === "sync" ? toApply : individualPresets;
      if (ocMode === "sync") setIndividualPresets(toApply);
      persistState(presetsToSave, sharedPreset, ocMode, selectedGpuIndex);
      const msg = formatGpuControlMessage(result);
      setStatus(result.ok ? msg : null);
      if (!result.ok) setError(msg);
      burstPollClocks();
    } catch (e) {
      setError(formatGpuControlError(e));
    } finally {
      setBusy(false);
    }
  }, [
    devices,
    ocMode,
    sharedPreset,
    individualPresets,
    selectedGpuIndex,
    persistState,
    burstPollClocks,
  ]);

  const handleResetAll = useCallback(async () => {
    if (devices.length === 0) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    const targets = devices.map((d) => d.index);
    try {
      const result = await invoke<GpuControlApplyResult>("reset_gpu_control", {
        gpuIndices: targets,
      });
      const resetIndividual = devices.map((d) => ({
        gpuIndex: d.index,
        powerLimitW: Math.round(d.powerDefaultW),
        coreOffsetMhz: 0,
        memOffsetMhz: 0,
      }));
      const resetShared = {
        powerLimitW: devices[0] ? Math.round(devices[0].powerDefaultW) : 0,
        coreOffsetMhz: 0,
        memOffsetMhz: 0,
      };
      setIndividualPresets(resetIndividual);
      setSharedPreset(resetShared);
      persistState(resetIndividual, resetShared, ocMode, selectedGpuIndex);
      const msg = result.ok ? "driver defaults SET" : formatGpuControlMessage(result);
      setStatus(result.ok ? msg : null);
      if (!result.ok) setError(msg);
      burstPollClocks();
    } catch (e) {
      setError(formatGpuControlError(e));
    } finally {
      setBusy(false);
    }
  }, [devices, ocMode, selectedGpuIndex, persistState, burstPollClocks]);

  const handleResetGpu = useCallback(async () => {
    if (devices.length === 0) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    const dev = deviceByIndex.get(selectedGpuIndex) ?? devices[0];
    if (!dev) {
      setBusy(false);
      return;
    }
    try {
      const result = await invoke<GpuControlApplyResult>("reset_gpu_control", {
        gpuIndices: [dev.index],
      });
      const defaultW = Math.round(dev.powerDefaultW);
      const resetIndividual = individualPresets.map((p) =>
        p.gpuIndex === dev.index
          ? { ...p, powerLimitW: defaultW, coreOffsetMhz: 0, memOffsetMhz: 0 }
          : p,
      );
      setIndividualPresets(resetIndividual);
      persistState(resetIndividual, sharedPreset, ocMode, selectedGpuIndex);
      const msg = result.ok
        ? `GPU ${dev.index} reset to driver defaults.`
        : formatGpuControlMessage(result);
      setStatus(result.ok ? msg : null);
      if (!result.ok) setError(msg);
      burstPollClocks();
    } catch (e) {
      setError(formatGpuControlError(e));
    } finally {
      setBusy(false);
    }
  }, [
    devices,
    deviceByIndex,
    selectedGpuIndex,
    individualPresets,
    sharedPreset,
    ocMode,
    persistState,
    burstPollClocks,
  ]);

  const overlayByGpu = useMemo(() => {
    const map = new Map<number, GpuOcOverlay>();
    for (const dev of devices) {
      let preset: GpuControlSharedPreset | undefined;
      if (ocMode === "sync" && syncGroup.some((g) => g.index === dev.index)) {
        preset = sharedPreset;
      } else {
        preset = individualPresets.find((p) => p.gpuIndex === dev.index);
      }
      if (!preset) continue;
      map.set(dev.index, {
        coreClockMhz: dev.coreClockMhz,
        memClockMhz: dev.memClockMhz,
        coreOffsetMhz: preset.coreOffsetMhz,
        memOffsetMhz: preset.memOffsetMhz,
        configPowerLimitW: preset.powerLimitW,
        profileActive: presetIsNonDefault(dev, preset),
      });
    }
    return map;
  }, [devices, ocMode, syncGroup, sharedPreset, individualPresets]);

  const getOverlay = useCallback(
    (gpuIndex: number): GpuOcOverlay | undefined => overlayByGpu.get(gpuIndex),
    [overlayByGpu],
  );

  const ocActive = useMemo(
    () =>
      isGpuOcActive(
        devices,
        individualPresets,
        sharedPreset,
        ocMode,
        selectedGpuIndex,
      ),
    [devices, individualPresets, sharedPreset, ocMode, selectedGpuIndex],
  );

  return useMemo(
    () => ({
      devices,
      ocActive,
      ocMode,
      selectedGpuIndex,
      syncGroup,
      sliderDevice,
      activePreset,
      initialLoading,
      busy,
      error,
      status,
      elevated,
      getOverlay,
      isOcTarget,
      handleModeChange,
      handleSelectGpu,
      handleApply,
      handleResetAll,
      handleResetGpu,
      /** @deprecated use handleResetAll */
      handleReset: handleResetAll,
      patchActivePreset,
    }),
    [
      devices,
      ocActive,
      ocMode,
      selectedGpuIndex,
      syncGroup,
      sliderDevice,
      activePreset,
      initialLoading,
      busy,
      error,
      status,
      elevated,
      getOverlay,
      isOcTarget,
      handleModeChange,
      handleSelectGpu,
      handleApply,
      handleResetAll,
      handleResetGpu,
      patchActivePreset,
    ],
  );
}