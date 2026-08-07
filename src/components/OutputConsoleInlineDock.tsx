import type { ReactNode } from "react";
import type { OutputConsoleCategory } from "./BlackwellOutputConsole";
import OutputConsoleHeader from "./OutputConsoleHeader";

interface OutputConsoleInlineDockProps {
  liveLine: string;
  activeCategory: OutputConsoleCategory;
  onCategoryChange: (category: OutputConsoleCategory) => void;
  isExpanded: boolean;
  onToggle: () => void;
  statusLeft: ReactNode;
  statusRight: ReactNode;
  foundrySlot?: ReactNode;
}

export default function OutputConsoleInlineDock({
  liveLine,
  activeCategory,
  onCategoryChange,
  isExpanded,
  onToggle,
  statusLeft,
  statusRight,
  foundrySlot,
}: OutputConsoleInlineDockProps) {
  const handleToggle = () => onToggle();

  return (
    <div
      className={`app-footer-console blackwell-output-console blackwell-output-console--compact${
        isExpanded ? " app-footer-console--expanded-open" : ""
      }`}
    >
      {!isExpanded && (
        <OutputConsoleHeader
          activeCategory={activeCategory}
          onCategoryChange={onCategoryChange}
          showControls={false}
          dockChevron={{ onToggle: handleToggle }}
          className="app-footer-console__header"
        />
      )}

      {/* min-height/flex live in chrome.css — do not add Tailwind min-h-0 (collapses click target) */}
      <div className="app-footer-console__status font-mono">
        <div className="app-footer-status-left flex items-center gap-2 shrink-0 min-w-0">
          {statusLeft}
        </div>

        <div
          className="app-footer-console__live cursor-pointer"
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

        {/*
          Live line flex-fills the middle (see .app-footer-console__live).
          ml-auto keeps foundry / SYSTEM NOMINAL / IPC on the far right.
        */}
        <div className="app-footer-status-right flex items-center gap-2 shrink-0 ml-auto min-w-0">
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
    </div>
  );
}