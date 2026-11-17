import { useEffect, useState } from "react";
import type { ModelEntry } from "../lib/types";
import {
  CATALOG_ENDPOINTS_MAX,
  CATALOG_PINS_MAX,
  CATALOG_SET_COUNT,
  ENDPOINT_ROLE_LABEL,
  catalogPathChipLabel,
  type CatalogSetIndex,
  type Endpoint,
  type EndpointRole,
  type EndpointSet,
} from "../lib/catalogQuickAccess";
import {
  dispatchAppEvent,
  EVENTS,
  type CatalogLaunchEndpointsDetail,
} from "../lib/events";
import { loadCatalogEndpointsOpen, saveCatalogEndpointsOpen } from "../lib/storage";

export type CatalogQuickStripProps = {
  models: ModelEntry[];
  endpoints: EndpointSet;
  activeSet: CatalogSetIndex;
  pins: string[];
  selectedPath: string | null;
  /**
   * Endpoints are launch chrome, not catalog chrome. First-run setup hides
   * them: a brand-new user has no models to pair, and the block pushed the
   * actual catalog down on first contact.
   */
  showEndpoints?: boolean;
  onSelectPath: (path: string) => void;
  onAssignEndpoint: (role: EndpointRole) => void;
  onAddEndpoint: () => void;
  onReplaceEndpoint: (id: string, path: string) => void;
  onRemoveEndpoint: (id: string) => void;
  onSelectSet: (index: CatalogSetIndex) => void;
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
  variant: "pin";
  title: string;
  onSelect: () => void;
  onUnpin?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

function QuickModelChip({
  model,
  selected,
  variant,
  title,
  onSelect,
  onUnpin,
  onContextMenu,
}: QuickChipProps) {
  return (
    <div
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
      <span className="catalog-quick-chip__text">
        <span className="catalog-quick-chip__name">
          {catalogPathChipLabel(model.path, model.name)}
        </span>
        <span className="catalog-quick-chip__meta">
          <span className="catalog-quick-chip__quant">{modelQuantLabel(model)}</span>
          {model.size_str ? (
            <span className="catalog-quick-chip__size">{model.size_str}</span>
          ) : null}
        </span>
      </span>
      {onUnpin && (
        <button
          type="button"
          className="catalog-quick-chip__unpin"
          title="Unpin from FAVORITE"
          aria-label={`Unpin ${model.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onUnpin();
          }}
        >
          ★
        </button>
      )}
    </div>
  );
}

/** Three rows fit the block; the rest scrolls under a fade. */
const VISIBLE_ROWS = 3;

export default function CatalogQuickStrip({
  models,
  endpoints,
  activeSet,
  pins,
  selectedPath,
  showEndpoints = true,
  onSelectPath,
  onAssignEndpoint,
  onAddEndpoint,
  onReplaceEndpoint,
  onRemoveEndpoint,
  onSelectSet,
  onTogglePinPath,
}: CatalogQuickStripProps) {
  const [endpointsOpen, setEndpointsOpen] = useState<boolean>(() => loadCatalogEndpointsOpen());
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    if (!helpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen]);

  // Remember the block open/closed. Opening the help panel force-expands it
  // without overwriting the stored preference.
  useEffect(() => {
    saveCatalogEndpointsOpen(endpointsOpen);
  }, [endpointsOpen]);

  const pinModels = pins
    .map((p) => findModel(models, p))
    .filter((m): m is ModelEntry => !!m);

  const selectedKey = selectedPath ? pathKey(selectedPath) : null;
  const brain = endpoints.find((e) => e.role === "brain") ?? null;
  const workers = endpoints.filter((e) => e.role === "worker");
  const atLimit = endpoints.length >= CATALOG_ENDPOINTS_MAX;
  const selectedAlreadyInSet =
    selectedKey != null && endpoints.some((e) => pathKey(e.path) === selectedKey);
  const expanded = endpointsOpen || helpOpen;
  const hasSelection = Boolean(selectedPath);
  const rowCount = 1 + workers.length + 1;
  const scrolls = rowCount > VISIBLE_ROWS;

  const launch = () => {
    if (!brain) return;
    const detail: CatalogLaunchEndpointsDetail = {
      setIndex: activeSet,
      endpointIds: endpoints.map((e) => e.id),
    };
    dispatchAppEvent(EVENTS.catalogLaunchEndpoints, detail);
  };

  const renderRow = (endpoint: Endpoint, index: number) => {
    const model = findModel(models, endpoint.path);
    const isSelected = selectedKey != null && pathKey(endpoint.path) === selectedKey;
    const selectionDiffers = selectedKey != null && !isSelected;
    // A worker row cannot take a model that already sits somewhere in this set:
    // moving it there would duplicate a path. BRAIN may pull a worker up.
    const canSet = selectionDiffers && (endpoint.role === "brain" || !selectedAlreadyInSet);

    return (
      <div
        key={endpoint.id}
        className={[
          "catalog-quick-seat",
          `catalog-quick-seat--${endpoint.role}`,
          "catalog-quick-seat--filled",
          isSelected ? "catalog-quick-seat--selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="catalog-quick-seat__body">
          <button
            type="button"
            className="catalog-quick-seat__main"
            title={`${ENDPOINT_ROLE_LABEL[endpoint.role]} · ${model?.name || endpoint.path}\nClick = select this model`}
            onClick={() => onSelectPath(endpoint.path)}
          >
            <span className="catalog-quick-seat__top">
              <span className="catalog-quick-seat__role">
                {ENDPOINT_ROLE_LABEL[endpoint.role]}
              </span>
              <span className="catalog-quick-seat__state">
                {String(index + 1).padStart(2, "0")}
              </span>
            </span>
            <span className="catalog-quick-seat__name">
              {model?.name || catalogPathChipLabel(endpoint.path)}
            </span>
            <span className="catalog-quick-seat__sub">
              {model ? (
                <>
                  <span className="catalog-quick-seat__quant">{modelQuantLabel(model)}</span>
                  {model.size_str ? (
                    <span className="catalog-quick-seat__size">{model.size_str}</span>
                  ) : null}
                </>
              ) : (
                <span className="catalog-quick-seat__hint">Not in the library</span>
              )}
            </span>
          </button>

          <div className="catalog-quick-seat__actions">
            {canSet ? (
              <button
                type="button"
                className="catalog-quick-seat__btn catalog-quick-seat__btn--replace"
                title={
                  endpoint.role === "brain"
                    ? "Move the selected model to BRAIN"
                    : "Use the selected catalog model in this row"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (endpoint.role === "brain") onAssignEndpoint("brain");
                  else onReplaceEndpoint(endpoint.id, selectedPath!);
                }}
              >
                SET
              </button>
            ) : null}
            <button
              type="button"
              className="catalog-quick-seat__btn catalog-quick-seat__btn--clear"
              title={`Remove ${ENDPOINT_ROLE_LABEL[endpoint.role]} from this set`}
              onClick={(e) => {
                e.stopPropagation();
                onRemoveEndpoint(endpoint.id);
              }}
            >
              ×
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="catalog-quick-strip" data-catalog-quick-strip>
      {showEndpoints && (
        <section
          className={[
            "catalog-quick-section catalog-quick-section--seats",
            expanded ? "" : "catalog-quick-section--seats-collapsed",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <header
            className="catalog-quick-section__head catalog-quick-section__head--seats"
            title="Endpoints — one BRAIN plus any number of WORKER models. Launching a set starts every filled row with the cockpit's current config."
          >
            <div className="catalog-quick-section__head-row catalog-quick-section__head-row--label">
              <div className="catalog-quick-section__sets" role="tablist" aria-label="Endpoint sets">
                {Array.from({ length: CATALOG_SET_COUNT }, (_, i) => {
                  const idx = i as CatalogSetIndex;
                  const active = activeSet === idx;
                  return (
                    <button
                      key={idx}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`catalog-quick-set-btn${active ? " catalog-quick-set-btn--active" : ""}`}
                      title={`Endpoint set ${idx + 1}${active ? " (active)" : ""}`}
                      onClick={() => onSelectSet(idx)}
                    >
                      {idx + 1}
                    </button>
                  );
                })}
              </div>
              <div className="catalog-quick-section__title-cluster">
                <span className="catalog-quick-section__title">ENDPOINTS</span>
                <button
                  type="button"
                  className={`catalog-quick-section__help${
                    helpOpen ? " catalog-quick-section__help--active" : ""
                  }`}
                  title="What are endpoints?"
                  aria-label="What are endpoints?"
                  aria-expanded={helpOpen}
                  aria-controls="catalog-endpoints-help"
                  onClick={() => setHelpOpen((v) => !v)}
                >
                  ?
                </button>
              </div>
              <button
                type="button"
                className="catalog-quick-section__collapse"
                title={expanded ? "Collapse endpoints" : "Expand endpoints"}
                aria-label={expanded ? "Collapse endpoints" : "Expand endpoints"}
                aria-expanded={expanded}
                aria-controls="catalog-endpoints-list"
                onClick={() => setEndpointsOpen((v) => !v)}
              >
                {expanded ? "\u25BC" : "\u25B6"}
              </button>
            </div>
          </header>
          <div
            id="catalog-endpoints-list"
            className={[
              "catalog-quick-seat-bank",
              helpOpen ? "catalog-quick-seat-bank--help" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {helpOpen ? (
              <div
                id="catalog-endpoints-help"
                className="catalog-seats-help"
                role="dialog"
                aria-label="Endpoints help"
              >
                <div className="catalog-seats-help__panel">
                  <div className="catalog-seats-help__top">
                    <span className="catalog-seats-help__kicker">ENDPOINTS</span>
                    <button
                      type="button"
                      className="catalog-seats-help__close"
                      onClick={() => setHelpOpen(false)}
                    >
                      CLOSE
                    </button>
                  </div>
                  <p className="catalog-seats-help__blurb">
                    A model pairing for the catalog quick launch. BRAIN is fixed; every
                    other row is a WORKER.
                  </p>
                  <div className="catalog-seats-help__flow" aria-hidden>
                    <div className="catalog-seats-help__step">
                      <span className="catalog-seats-help__n">1</span>
                      <span className="catalog-seats-help__step-title">PAIR</span>
                      <span className="catalog-seats-help__roles">
                        <span className="catalog-seats-help__role catalog-seats-help__role--brain">
                          BRAIN
                        </span>
                        <span className="catalog-seats-help__role catalog-seats-help__role--worker">
                          WORKER
                        </span>
                      </span>
                      <span className="catalog-seats-help__step-copy">pick models · + adds workers</span>
                    </div>
                    <span className="catalog-seats-help__arrow">→</span>
                    <div className="catalog-seats-help__step">
                      <span className="catalog-seats-help__n">2</span>
                      <span className="catalog-seats-help__step-title">LAUNCH</span>
                      <span className="catalog-seats-help__launch">▶</span>
                      <span className="catalog-seats-help__step-copy">start the set</span>
                    </div>
                    <span className="catalog-seats-help__arrow">→</span>
                    <div className="catalog-seats-help__step">
                      <span className="catalog-seats-help__n">3</span>
                      <span className="catalog-seats-help__step-title">CONNECT</span>
                      <span className="catalog-seats-help__connect">HARNESS</span>
                      <span className="catalog-seats-help__step-copy">open pi on BRAIN + first worker</span>
                    </div>
                  </div>
                  <p className="catalog-seats-help__foot">
                    Sets <b>1 – 5</b> store alternate pairings. Launch uses the cockpit's current
                    knobs for each endpoint.
                  </p>
                </div>
              </div>
            ) : null}
            {!helpOpen ? (
              <>
                <div
                  className={[
                    "catalog-quick-strip__seats",
                    scrolls ? "catalog-quick-strip__seats--scroll" : "",
                    scrolls ? "eink-scrollbar" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {brain ? (
                    renderRow(brain, 0)
                  ) : (
                    <div className="catalog-quick-seat catalog-quick-seat--brain catalog-quick-seat--empty">
                      <div className="catalog-quick-seat__body">
                        <button
                          type="button"
                          className="catalog-quick-seat__main"
                          title={
                            hasSelection
                              ? "Set the selected model as BRAIN"
                              : "Select a catalog model first"
                          }
                          onClick={() => {
                            if (hasSelection) onAssignEndpoint("brain");
                          }}
                        >
                          <span className="catalog-quick-seat__top">
                            <span className="catalog-quick-seat__role">BRAIN</span>
                            <span className="catalog-quick-seat__state">EMPTY</span>
                          </span>
                          <span className="catalog-quick-seat__name">
                            {hasSelection ? "Set selected model" : "No model"}
                          </span>
                          <span className="catalog-quick-seat__sub">
                            <span className="catalog-quick-seat__hint">
                              {hasSelection
                                ? "Click to fill BRAIN"
                                : "Select a model in the list first"}
                            </span>
                          </span>
                        </button>
                      </div>
                    </div>
                  )}

                  {workers.map((worker, i) => renderRow(worker, i + 1))}

                  <div
                    className={[
                      "catalog-quick-seat",
                      "catalog-quick-seat--worker",
                      "catalog-quick-seat--empty",
                      atLimit || !hasSelection || selectedAlreadyInSet || !brain
                        ? "catalog-quick-seat--add-idle"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="catalog-quick-seat__body">
                      <button
                        type="button"
                        className="catalog-quick-seat__main"
                        disabled={atLimit || !hasSelection || selectedAlreadyInSet || !brain}
                        title={
                          !brain
                            ? "Fill BRAIN before adding a worker"
                            : atLimit
                              ? `A set holds at most ${CATALOG_ENDPOINTS_MAX} endpoints`
                              : !hasSelection
                                ? "Select a catalog model first"
                                : selectedAlreadyInSet
                                  ? "That model is already in this set"
                                  : "Add the selected model as a WORKER"
                        }
                        onClick={() => {
                          if (brain && !atLimit && hasSelection && !selectedAlreadyInSet) {
                            onAddEndpoint();
                          }
                        }}
                      >
                        <span className="catalog-quick-seat__top">
                          <span className="catalog-quick-seat__role">+ ADD ENDPOINT</span>
                          <span className="catalog-quick-seat__state">
                            {endpoints.length} / {CATALOG_ENDPOINTS_MAX}
                          </span>
                        </span>
                        <span className="catalog-quick-seat__name">
                          {!brain
                            ? "Fill BRAIN first"
                            : atLimit
                              ? "Endpoint limit reached"
                              : selectedAlreadyInSet
                                ? "Already in this set"
                                : hasSelection
                                  ? "Add selected model as WORKER"
                                  : "No model selected"}
                        </span>
                        <span className="catalog-quick-seat__sub">
                          <span className="catalog-quick-seat__hint">
                            {!brain
                              ? "One BRAIN per set"
                              : atLimit
                                ? "Remove one to add another"
                                : selectedAlreadyInSet
                                  ? "Pick a different model"
                                  : "Workers run alongside BRAIN"}
                          </span>
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </div>
          {expanded && !helpOpen ? (
            <div className="catalog-quick-section__actions-row">
              <div className="catalog-quick-section__launch-actions">
                <button
                  type="button"
                  className="catalog-quick-section__action catalog-quick-section__action--launch"
                  disabled={!brain}
                  title={
                    brain
                      ? endpoints.length > 1
                        ? "Launch BRAIN + every WORKER in this set"
                        : "Launch BRAIN"
                      : "Fill BRAIN first"
                  }
                  onClick={launch}
                >
                  ▶
                </button>
              </div>
              <span className="catalog-quick-section__endpoint-count">
                {endpoints.length} / {CATALOG_ENDPOINTS_MAX}
              </span>
              <button
                type="button"
                className="catalog-quick-section__action catalog-quick-section__action--connect"
                title="Open harness connect veil"
                onClick={() => dispatchAppEvent(EVENTS.harnessConnectOpen)}
              >
                HARNESS
              </button>
            </div>
          ) : null}
        </section>
      )}
      {pinModels.length > 0 && !expanded && (
        <section className="catalog-quick-section catalog-quick-section--pins">
          <header className="catalog-quick-section__head catalog-quick-section__head--pins">
            <span className="catalog-quick-section__count">
              {pinModels.length} / {CATALOG_PINS_MAX}
            </span>
            <span className="catalog-quick-section__title">
              <span className="catalog-quick-section__star" aria-hidden>
                ★
              </span>
              FAVORITE
            </span>
          </header>
          <div className="catalog-quick-section__grid">
            {pinModels.map((m) => (
              <QuickModelChip
                key={`pin-${m.path}`}
                model={m}
                variant="pin"
                selected={selectedKey != null && pathKey(m.path) === selectedKey}
                title={`${m.name}\n${modelQuantLabel(m)}\nClick select · ★ unpin`}
                onSelect={() => onSelectPath(m.path)}
                onUnpin={() => onTogglePinPath(m.path)}
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
