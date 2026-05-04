import { motion } from "framer-motion";
import EngineCard from "./EngineCard";
import EngineBanner from "./EngineBanner";
import type { StackEntry, LogEntry, SystemEvent, EnginePerfEvent } from "../lib/types";

const EMPTY_LOGS: LogEntry[] = [];
const EMPTY_EVENTS: Array<{ text: string; timestamp: string }> = [];

interface StackViewProps {
  stack: StackEntry[];
  logs: Map<number, LogEntry[]>;
  systemEvents: Map<number, Array<{ text: string; timestamp: string }>>;
  enginePerfEvents: Map<number, EnginePerfEvent>;
  onStop: (alias: string) => void;
  onStopAll: () => void;
}

export default function StackView({ stack, logs, systemEvents, enginePerfEvents, onStop, onStopAll }: StackViewProps) {
  const onlineCount = stack.filter((e) => e.status === "RUNNING").length;
  const loadingCount = stack.filter((e) => e.status === "LOADING").length;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 border-b border-stealth-border flex items-center justify-between bg-stealth-dark/50">
        <div>
          <h2 className="text-xs font-mono text-nv-green tracking-wider">DEPLOYMENT STACK</h2>
          <p className="text-[10px] font-mono text-stealth-muted mt-0.5">
            {onlineCount} RUNNING{loadingCount > 0 ? `, ${loadingCount} LOADING` : ""} / {stack.length} TOTAL
          </p>
        </div>

        <button
          onClick={onStopAll}
          disabled={stack.length === 0}
          className="px-3 py-1 text-[10px] font-mono bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30 transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          STOP ALL
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {stack.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center h-full text-stealth-muted"
          >
            <svg width="48" height="48" viewBox="0 0 28 28" fill="none" className="mb-4 opacity-30">
              <path d="M14 2L6 8v10l8 6 8-6V8L14 2z" stroke="#76B900" strokeWidth="1.5" fill="none" />
            </svg>
            <p className="text-xs font-mono tracking-wider">NO ENGINES DEPLOYED</p>
            <p className="text-[10px] font-mono mt-1 text-stealth-muted/60">
              ADD MODELS FROM THE CATALOG TAB
            </p>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {stack.map((entry, idx) => (
              <div key={`${entry.alias}-${idx}`} className={`overflow-hidden border border-stealth-border/50 rounded-sm ${entry.status === "IDLE" ? "opacity-75" : ""}`}>
                <EngineBanner slotIndex={entry.idx} providerName={entry.provider_name} providerType={entry.provider_type} status={entry.status} gpuMask={entry.gpu} buildInfo={entry.build_info} />
                <EngineCard
                  entry={entry}
                  logs={logs.get(entry.idx) ?? EMPTY_LOGS}
                  systemEvents={systemEvents.get(entry.idx) ?? EMPTY_EVENTS}
                  enginePerfEvent={enginePerfEvents.get(entry.idx)}
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
