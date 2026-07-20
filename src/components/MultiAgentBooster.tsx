import { useCallback, useMemo, useState } from "react";
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
        kvQuantValues,
      }),
    [codingMode, speedBoost, brains, think, capabilities, dflashLibraryReady, kvQuantValues],
  );

  const snippets = useMemo(
    () =>
      buildHarnessSnippets({
        port,
        modelId,
        concurrentHint: plan.parallel,
      }),
    [port, modelId, plan.parallel],
  );

  const capSet = useMemo(() => new Set(capabilities), [capabilities]);

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
      {/* Header: title + Connect button */}
      <div className="full-auto-cockpit__header">
        <div className="full-auto-cockpit__header-main min-w-0 flex-1">
          <span className="full-auto-cockpit__title font-mono tracking-[0.16em] uppercase">
            Full Auto cockpit
          </span>
        </div>
        <button
          type="button"
          onClick={() => setHarnessOpen((v) => !v)}
          className="full-auto-cockpit__connect font-mono tracking-wider uppercase shrink-0 self-end"
          title="Copy endpoint + harness setup"
        >
          {harnessOpen ? "Hide connect" : "Connect harness"}
        </button>
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

        {/* 2x2 grid: Agents + Speed / KV + Think */}
        <div className="full-auto-cockpit__grid">
          {/* Row 1: Agents | Speed */}
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Agents"
              value={codingMode}
              onChange={onCodingMode}
              options={CODING_MODE_OPTIONS.map((o) => ({
                id: o.id,
                label: o.label,
                blurb: `${o.blurb} (x${o.parallel})`,
              }))}
              valueBadge={`x${parallelForCodingMode(codingMode)}`}
              badgeWidth="3rem"
              heroBadge
            />
          </div>
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Speed"
              value={speedBoost === "off" ? "smart" : speedBoost}
              onChange={onSpeedBoost}
              options={SPEED_BOOST_OPTIONS.filter((o) => o.id !== "off").map((o) => {
                const needDraftLib = o.id === "dflash" && !dflashLibraryReady;
                const needCap = Boolean(o.needs && !capSet.has(o.needs));
                return {
                  id: o.id,
                  label: o.label,
                  blurb: needDraftLib
                    ? "DFlash needs a matching draft GGUF"
                    : needCap
                      ? `${o.label} not available`
                      : o.blurb,
                  disabled: needCap || needDraftLib,
                  badgeColor: o.id === "mtp" ? "amber" : o.id === "dflash" ? "cyan" : undefined,
                };
              })}
            />
          </div>

          {/* Row 2: KV | Think */}
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="KV"
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
      </div>

      {/* Status line — bottom of cockpit */}
      <div className="full-auto-cockpit__status font-mono text-center" title={plan.outcome}>
        <span className="full-auto-cockpit__status-text">
          {plan.outcome}
          {plan.softNote ? (
            <span className="full-auto-cockpit__status-note"> · {plan.softNote}</span>
          ) : null}
        </span>
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
    </div>
  );
}
