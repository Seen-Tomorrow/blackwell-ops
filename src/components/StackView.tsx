import "../styles/stack-page.css";
import { useEffect, useRef, useState } from "react";
import EngineBanner from "./EngineBanner";
import AnsiText from "./AnsiText";
import TabPageHeader from "./TabPageHeader";

import type { StackEntry } from "../lib/types";
import { sanitizeAlias } from "../lib/types";
import { getActiveStackSlots } from "../lib/engineStack";
import { useFusionSlot } from "../hooks/useFusionData";
import { useSlotLogStore } from "../lib/logSlotStore";

interface StackViewProps {
  stack: StackEntry[];
  onStop: (slotIdx: number) => void;
  onStopAll: () => void;
}

/** Compact token count for the CTX column (262144 → 256K). */
function formatCtx(n?: number): string {
  if (!n || n <= 0) return "—";
  if (n >= 1_048_576) return `${Math.round((n / 1_048_576) * 10) / 10}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

type RowPhase = { key: string; label: string };

function rowPhase(status: string, fusionPhase?: string): RowPhase {
  if (status === "LOADING") return { key: "loading", label: "LOADING" };
  if (status === "ERROR") return { key: "error", label: "ERROR" };
  if (status !== "RUNNING") return { key: "idle", label: status || "IDLE" };
  if (fusionPhase === "PP") return { key: "pp", label: "PREFILL" };
  if (fusionPhase === "TG") return { key: "tg", label: "GENERATING" };
  return { key: "idle", label: "IDLE" };
}

function phaseDotClass(key: string): string {
  switch (key) {
    case "pp": return "status-loading";
    case "tg": return "status-online";
    case "loading": return "status-loading";
    case "error": return "status-error";
    default: return "status-offline";
  }
}

/**
 * One engine in the fleet table. The row always subscribes to its fusion lane
 * (phase/TPS); the log tail only mounts while the row is expanded, so a 64-engine
 * fleet does not hold 64 log subscriptions.
 */
function StackRow({
  entry,
  expanded,
  onToggle,
  onStop,
}: {
  entry: StackEntry;
  expanded: boolean;
  onToggle: () => void;
  onStop: (slotIdx: number) => void;
}) {
  const fusion = useFusionSlot(entry.idx);
  const phase = rowPhase(entry.status, fusion?.phase);
  const tps =
    fusion?.engine_state === "ACTIVE" && fusion.genTps > 0 ? fusion.genTps : null;
  const alias = entry.alias ? sanitizeAlias(entry.alias).toUpperCase() : `SLOT ${entry.idx + 1}`;
  const vramGb = entry.vram_mib ? (entry.vram_mib / 1024).toFixed(1) : null;

  return (
    <div className={`stack-item${expanded ? " is-open" : ""}`}>
      <div
        role="row"
        tabIndex={0}
        aria-expanded={expanded}
        className="stack-row"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className="stack-row__cell stack-row__slot">
          {String(entry.idx + 1).padStart(2, "0")}
        </span>
        <span className="stack-row__cell stack-row__engine" title={entry.alias}>
          {alias}
        </span>
        <span className="stack-row__cell stack-row__model" title={entry.model_path || entry.model_name}>
          {entry.model_name && entry.model_name !== "none" ? entry.model_name : "—"}
        </span>
        <span className="stack-row__cell stack-row__gpu">{entry.gpu || "—"}</span>
        <span className="stack-row__cell stack-row__port">:{entry.port}</span>
        <span className={`stack-row__cell stack-row__state stack-row__state--${phase.key}`}>
          <span className={`status-dot ${phaseDotClass(phase.key)}`} aria-hidden />
          {phase.label}
        </span>
        <span className={`stack-row__cell stack-row__tps${tps != null ? " is-live" : ""}`}>
          {tps != null ? tps.toFixed(1) : "--"}
        </span>
        <span className="stack-row__cell stack-row__ctx">{formatCtx(entry.n_ctx)}</span>
        <span className="stack-row__cell stack-row__caret" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
        <span className="stack-row__cell stack-row__actions">
          <button
            type="button"
            className="stack-row__stop"
            disabled={entry.status === "IDLE" || entry.status === "ERROR"}
            onClick={(e) => {
              e.stopPropagation();
              onStop(entry.idx);
            }}
            title={`Stop ${alias}`}
          >
            STOP
          </button>
        </span>
      </div>

      {expanded && (
        <div className="stack-detail">
          <EngineBanner
            slotIndex={entry.idx}
            alias={entry.alias}
            providerName={entry.provider_name}
            providerType={entry.provider_type}
            binaryProfile={entry.binaryProfile}
            status={entry.status}
            gpuMask={entry.gpu}
            buildInfo={entry.build_info}
          />
          {/* Provider/profile are already in the banner above. */}
          <div className="stack-detail__stats">
            <span><b>CTX</b> {formatCtx(entry.n_ctx)}</span>
            <span><b>SPLIT</b> {entry.splitMode || "none"}</span>
            <span><b>PARALLEL</b> {entry.parallel ?? 1}</span>
            <span><b>VRAM</b> {vramGb ? `${vramGb} GB` : "—"}</span>
          </div>
          <StackLogTail idx={entry.idx} status={entry.status} />
        </div>
      )}
    </div>
  );
}

/** Mounted only for the expanded row — log subscriptions stay scoped. */
function StackLogTail({ idx, status }: { idx: number; status: string }) {
  const { logs, events } = useSlotLogStore(idx);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, events.length]);

  const visible = logs.slice(-150);

  return (
    <div ref={ref} className="stack-detail__log eink-scrollbar">
      {visible.length === 0 && events.length === 0 ? (
        <p className="stack-detail__empty">
          {status === "LOADING" ? "WAITING FOR READY…" : "NO OUTPUT YET"}
        </p>
      ) : (
        <>
          {events.map((evt, i) => (
            <p key={`sys-${i}`} className="stack-detail__line stack-detail__line--sys">
              {evt.text}
            </p>
          ))}
          {visible.map((log, i) => (
            <p key={`log-${i}`} className="stack-detail__line">
              <AnsiText text={log.text} />
            </p>
          ))}
        </>
      )}
    </div>
  );
}

export default function StackView({ stack, onStop, onStopAll }: StackViewProps) {
  const activeSlots = getActiveStackSlots(stack);
  const onlineCount = activeSlots.filter((e) => e.status === "RUNNING").length;
  const loadingCount = activeSlots.filter((e) => e.status === "LOADING").length;
  const errorCount = activeSlots.filter((e) => e.status === "ERROR").length;

  const [openSlot, setOpenSlot] = useState<number | null>(null);

  // One or two engines: keep the inspector open so the tab is not a lone row.
  // A fleet: rows stay collapsed until the user picks one.
  const slotKey = activeSlots.map((e) => e.idx).join(",");
  useEffect(() => {
    setOpenSlot((prev) => {
      if (prev != null && activeSlots.some((e) => e.idx === prev)) return prev;
      return activeSlots.length > 0 && activeSlots.length <= 2 ? activeSlots[0].idx : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey]);

  return (
    <div className="flex flex-col h-full" data-engine-stack>
      <TabPageHeader
        title="ENGINE STACK"
        meta={(
          <span className="type-tiny font-mono eng-stack-meta opacity-40 shrink-0">
            {activeSlots.length} ENGINES
            {onlineCount > 0 ? ` · ${onlineCount} RUNNING` : ""}
            {loadingCount > 0 ? ` · ${loadingCount} LOADING` : ""}
            {errorCount > 0 ? ` · ${errorCount} ERROR` : ""}
          </span>
        )}
        actions={(
          <button
            onClick={onStopAll}
            disabled={activeSlots.length === 0}
            className="px-2 py-0.5 type-tiny font-mono eng-stop-all transition-colors rounded-sm disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
          >
            STOP ALL
          </button>
        )}
      />

      <div className="flex-1 overflow-y-auto eink-scrollbar p-3 min-h-0">
        {activeSlots.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full eng-stack-empty fade-in">
            <svg width="48" height="48" viewBox="0 0 28 28" fill="none" className="mb-4 opacity-30 engine-stack-empty-icon">
              <path d="M14 2L6 8v10l8 6 8-6V8L14 2z" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
            <p className="text-xs font-mono tracking-wider theme-accent-text opacity-60">NO ENGINES RUNNING</p>
            <p className="type-body font-mono mt-1 eng-stack-empty__note">
              LAUNCH A MODEL ON OPERATIONS — THE FLEET APPEARS HERE
            </p>
          </div>
        ) : (
          <div className="stack-table" role="table" aria-label="Running engines">
            <div className="stack-table__head" role="row">
              <span className="stack-row__cell">SLOT</span>
              <span className="stack-row__cell">ENGINE</span>
              <span className="stack-row__cell">MODEL</span>
              <span className="stack-row__cell">GPU</span>
              <span className="stack-row__cell">PORT</span>
              <span className="stack-row__cell">STATE</span>
              <span className="stack-row__cell stack-row__cell--right">TPS</span>
              <span className="stack-row__cell stack-row__cell--right">CTX</span>
              <span className="stack-row__cell" />
              <span className="stack-row__cell" />
            </div>

            {activeSlots.map((entry) => (
              <StackRow
                key={`slot-${entry.idx}`}
                entry={entry}
                expanded={openSlot === entry.idx}
                onToggle={() => setOpenSlot((prev) => (prev === entry.idx ? null : entry.idx))}
                onStop={onStop}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
