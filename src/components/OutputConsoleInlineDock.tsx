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
    <div className={`app-footer-console blackwell-output-console${isExpanded ? " app-footer-console--expanded-open" : ""}`}>
      {!isExpanded && (
        <div
          className="app-footer-console__header blackwell-output-console__header flex items-center px-2 tracking-wide cursor-pointer"
          onClick={handleToggle}
          title="Click to expand console"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleToggle();
            }
          }}
        >
          <span className="font-bold shrink-0 w-12">OUTPUT</span>

          <div className="flex-1 flex items-center justify-center min-w-0 px-2">
            <div className="flex items-center gap-0.5 overflow-x-auto eink-scrollbar">
              {OUTPUT_CONSOLE_CATEGORIES.map((cat) => {
                const isLive = liveCategory === cat;
                return (
                  <span
                    key={cat}
                    className={`boc-tab rounded-sm border shrink-0 ${
                      isLive ? "boc-tab--active" : "boc-tab--idle"
                    }`}
                  >
                    {OUTPUT_CONSOLE_CATEGORY_LABELS[cat]}
                  </span>
                );
              })}
            </div>
          </div>

          <span className="shrink-0 opacity-60 w-4 text-right">▲</span>
        </div>
      )}

      <div className="app-footer-console__status flex items-center font-mono min-h-0">
        <div className="flex items-center gap-2 shrink-0">{statusLeft}</div>

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
          <span className="app-footer-console__live-label shrink-0 tracking-widest uppercase">
            Live
          </span>
          <div className="app-console-mono app-footer-console__live-text flex-1 min-w-0 truncate leading-snug">
            {liveLine}
          </div>
        </div>

        {foundrySlot ? (
          <div className="flex items-center shrink-0">{foundrySlot}</div>
        ) : null}

        {isExpanded ? (
          <button
            type="button"
            className="app-footer-console__collapse shrink-0"
            onClick={handleToggle}
            title="Close console"
          >
            ▼
          </button>
        ) : null}

        <div className="flex items-center gap-2 shrink-0">{statusRight}</div>
      </div>
    </div>
  );
}