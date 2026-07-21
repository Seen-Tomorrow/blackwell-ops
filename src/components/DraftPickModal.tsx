/**
 * Unified draft picker — HF download candidates or local library re-pair.
 * Keyboard: ↑/↓ + Enter (catalog-style). Wheel cycles selection. Esc cancels.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DflashDraftOffer } from "../lib/dflashGetDraft";
import { normalizeHfModelIdInput } from "../lib/dflashGetDraft";

export type DraftPickMode = "hf-download" | "library";

export interface DraftPickListItem {
  id: string;
  /** Model / file name (row 1, after rank). */
  title: string;
  /** Secondary line: author · quant · size (no full path). */
  meta?: string;
  /** Optional raw score for sorting / hero match badge */
  score?: number;
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${Math.max(1, Math.round(mb))} MB`;
}

function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ↓`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K ↓`;
  if (n > 0) return `${n} ↓`;
  return "";
}

/** Hero match label from pairing score. */
export function draftMatchHeroLabel(score: number | undefined): string {
  if (score == null || !Number.isFinite(score) || score < 0) return "weak match";
  return `match ${Math.round(score)}%`;
}

export function hfOffersToPickItems(offers: DflashDraftOffer[]): DraftPickListItem[] {
  return offers.map((c) => {
    const slash = c.hfModelId.indexOf("/");
    const author = slash > 0 ? c.hfModelId.slice(0, slash) : c.hfAuthor;
    const name = slash > 0 ? c.hfModelId.slice(slash + 1) : c.hfModelId;
    return {
      id: c.hfModelId,
      title: name,
      meta: [
        author,
        c.quantType,
        formatSize(c.sizeBytes),
        c.downloads > 0 ? formatDownloads(c.downloads) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      score: c.score,
    };
  });
}

interface DraftPickModalProps {
  open: boolean;
  mode: DraftPickMode;
  mainLabel: string;
  items: DraftPickListItem[];
  /** Pre-select active pairing (library path or HF id) when opening. */
  initialSelectedId?: string | null;
  /** HF mode only — map id → full offer for confirm */
  hfOffers?: DflashDraftOffer[];
  resolving?: boolean;
  resolveError?: string | null;
  onCancel: () => void;
  /** HF list confirm */
  onConfirmHf?: (offer: DflashDraftOffer) => void;
  onConfirmManual?: (hfModelId: string) => void;
  /** Library mode — selected local draft path */
  onConfirmLibrary?: (path: string) => void;
}

export default function DraftPickModal({
  open,
  mode,
  mainLabel,
  items,
  initialSelectedId = null,
  hfOffers = [],
  resolving = false,
  resolveError = null,
  onCancel,
  onConfirmHf,
  onConfirmManual,
  onConfirmLibrary,
}: DraftPickModalProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pickSource, setPickSource] = useState<"list" | "manual">("list");
  const [manualId, setManualId] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const allowManual = mode === "hf-download";

  useEffect(() => {
    if (!open) return;
    setManualId("");
    if (items.length === 0) {
      setSelectedIdx(0);
      setPickSource(allowManual ? "manual" : "list");
      return;
    }
    // Open with already-active draft selected when auto-logic paired one.
    let idx = 0;
    if (initialSelectedId) {
      const want = initialSelectedId.replace(/\\/g, "/").toLowerCase();
      const hit = items.findIndex((it) => {
        const id = it.id.replace(/\\/g, "/").toLowerCase();
        return id === want || id.endsWith(want) || want.endsWith(id);
      });
      if (hit >= 0) idx = hit;
    }
    setSelectedIdx(idx);
    setPickSource("list");
  }, [open, items, allowManual, mode, initialSelectedId]);

  // Keep highlighted card in view
  useEffect(() => {
    if (!open || pickSource !== "list") return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector(`[data-draft-pick-index="${selectedIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, open, pickSource]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!resolving) onCancel();
        return;
      }
      // Don't steal arrows while typing manual HF id
      const tag = (e.target as HTMLElement)?.tagName;
      const typingManual =
        pickSource === "manual" && (tag === "INPUT" || tag === "TEXTAREA");

      if (!typingManual && items.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        e.stopPropagation();
        setPickSource("list");
        setSelectedIdx((h) => {
          if (e.key === "ArrowDown") return Math.min(h + 1, items.length - 1);
          return Math.max(h - 1, 0);
        });
        return;
      }
      if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (resolving) return;
        if (pickSource === "manual" && allowManual) {
          const id = normalizeHfModelIdInput(manualId);
          if (id) {
            e.preventDefault();
            e.stopPropagation();
            onConfirmManual?.(id);
          }
          return;
        }
        if (pickSource === "list" && items[selectedIdx]) {
          e.preventDefault();
          e.stopPropagation();
          commitListIndex(selectedIdx);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    open,
    items,
    selectedIdx,
    pickSource,
    manualId,
    allowManual,
    resolving,
    onCancel,
    onConfirmManual,
  ]);

  const commitListIndex = (idx: number) => {
    const item = items[idx];
    if (!item) return;
    if (mode === "library") {
      onConfirmLibrary?.(item.id);
      return;
    }
    const offer = hfOffers.find((o) => o.hfModelId === item.id);
    if (offer) onConfirmHf?.(offer);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (items.length === 0 || resolving) return;
    e.preventDefault();
    setPickSource("list");
    const dir = e.deltaY > 0 ? 1 : -1;
    setSelectedIdx((h) => Math.max(0, Math.min(items.length - 1, h + dir)));
  };

  if (!open) return null;

  const selected = pickSource === "list" ? items[Math.min(selectedIdx, Math.max(0, items.length - 1))] : null;
  const manualNormalized = normalizeHfModelIdInput(manualId);
  const canConfirmList = pickSource === "list" && selected != null && !resolving;
  const canConfirmManual = pickSource === "manual" && allowManual && Boolean(manualNormalized) && !resolving;

  const title =
    mode === "library" ? "Choose local draft" : "Confirm DFlash draft";
  const hint =
    mode === "library"
      ? "↑/↓ or mouse wheel · Enter to pair · Esc cancel. Library match is a guess — pick the right file."
      : "↑/↓ or mouse wheel · Enter to download · or paste HF org/repo. Download only after confirm.";

  const primaryLabel = () => {
    if (resolving) return mode === "library" ? "Pairing…" : "Resolving…";
    if (pickSource === "manual") return "Download from repo";
    if (mode === "library") return "Use this draft";
    if (selected) {
      const offer = hfOffers.find((o) => o.hfModelId === selected.id);
      return offer ? `Download ${offer.quantType}` : "Download";
    }
    return "Confirm";
  };

  const handlePrimary = () => {
    if (pickSource === "manual" && allowManual && manualNormalized) {
      onConfirmManual?.(manualNormalized);
      return;
    }
    if (selected) commitListIndex(items.indexOf(selected));
  };

  const modal = (
    <div
      className="dflash-pick-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !resolving) onCancel();
      }}
    >
      <div
        className="dflash-pick-modal font-mono"
        role="dialog"
        aria-modal="true"
        aria-labelledby="draft-pick-title"
      >
        <div className="dflash-pick-modal__header">
          <h3 id="draft-pick-title" className="dflash-pick-modal__title">
            {title}
          </h3>
          <p className="dflash-pick-modal__sub">
            For <span className="dflash-pick-modal__main">{mainLabel}</span>
          </p>
          <p className="dflash-pick-modal__hint">{hint}</p>
        </div>

        {items.length > 0 ? (
          <div
            ref={listRef}
            className="dflash-pick-modal__list"
            role="listbox"
            aria-label={mode === "library" ? "Local draft models" : "HF draft candidates"}
            onWheel={handleWheel}
          >
            {items.map((c, idx) => {
              const active = pickSource === "list" && idx === selectedIdx;
              const matchHero = draftMatchHeroLabel(c.score);
              const weak = c.score == null || !Number.isFinite(c.score) || c.score < 0;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  data-draft-pick-index={idx}
                  aria-selected={active}
                  className={`dflash-pick-modal__card${active ? " dflash-pick-modal__card--active" : ""}`}
                  onClick={() => {
                    setPickSource("list");
                    setSelectedIdx(idx);
                  }}
                  onDoubleClick={() => {
                    if (!resolving) {
                      setPickSource("list");
                      setSelectedIdx(idx);
                      commitListIndex(idx);
                    }
                  }}
                  disabled={resolving}
                >
                  <div className="dflash-pick-modal__card-cols">
                    <div className="dflash-pick-modal__card-left">
                      <div className="dflash-pick-modal__card-top">
                        <span className="dflash-pick-modal__rank">#{idx + 1}</span>
                        <span className="dflash-pick-modal__repo" title={c.title}>
                          {c.title}
                        </span>
                      </div>
                      {c.meta ? (
                        <div className="dflash-pick-modal__meta">{c.meta}</div>
                      ) : null}
                    </div>
                    <div
                      className={`dflash-pick-modal__match${weak ? " dflash-pick-modal__match--weak" : ""}`}
                      title={matchHero}
                    >
                      {matchHero}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="dflash-pick-modal__empty">
            {mode === "library"
              ? "No DFlash drafts found in your library yet."
              : "No auto-matches — paste the HF draft repo below."}
          </p>
        )}

        {allowManual ? (
          <div
            className={`dflash-pick-modal__manual${pickSource === "manual" ? " dflash-pick-modal__manual--active" : ""}`}
          >
            <label className="dflash-pick-modal__manual-label" htmlFor="draft-manual-hf-id">
              Or HF model id
            </label>
            <input
              id="draft-manual-hf-id"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="zai-org/GLM-5.1"
              value={manualId}
              disabled={resolving}
              onChange={(e) => {
                setManualId(e.target.value);
                setPickSource("manual");
              }}
              onFocus={() => setPickSource("manual")}
              className="dflash-pick-modal__manual-input"
            />
            <p className="dflash-pick-modal__manual-hint">
              Format: org/repo — e.g. zai-org/GLM-5.1 or full huggingface.co URL
            </p>
          </div>
        ) : null}

        {resolveError ? <p className="dflash-pick-modal__error">{resolveError}</p> : null}

        <div className="dflash-pick-modal__actions">
          <button
            type="button"
            className="dflash-pick-modal__btn dflash-pick-modal__btn--ghost"
            onClick={onCancel}
            disabled={resolving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="dflash-pick-modal__btn dflash-pick-modal__btn--primary"
            disabled={!(canConfirmList || canConfirmManual)}
            onClick={handlePrimary}
          >
            {primaryLabel()}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
