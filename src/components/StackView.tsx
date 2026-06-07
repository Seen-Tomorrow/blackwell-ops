import SlotLogPanel from "./SlotLogPanel";
import EngineBanner from "./EngineBanner";

import type { StackEntry, LogEntry } from "../lib/types";
import { useFusionData } from "../hooks/useFusionData";

const EMPTY_LOGS: LogEntry[] = [];
const EMPTY_EVENTS: Array<{ text: string; timestamp: string }> = [];

interface StackViewProps {
  stack: StackEntry[];
  logs: Map<number, LogEntry[]>;
  systemEvents: Map<number, Array<{ text: string; timestamp: string }>>;
  onStop: (slotIdx: number) => void;
  onStopAll: () => void;
}

function cardGlowClass(status: string): string {
  switch (status) {
    case "RUNNING": return "glow-border";
    case "LOADING": return "glow-border-warning";
    case "ERROR": return "glow-border-error";
    default: return "";
  }
}

export default function StackView({ stack, logs, systemEvents, onStop, onStopAll }: StackViewProps) {
  const { getEngine } = useFusionData();
  const onlineCount = stack.filter((e) => e.status === "RUNNING").length;
  const loadingCount = stack.filter((e) => e.status === "LOADING").length;

  return (
    <div className="flex flex-col h-full" data-engine-stack>
      <div className="px-4 py-2.5 border-b border-stealth-border/50 flex items-center justify-between fade-in">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-xs font-mono theme-accent-text tracking-widest shrink-0">✦ ENGINE STACK</h2>
          <span className="text-[8px] font-mono opacity-40 shrink-0">
            {onlineCount} RUNNING{loadingCount > 0 ? ` · ${loadingCount} LOADING` : ""} / {stack.length}
          </span>
        </div>

        <button
          onClick={onStopAll}
          disabled={stack.length === 0}
          className="px-2 py-0.5 text-[8px] font-mono border border-telemetry-red/40 text-telemetry-red hover:bg-telemetry-red/10 transition-colors rounded-sm disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
        >
          STOP ALL
        </button>
      </div>

      <div className="flex-1 overflow-y-auto eink-scrollbar p-4 min-h-0">
        {stack.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-stealth-muted fade-in">
            <svg width="48" height="48" viewBox="0 0 28 28" fill="none" className="mb-4 opacity-30 engine-stack-empty-icon">
              <path d="M14 2L6 8v10l8 6 8-6V8L14 2z" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
            <p className="text-xs font-mono tracking-wider theme-accent-text opacity-60">NO ENGINES DEPLOYED</p>
            <p className="text-[10px] font-mono mt-1 text-stealth-muted/60">
              LAUNCH MODELS FROM THE MODELS TAB
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {stack.map((entry, idx) => (
              <div
                key={`slot-${entry.idx}`}
                className={`engine-stack-card eink-panel rounded-sm overflow-hidden engine-panel-enter ${cardGlowClass(entry.status)} ${entry.status === "IDLE" ? "opacity-75" : ""}`}
              >
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
                <SlotLogPanel
                  entry={entry}
                  logs={logs.get(entry.idx) ?? EMPTY_LOGS}
                  systemEvents={systemEvents.get(entry.idx) ?? EMPTY_EVENTS}
                  fusionUpdate={getEngine(entry.idx)}
                  n_ctx={entry.n_ctx || 32768}
                  onStop={onStop}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}