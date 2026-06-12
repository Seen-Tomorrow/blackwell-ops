import { useState, useEffect, useRef, useCallback } from "react";
import {
  copyFusionSharePngToClipboard,
  downloadFusionSharePng,
  renderFusionSharePng,
  toastFusionShare,
  type FusionShareMeta,
} from "../lib/fusionShareCapture";

interface FusionShareMenuProps extends FusionShareMeta {
  alias?: string;
}

function ShareIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

export default function FusionShareMenu({
  alias,
  providerName,
  modelName,
  modelQuant,
  profileLabel,
  cudaVersion,
  launchConfig,
}: FusionShareMenuProps) {
  const shareMeta: FusionShareMeta = {
    providerName,
    modelName,
    modelQuant,
    profileLabel,
    cudaVersion,
    launchConfig,
  };
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const runCapture = useCallback(
    async (mode: "clipboard" | "download") => {
      if (busy) return;
      setOpen(false);
      setBusy(true);
      try {
        if (mode === "clipboard") {
          await copyFusionSharePngToClipboard(shareMeta);
          toastFusionShare("Fusion card copied to clipboard", "success");
        } else {
          const blob = await renderFusionSharePng(shareMeta);
          downloadFusionSharePng(blob, alias);
          toastFusionShare("Fusion card downloaded as PNG", "success");
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        toastFusionShare(
          mode === "clipboard"
            ? `Clipboard failed — try Download PNG (${detail})`
            : `Download failed (${detail})`,
          "error",
        );
      } finally {
        setBusy(false);
      }
    },
    [alias, busy, cudaVersion, launchConfig, modelName, modelQuant, profileLabel, providerName],
  );

  return (
    <div ref={rootRef} className="relative flex-shrink-0" data-fusion-share-exclude>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        title="Share fusion results (VRAM display + bezel)"
        className={`fusion-share-trigger flex items-center justify-center w-5 h-5 rounded-sm border transition-colors select-none ${
          open
            ? "border-stealth-muted/50 text-stealth-muted/80 bg-black/10"
            : "border-stealth-border/50 text-stealth-muted/55 hover:text-stealth-muted/80 hover:border-stealth-muted/40 bg-transparent"
        } ${busy ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
      >
        <ShareIcon />
      </button>

      {open && (
        <div className="fusion-share-menu absolute left-0 top-full mt-1 z-[80] flex flex-col gap-0.5 min-w-[7.5rem]">
          <button
            type="button"
            disabled={busy}
            onClick={() => void runCapture("clipboard")}
            className="fusion-share-menu__btn"
          >
            TO CLIPBOARD
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runCapture("download")}
            className="fusion-share-menu__btn"
          >
            DOWNLOAD PNG
          </button>
        </div>
      )}
    </div>
  );
}