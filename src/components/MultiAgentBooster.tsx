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
import SliderParam from "./SliderParam";

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
      {/* Header: title + inset status · Connect bottom-right of header band */}
      <div className="full-auto-cockpit__header">
        <div className="full-auto-cockpit__header-main min-w-0 flex-1">
          <span className="full-auto-cockpit__title font-mono tracking-[0.16em] uppercase">
            Full Auto cockpit
          </span>
          <div className="full-auto-cockpit__status font-mono" title={plan.outcome}>
            <span className="full-auto-cockpit__status-text">
              {plan.outcome}
              {plan.softNote ? (
                <span className="full-auto-cockpit__status-note"> · {plan.softNote}</span>
              ) : null}
            </span>
          </div>
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

      <div
        className={`full-auto-cockpit__body ${
          showCtxRail ? "full-auto-cockpit__body--with-ctx" : "space-y-3"
        }`}
      >
        <div className="full-auto-cockpit__rows space-y-3 min-w-0">
          {/* a) AGENTS */}
          <div className="full-auto-cockpit__row flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
            <RowLabel>Agents</RowLabel>
            <div className="flex flex-wrap gap-1.5 min-w-0">
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

          {/* b) SPEED */}
          <div className="full-auto-cockpit__row flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
            <RowLabel>Speed</RowLabel>
            <div className="flex flex-wrap gap-1.5 min-w-0">
              {SPEED_BOOST_OPTIONS.map((opt) => {
                const needDraftLib = opt.id === "dflash" && !dflashLibraryReady;
                const needCap = Boolean(opt.needs && !capSet.has(opt.needs));
                const disabled = needCap || needDraftLib;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={disabled}
                    title={
                      needDraftLib
                        ? "DFlash needs a matching draft GGUF in your library"
                        : needCap
                          ? `${opt.label} not available for this model`
                          : opt.blurb
                    }
                    onClick={() => {
                      if (!disabled) onSpeedBoost(opt.id);
                    }}
                    className={chip(speedBoost === opt.id, disabled)}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* c) BRAINS */}
          <div className="full-auto-cockpit__row flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
            <RowLabel>Brains</RowLabel>
            <div className="flex flex-wrap gap-1.5 min-w-0 items-center">
              {BRAINS_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  title={opt.blurb}
                  onClick={() => onBrains(opt.id)}
                  className={chip(brains === opt.id)}
                >
                  {opt.label}
                </button>
              ))}
              <span className="full-auto-cockpit__sep select-none" aria-hidden>
                |
              </span>
              {THINK_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  title={opt.blurb}
                  onClick={() => onThink(opt.id)}
                  className={chip(think === opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {showCtxRail && (
          <div className="full-auto-cockpit__ctx-rail min-w-0">
            <span className="full-auto-cockpit__ctx-label font-mono tracking-wider uppercase">
              Context
            </span>
            <div className="full-auto-cockpit__ctx-slider min-w-0">
              <SliderParam
                paramKey="ctx"
                currentValue={ctxValue}
                defaultValue={ctxDefault}
                onChange={onCtxChange!}
                step={ctxStep}
                values={ctxValues}
                perSlotReserve={(ctxSlotCount ?? 1) > 1}
                perSlotTokens={ctxPerSlot != null && ctxPerSlot > 0 ? ctxPerSlot : undefined}
                perSlotTitle={
                  ctxPerSlot != null && ctxPerSlot > 0 && ctxSlotCount != null && ctxSlotCount > 1
                    ? `Per slot ≈ ${ctxPerSlot} tokens (total ÷ ${ctxSlotCount})`
                    : undefined
                }
              />
            </div>
          </div>
        )}
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
