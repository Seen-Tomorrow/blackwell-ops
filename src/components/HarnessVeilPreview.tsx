/**
 * DEV design preview — `?harness-veil` in the URL renders the harness connect
 * veil as a standalone full-viewport phosphor face, so the veil can be
 * iterated without launching BRAIN/WORKER seats. Dev builds only.
 *
 *   npm run vite  →  open http://127.0.0.1:1420/?harness-veil
 */
import { useState } from "react";
import { isDevBuild } from "../lib/build";
import type { HarnessBinding } from "../lib/harnessBinding";
import type { StackEntry } from "../lib/types";
import HarnessConnectPanel from "./HarnessConnectPanel";
import MatrixAsciiRain from "./MatrixAsciiRain";

const DEV_TWIN_BINDING: HarnessBinding = {
  mode: "twin",
  brain: {
    alias: "brain",
    port: 11435,
    parallel: 2,
    status: "RUNNING",
    model_name: "Qwen3.8-27B-GGUF",
  } as unknown as StackEntry,
  worker: {
    alias: "worker",
    port: 11436,
    parallel: 8,
    status: "RUNNING",
    model_name: "Qwopus3.5-48-Coder",
  } as unknown as StackEntry,
};

export default function HarnessVeilPreview() {
  const [open, setOpen] = useState(true);
  const active =
    isDevBuild() && new URLSearchParams(window.location.search).has("harness-veil");
  if (!active || !open) return null;

  return (
    <div
      className="harness-connect-veil harness-connect-veil--opaque harness-connect-veil--preview"
      data-harness-veil="preview"
      role="dialog"
      aria-label="Harness connect (dev preview)"
    >
      <div className="harness-connect-veil__fx" aria-hidden>
        <MatrixAsciiRain className="harness-connect-veil__matrix" opacity={0.8} />
        <span className="harness-connect-veil__corners" />
      </div>
      <HarnessConnectPanel
        binding={DEV_TWIN_BINDING}
        onDismiss={() => setOpen(false)}
      />
    </div>
  );
}
