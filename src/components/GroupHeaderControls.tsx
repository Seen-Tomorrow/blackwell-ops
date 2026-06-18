import type { GroupDisplayZone } from "../lib/storage";

interface GroupHeaderControlsProps {
  zone: GroupDisplayZone;
  displayZone: GroupDisplayZone;
  isHidden: boolean;
  isDragging: boolean;
  hideZoneToggle?: boolean;
  hideHideToggle?: boolean;
  columnIdx?: number;
  columnCount?: number;
  onMoveColumnLeft?: () => void;
  onMoveColumnRight?: () => void;
  onDragStart: (e: React.MouseEvent) => void;
  onToggleZone: () => void;
  onToggleHide: () => void;
  showDelete?: boolean;
  onDelete?: () => void;
}

/** Layout-mode group chrome: drag handle, above/below pin, hide. */
export default function GroupHeaderControls({
  zone,
  displayZone,
  isHidden,
  isDragging,
  hideZoneToggle = false,
  hideHideToggle = false,
  columnIdx = 0,
  columnCount = 1,
  onMoveColumnLeft,
  onMoveColumnRight,
  onDragStart,
  onToggleZone,
  onToggleHide,
  showDelete = false,
  onDelete,
}: GroupHeaderControlsProps) {
  const pinnedAbove = displayZone === "above";
  const showColumnArrows = zone === "above" || (zone === "below" && columnCount > 1);

  return (
    <div
      className={`config-group-layout-controls flex items-center gap-0.5 flex-shrink-0 ml-auto ${
        isDragging ? "config-group-layout-controls--dragging" : ""
      }`}
      data-group-layout-controls
    >
      <button
        type="button"
        onMouseDown={onDragStart}
        onClick={(e) => e.preventDefault()}
        draggable={false}
        className="config-group-layout-controls__drag select-none px-1 cursor-grab active:cursor-grabbing"
        title={`Drag to reorder within ${zone === "above" ? "above" : "below"} zone`}
      >
        &#x2630;
      </button>
      {showColumnArrows && (
        <div className="config-group-layout-controls__cols flex items-center gap-px">
          <button
            type="button"
            disabled={columnIdx <= 0}
            onClick={onMoveColumnLeft}
            className="config-group-layout-controls__col-btn px-1 py-0 text-[8px] font-mono rounded-sm border border-stealth-border/40 text-stealth-muted/55 hover:text-stealth-muted disabled:opacity-25 disabled:cursor-not-allowed"
            title="Move group to column on the left"
          >
            ◀
          </button>
          <button
            type="button"
            disabled={columnIdx >= columnCount - 1}
            onClick={onMoveColumnRight}
            className="config-group-layout-controls__col-btn px-1 py-0 text-[8px] font-mono rounded-sm border border-stealth-border/40 text-stealth-muted/55 hover:text-stealth-muted disabled:opacity-25 disabled:cursor-not-allowed"
            title="Move group to column on the right"
          >
            ▶
          </button>
        </div>
      )}
      {!hideZoneToggle && (
        <button
          type="button"
          onClick={onToggleZone}
          className={`config-group-layout-controls__zone px-1.5 py-0 text-[7px] font-mono rounded-sm border transition-colors ${
            pinnedAbove
              ? "border-nv-green/50 text-nv-green/90 bg-nv-green/10"
              : "border-stealth-border/40 text-stealth-muted/45 hover:text-stealth-muted"
          }`}
          title={pinnedAbove ? "Click to move below VRAM display" : "Click to pin above VRAM display"}
        >
          {pinnedAbove ? "▼ BELOW" : "▲ ABOVE"}
        </button>
      )}
      {!hideHideToggle && (
        <button
          type="button"
          onClick={onToggleHide}
          className={`config-group-layout-controls__hide px-1.5 py-0 text-[7px] font-mono rounded-sm border transition-colors ${
            isHidden
              ? "border-yellow-400/40 text-yellow-400/80 bg-yellow-400/8"
              : "border-stealth-border/40 text-stealth-muted/45 hover:text-stealth-muted"
          }`}
          title={isHidden ? "Show group in engine config" : "Hide group from engine config"}
        >
          {isHidden ? "SHOW" : "HIDE"}
        </button>
      )}
      {showDelete && onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="config-group-layout-controls__delete px-1.5 py-0 text-[7px] font-mono rounded-sm border border-red-400/35 text-red-400/75 hover:text-red-400 hover:border-red-400/55 transition-colors"
          title="Remove empty group"
        >
          DEL
        </button>
      )}
    </div>
  );
}