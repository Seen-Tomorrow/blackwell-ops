import { useState, useEffect, useRef, useCallback } from "react";
import {
  copyFusionSharePngToClipboard,
  downloadFusionSharePng,
  renderFusionSharePng,
  toastFusionShare,
  type FusionShareMeta,
  type FusionShareVariant,
} from "../lib/fusionShareCapture";

interface FusionShareMenuProps extends FusionShareMeta {
  alias?: string;
}

const VARIANTS: { id: FusionShareVariant; label: string; title: string }[] = [
  { id: "white", label: "WHT", title: "Share light card (ARCTIC · phosphor light)" },
  { id: "black", label: "BLK", title: "Share dark card (SLATE · phosphor dark)" },
];

export default function FusionShareMenu({
  alias,
  providerName,
  providerBuildVersion,
  modelName,
  modelQuant,
  profileLabel,
  cudaVersion,
  launchConfig,
  hwTopo,
}: FusionShareMenuProps) {
  const shareMeta: FusionShareMeta = {
    providerName,
    providerBuildVersion,
    modelName,
    modelQuant,
    profileLabel,
    cudaVersion,
    launchConfig,
    hwTopo,
  };
  const [openVariant, setOpenVariant] = useState<FusionShareVariant | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!openVariant) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpenVariant(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [openVariant]);

  const runCapture = useCallback(
    async (variant: FusionShareVariant, mode: "clipboard" | "download") => {
      if (busy) return;
      setOpenVariant(null);
      setBusy(true);
      try {
        if (mode === "clipboard") {
          await copyFusionSharePngToClipboard(shareMeta, variant);
          toastFusionShare(
            `Fusion card copied (${variant === "white" ? "light" : "dark"})`,
            "success",
          );
        } else {
          const blob = await renderFusionSharePng(shareMeta, variant);
          downloadFusionSharePng(blob, alias, variant);
          toastFusionShare(
            `Fusion card downloaded (${variant === "white" ? "light" : "dark"})`,
            "success",
          );
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
    [alias, busy, cudaVersion, hwTopo, launchConfig, modelName, modelQuant, profileLabel, providerBuildVersion, providerName],
  );

  return (
    <div
      ref={rootRef}
      className="relative flex items-center gap-0.5 flex-shrink-0"
      data-fusion-share-exclude
    >
      {VARIANTS.map(({ id, label, title }) => {
        const isOpen = openVariant === id;
        return (
          <div key={id} className="relative">
            <button
              type="button"
              onClick={() => setOpenVariant((current) => (current === id ? null : id))}
              disabled={busy}
              title={title}
              aria-label={title}
              aria-expanded={isOpen}
              className={`fusion-share-variant-btn flex items-center justify-center gap-1 h-5 px-1 rounded-sm border transition-colors select-none ${
                isOpen
                  ? "border-stealth-muted/50 text-stealth-muted/80 bg-black/10"
                  : "border-stealth-border/50 text-stealth-muted/55 hover:text-stealth-muted/80 hover:border-stealth-muted/40 bg-transparent"
              } ${busy ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
            >
              <span
                className={`fusion-share-variant-swatch fusion-share-variant-swatch--${id}`}
                aria-hidden
              />
              <span className="fusion-share-variant-label">{label}</span>
            </button>

            {isOpen && (
              <div className="fusion-share-menu absolute left-0 top-full mt-1 z-[80] flex flex-col gap-0.5 min-w-[7.5rem]">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runCapture(id, "clipboard")}
                  className="fusion-share-menu__btn"
                >
                  TO CLIPBOARD
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runCapture(id, "download")}
                  className="fusion-share-menu__btn"
                >
                  DOWNLOAD PNG
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}