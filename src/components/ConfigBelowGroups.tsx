import type { ReactNode } from "react";
import type { ConfigColumnCount } from "../lib/configColumnLayout";
import { columnWidthsToGridTemplate } from "../lib/configColumnLayout";

interface ConfigBelowGroupsProps {
  columnCount: ConfigColumnCount;
  columnWidths: number[];
  belowGroupsByColumn: string[][];
  renderGroup: (groupId: string, columnIdx: number, groupIdx: number) => ReactNode;
  onGutterDragStart: (gutterIndex: number, e: React.MouseEvent) => void;
  draggingGutterIndex?: number | null;
}

/** Maintenance-bay column grid — 1/2/3 columns with draggable gutters. */
export default function ConfigBelowGroups({
  columnCount,
  columnWidths,
  belowGroupsByColumn,
  renderGroup,
  onGutterDragStart,
  draggingGutterIndex = null,
}: ConfigBelowGroupsProps) {
  if (columnCount === 1) {
    const col = belowGroupsByColumn[0] ?? [];
    return (
      <div className="config-params-below config-params-below--1c min-w-0">
        {col.map((groupId, groupIdx) => (
          <div
            key={groupId}
            data-group-zone="below"
            data-column-idx={0}
            data-group-idx={groupIdx}
            data-group-id={groupId}
          >
            {renderGroup(groupId, 0, groupIdx)}
          </div>
        ))}
      </div>
    );
  }

  const cells: ReactNode[] = [];
  for (let colIdx = 0; colIdx < columnCount; colIdx++) {
    const groups = belowGroupsByColumn[colIdx] ?? [];
    cells.push(
      <div
        key={`col-${colIdx}`}
        className="config-params-col min-w-0"
        data-config-column={colIdx}
        style={{ gridColumn: colIdx * 2 + 1 }}
      >
        <div className="config-params-col__stack space-y-3 min-w-0">
          {groups.map((groupId, groupIdx) => (
            <div
              key={groupId}
              data-group-zone="below"
              data-column-idx={colIdx}
              data-group-idx={groupIdx}
              data-group-id={groupId}
            >
              {renderGroup(groupId, colIdx, groupIdx)}
            </div>
          ))}
        </div>
      </div>,
    );
    if (colIdx < columnCount - 1) {
      cells.push(
        <div
          key={`gutter-${colIdx}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize config columns"
          className={`catalog-split-handle config-col-split-handle${
            draggingGutterIndex === colIdx ? " is-dragging" : ""
          }`}
          style={{ gridColumn: colIdx * 2 + 2 }}
          onMouseDown={(e) => onGutterDragStart(colIdx, e)}
          title="Drag to resize columns"
        />,
      );
    }
  }

  return (
    <div
      className={`config-params-below config-params-below--multi config-params-below--${columnCount}c min-w-0`}
      style={{ gridTemplateColumns: columnWidthsToGridTemplate(columnWidths) }}
      data-config-column-count={columnCount}
      data-config-zone="below"
    >
      {cells}
    </div>
  );
}
