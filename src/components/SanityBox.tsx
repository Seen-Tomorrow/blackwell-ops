// SANITY-BOX — self-contained, removable in full by deleting this file + grepping for SANITY-BOX
import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { SanityEntry } from "../lib/types";

type TabKey = "all" | "js" | "rust" | "scenario";

// Highlight the scenario name (after "Scenario: ") in white within teal text.
function renderScenarioText(text: string) {
  const idx = text.indexOf("Scenario: ");
  if (idx < 0) return text;
  const prefix = text.substring(0, idx + 10); // "[SCENARIO] Scenario: "
  const rest = text.substring(idx + 10);
  // Scenario name is the first word after "Scenario: "
  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx < 0) return text;
  const name = rest.substring(0, spaceIdx);
  const tail = rest.substring(spaceIdx);
  return (
    <>
      {prefix}
      <span className="text-white font-bold">{name}</span>
      {tail}
    </>
  );
}

// ── Inline badge (header bar) ──

interface SanityBadgeProps {
  entries: SanityEntry[];
  isAdminUnlocked: boolean;
  expanded: boolean;
  onToggle: () => void;
}

export function SanityBadge({ entries, isAdminUnlocked, expanded, onToggle }: SanityBadgeProps) {
  const errorCount = entries.filter(e => e.level === "error").length;
  const warnCount = entries.filter(e => e.level === "warn").length;
  const allCount = entries.length;

  if (!isAdminUnlocked) return null;

  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-1.5 px-2 py-0.5 hover:bg-stealth-panel/40 transition-colors cursor-pointer rounded-sm ${
        expanded ? "bg-nv-green/10" : ""
      }`}
    >
      <span className={`text-[9px] font-mono tracking-wider ${expanded ? "text-nv-green" : "text-nv-green/60"}`}>
        {expanded ? "COLLAPSE SANITY" : "SANITY"}
      </span>
      {errorCount > 0 && (
        <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm bg-telemetry-red/20 text-telemetry-red border border-telemetry-red/30">
          E:{errorCount}
        </span>
      )}
      {warnCount > 0 && (
        <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm bg-telemetry-amber/20 text-telemetry-amber border border-telemetry-amber/30">
          W:{warnCount}
        </span>
      )}
      {allCount === 0 && (
        <span className="text-[8px] font-mono text-stealth-muted">CLEAN</span>
      )}
    </button>
  );
}

// ── Expanded panel (full-width row) ──

interface SanityPanelProps {
  entries: SanityEntry[];
  isAdminUnlocked: boolean;
  expanded: boolean;
  tab: TabKey;
  onTabChange: (t: TabKey) => void;
}

export function SanityPanel({ entries, isAdminUnlocked, expanded, tab, onTabChange }: SanityPanelProps) {
  const filtered = useMemo(() => {
    if (tab === "all") return entries;
    if (tab === "scenario") return entries.filter(e => e.text.startsWith("[SCENARIO]"));
    return entries.filter(e => e.source === tab);
  }, [entries, tab]);

  const errorCount = entries.filter(e => e.level === "error").length;
  const warnCount = entries.filter(e => e.level === "warn").length;
  const allCount = entries.length;
  const jsCount = entries.filter(e => e.source === "js").length;
  const rustCount = entries.filter(e => e.source === "rust").length;
  const scenarioCount = entries.filter(e => e.text.startsWith("[SCENARIO]")).length;

  if (!isAdminUnlocked || !expanded) return null;

  return (
    <motion.div
      key="sanity-expanded"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden border-b border-stealth-border/50 bg-stealth-dark"
    >
      <div className="px-4 py-2">
        {/* Header row */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-mono text-nv-green/60 tracking-wider">SANITY BOX</span>
            {errorCount > 0 && (
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm bg-telemetry-red/20 text-telemetry-red border border-telemetry-red/30">
                ERR {errorCount}
              </span>
            )}
            {warnCount > 0 && (
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm bg-telemetry-amber/20 text-telemetry-amber border border-telemetry-amber/30">
                WARN {warnCount}
              </span>
            )}
            <span className="text-[8px] font-mono text-stealth-muted/40">{allCount} total</span>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-2">
          {([
            ["all", "ALL"],
            ["js", "JS Front"],
            ["rust", "Rust Back"],
            ["scenario", "SCENARIO"],
          ] as [TabKey, string][]).map(([key, label]) => {
            const count = key === "all" ? allCount : key === "js" ? jsCount : key === "rust" ? rustCount : scenarioCount;
            const isActive = tab === key;
            return (
              <button
                key={key}
                onClick={() => onTabChange(key)}
                className={`px-2 py-0.5 text-[8px] font-mono rounded-sm border transition-colors ${
                  isActive
                    ? key === "scenario"
                      ? "border-teal-400/60 text-teal-400 bg-teal-400/10"
                      : "border-nv-green/60 text-nv-green bg-nv-green/10"
                    : "border-stealth-border/30 text-stealth-muted/40 hover:text-stealth-muted hover:border-stealth-border"
                }`}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>

        {/* Log lines — ~15 visible, scroll for rest */}
        <div className="font-mono overflow-y-auto cyber-scrollbar" style={{ height: "240px" }}>
          {filtered.length === 0 ? (
            <p className="text-[9px] text-stealth-muted/40 italic py-1">NO ENTRIES</p>
          ) : (
            <div className="space-y-0">
              {filtered.map((entry, i) => {
                const isScenario = entry.text.startsWith("[SCENARIO]");
                return (
                  <div key={i} className={`flex items-start gap-2 text-[9px] leading-relaxed py-px border-b border-stealth-border/10 ${
                    isScenario ? "text-teal-400" : entry.level === "error" ? "text-telemetry-red" : "text-telemetry-amber"
                  }`}>
                    <span className="text-stealth-muted/40 flex-shrink-0 w-[60px]">{entry.timestamp}</span>
                    <span className={`flex-shrink-0 w-[52px] text-[8px] uppercase ${
                      isScenario ? "text-teal-400/70" : entry.level === "error" ? "text-telemetry-red/70" : "text-telemetry-amber/70"
                    }`}>
                      [{isScenario ? "INFO " : entry.level}]
                    </span>
                    <span className={`flex-shrink-0 w-[36px] text-[8px] ${
                      isScenario ? "text-teal-400/60" : entry.source === "rust" ? "text-electric-blue/60" : "text-neon-magenta/60"
                    }`}>
                      {isScenario ? "[SCEN]" : entry.source === "rust" ? "[RUST]" : "[JS  ]"}
                    </span>
                    <span className="break-all">
                      {isScenario ? renderScenarioText(entry.text) : entry.text}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
