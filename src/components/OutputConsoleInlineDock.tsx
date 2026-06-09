import type { ReactNode } from "react";
import {
  OUTPUT_CONSOLE_CATEGORIES,
  OUTPUT_CONSOLE_CATEGORY_LABELS,
  type OutputConsoleCategory,
} from "./BlackwellOutputConsole";

interface OutputConsoleInlineDockProps {
  liveLine: string;
  liveCategory: OutputConsoleCategory | null;
  isExpanded: boolean;
  onToggle: () => void;
  statusLeft: ReactNode;
  statusRight: ReactNode;
  foundrySlot?: ReactNode;
}

export default function OutputConsoleInlineDock({
  liveLine,
  liveCategory,
  isExpanded,
  onToggle,
  statusLeft,
  statusRight,
  foundrySlot,
}: OutputConsoleInlineDockProps) {
  const handleToggle = () => onToggle();

  return (
    <div className="app-footer-console blackwell-output-console">
      <div
        className="app-footer-console__header blackwell-output-console__header flex items-center px-3 text-[8px] tracking-wide cursor-pointer"
        onClick={handleToggle}
        title={isExpanded ? "Click to close console" : "Click to expand console"}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggle();
          }
        }}
      >
        <span className="font-bold shrink-0 w-14">OUTPUT</span>

        <div className="flex-1 flex items-center justify-center min-w-0 px-2">
          {!isExpanded && (
            <div className="flex items-center gap-0.5 overflow-x-auto eink-scrollbar">
              {OUTPUT_CONSOLE_CATEGORIES.map((cat) => {
                const isLive = liveCategory === cat;
                return (
                  <span
                    key={cat}
                    className={`boc-tab px-1.5 py-px rounded-sm border shrink-0 ${
                      cat === "error"
                        ? isLive
                          ? "boc-tab--error-active"
                          : "boc-tab--error"
                        : isLive
                          ? "boc-tab--active"
                          : "boc-tab--idle"
                    }`}
                  >
                    {OUTPUT_CONSOLE_CATEGORY_LABELS[cat]}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        <span className="shrink-0 opacity-60 text-[7px] w-4 text-right">
          {isExpanded ? "▼" : "▲"}
        </span>
      </div>

      <div className="app-footer-console__status flex items-center gap-3 px-6 text-[10px] font-mono min-h-0">
        <div className="flex items-center gap-4 shrink-0">{statusLeft}</div>

        <div
          className="app-footer-console__live flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
          onClick={handleToggle}
          title={isExpanded ? "Click to close console" : "Click to expand console"}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleToggle();
            }
          }}
        >
          <span className="app-footer-console__live-label shrink-0 text-[7px] tracking-widest uppercase">
            Live
          </span>
          <div className="app-footer-console__live-text flex-1 min-w-0 truncate text-[8px] leading-snug">
            {liveLine}
          </div>
        </div>

        {foundrySlot ? (
          <div className="flex items-center shrink-0">{foundrySlot}</div>
        ) : null}

        <div className="flex items-center gap-4 shrink-0">{statusRight}</div>
      </div>
    </div>
  );
}