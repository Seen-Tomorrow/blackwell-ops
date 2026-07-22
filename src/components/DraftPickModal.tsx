/**
 * Unified draft picker — local library (≤3) + optional HF packs (≤3, expand) + manual HF.
 * Keyboard: ↑/↓ + Enter. Wheel cycles active list. Esc cancels.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DflashDraftOffer } from "../lib/dflashGetDraft";
import {
  DFLASH_SCORE_HIGH,
  DFLASH_SCORE_SUGGEST,
  dflashMatchTier,
  normalizeHfModelIdInput,
} from "../lib/dflashGetDraft";

export type DraftPickMode = "hf-download" | "library";

export interface DraftPickListItem {
  id: string;
  /** Model / file name (row 1, after rank). */
  title: string;
  /** Secondary line: author · quant · size (no full path). */
  meta?: string;
  /** Optional 0–100 confidence for sorting / hero match badge */
  score?: number;
}

const LOCAL_LIST_CAP = 3;
const REMOTE_LIST_CAP = 3;

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

/**
 * Hero match label — 0–100 confidence.
 *   ≥80 high · 50–79 match (confirm) · <50 weak
 */
export function draftMatchHeroLabel(score: number | undefined): string {
  if (score == null || !Number.isFinite(score) || score < 0) return "weak match";
  const pct = Math.max(0, Math.min(100, Math.round(score)));
  const tier = dflashMatchTier(pct);
  if (tier === "ignore") return `weak ${pct}%`;
  if (tier === "high") return `high ${pct}%`;
  return `match ${pct}%`;
}

export function draftMatchTierClass(score: number | undefined): string {
  const tier = dflashMatchTier(score);
  if (tier === "high") return "dflash-pick-modal__match--high";
  if (tier === "ignore") return "dflash-pick-modal__match--weak";
  return "dflash-pick-modal__match--suggest";
}

export function hfOffersToPickItems(offers: DflashDraftOffer[]): DraftPickListItem[] {
  return offers.slice(0, REMOTE_LIST_CAP).map((c) => {
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

type PickSource = "local" | "remote" | "manual";

interface DraftPickModalProps {
  open: boolean;
  mode: DraftPickMode;
  mainLabel: string;
  /** Local on-disk drafts (top 3 shown). */
  localItems?: DraftPickListItem[];
  /**
   * @deprecated Prefer localItems + remote via hfOffers.
   * When localItems omitted, used as the primary list (legacy).
   */
  items?: DraftPickListItem[];
  /** Pre-select active local pairing path when opening. */
  initialSelectedId?: string | null;
  /** HF download candidates (top 3 when expanded). */
  hfOffers?: DflashDraftOffer[];
  /** True while parent is fetching HF list (expand search). */
  remoteLoading?: boolean;
  resolving?: boolean;
  resolveError?: string | null;
  onCancel: () => void;
  onConfirmHf?: (offer: DflashDraftOffer) => void;
  onConfirmManual?: (hfModelId: string) => void;
  onConfirmLibrary?: (path: string) => void;
  /** Lazy-load HF when user expands remote (if offers empty). */
  onRequestRemote?: () => void;
}

function pickDefaultLocalIdx(items: DraftPickListItem[], initialSelectedId: string | null): number {
  if (items.length === 0) return 0;
  if (initialSelectedId) {
    const want = initialSelectedId.replace(/\\/g, "/").toLowerCase();
    const hit = items.findIndex((it) => {
      const id = it.id.replace(/\\/g, "/").toLowerCase();
      return id === want || id.endsWith(want) || want.endsWith(id);
    });
    if (hit >= 0) return hit;
  }
  const highIdx = items.findIndex((it) => it.score != null && it.score >= DFLASH_SCORE_HIGH);
  if (highIdx >= 0) return highIdx;
  const okIdx = items.findIndex((it) => it.score != null && it.score >= DFLASH_SCORE_SUGGEST);
  if (okIdx >= 0) return okIdx;
  return 0;
}

function pickDefaultRemoteIdx(items: DraftPickListItem[]): number {
  if (items.length === 0) return 0;
  const highIdx = items.findIndex((it) => it.score != null && it.score >= DFLASH_SCORE_HIGH);
  if (highIdx >= 0) return highIdx;
  const okIdx = items.findIndex((it) => it.score != null && it.score >= DFLASH_SCORE_SUGGEST);
  if (okIdx >= 0) return okIdx;
  return 0;
}

function MatchRight({ score }: { score?: number }) {
  const matchHero = draftMatchHeroLabel(score);
  const tier = dflashMatchTier(score);
  const tierClass = draftMatchTierClass(score);
  return (
    <div className="dflash-pick-modal__match-col">
      {tier === "high" ? (
        <span className="dflash-pick-modal__rec-pill" title="High confidence — confirm to use">
          Best
        </span>
      ) : tier === "suggest" ? (
        <span
          className="dflash-pick-modal__rec-pill dflash-pick-modal__rec-pill--suggest"
          title="Recommended — confirm match"
        >
          Rec
        </span>
      ) : null}
      <div className={`dflash-pick-modal__match ${tierClass}`} title={matchHero}>
        {matchHero}
      </div>
    </div>
  );
}

export default function DraftPickModal({
  open,
  mode,
  mainLabel,
  localItems: localItemsProp,
  items: legacyItems,
  initialSelectedId = null,
  hfOffers = [],
  remoteLoading = false,
  resolving = false,
  resolveError = null,
  onCancel,
  onConfirmHf,
  onConfirmManual,
  onConfirmLibrary,
  onRequestRemote,
}: DraftPickModalProps) {
  const localAll = localItemsProp ?? (mode === "library" ? legacyItems ?? [] : []);
  const localItems = localAll.slice(0, LOCAL_LIST_CAP);
  const remoteItems = hfOffersToPickItems(hfOffers);
  const hasLocal = localItems.length > 0;
  const hasRemote = remoteItems.length > 0;
  const allowManual = Boolean(onConfirmManual);

  const [pickSource, setPickSource] = useState<PickSource>("local");
  const [localIdx, setLocalIdx] = useState(0);
  const [remoteIdx, setRemoteIdx] = useState(0);
  const [manualId, setManualId] = useState("");
  const [remoteOpen, setRemoteOpen] = useState(false);
  const localListRef = useRef<HTMLDivElement>(null);
  const remoteListRef = useRef<HTMLDivElement>(null);
  const prevOpenRef = useRef(false);

  // Reset only when modal opens (false→true).
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;
    if (!justOpened) return;

    setManualId("");
    // Get-draft with remote ready → expand remote. Change-draft with local → local first.
    const openRemote =
      mode === "hf-download" && (hfOffers.length > 0 || !hasLocal);
    setRemoteOpen(openRemote);

    if (hasLocal) {
      setLocalIdx(pickDefaultLocalIdx(localItems, initialSelectedId));
      setPickSource("local");
    } else if (hfOffers.length > 0 || openRemote) {
      setRemoteIdx(pickDefaultRemoteIdx(remoteItems));
      setPickSource(hfOffers.length > 0 ? "remote" : allowManual ? "manual" : "local");
    } else {
      setPickSource(allowManual ? "manual" : "local");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot at open only
  }, [open]);

  // When HF results arrive after expand, select best remote (don't steal manual focus).
  useEffect(() => {
    if (!open || !remoteOpen) return;
    if (remoteItems.length === 0) return;
    setRemoteIdx(pickDefaultRemoteIdx(remoteItems));
    setPickSource((src) => {
      if (src === "manual") return src;
      if (src === "remote" || !hasLocal) return "remote";
      return src;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to offers landing
  }, [open, remoteOpen, hfOffers]);

  useEffect(() => {
    if (!open) return;
    if (pickSource === "local") {
      const el = localListRef.current?.querySelector(
        `[data-draft-pick-index="${localIdx}"]`,
      ) as HTMLElement | null;
      el?.scrollIntoView({ block: "nearest" });
    } else if (pickSource === "remote") {
      const el = remoteListRef.current?.querySelector(
        `[data-draft-pick-index="${remoteIdx}"]`,
      ) as HTMLElement | null;
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [localIdx, remoteIdx, open, pickSource]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!resolving) onCancel();
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      const typingManual =
        pickSource === "manual" && (tag === "INPUT" || tag === "TEXTAREA");

      if (!typingManual && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        // Unified focus chain: local → remote (when open) so remote never traps focus.
        type Slot = { src: "local" | "remote"; idx: number };
        const chain: Slot[] = [
          ...localItems.map((_, idx) => ({ src: "local" as const, idx })),
          ...(remoteOpen ? remoteItems.map((_, idx) => ({ src: "remote" as const, idx })) : []),
        ];
        if (chain.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        let cur = 0;
        if (pickSource === "local") {
          cur = chain.findIndex((s) => s.src === "local" && s.idx === localIdx);
        } else if (pickSource === "remote") {
          cur = chain.findIndex((s) => s.src === "remote" && s.idx === remoteIdx);
        } else {
          cur = dir > 0 ? -1 : 0;
        }
        if (cur < 0) cur = dir > 0 ? -1 : 0;
        const next = Math.max(0, Math.min(chain.length - 1, cur + dir));
        const slot = chain[next];
        if (!slot) return;
        if (slot.src === "local") {
          setPickSource("local");
          setLocalIdx(slot.idx);
        } else {
          setPickSource("remote");
          setRemoteIdx(slot.idx);
        }
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
        if (pickSource === "local" && localItems[localIdx]) {
          e.preventDefault();
          e.stopPropagation();
          commitLocal(localIdx);
        }
        if (pickSource === "remote" && remoteItems[remoteIdx]) {
          e.preventDefault();
          e.stopPropagation();
          commitRemote(remoteIdx);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    open,
    localItems,
    remoteItems,
    localIdx,
    remoteIdx,
    pickSource,
    manualId,
    allowManual,
    resolving,
    onCancel,
    onConfirmManual,
    hasLocal,
    hasRemote,
    remoteOpen,
  ]);

  const commitLocal = (idx: number) => {
    const item = localItems[idx];
    if (!item) return;
    onConfirmLibrary?.(item.id);
  };

  const commitRemote = (idx: number) => {
    const item = remoteItems[idx];
    if (!item) return;
    const offer = hfOffers.find((o) => o.hfModelId === item.id);
    if (offer) onConfirmHf?.(offer);
  };

  /** Wheel steps across local+remote chain (same as ↑/↓) when remote is open. */
  const stepFocusChain = (dir: 1 | -1) => {
    type Slot = { src: "local" | "remote"; idx: number };
    const chain: Slot[] = [
      ...localItems.map((_, idx) => ({ src: "local" as const, idx })),
      ...(remoteOpen ? remoteItems.map((_, idx) => ({ src: "remote" as const, idx })) : []),
    ];
    if (chain.length === 0) return;
    let cur = 0;
    if (pickSource === "local") {
      cur = chain.findIndex((s) => s.src === "local" && s.idx === localIdx);
    } else if (pickSource === "remote") {
      cur = chain.findIndex((s) => s.src === "remote" && s.idx === remoteIdx);
    } else {
      cur = dir > 0 ? -1 : 0;
    }
    if (cur < 0) cur = dir > 0 ? -1 : 0;
    const next = Math.max(0, Math.min(chain.length - 1, cur + dir));
    const slot = chain[next];
    if (!slot) return;
    if (slot.src === "local") {
      setPickSource("local");
      setLocalIdx(slot.idx);
    } else {
      setPickSource("remote");
      setRemoteIdx(slot.idx);
    }
  };

  const handleLocalWheel = (e: React.WheelEvent) => {
    if (resolving) return;
    if (localItems.length === 0 && !(remoteOpen && hasRemote)) return;
    e.preventDefault();
    e.stopPropagation();
    stepFocusChain(e.deltaY > 0 ? 1 : -1);
  };

  const handleRemoteWheel = (e: React.WheelEvent) => {
    if (resolving) return;
    if (remoteItems.length === 0 && !hasLocal) return;
    e.preventDefault();
    e.stopPropagation();
    stepFocusChain(e.deltaY > 0 ? 1 : -1);
  };

  const toggleRemote = () => {
    if (resolving) return;
    const next = !remoteOpen;
    setRemoteOpen(next);
    if (next) {
      setPickSource(hasRemote ? "remote" : pickSource);
      if (!hasRemote && !remoteLoading) onRequestRemote?.();
    }
  };

  if (!open) return null;

  const selectedLocal =
    pickSource === "local" ? localItems[Math.min(localIdx, Math.max(0, localItems.length - 1))] : null;
  const selectedRemote =
    pickSource === "remote"
      ? remoteItems[Math.min(remoteIdx, Math.max(0, remoteItems.length - 1))]
      : null;
  const manualNormalized = normalizeHfModelIdInput(manualId);
  const canConfirmLocal = pickSource === "local" && selectedLocal != null && !resolving;
  const canConfirmRemote = pickSource === "remote" && selectedRemote != null && !resolving;
  const canConfirmManual = pickSource === "manual" && allowManual && Boolean(manualNormalized) && !resolving;

  const primaryLabel = () => {
    if (resolving) {
      if (pickSource === "manual" || pickSource === "remote") return "Resolving…";
      return "Pairing…";
    }
    if (pickSource === "manual") return "Download from HF";
    if (pickSource === "remote" && selectedRemote) {
      const offer = hfOffers.find((o) => o.hfModelId === selectedRemote.id);
      return offer ? `Download ${offer.quantType}` : "Download from HF";
    }
    if (pickSource === "local") return "Use local draft";
    return "Confirm";
  };

  const handlePrimary = () => {
    if (pickSource === "manual" && allowManual && manualNormalized) {
      onConfirmManual?.(manualNormalized);
      return;
    }
    if (pickSource === "remote" && selectedRemote) {
      commitRemote(remoteItems.indexOf(selectedRemote));
      return;
    }
    if (pickSource === "local" && selectedLocal) {
      commitLocal(localItems.indexOf(selectedLocal));
    }
  };

  const renderCard = (
    c: DraftPickListItem,
    idx: number,
    opts: {
      active: boolean;
      list: "local" | "remote";
      onSelect: () => void;
      onCommit: () => void;
    },
  ) => {
    const tier = dflashMatchTier(c.score);
    return (
      <button
        key={`${opts.list}-${c.id}`}
        type="button"
        role="option"
        data-draft-pick-index={idx}
        aria-selected={opts.active}
        className={`dflash-pick-modal__card dflash-pick-modal__card--${opts.list}${
          opts.active ? " dflash-pick-modal__card--active" : ""
        }${tier === "high" ? " dflash-pick-modal__card--high" : ""}`}
        onClick={opts.onSelect}
        onDoubleClick={() => {
          if (!resolving) {
            opts.onSelect();
            opts.onCommit();
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
            {c.meta ? <div className="dflash-pick-modal__meta">{c.meta}</div> : null}
          </div>
          <MatchRight score={c.score} />
        </div>
      </button>
    );
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
            Pick DFlash draft
          </h3>
          <p className="dflash-pick-modal__sub">
            For <span className="dflash-pick-modal__main">{mainLabel}</span>
          </p>
          <p className="dflash-pick-modal__hint">
            Local on disk · optional HF packs (expand) · paste repo · ↑/↓ wheel · Enter confirm · never
            auto-downloads
          </p>
        </div>

        {/* ── LOCAL (on drive) ─────────────────────────────────────────── */}
        <div className="dflash-pick-modal__section dflash-pick-modal__section--local">
          <div className="dflash-pick-modal__section-head">
            <span className="dflash-pick-modal__section-label">On your drive</span>
            <span className="dflash-pick-modal__section-badge dflash-pick-modal__section-badge--local">
              Local · max {LOCAL_LIST_CAP}
            </span>
          </div>
          {hasLocal ? (
            <div
              ref={localListRef}
              className="dflash-pick-modal__list dflash-pick-modal__list--capped"
              role="listbox"
              aria-label="Local draft models"
              onWheel={handleLocalWheel}
            >
              {localItems.map((c, idx) =>
                renderCard(c, idx, {
                  active: pickSource === "local" && idx === localIdx,
                  list: "local",
                  onSelect: () => {
                    setPickSource("local");
                    setLocalIdx(idx);
                  },
                  onCommit: () => commitLocal(idx),
                }),
              )}
            </div>
          ) : (
            <p className="dflash-pick-modal__empty">
              No DFlash drafts on disk yet — expand Hugging Face below or paste a repo.
            </p>
          )}
        </div>

        {/* ── REMOTE HF (collapsed by default when local exists) ───────── */}
        <div
          className={`dflash-pick-modal__section dflash-pick-modal__section--remote${
            remoteOpen ? " dflash-pick-modal__section--remote-open" : ""
          }`}
        >
          <button
            type="button"
            className="dflash-pick-modal__remote-toggle"
            onClick={toggleRemote}
            disabled={resolving}
            aria-expanded={remoteOpen}
          >
            <span className="dflash-pick-modal__section-label dflash-pick-modal__section-label--remote">
              {remoteOpen ? "▾" : "▸"} Download from Hugging Face
            </span>
            <span className="dflash-pick-modal__section-badge dflash-pick-modal__section-badge--remote">
              Remote · max {REMOTE_LIST_CAP}
            </span>
          </button>

          {remoteOpen ? (
            <div className="dflash-pick-modal__remote-body">
              {remoteLoading && !hasRemote ? (
                <p className="dflash-pick-modal__remote-status">Searching HF for drafts…</p>
              ) : hasRemote ? (
                <div
                  ref={remoteListRef}
                  className="dflash-pick-modal__list dflash-pick-modal__list--capped dflash-pick-modal__list--remote"
                  role="listbox"
                  aria-label="Hugging Face draft packs"
                  onWheel={handleRemoteWheel}
                >
                  {remoteItems.map((c, idx) =>
                    renderCard(c, idx, {
                      active: pickSource === "remote" && idx === remoteIdx,
                      list: "remote",
                      onSelect: () => {
                        setPickSource("remote");
                        setRemoteIdx(idx);
                      },
                      onCommit: () => commitRemote(idx),
                    }),
                  )}
                </div>
              ) : (
                <p className="dflash-pick-modal__remote-status">
                  {resolveError
                    ? resolveError
                    : "No HF packs scored ≥50% — paste org/repo below."}
                </p>
              )}
            </div>
          ) : (
            <p className="dflash-pick-modal__remote-collapsed-hint">
              Click to show up to {REMOTE_LIST_CAP} downloadable packs (separate from local files)
            </p>
          )}
        </div>

        {/* ── MANUAL HF ────────────────────────────────────────────────── */}
        {allowManual ? (
          <div
            className={`dflash-pick-modal__manual${
              pickSource === "manual" ? " dflash-pick-modal__manual--active" : ""
            }`}
          >
            <div className="dflash-pick-modal__section-head">
              <span className="dflash-pick-modal__section-label dflash-pick-modal__section-label--remote">
                Paste HF id
              </span>
              <span className="dflash-pick-modal__section-badge dflash-pick-modal__section-badge--remote">
                Manual download
              </span>
            </div>
            <label className="dflash-pick-modal__manual-label" htmlFor="draft-manual-hf-id">
              org/repo or full huggingface.co URL
            </label>
            <input
              id="draft-manual-hf-id"
              type="text"
              spellCheck={false}
              autoComplete="off"
              placeholder="org/repo or huggingface.co/…"
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
              Downloads a GGUF draft pack after confirm. Example: zai-org/GLM-5.1
            </p>
          </div>
        ) : null}

        {resolveError && !remoteOpen ? (
          <p className="dflash-pick-modal__error">{resolveError}</p>
        ) : null}

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
            className={`dflash-pick-modal__btn dflash-pick-modal__btn--primary${
              pickSource === "manual" || pickSource === "remote"
                ? " dflash-pick-modal__btn--primary-remote"
                : ""
            }`}
            disabled={!(canConfirmLocal || canConfirmRemote || canConfirmManual)}
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
