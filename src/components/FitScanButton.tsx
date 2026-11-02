import { useEffect, useState } from "react";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import { KEYS, readStorage } from "../lib/storage";
import { getRunningFitSession, startFitScan, stopFitScan } from "../lib/libraryJobs";
import { subscribeFitScanSessions } from "../lib/fitScanSessionStore";

/** Library VRAM fit scan, on demand.
 *
 *  The library schedule only probes models it has not measured yet (and the first
 *  contact is the path-add autotrigger), so there was no way to re-measure or to fill
 *  a half-scanned library after the providers page lost its FIT section. This is that
 *  trigger; it reuses the same session store, so progress and the running scan are the
 *  ones the schedule owns and a second start still reports `busy`. */
const FIT_PARALLEL = 2;

export function FitScanButton() {
  const [, setRevision] = useState(0);
  useEffect(() => subscribeFitScanSessions(() => setRevision((r) => r + 1)), []);

  const running = getRunningFitSession();
  const buttonBase =
    "px-3 py-1 type-label font-mono border transition-colors";

  if (running) {
    const { completed, totalModels } = running.state;
    return (
      <button
        type="button"
        onClick={() => void stopFitScan(running.providerId)}
        title="VRAM fit scan running — click to stop"
        className={`${buttonBase} cfg-bord--dng--a30 cfg-dng hover:cfg-fill--dng--a15`}
      >
        {`FIT ${completed}/${totalModels} · STOP`}
      </button>
    );
  }

  const providerId = readStorage(KEYS.lastProvider) || DEFAULT_PROVIDER_ID;

  return (
    <button
      type="button"
      onClick={() => void startFitScan(providerId, FIT_PARALLEL, false, { manual: true })}
      title="Measure VRAM for every model in the library (skips models already measured)"
      className={`${buttonBase} cfg-bord--acc--a60 cfg-acc hover:cfg-fill--a15`}
    >
      RUN FIT SCAN
    </button>
  );
}
