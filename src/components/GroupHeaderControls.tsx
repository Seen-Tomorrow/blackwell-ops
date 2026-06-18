import type { GroupDisplayZone } from "../lib/storage";

interface GroupHeaderControlsProps {
  zone: GroupDisplayZone;
  displayZone: GroupDisplayZone;
  isHidden: boolean;
  isDragging: boolean;
  hideZoneToggle?: boolean;
  hideHideToggle?: boolean;
  onDragStart: (e: React.MouseEvent) => void;
  onToggleZone: () => void;
  onToggleHide: () => void;
}

/** Layout-mode group chrome: drag handle, above/below pin, hide. */
export default function GroupHeaderControls({
  zone,
  displayZone,
  isHidden,
  isDragging,
  hideZoneToggle = false,
  hideHideToggle = false,
  onDragStart,
  onToggleZone,
  onToggleHide,
}: GroupHeaderControlsProps) {
  const pinnedAbove = displayZone === "above";

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
      {!hideZoneToggle && (
        <button
          type="button"
          onClick={onToggleZone}
          className={`config-group-layout-controls__zone px-1.5 py-0 text-[7px] font-mono rounded-sm border transition-colors ${
            pinnedAbove
              ? "border-nv-green/50 text-nv-green/90 bg-nv-green/10"
              : "border-stealth-border/40 text-stealth-muted/45 hover:text-stealth-muted"
          }`}
          title={pinnedAbove ? "Pinned above display — click to move below" : "Pin above VRAM display"}
        >
          {pinnedAbove ? "▲ ABOVE" : "▼ BELOW"}
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
    </div>
  );
}