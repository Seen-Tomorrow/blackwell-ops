import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpecCapability } from "../lib/specDraft";
import {
  BRAINS_OPTIONS,
  CODING_MODE_OPTIONS,
  SPEED_BOOST_OPTIONS,
  THINK_OPTIONS,
  buildHarnessSnippets,
  parallelForCodingMode,
  resolveFullAutoPlan,
  type BrainsId,
  type CodingModeId,
  type SpeedBoostId,
  type ThinkId,
} from "../lib/multiAgentBooster";
import CustomSliderParam from "./CustomSliderParam";
import CockpitSlider from "./CockpitSlider";

export type DflashGetUiState = "idle" | "searching" | "downloading" | "error";

export interface MultiAgentBoosterProps {
  codingMode: CodingModeId;
  speedBoost: SpeedBoostId;
  brains: BrainsId;
  think: ThinkId;
  onCodingMode: (mode: CodingModeId) => void;
  onSpeedBoost: (speed: SpeedBoostId) => void;
  onBrains: (brains: BrainsId) => void;
  onThink: (think: ThinkId) => void;
  capabilities: SpecCapability[];
  dflashLibraryReady: boolean;
  /** Family likely has HF DFlash packs — offer Get draft when library empty. */
  dflashGettable?: boolean;
  /** Short name of paired draft when library ready. */
  dflashDraftLabel?: string | null;
  dflashGetState?: DflashGetUiState;
  dflashGetError?: string | null;
  dflashGetOfferLabel?: string | null;
  onGetDflashDraft?: () => void;
  /** Open local-library draft re-picker (when pairing is wrong). */
  onChangeDflashDraft?: () => void;
  kvQuantValues: (string | number)[];
  port: number;
  modelId: string;
  /** Full Auto cockpit vs compact assisted strip. */
  layout?: "hero" | "normal" | "dense";
  className?: string;
  /** Right-rail CTX (hero Full Auto only). */
  ctxValue?: number | string;
  ctxDefault?: number | string;
  ctxValues?: (string | number)[];
  ctxStep?: number;
  onCtxChange?: (v: number) => void;
  ctxPerSlot?: number;
  ctxSlotCount?: number;
}

function RowLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="full-auto-cockpit__row-label font-mono tracking-wider uppercase flex-shrink-0">
      {children}
    </span>
  );
}

export default function MultiAgentBooster({
  codingMode,
  speedBoost,
  brains,
  think,
  onCodingMode,
  onSpeedBoost,
  onBrains,
  onThink,
  capabilities,
  dflashLibraryReady,
  dflashGettable = false,
  dflashDraftLabel = null,
  dflashGetState = "idle",
  dflashGetError = null,
  dflashGetOfferLabel = null,
  onGetDflashDraft,
  onChangeDflashDraft,
  kvQuantValues,
  port,
  modelId,
  layout = "normal",
  className = "",
  ctxValue,
  ctxDefault,
  ctxValues,
  ctxStep = 1024,
  onCtxChange,
  ctxPerSlot,
  ctxSlotCount = 1,
}: MultiAgentBoosterProps) {
  const [harnessOpen, setHarnessOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const hero = layout === "hero";
  const dense = layout === "dense";
  const showCtxRail = hero && onCtxChange != null && (ctxValues?.length ?? 0) > 0;

  const plan = useMemo(
    () =>
      resolveFullAutoPlan({
        codingMode,
        speed: speedBoost,
        brains,
        think,
        capabilities,
        dflashLibraryReady,
        dflashGettable,
        kvQuantValues,
      }),
    [
      codingMode,
      speedBoost,
      brains,
      think,
      capabilities,
      dflashLibraryReady,
      dflashGettable,
      kvQuantValues,
    ],
  );

  // Keep parent Boost state on the resolved plan (fixes thumb stuck on MTP after model change).
  useEffect(() => {
    if (plan.speed !== speedBoost) {
      onSpeedBoost(plan.speed);
    }
  }, [plan.speed, speedBoost, onSpeedBoost]);

  const capSet = useMemo(() => new Set(capabilities), [capabilities]);

  /** Effective boost for UI (never a disabled mark). */
  const displayBoost = plan.speed === "off" ? "smart" : plan.speed;

  const showDflashGet =
    Boolean(onGetDflashDraft) &&
    displayBoost === "dflash" &&
    (plan.needsDflashDraft ||
      !dflashLibraryReady ||
      dflashGetState === "searching" ||
      dflashGetState === "downloading" ||
      dflashGetState === "error");

  const showDflashChange =
    Boolean(onChangeDflashDraft) &&
    dflashLibraryReady &&
    displayBoost === "dflash";

  const mtpAvailable = capSet.has("mtp");
  const dflashAvailable = dflashLibraryReady || dflashGettable || capSet.has("dflash");
  /** MTP forces Solo — multi-agent marks stay visible but locked. */
  const mtpLocksAgents = displayBoost === "mtp";

  const snippets = useMemo(
    () =>
      buildHarnessSnippets({
        port,
        modelId,
        concurrentHint: plan.parallel,
      }),
    [port, modelId, plan.parallel],
  );

  const copy = useCallback(async (id: string, body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1600);
    } catch {
      /* ignore */
    }
  }, []);

  const chip = (active: boolean, disabled?: boolean) =>
    `full-auto-cockpit__chip font-mono rounded-sm border transition-colors ${
      active ? "full-auto-cockpit__chip--active" : ""
    }${disabled ? " full-auto-cockpit__chip--disabled" : ""}`;

  if (dense) {
    return (
      <div className={`full-auto-cockpit full-auto-cockpit--dense ${className}`}>
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <RowLabel>Agents</RowLabel>
          {CODING_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              title={`${opt.blurb} (×${opt.parallel})`}
              onClick={() => onCodingMode(opt.id)}
              className={chip(codingMode === opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`full-auto-cockpit ${hero ? "full-auto-cockpit--hero" : "full-auto-cockpit--normal"} ${className}`}
      data-booster-layout={layout}
    >
      {/* Header: title + BOOST · MEMORY · AGENTS · THINK (boost tinted when MTP/DFlash) */}
      <div className="full-auto-cockpit__header">
        <span className="full-auto-cockpit__title font-mono tracking-[0.16em] uppercase shrink-0">
          Full Auto cockpit
        </span>
        <div
          className="full-auto-cockpit__status full-auto-cockpit__status--inline font-mono min-w-0 flex-1"
          title={plan.outcome + (plan.softNote ? ` · ${plan.softNote}` : "")}
        >
          <span className="full-auto-cockpit__status-text">
            <span
              className={`full-auto-cockpit__boost-seg full-auto-cockpit__boost-seg--${plan.boostTone}`}
            >
              Boost {plan.boostLabel}
            </span>
            <span className="full-auto-cockpit__status-sep"> · </span>
            <span>Memory {plan.brainsLabel}</span>
            <span className="full-auto-cockpit__status-sep"> · </span>
            <span>Agents {plan.agentsLabel}</span>
            <span className="full-auto-cockpit__status-sep"> · </span>
            <span>Think {plan.thinkLabel}</span>
            {plan.softNote ? (
              <span className="full-auto-cockpit__status-note"> · {plan.softNote}</span>
            ) : null}
          </span>
        </div>
      </div>

      <div className="full-auto-cockpit__body space-y-3">
        {/* CTX hero section — full width, top of body */}
        {showCtxRail && (
          <div className="full-auto-cockpit__ctx-hero">
            <div className="full-auto-cockpit__ctx-slider min-w-0">
              <CustomSliderParam
                paramKey="ctx"
                currentValue={ctxValue}
                defaultValue={ctxDefault}
                onChange={onCtxChange!}
                step={ctxStep}
                values={ctxValues}
              />
            </div>
            <div className="full-auto-cockpit__ctx-values">
              <span className="full-auto-cockpit__ctx-value font-mono">
                {typeof ctxValue === "number"
                  ? `${Math.round(ctxValue / 1024)}K`
                  : String(ctxValue)}
              </span>
              {ctxPerSlot != null && ctxPerSlot > 0 && ctxSlotCount != null && ctxSlotCount > 1 && (
                <>
                  <span className="full-auto-cockpit__ctx-sep font-mono">|</span>
                  <span className="full-auto-cockpit__ctx-per-slot font-mono">
                    {Math.round(ctxPerSlot / 1024)}K / slot
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {/* 2x2: LEFT Memory / Boost · RIGHT Agents / Think */}
        <div className="full-auto-cockpit__grid">
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Memory"
              value={brains}
              onChange={onBrains}
              options={BRAINS_OPTIONS.map((o) => ({
                id: o.id,
                label: o.label,
                blurb: o.blurb,
              }))}
              valueBadge={BRAINS_OPTIONS.find((o) => o.id === brains)?.kvQuant}
              badgeWidth="3rem"
              heroBadge
            />
          </div>
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Agents"
              value={mtpLocksAgents ? "solo" : codingMode}
              onChange={onCodingMode}
              options={CODING_MODE_OPTIONS.map((o) => {
                const locked = mtpLocksAgents && o.id !== "solo";
                return {
                  id: o.id,
                  label: o.label,
                  blurb: locked
                    ? "MTP needs Solo — multi-agent disabled"
                    : `${o.blurb} (x${o.parallel})`,
                  disabled: locked,
                  strike: locked,
                };
              })}
              valueBadge={`x${mtpLocksAgents ? 1 : parallelForCodingMode(codingMode)}`}
              badgeWidth="3rem"
              heroBadge
              className={mtpLocksAgents ? "cockpit-slider-row--mtp-agents" : ""}
            />
          </div>

          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Boost"
              value={displayBoost}
              onChange={onSpeedBoost}
              options={SPEED_BOOST_OPTIONS.filter((o) => o.id !== "off").map((o) => {
                const mtpMissing = o.id === "mtp" && !mtpAvailable;
                const dflashMissing = o.id === "dflash" && !dflashAvailable;
                const needCap = mtpMissing || dflashMissing;
                const available =
                  (o.id === "mtp" && mtpAvailable) ||
                  (o.id === "dflash" && dflashAvailable) ||
                  o.id === "smart";
                let blurb = o.blurb;
                let aboveLabel: string | undefined;
                if (o.id === "dflash") {
                  if (dflashLibraryReady) {
                    aboveLabel = "draft ready";
                    blurb = dflashDraftLabel
                      ? `Draft ready: ${dflashDraftLabel} — change if wrong`
                      : "Draft ready in library";
                  } else if (dflashGettable) {
                    aboveLabel = "downloadable";
                    blurb = "Draft downloadable from HF — Get draft to confirm";
                  } else if (needCap) {
                    blurb = "DFlash not available for this model";
                  }
                } else if (o.id === "mtp") {
                  if (mtpAvailable) {
                    aboveLabel = "built-in";
                  } else if (needCap) {
                    blurb = "MTP not available for this model";
                  }
                }
                return {
                  id: o.id,
                  label: o.label,
                  blurb,
                  disabled: needCap,
                  // MTP = green, DFlash = violet — only when capable
                  badgeColor: o.id === "mtp" ? "green" : o.id === "dflash" ? "violet" : undefined,
                  emphasize: available && !needCap && (o.id === "mtp" || o.id === "dflash"),
                  aboveLabel,
                };
              })}
            />
          </div>
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Think"
              value={think}
              onChange={onThink}
              options={THINK_OPTIONS.map((o) => ({
                id: o.id,
                label: o.label,
                blurb: o.blurb,
              }))}
            />
          </div>
        </div>

        {/* Draft strip under Boost — 2-line violet block, full filename, button right */}
        {showDflashGet || showDflashChange ? (
          <div className="full-auto-cockpit__dflash-get font-mono">
            <div className="full-auto-cockpit__dflash-get-main min-w-0 flex-1">
              {showDflashGet ? (
                <>
                  <div className="full-auto-cockpit__dflash-get-line">
                    {dflashGetState === "searching"
                      ? "Searching HF for matching drafts…"
                      : dflashGetState === "downloading"
                        ? "Downloading draft…"
                        : dflashGetState === "error"
                          ? dflashGetError || "No DFlash draft found"
                          : "DFlash needs a draft model in your library"}
                  </div>
                  {dflashGetState === "downloading" && dflashGetOfferLabel ? (
                    <div className="full-auto-cockpit__dflash-get-name" title={dflashGetOfferLabel}>
                      {dflashGetOfferLabel}
                    </div>
                  ) : dflashGetState === "idle" || dflashGetState === "error" ? (
                    <div className="full-auto-cockpit__dflash-get-sub">
                      Confirm pack to download
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  <div className="full-auto-cockpit__dflash-get-line">Paired draft</div>
                  <div
                    className="full-auto-cockpit__dflash-get-name"
                    title={dflashDraftLabel ?? undefined}
                  >
                    {dflashDraftLabel || "—"}
                  </div>
                </>
              )}
            </div>
            <div className="full-auto-cockpit__dflash-get-actions">
              {showDflashChange ? (
                <button
                  type="button"
                  className="full-auto-cockpit__dflash-get-btn full-auto-cockpit__dflash-get-btn--ghost"
                  onClick={() => onChangeDflashDraft?.()}
                  title="Pick a different DFlash draft from your library"
                >
                  Change draft
                </button>
              ) : null}
              {showDflashGet ? (
                <button
                  type="button"
                  className="full-auto-cockpit__dflash-get-btn"
                  disabled={
                    !onGetDflashDraft ||
                    dflashGetState === "searching" ||
                    dflashGetState === "downloading"
                  }
                  onClick={() => onGetDflashDraft?.()}
                  title="Search Hugging Face for DFlash drafts — you confirm before download"
                >
                  {dflashGetState === "searching"
                    ? "Searching…"
                    : dflashGetState === "downloading"
                      ? "Downloading…"
                      : dflashGetState === "error"
                        ? "Retry Get draft"
                        : "Get draft"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {harnessOpen && (
        <div className="full-auto-cockpit__harness space-y-2">
          <p className="full-auto-cockpit__harness-hint font-mono leading-snug">
            Point an OpenAI-compatible harness here. Multi-agent only helps if the harness runs
            concurrent agents (≈ {parallelForCodingMode(plan.codingMode)} slots ready).
          </p>
          {snippets.map((s) => (
            <div key={s.id} className="full-auto-cockpit__snippet overflow-hidden">
              <div className="full-auto-cockpit__snippet-bar flex items-center justify-between gap-2">
                <span className="font-mono tracking-wider uppercase">{s.title}</span>
                <button
                  type="button"
                  onClick={() => void copy(s.id, s.body)}
                  className="full-auto-cockpit__copy font-mono"
                >
                  {copiedId === s.id ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="full-auto-cockpit__snippet-body font-mono whitespace-pre-wrap break-all leading-relaxed max-h-32 overflow-y-auto eink-scrollbar">
                {s.body}
              </pre>
            </div>
          ))}
        </div>
      )}

      <div className="full-auto-cockpit__footer">
        <button
          type="button"
          onClick={() => setHarnessOpen((v) => !v)}
          className="full-auto-cockpit__connect font-mono tracking-wider uppercase"
          title="Copy endpoint + harness setup"
        >
          {harnessOpen ? "Hide connect" : "Connect harness"}
        </button>
      </div>
    </div>
  );
}
