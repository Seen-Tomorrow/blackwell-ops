import type {
  GpuControlDeviceInfo,
  GpuControlOcMode,
  GpuControlPreset,
  GpuControlSharedPreset,
  GpuControlSavedState,
} from "./types";

export function syncGroupFor(
  devices: GpuControlDeviceInfo[],
  referenceIndex: number,
): GpuControlDeviceInfo[] {
  const ref = devices.find((d) => d.index === referenceIndex) ?? devices[0];
  if (!ref) return [];
  return devices.filter((d) => d.name === ref.name);
}

export function presetsForApply(
  devices: GpuControlDeviceInfo[],
  ocMode: GpuControlOcMode,
  sharedPreset: GpuControlSharedPreset,
  individualPresets: GpuControlPreset[],
  selectedGpuIndex: number,
): GpuControlPreset[] {
  if (devices.length === 0) return [];
  if (ocMode === "sync") {
    const group = syncGroupFor(devices, selectedGpuIndex);
    const targets = group.length > 0 ? group : devices;
    return targets.map((d) => ({
      gpuIndex: d.index,
      powerLimitW: sharedPreset.powerLimitW,
      coreOffsetMhz: sharedPreset.coreOffsetMhz,
      memOffsetMhz: sharedPreset.memOffsetMhz,
    }));
  }
  return individualPresets;
}

export function presetsForLaunch(state: GpuControlSavedState): GpuControlPreset[] {
  if (state.ocMode === "sync") {
    if (state.sharedPreset.powerLimitW <= 0 && state.presets.length === 0) {
      return [];
    }
    return state.presets.length > 0
      ? state.presets.map((p) => ({
          gpuIndex: p.gpuIndex,
          powerLimitW: state.sharedPreset.powerLimitW || p.powerLimitW,
          coreOffsetMhz: state.sharedPreset.coreOffsetMhz,
          memOffsetMhz: state.sharedPreset.memOffsetMhz,
        }))
      : [];
  }
  return state.presets;
}

export async function buildLaunchApplyPresets(
  getDevices: () => Promise<GpuControlDeviceInfo[]>,
  state: GpuControlSavedState,
): Promise<GpuControlPreset[]> {
  if (!state.reapplyOnLaunch) return [];
  try {
    const devices = await getDevices();
    if (devices.length === 0) return [];
    if (state.ocMode === "sync") {
      return presetsForApply(
        devices,
        "sync",
        state.sharedPreset,
        state.presets,
        state.selectedGpuIndex,
      ).filter(
        (p) =>
          p.powerLimitW > 0 || p.coreOffsetMhz !== 0 || p.memOffsetMhz !== 0,
      );
    }
    return state.presets.filter(
      (p) =>
        p.powerLimitW > 0 || p.coreOffsetMhz !== 0 || p.memOffsetMhz !== 0,
    );
  } catch {
    return presetsForLaunch(state);
  }
}