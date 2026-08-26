import type { ModelEntry } from "../lib/types";
import {
  CATALOG_SEAT_LABEL,
  CATALOG_SEAT_ROLES,
  catalogPathChipLabel,
  type CatalogRecentEntry,
  type CatalogSeatRole,
  type CatalogSeatsState,
} from "../lib/catalogQuickAccess";

export type CatalogQuickStripProps = {
  models: ModelEntry[];
  seats: CatalogSeatsState;
  pins: string[];
  recents: CatalogRecentEntry[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  onAssignSeat: (role: CatalogSeatRole) => void;
  onClearSeat: (role: CatalogSeatRole) => void;
  onTogglePinPath: (path: string) => void;
};

function pathKey(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

function findModel(models: ModelEntry[], path: string): ModelEntry | undefined {
  const n = pathKey(path);
  return models.find((m) => pathKey(m.path) === n);
}

export default function CatalogQuickStrip({
  models,
  seats,
  pins,
  recents,
  selectedPath,
  onSelectPath,
  onAssignSeat,
  onClearSeat,
  onTogglePinPath,
}: CatalogQuickStripProps) {
  const seatPathKeys: Record<string, true> = {};
  for (const r of CATALOG_SEAT_ROLES) {
    const p = seats[r]?.path;
    if (p) seatPathKeys[pathKey(p)] = true;
  }

  const pinModels = pins
    .map((p) => findModel(models, p))
    .filter((m): m is ModelEntry => !!m);

  const pinKeys: Record<string, true> = {};
  for (const p of pins) pinKeys[pathKey(p)] = true;

  const recentModels = recents
    .map((r) => findModel(models, r.path))
    .filter((m): m is ModelEntry => !!m)
    .filter((m) => {
      const key = pathKey(m.path);
      return !seatPathKeys[key] && !pinKeys[key];
    })
    .slice(0, 6);

  const selectedKey = selectedPath ? pathKey(selectedPath) : null;

  return (
    <div className="catalog-quick-strip" data-catalog-quick-strip>
      <div className="catalog-quick-strip__seats">
        {CATALOG_SEAT_ROLES.map((role) => {
          const slot = seats[role];
          const model = slot ? findModel(models, slot.path) : undefined;
          const filled = Boolean(slot?.path);
          const isSelected = filled && selectedKey != null && pathKey(slot!.path) === selectedKey;
          const label = filled
            ? catalogPathChipLabel(slot!.path, model?.name)
            : "—";
          return (
            <div
              key={role}
              className={[
                "catalog-quick-seat",
                `catalog-quick-seat--${role}`,
                filled ? "catalog-quick-seat--filled" : "catalog-quick-seat--empty",
                isSelected ? "catalog-quick-seat--selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <button
                type="button"
                className="catalog-quick-seat__main"
                title={
                  filled
                    ? `${CATALOG_SEAT_LABEL[role]} · ${model?.name || slot!.path}\nClick to select · right-click to clear`
                    : `${CATALOG_SEAT_LABEL[role]} empty — select a model, then click to assign`
                }
                onClick={() => {
                  if (filled && slot) onSelectPath(slot.path);
                  else onAssignSeat(role);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (filled) onClearSeat(role);
                }}
              >
                <span className="catalog-quick-seat__role">{CATALOG_SEAT_LABEL[role]}</span>
                <span className="catalog-quick-seat__name">{label}</span>
              </button>
              {filled && (
                <button
                  type="button"
                  className="catalog-quick-seat__clear"
                  title={`Clear ${CATALOG_SEAT_LABEL[role]} seat`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearSeat(role);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      {(pinModels.length > 0 || recentModels.length > 0) && (
        <div className="catalog-quick-strip__rail">
          {pinModels.length > 0 && (
            <div className="catalog-quick-rail-group">
              <span className="catalog-quick-rail-label" title="Pinned models">
                ★
              </span>
              {pinModels.map((m) => {
                const sel = selectedKey != null && pathKey(m.path) === selectedKey;
                return (
                  <button
                    key={`pin-${m.path}`}
                    type="button"
                    className={`catalog-quick-chip catalog-quick-chip--pin${
                      sel ? " catalog-quick-chip--selected" : ""
                    }`}
                    title={`${m.name}\nClick select · right-click unpin`}
                    onClick={() => onSelectPath(m.path)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      onTogglePinPath(m.path);
                    }}
                  >
                    {catalogPathChipLabel(m.path, m.name)}
                  </button>
                );
              })}
            </div>
          )}
          {recentModels.length > 0 && (
            <div className="catalog-quick-rail-group">
              <span className="catalog-quick-rail-label" title="Recently launched">
                REC
              </span>
              {recentModels.map((m) => {
                const sel = selectedKey != null && pathKey(m.path) === selectedKey;
                return (
                  <button
                    key={`rec-${m.path}`}
                    type="button"
                    className={`catalog-quick-chip catalog-quick-chip--recent${
                      sel ? " catalog-quick-chip--selected" : ""
                    }`}
                    title={`${m.name} · recently launched`}
                    onClick={() => onSelectPath(m.path)}
                  >
                    {catalogPathChipLabel(m.path, m.name)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
