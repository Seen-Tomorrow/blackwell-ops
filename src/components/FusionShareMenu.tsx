import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
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
  /** Bench footer — share glyph + SHARE RESULTS label before variant swatches. */
  labeled?: boolean;
  /** Inline bench actions — black/white share-icon triggers instead of color swatches. */
  triggerStyle?: "swatch" | "share-icon";
}

const VARIANTS: { id: FusionShareVariant; title: string }[] = [
  { id: "white", title: "Share light card (ARCTIC · phosphor light)" },
  { id: "black", title: "Share dark card (SLATE · phosphor dark)" },
];

function ShareGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 10.5 14 8l-3-2.5v2H8.5V5H11V2.5L14 5l-3 2.5z" />
      <path d="M3 4.5h5M3 8h3.5M3 11.5H7" />
    </svg>
  );
}

function ClipboardGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="5" y="3.5" width="8" height="10" rx="1" />
      <path d="M4 5.5H3.5a1.5 1.5 0 0 0-1.5 1.5v7a1.5 1.5 0 0 0 1.5 1.5H10" />
    </svg>
  );
}

function DownloadGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 2.5v8" />
      <path d="M5.5 8 8 10.5 10.5 8" />
      <path d="M3 13.5h10" />
    </svg>
  );
}

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
  labeled = false,
  triggerStyle = "swatch",
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
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);
  const anchorRefs = useRef<Record<FusionShareVariant, HTMLDivElement | null>>({
    white: null,
    black: null,
  });
  const menuPlacement = labeled ? "above" : "below";

  const positionMenu = useCallback(() => {
    if (!openVariant) {
      setMenuStyle(null);
      return;
    }
    const anchor = anchorRefs.current[openVariant];
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const gap = 4;
    if (menuPlacement === "above") {
      setMenuStyle({
        position: "fixed",
        left: rect.right,
        top: rect.top - gap,
        transform: "translate(-100%, -100%)",
        zIndex: 10000,
      });
    } else {
      setMenuStyle({
        position: "fixed",
        left: rect.right,
        top: rect.bottom + gap,
        transform: "translateX(-100%)",
        zIndex: 10000,
      });
    }
  }, [menuPlacement, openVariant]);

  useLayoutEffect(() => {
    positionMenu();
  }, [positionMenu]);

  useEffect(() => {
    if (!openVariant) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuPortalRef.current?.contains(target)) return;
      setOpenVariant(null);
    };
    const onReposition = () => positionMenu();
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [openVariant, positionMenu]);

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
      className={`relative flex items-center flex-shrink-0 ${labeled ? "gap-1" : "gap-0.5"}`}
      data-fusion-share-exclude
    >
      {labeled && (
        <>
          <ShareGlyph className="w-3 h-3 text-stealth-muted/55 flex-shrink-0" />
          <span className="text-[6px] font-mono text-stealth-muted/50 tracking-wider uppercase whitespace-nowrap">
            SHARE RESULTS
          </span>
        </>
      )}
      {VARIANTS.map(({ id, title }) => {
        const isOpen = openVariant === id;
        return (
          <div
            key={id}
            className="relative"
            ref={(node) => {
              anchorRefs.current[id] = node;
            }}
          >
            <button
              type="button"
              onClick={() => setOpenVariant((current) => (current === id ? null : id))}
              disabled={busy}
              title={title}
              aria-label={title}
              aria-expanded={isOpen}
              aria-haspopup="menu"
              className={`fusion-share-variant-btn flex items-center justify-center h-5 w-5 rounded-sm border transition-colors select-none ${
                triggerStyle === "share-icon"
                  ? `fusion-share-variant-btn--icon fusion-share-variant-btn--${id} ${
                      isOpen ? "fusion-share-variant-btn--open" : ""
                    }`
                  : isOpen
                    ? "border-stealth-muted/50 text-stealth-muted/80 bg-black/10"
                    : "border-stealth-border/50 text-stealth-muted/55 hover:text-stealth-muted/80 hover:border-stealth-muted/40 bg-transparent"
              } ${busy ? "opacity-50 cursor-wait" : "cursor-pointer"}`}
            >
              {triggerStyle === "share-icon" ? (
                <ShareGlyph className="w-3 h-3 flex-shrink-0" />
              ) : (
                <span
                  className={`fusion-share-variant-swatch fusion-share-variant-swatch--${id}`}
                  aria-hidden
                />
              )}
            </button>
          </div>
        );
      })}

      {openVariant &&
        menuStyle &&
        createPortal(
          <div
            ref={menuPortalRef}
            className="fusion-share-menu flex flex-col gap-0.5 min-w-[8.5rem] pointer-events-auto"
            style={menuStyle}
            role="menu"
          >
            <button
              type="button"
              disabled={busy}
              onClick={() => void runCapture(openVariant, "clipboard")}
              className="fusion-share-menu__btn fusion-share-menu__btn--icon"
              role="menuitem"
            >
              <ClipboardGlyph className="w-3 h-3 flex-shrink-0 opacity-80" />
              <span>CLIPBOARD</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runCapture(openVariant, "download")}
              className="fusion-share-menu__btn fusion-share-menu__btn--icon"
              role="menuitem"
            >
              <DownloadGlyph className="w-3 h-3 flex-shrink-0 opacity-80" />
              <span>PNG</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}