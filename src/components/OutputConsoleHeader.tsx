import {
  OUTPUT_CONSOLE_CATEGORIES,
  OUTPUT_CONSOLE_CATEGORY_LABELS,
  type OutputConsoleCategory,
} from "./BlackwellOutputConsole";

interface OutputConsoleHeaderProps {
  activeCategory: OutputConsoleCategory;
  onCategoryChange: (category: OutputConsoleCategory) => void;
  onClearCategory?: () => void;
  onSaveCategory?: () => void;
  onClearAll?: () => void;
  onDetach?: () => void;
  onDock?: () => void;
  onClose?: () => void;
  isDetached?: boolean;
  showTitle?: boolean;
  showControls?: boolean;
  /** Footer collapsed: expand chevron on the right */
  dockChevron?: { onToggle: () => void };
  onMouseDown?: (event: React.MouseEvent) => void;
  className?: string;
}

export default function OutputConsoleHeader({
  activeCategory,
  onCategoryChange,
  onClearCategory,
  onSaveCategory,
  onClearAll,
  onDetach,
  onDock,
  onClose,
  isDetached = false,
  showTitle = true,
  showControls = true,
  dockChevron,
  onMouseDown,
  className = "",
}: OutputConsoleHeaderProps) {
  const dragClass = isDetached ? "cursor-grab active:cursor-grabbing" : "";
  const showRightSlot = showControls || dockChevron;

  return (
    <div
      className={`blackwell-output-console__header flex items-center px-3 tracking-[1.2px] ${dragClass} ${className}`.trim()}
      onMouseDown={onMouseDown}
    >
      {showTitle ? (
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-bold">BLACKWELL OUTPUT CONSOLE</span>
        </div>
      ) : null}

      <div className={`flex items-center justify-center min-w-0 px-2 ${showTitle || showRightSlot ? "flex-1" : "flex-1 w-full"}`}>
        <div className="flex items-center gap-1.5 overflow-x-auto eink-scrollbar">
          {OUTPUT_CONSOLE_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => onCategoryChange(cat)}
              className={`boc-tab boc-tab--toolbar rounded-sm border transition-all shrink-0 ${
                activeCategory === cat ? "boc-tab--active" : "boc-tab--idle"
              }`}
              title={`${OUTPUT_CONSOLE_CATEGORY_LABELS[cat]} log`}
            >
              {OUTPUT_CONSOLE_CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
      </div>

      {showRightSlot ? (
        <div className="flex items-center gap-1.5 shrink-0">
          {showControls ? (
            <>
              <div className="boc-divider w-px h-3 mx-1" />

              <button
                type="button"
                onClick={onClearCategory}
                className="boc-action-btn boc-action-btn--clear"
                title="Clear tab"
              >
                C
              </button>
              <button
                type="button"
                onClick={onSaveCategory}
                className="boc-action-btn boc-action-btn--save"
                title="Save tab"
              >
                S
              </button>
              <button
                type="button"
                onClick={onClearAll}
                className="boc-action-btn boc-action-btn--clear"
                title="Clear all"
              >
                ALL
              </button>

              {isDetached ? (
                <>
                  <button type="button" onClick={onDock} className="boc-utility-btn">
                    DOCK
                  </button>
                  <button type="button" onClick={onClose} className="boc-close-btn ml-1">
                    ✕
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={onDetach} className="boc-utility-btn">
                    DETACH
                  </button>
                  <button type="button" onClick={onClose} className="boc-close-btn ml-1">
                    ✕
                  </button>
                </>
              )}
            </>
          ) : dockChevron ? (
            <button
              type="button"
              onClick={dockChevron.onToggle}
              className="boc-close-btn ml-1 opacity-60"
              title="Expand console"
            >
              ▲
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}