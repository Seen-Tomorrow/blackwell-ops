import { useMemo } from "react";
import type { GpuInfo } from "../../lib/types";

/**
 * Session PCIe peak per GPU, kept outside React state.
 *
 * The tiles unmount when the density flips, so the peak cannot live in a tile;
 * and it must keep tracking while the compact density hides the PCIe block,
 * otherwise switching back to full would show an understated "session peak".
 */
const sessionPeaks = new Map<number, { rx: number; tx: number }>();

export type PciePeakMap = Record<number, { rx: number; tx: number }>;

export function usePciePeaks(gpus: GpuInfo[]): PciePeakMap {
  return useMemo(() => {
    const peaks: PciePeakMap = {};
    for (const gpu of gpus) {
      const previous = sessionPeaks.get(gpu.index) ?? { rx: 0, tx: 0 };
      const next = {
        rx: Math.max(previous.rx, gpu.pcie_rx_mib_per_s ?? 0),
        tx: Math.max(previous.tx, gpu.pcie_tx_mib_per_s ?? 0),
      };
      sessionPeaks.set(gpu.index, next);
      peaks[gpu.index] = next;
    }
    return peaks;
  }, [gpus]);
}
