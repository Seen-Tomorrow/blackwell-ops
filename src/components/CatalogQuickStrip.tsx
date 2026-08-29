import { useEffect, useState } from "react";
import type { ModelEntry } from "../lib/types";
import {
  CATALOG_ENGINE_SEAT_ROLES,
  CATALOG_SEAT_LABEL,
  CATALOG_SEAT_SET_COUNT,
  catalogPathChipLabel,
  loadCatalogSetComboId,
  type CatalogEngineSeatRole,
  type CatalogSeatSetIndex,
  type CatalogSeatsState,
} from "../lib/catalogQuickAccess";
import {
  dispatchAppEvent,
  EVENTS,
  type CatalogLaunchSeatSoloDetail,
  type CatalogLaunchSeatsDetail,
  type CatalogSeatEditDetail,
  type CatalogSeatEditEndedDetail,
} from "../lib/events";
import { getCombo, seatOnCombo } from "../lib/launchPresets";
import {
  fetchLearnedMemForSeat,
  ramValueText,
  sumLearnedMem,
  vramValueText,
  type LearnedMemGb,
} from "../lib/catalogSeatLearnedMem";

export type CatalogQuickStripProps = {
  models: ModelEntry[];
  seats: CatalogSeatsState;
  activeSeatSet: CatalogSeatSetIndex;
  pins: string[];
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  onAssignSeat: (role: CatalogEngineSeatRole) => void;
  onClearSeat: (role: CatalogEngineSeatRole) => void;
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

/** Live perimeter cue — same family as VramBadge NEED frame rim. */
function SeatLiveRim() {
  return (
    <span className="catalog-quick-seat__live" aria-hidden>
      <span className="catalog-quick-seat__live-rim" />
    </span>
  );
}

type PendingAction =
  | { kind: "replace"; role: CatalogEngineSeatRole }
  | { kind: "clear"; role: CatalogEngineSeatRole }
  | null;

export default function CatalogQuickStrip({
  models,
  seats,
  activeSeatSet,
  pins,
  selectedPath,
  onSelectPath,
  onAssignSeat,
  onClearSeat,
  onSelectSeatSet,
  onTogglePinPath,
}: CatalogQuickStripProps) {
  const [editingRole, setEditingRole] = useState<CatalogEngineSeatRole | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [launchMode, setLaunchMode] = useState<"solo" | "twin">("twin");
  const [learnedMem, setLearnedMem] = useState<{
    brain: LearnedMemGb | null;
    worker: LearnedMemGb | null;
  }>({ brain: null, worker: null });

  useEffect(() => {
    const onEnded = (e: Event) => {
      const detail = (e as CustomEvent<CatalogSeatEditEndedDetail>).detail;
      if (detail) {
        setEditingRole(null);
        setPending(null);
      }
    };
    window.addEventListener(EVENTS.catalogSeatEditEnded, onEnded);
    return () => window.removeEventListener(EVENTS.catalogSeatEditEnded, onEnded);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const comboId = loadCatalogSetComboId(activeSeatSet);
      const combo = comboId ? getCombo(comboId) : null;
      const brainSeat = seatOnCombo(combo, "brain");
      const workerSeat = seatOnCombo(combo, "worker");
      void Promise.all([
        brainSeat?.modelPath ? fetchLearnedMemForSeat(brainSeat) : Promise.resolve(null),
        workerSeat?.modelPath ? fetchLearnedMemForSeat(workerSeat) : Promise.resolve(null),
      ]).then(([brain, worker]) => {
        if (!cancelled) setLearnedMem({ brain, worker });
      });
    };
    load();
    window.addEventListener(EVENTS.catalogSeatsChanged, load);
    window.addEventListener(EVENTS.launchSuccess, load);
    return () => {
      cancelled = true;
      window.removeEventListener(EVENTS.catalogSeatsChanged, load);
      window.removeEventListener(EVENTS.launchSuccess, load);
    };
  }, [activeSeatSet, seats.brain?.path, seats.worker?.path]);

  useEffect(() => {
    setPending(null);
  }, [activeSeatSet]);

  const pinModels = pins
    .map((p) => findModel(models, p))
    .filter((m): m is ModelEntry => !!m);

  const selectedKey = selectedPath ? pathKey(selectedPath) : null;
  const canLaunchTwin = Boolean(seats.brain?.path && seats.worker?.path);
  const canLaunchSolo = Boolean(seats.brain?.path);
  const seatEditing = editingRole != null;
  const sum = sumLearnedMem(learnedMem.brain, learnedMem.worker);
  const hasSelection = Boolean(selectedPath);

  const launchSeats = () => {
    if (launchMode === "twin") {
      if (!seats.brain?.path || !seats.worker?.path) return;
      const detail: CatalogLaunchSeatsDetail = {
        brainPath: seats.brain.path,
        workerPath: seats.worker.path,
        setIndex: activeSeatSet,
      };
      dispatchAppEvent(EVENTS.catalogLaunchSeats, detail);
      return;
    }
    const path = seats.brain?.path;
    if (!path) return;
    const detail: CatalogLaunchSeatSoloDetail = {
      role: "brain",
      modelPath: path,
      setIndex: activeSeatSet,
    };
    dispatchAppEvent(EVENTS.catalogLaunchSeatSolo, detail);
  };

  const beginSeatEdit = (role: CatalogEngineSeatRole) => {
    const path = seats[role]?.path;
    if (!path) return;
    setPending(null);
    onSelectPath(path);
    dispatchAppEvent(EVENTS.catalogFocusModel, { path });
    setEditingRole(role);
    const detail: CatalogSeatEditDetail = {
      role,
      setIndex: activeSeatSet,
      modelPath: path,
    };
    window.requestAnimationFrame(() => {
      dispatchAppEvent(EVENTS.catalogSeatEdit, detail);
    });
  };

  const tryAssignEmpty = (role: CatalogEngineSeatRole) => {
    if (!hasSelection) return;
    onAssignSeat(role);
  };

  const confirmPending = () => {
    if (!pending) return;
    if (pending.kind === "replace") onAssignSeat(pending.role);
    else onClearSeat(pending.role);
    setPending(null);
  };

  const rolesToShow: CatalogEngineSeatRole[] = seatEditing
    ? [editingRole!]
    : [...CATALOG_ENGINE_SEAT_ROLES];

  return (
    <div
      className={[
        "catalog-quick-strip",
        seatEditing ? "catalog-quick-strip--seat-editing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-catalog-quick-strip
      data-seat-editing={seatEditing ? editingRole : undefined}
    >
      <section
        className={[
          "catalog-quick-section catalog-quick-section--seats",
          seatEditing ? "catalog-quick-section--seats-editing" : "",
        ].filter(Boolean).join(" ")}
      >
        {seatEditing ? <SeatLiveRim /> : null}
        <header
          className="catalog-quick-section__head"
          title="Agentic harness seats — BRAIN / WORKER. SOLO launches one seat; TWIN needs both saved bags."
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
                  disabled={seatEditing}
                  onClick={() => {
                    if (seatEditing) dispatchAppEvent(EVENTS.catalogSeatCancel);
                    onSelectSeatSet(idx);
                  }}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>
          <span className="catalog-quick-section__title">
            {seatEditing
              ? `EDITING ${CATALOG_SEAT_LABEL[editingRole!]}`
              : "HARNESS SEATS"}
          </span>
          <div className="catalog-quick-section__actions">
            {!seatEditing ? (
              <>
                <button
                  type="button"
                  className="catalog-quick-section__action catalog-quick-section__action--mode"
                  title="Switch SOLO / TWIN launch"
                  onClick={() => setLaunchMode((m) => (m === "twin" ? "solo" : "twin"))}
                >
                  {launchMode === "twin" ? "TWIN" : "SOLO"}
                </button>
                <button
                  type="button"
                  className="catalog-quick-section__action"
                  disabled={launchMode === "twin" ? !canLaunchTwin : !canLaunchSolo}
                  title={
                    launchMode === "twin"
                      ? canLaunchTwin
                        ? "Launch BRAIN + WORKER (needs saved bags on both)"
                        : "Assign BRAIN and WORKER first"
                      : canLaunchSolo
                        ? "Launch BRAIN seat as solo"
                        : "Assign BRAIN seat first"
                  }
                  onClick={launchSeats}
                >
                  ▶
                </button>
                <button
                  type="button"
                  className="catalog-quick-section__action"
                  title="Open harness connect veil"
                  onClick={() => dispatchAppEvent(EVENTS.harnessConnectOpen)}
                >
                  HARNESS
                </button>

              </>
            ) : null}
          </div>
        </header>
        {(learnedMem.brain || learnedMem.worker) && !seatEditing ? (
          <div
            className="catalog-quick-mem"
            title="LEARNED VRAM+RAM at saved seat knobs (re-read, not stored on the bag)"
          >
            <span className="catalog-quick-mem__half catalog-quick-mem__half--vram">
              <span className="catalog-quick-mem__sigma">Σ</span>
              {vramValueText(sum)}
              <span className="catalog-quick-mem__unit">GB VRAM</span>
            </span>
            <span className="catalog-quick-mem__half catalog-quick-mem__half--ram">
              {ramValueText(sum) ?? "—"}
              <span className="catalog-quick-mem__unit">GB RAM</span>
            </span>
          </div>
        ) : null}
        <div
          className={[
            "catalog-quick-strip__seats catalog-quick-strip__seats--twin",
            seatEditing ? "catalog-quick-strip__seats--editing" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {rolesToShow.map((role) => {
            const slot = seats[role];
            const model = slot ? findModel(models, slot.path) : undefined;
            const filled = Boolean(slot?.path);
            const isSelected =
              filled && selectedKey != null && pathKey(slot!.path) === selectedKey;
            const isEditing = editingRole === role;
            const selectionDiffers =
              filled
              && selectedPath
              && pathKey(slot!.path) !== pathKey(selectedPath);
            const pendingHere =
              pending && pending.role === role ? pending.kind : null;
            const label = filled
              ? catalogPathChipLabel(slot!.path, model?.name)
              : "— empty";

            return (
              <div
                key={role}
                className={[
                  "catalog-quick-seat",
                  `catalog-quick-seat--${role}`,
                  filled ? "catalog-quick-seat--filled" : "catalog-quick-seat--empty",
                  isSelected ? "catalog-quick-seat--selected" : "",
                  isEditing ? "catalog-quick-seat--editing" : "",
                  pendingHere ? "catalog-quick-seat--pending" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {isEditing ? <SeatLiveRim /> : null}
                {filled && !seatEditing && learnedMem[role] ? (
                  <span className="catalog-quick-seat__mem">
                    <span className="catalog-quick-mem__half catalog-quick-mem__half--vram">
                      {vramValueText(learnedMem[role])}
                      <span className="catalog-quick-mem__unit">GB VRAM</span>
                    </span>
                  </span>
                ) : null}
                <div className="catalog-quick-seat__body">
                <button
                  type="button"
                  className="catalog-quick-seat__main"
                  title={
                    isEditing
                      ? `Editing ${CATALOG_SEAT_LABEL[role]} — tune panel, then SAVE on this seat`
                      : filled
                        ? `${CATALOG_SEAT_LABEL[role]} · ${model?.name || slot!.path}\nClick = select · EDIT = knobs · REPLACE = swap model`
                        : hasSelection
                          ? `${CATALOG_SEAT_LABEL[role]} empty — click to seat selected model`
                          : `${CATALOG_SEAT_LABEL[role]} empty — select a catalog model first`
                  }
                  onClick={() => {
                    if (isEditing) return;
                    if (filled && slot) {
                      onSelectPath(slot.path);
                      return;
                    }
                    tryAssignEmpty(role);
                  }}
                >
                  <span className="catalog-quick-seat__role">
                    {CATALOG_SEAT_LABEL[role]}
                  </span>
                  <span className="catalog-quick-seat__name">{label}</span>
                  {filled && model ? (
                    <span className="catalog-quick-seat__quant">{modelQuantLabel(model)}</span>
                  ) : null}
                </button>

                <div className="catalog-quick-seat__actions">
                  {pendingHere ? (
                    <>
                      <button
                        type="button"
                        className="catalog-quick-seat__btn catalog-quick-seat__btn--yes"
                        title="Confirm"
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmPending();
                        }}
                      >
                        Y
                      </button>
                      <button
                        type="button"
                        className="catalog-quick-seat__btn catalog-quick-seat__btn--no"
                        title="Cancel"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPending(null);
                        }}
                      >
                        N
                      </button>
                    </>
                  ) : isEditing ? (
                    <>
                      <button
                        type="button"
                        className="catalog-quick-seat__btn catalog-quick-seat__btn--save"
                        title="Save panel config into this seat"
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatchAppEvent(EVENTS.catalogSeatSave);
                        }}
                      >
                        <span className="catalog-quick-seat__save-ico" aria-hidden>
                          ▣
                        </span>
                        SAVE
                      </button>
                      <button
                        type="button"
                        className="catalog-quick-seat__btn catalog-quick-seat__btn--cancel"
                        title="Cancel seat edit"
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatchAppEvent(EVENTS.catalogSeatCancel);
                        }}
                      >
                        CANCEL
                      </button>
                    </>
                  ) : (
                    <>
                      {filled && selectionDiffers ? (
                        <button
                          type="button"
                          className="catalog-quick-seat__btn catalog-quick-seat__btn--replace"
                          title="Replace this seat’s model with the selected catalog model"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPending({ kind: "replace", role });
                          }}
                        >
                          R
                        </button>
                      ) : null}
                      {filled ? (
                        <button
                          type="button"
                          className="catalog-quick-seat__btn catalog-quick-seat__btn--edit"
                          title={`Edit ${CATALOG_SEAT_LABEL[role]} knobs in the real panel`}
                          onClick={(e) => {
                            e.stopPropagation();
                            beginSeatEdit(role);
                          }}
                        >
                          E
                        </button>
                      ) : null}
                      {filled ? (
                        <button
                          type="button"
                          className="catalog-quick-seat__btn catalog-quick-seat__btn--clear"
                          title={`Clear ${CATALOG_SEAT_LABEL[role]} seat`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPending({ kind: "clear", role });
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {pinModels.length > 0 && (
        <section className="catalog-quick-section catalog-quick-section--pins">
          <header className="catalog-quick-section__head">
            <span className="catalog-quick-section__title">FAVORITE</span>
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

    </div>
  );
}
