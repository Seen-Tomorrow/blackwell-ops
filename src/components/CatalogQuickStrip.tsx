import type { ModelEntry } from "../lib/types";
import {
  CATALOG_SEAT_LABEL,
  CATALOG_SEAT_ROLES,
  CATALOG_SEAT_SET_COUNT,
  catalogPathChipLabel,
  type CatalogRecentEntry,
  type CatalogSeatRole,
  type CatalogSeatSetIndex,
  type CatalogSeatsState,
} from "../lib/catalogQuickAccess";
import { dispatchAppEvent, EVENTS, type CatalogLaunchSeatsDetail } from "../lib/events";

export type CatalogQuickStripProps = {
  models: ModelEntry[];
  seats: CatalogSeatsState;
  activeSeatSet: CatalogSeatSetIndex;
  pins: string[];
  recents: CatalogRecentEntry[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  onAssignSeat: (role: CatalogSeatRole) => void;
  onClearSeat: (role: CatalogSeatRole) => void;
  onSelectSeatSet: (index: CatalogSeatSetIndex) => void;
  onTogglePinPath: (path: string) => void;
};

function pathKey(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

function findModel(models: ModelEntry[], path: string): ModelEntry | undefined {
  const n = pathKey(path);
  return models.find((m) => pathKey(m.path) === n);
}

function isShardNoiseQuant(label: string): boolean {
  return /^\d{3,}$/.test(label.trim());
}

/** Quant line under the model name — never the bare "GGUF" / shard index. */
function modelQuantLabel(m: ModelEntry): string {
  const header = m.metadata?.file_type_str?.trim() ?? "";
  const catalog = m.quant?.trim() ?? "";
  const q =
    header && !isShardNoiseQuant(header)
      ? header
      : catalog && catalog.toUpperCase() !== "GGUF" && !isShardNoiseQuant(catalog)
        ? catalog
        : "";
  if (!q) return "—";
  return q.length > 16 ? `${q.slice(0, 14)}…` : q;
}

type QuickChipProps = {
  model: ModelEntry;
  selected: boolean;
  variant: "pin" | "recent";
  title: string;
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

function QuickModelChip({
  model,
  selected,
  variant,
  title,
  onSelect,
  onContextMenu,
}: QuickChipProps) {
  return (
    <button
      type="button"
      className={[
        "catalog-quick-chip",
        `catalog-quick-chip--${variant}`,
        selected ? "catalog-quick-chip--selected" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={title}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <span className="catalog-quick-chip__name">
        {catalogPathChipLabel(model.path, model.name)}
      </span>
      <span className="catalog-quick-chip__quant">{modelQuantLabel(model)}</span>
    </button>
  );
}

export default function CatalogQuickStrip({
  models,
  seats,
  activeSeatSet,
  pins,
  recents,
  selectedPath,
  onSelectPath,
  onAssignSeat,
  onClearSeat,
  onSelectSeatSet,
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
  const canLaunchTwin = Boolean(seats.brain?.path && seats.worker?.path);

  const launchSeatedTwin = () => {
    if (!seats.brain?.path || !seats.worker?.path) return;
    const detail: CatalogLaunchSeatsDetail = {
      brainPath: seats.brain.path,
      workerPath: seats.worker.path,
      draftPath: seats.draft?.path ?? null,
    };
    dispatchAppEvent(EVENTS.catalogLaunchSeats, detail);
  };

  return (
    <div className="catalog-quick-strip" data-catalog-quick-strip>
      <section className="catalog-quick-section catalog-quick-section--seats">
        <header
          className="catalog-quick-section__head"
          title="BRAIN + WORKER launch as engines. DRAFT is BRAIN’s speculative pack (Boost), not a third server. Sets 1–3 are independent twin stacks (catalog-only, not launch presets)."
        >
          <div className="catalog-quick-section__sets" role="tablist" aria-label="Seat sets">
            {Array.from({ length: CATALOG_SEAT_SET_COUNT }, (_, i) => {
              const idx = i as CatalogSeatSetIndex;
              const active = activeSeatSet === idx;
              return (
                <button
                  key={idx}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`catalog-quick-set-btn${active ? " catalog-quick-set-btn--active" : ""}`}
                  title={`Seat set ${idx + 1}${active ? " (active)" : ""}`}
                  onClick={() => onSelectSeatSet(idx)}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>
          <span className="catalog-quick-section__title">SEATS</span>
          <button
            type="button"
            className="catalog-quick-section__action"
            disabled={!canLaunchTwin}
            title={
              canLaunchTwin
                ? seats.draft?.path
                  ? `Launch set ${activeSeatSet + 1}: BRAIN + WORKER · DRAFT → BRAIN Boost`
                  : `Launch set ${activeSeatSet + 1}: BRAIN + WORKER twin`
                : "Assign BRAIN and WORKER on this set first"
            }
            onClick={launchSeatedTwin}
          >
            ▶ TWIN
          </button>
        </header>
        <div className="catalog-quick-strip__seats">
          {CATALOG_SEAT_ROLES.map((role) => {
            const slot = seats[role];
            const model = slot ? findModel(models, slot.path) : undefined;
            const filled = Boolean(slot?.path);
            const isSelected =
              filled && selectedKey != null && pathKey(slot!.path) === selectedKey;
            const label = filled
              ? catalogPathChipLabel(slot!.path, model?.name)
              : role === "draft"
                ? "spec pack"
                : "—";
            const roleTitle =
              role === "draft"
                ? filled
                  ? `DRAFT (spec pack for BRAIN Boost) · ${model?.name || slot!.path}\nNot a third engine — pairs under BRAIN DFlash/DSpark\nClick select · right-click clear`
                  : "DRAFT seat — assign a speculative draft pack (DFlash/Eagle). Used by BRAIN Boost, not launched alone."
                : filled
                  ? `${CATALOG_SEAT_LABEL[role]} · ${model?.name || slot!.path}\nClick to select · right-click to clear`
                  : `${CATALOG_SEAT_LABEL[role]} empty — select a model, then click to assign`;

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
                  title={roleTitle}
                  onClick={() => {
                    if (filled && slot) onSelectPath(slot.path);
                    else onAssignSeat(role);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (filled) onClearSeat(role);
                  }}
                >
                  <span className="catalog-quick-seat__role">
                    {role === "draft" ? "DRAFT" : CATALOG_SEAT_LABEL[role]}
                  </span>
                  <span className="catalog-quick-seat__name">{label}</span>
                  {filled && model && (
                    <span className="catalog-quick-seat__quant">{modelQuantLabel(model)}</span>
                  )}
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
      </section>

      {pinModels.length > 0 && (
        <section className="catalog-quick-section catalog-quick-section--pins">
          <header className="catalog-quick-section__head">
            <span className="catalog-quick-section__title">PINS</span>
            <span className="catalog-quick-section__count">{pinModels.length}</span>
          </header>
          <div className="catalog-quick-section__grid">
            {pinModels.map((m) => (
              <QuickModelChip
                key={`pin-${m.path}`}
                model={m}
                variant="pin"
                selected={selectedKey != null && pathKey(m.path) === selectedKey}
                title={`${m.name}\n${modelQuantLabel(m)}\nClick select · right-click unpin`}
                onSelect={() => onSelectPath(m.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onTogglePinPath(m.path);
                }}
              />
            ))}
          </div>
        </section>
      )}

      {recentModels.length > 0 && (
        <section className="catalog-quick-section catalog-quick-section--recents">
          <header className="catalog-quick-section__head">
            <span className="catalog-quick-section__title">RECENTS</span>
            <span className="catalog-quick-section__count">{recentModels.length}</span>
          </header>
          <div className="catalog-quick-section__grid">
            {recentModels.map((m) => (
              <QuickModelChip
                key={`rec-${m.path}`}
                model={m}
                variant="recent"
                selected={selectedKey != null && pathKey(m.path) === selectedKey}
                title={`${m.name}\n${modelQuantLabel(m)} · recently launched`}
                onSelect={() => onSelectPath(m.path)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
