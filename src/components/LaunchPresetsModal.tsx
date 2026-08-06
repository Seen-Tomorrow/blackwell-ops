/**
 * Full launch-presets editor — large modal (Manage / Edit).
 */

import { useEffect, useState } from "react";
import type {
  ComboPreset,
  LaunchSeat,
  PortPolicy,
  PortPolicyMode,
  SeatRole,
} from "../lib/launchPresets";
import { estimateComboMemory, formatGb } from "../lib/launchPresets";

export type LaunchPresetsModalProps = {
  open: boolean;
  combos: ComboPreset[];
  models?: Array<{ path: string; metadata?: { file_size_bytes?: number }; name?: string }>;
  onClose: () => void;
  onSave: (combo: ComboPreset) => void;
  onDelete: (id: string) => void;
  onDuplicate: (combo: ComboPreset) => void;
  /** Opens confirm / apply path — parent owns confirmation. */
  onApply: (combo: ComboPreset, opts: { loadIntoPanel: boolean }) => void;
};

const PORT_MODES: PortPolicyMode[] = ["auto", "prefer", "fixed"];

const POLICY_LABEL: Record<string, string> = {
  full_auto: "Full Auto",
  assisted_essentials: "Assisted Essentials",
  assisted_full: "Assisted Full",
};

function seatSummary(s: LaunchSeat): string {
  const name = s.modelName || s.modelPath.split(/[/\\]/).pop() || s.modelPath;
  return `${s.role.toUpperCase()} · ${name}`;
}

export default function LaunchPresetsModal({
  open,
  combos,
  models = [],
  onClose,
  onSave,
  onDelete,
  onDuplicate,
  onApply,
}: LaunchPresetsModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ComboPreset | null>(null);
  const [loadIntoPanel, setLoadIntoPanel] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (selectedId) {
      const c = combos.find((x) => x.id === selectedId) ?? null;
      setDraft(c ? structuredClone(c) : null);
    } else if (combos[0]) {
      setSelectedId(combos[0].id);
      setDraft(structuredClone(combos[0]));
    } else {
      setDraft(null);
    }
  }, [open, selectedId, combos]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const updateSeat = (seatId: string, patch: Partial<LaunchSeat>) => {
    if (!draft) return;
    setDraft({
      ...draft,
      seats: draft.seats.map((s) => (s.id === seatId ? { ...s, ...patch } : s)),
    });
  };

  const updatePortPolicy = (seatId: string, policy: PortPolicy) => {
    updateSeat(seatId, { portPolicy: policy });
  };

  return (
    <div
      className="launch-presets-modal-overlay fixed inset-0 z-[120] flex items-center justify-center bg-black/70"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="launch-presets-modal border border-stealth-border/60 w-[min(920px,94vw)] max-h-[88vh] flex flex-col font-mono text-[10px] shadow-xl rounded-sm text-stealth-text"
        style={{
          // Solid panel — theme-surface-raised alone can be transparent in WebView2
          backgroundColor: "var(--color-stealth-panel, #111810)",
          color: "var(--color-stealth-text, #c8d4c0)",
        }}
        role="dialog"
        aria-labelledby="launch-presets-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className="flex items-center gap-2 px-3 py-2 border-b border-stealth-border/50 flex-shrink-0"
          style={{ backgroundColor: "var(--color-stealth-panel, #111810)" }}
        >
          <h2
            id="launch-presets-modal-title"
            className="m-0 text-[11px] tracking-widest uppercase text-nv-green/90"
          >
            Launch presets
          </h2>
          <span className="text-stealth-muted/50 text-[8px]">solo · twin · manage</span>
          <button
            type="button"
            className="ml-auto config-panel-toolbar-chip px-2 py-0.5"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        <div className="flex flex-1 min-h-0" style={{ backgroundColor: "var(--color-stealth-panel, #111810)" }}>
          {/* List */}
          <aside
            className="w-[200px] flex-shrink-0 border-r border-stealth-border/40 overflow-y-auto"
            style={{ backgroundColor: "color-mix(in srgb, #000 25%, var(--color-stealth-panel, #111810))" }}
          >
            {combos.length === 0 && (
              <p className="p-2 text-stealth-muted/60 m-0">No presets saved yet.</p>
            )}
            {combos.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`w-full text-left px-2 py-2 border-b border-stealth-border/20 ${
                  c.id === selectedId ? "bg-nv-green/15 text-nv-green" : "hover:bg-white/5"
                }`}
                onClick={() => setSelectedId(c.id)}
              >
                <div className="uppercase text-[8px] opacity-70">{c.kind}</div>
                <div className="truncate">{c.name}</div>
              </button>
            ))}
          </aside>

          {/* Editor */}
          <main className="flex-1 min-w-0 overflow-y-auto p-3 space-y-3">
            {!draft && (
              <p className="text-stealth-muted m-0">
                Save a solo seat or twin from the PRESETS menu, then edit here.
              </p>
            )}
            {draft && (
              <>
                <label className="flex flex-col gap-0.5">
                  <span className="text-stealth-muted uppercase text-[8px]">Name</span>
                  <input
                    className="border border-stealth-border/50 px-2 py-1 rounded-sm text-stealth-text"
                    style={{ backgroundColor: "color-mix(in srgb, #000 35%, var(--color-stealth-panel, #111810))" }}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>

                <label className="flex flex-col gap-0.5">
                  <span className="text-stealth-muted uppercase text-[8px]">Notes</span>
                  <input
                    className="border border-stealth-border/50 px-2 py-1 rounded-sm text-stealth-text"
                    style={{ backgroundColor: "color-mix(in srgb, #000 35%, var(--color-stealth-panel, #111810))" }}
                    value={draft.notes ?? ""}
                    onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                    placeholder="optional"
                  />
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!draft.sequenceBrainFirst}
                    onChange={(e) =>
                      setDraft({ ...draft, sequenceBrainFirst: e.target.checked })
                    }
                    className="accent-nv-green"
                  />
                  <span>Sequence BRAIN first on cold launch (default: parallel)</span>
                </label>

                {draft.kind === "twin" && (
                  <label className="flex flex-col gap-0.5 max-w-[200px]">
                    <span className="text-stealth-muted uppercase text-[8px]">
                      Agents N override (empty = WORKER parallel)
                    </span>
                    <input
                      type="number"
                      min={1}
                      className="bg-stealth-input border border-stealth-border/50 px-2 py-1 rounded-sm"
                      value={draft.harness?.agentsOverride ?? ""}
                      placeholder="auto"
                      onChange={(e) => {
                        const n = e.target.value === "" ? undefined : Math.max(1, Number(e.target.value) || 1);
                        setDraft({
                          ...draft,
                          harness: {
                            tool: draft.harness?.tool ?? "pi",
                            defaultMode: "twin",
                            agentsOverride: n,
                          },
                        });
                      }}
                    />
                  </label>
                )}

                {(() => {
                  const mem = estimateComboMemory(draft, models);
                  return (
                    <div className="text-[9px] text-stealth-muted flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>
                        Est. VRAM{" "}
                        <strong className="text-stealth-text tabular-nums">
                          ~{formatGb(mem.totalVramGb)}
                        </strong>
                      </span>
                      <span className="opacity-60">weights×1.12 · not full FIT</span>
                    </div>
                  );
                })()}

                <div className="space-y-2">
                  <div className="text-stealth-muted uppercase text-[8px] tracking-wider">Seats</div>
                  {draft.seats.map((seat) => (
                    <div
                      key={seat.id}
                      className="border border-stealth-border/40 rounded-sm p-2 space-y-1.5"
                      style={{ backgroundColor: "color-mix(in srgb, #000 20%, var(--color-stealth-panel, #111810))" }}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <select
                          className="border border-stealth-border/50 px-1 py-0.5 text-stealth-text"
                          style={{ backgroundColor: "color-mix(in srgb, #000 35%, var(--color-stealth-panel, #111810))" }}
                          value={seat.role}
                          onChange={(e) =>
                            updateSeat(seat.id, { role: e.target.value as SeatRole })
                          }
                        >
                          {(["brain", "worker", "solo", "custom"] as SeatRole[]).map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        <span className="truncate opacity-80">{seatSummary(seat)}</span>
                        <span
                          className="ml-auto text-[7px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm border border-stealth-border/40 text-stealth-muted"
                          title="Launch mode at save — edit by re-saving from Full Auto / Assisted panel"
                        >
                          {POLICY_LABEL[seat.policyId] ?? seat.policyId}
                        </span>
                      </div>
                      <div className="text-[8px] text-stealth-muted break-all">{seat.modelPath}</div>
                      <div className="flex flex-wrap gap-2 items-end">
                        <label className="flex flex-col gap-0.5">
                          <span className="text-stealth-muted text-[7px] uppercase">Port</span>
                          <select
                            className="bg-stealth-input border border-stealth-border/50 px-1 py-0.5"
                            value={seat.portPolicy.mode}
                            onChange={(e) => {
                              const mode = e.target.value as PortPolicyMode;
                              updatePortPolicy(seat.id, {
                                mode,
                                port: seat.portPolicy.port,
                              });
                            }}
                          >
                            {PORT_MODES.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </label>
                        {(seat.portPolicy.mode === "prefer" || seat.portPolicy.mode === "fixed") && (
                          <label className="flex flex-col gap-0.5">
                            <span className="text-stealth-muted text-[7px] uppercase">Port #</span>
                            <input
                              type="number"
                              className="bg-stealth-input border border-stealth-border/50 px-1 py-0.5 w-20"
                              value={seat.portPolicy.port ?? ""}
                              onChange={(e) =>
                                updatePortPolicy(seat.id, {
                                  mode: seat.portPolicy.mode,
                                  port: Number(e.target.value) || undefined,
                                })
                              }
                            />
                          </label>
                        )}
                        <label className="flex flex-col gap-0.5">
                          <span className="text-stealth-muted text-[7px] uppercase">Parallel</span>
                          <input
                            type="number"
                            min={1}
                            className="bg-stealth-input border border-stealth-border/50 px-1 py-0.5 w-16"
                            value={seat.paramOverrides.parallel ?? ""}
                            onChange={(e) => {
                              const n = Math.max(1, Number(e.target.value) || 1);
                              updateSeat(seat.id, {
                                paramOverrides: { ...seat.paramOverrides, parallel: n },
                              });
                            }}
                          />
                        </label>
                        <label className="flex flex-col gap-0.5">
                          <span className="text-stealth-muted text-[7px] uppercase">CTX</span>
                          <input
                            type="number"
                            min={512}
                            className="bg-stealth-input border border-stealth-border/50 px-1 py-0.5 w-20"
                            value={seat.paramOverrides.ctx ?? ""}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              updateSeat(seat.id, {
                                paramOverrides: {
                                  ...seat.paramOverrides,
                                  ...(Number.isFinite(n) && n > 0 ? { ctx: n } : {}),
                                },
                              });
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap gap-2 pt-2 border-t border-stealth-border/40">
                  <label className="flex items-center gap-1 mr-auto cursor-pointer">
                    <input
                      type="checkbox"
                      checked={loadIntoPanel}
                      onChange={(e) => setLoadIntoPanel(e.target.checked)}
                      className="accent-nv-green"
                    />
                    Load into panel on Apply
                  </label>
                  <button
                    type="button"
                    className="config-panel-toolbar-chip px-2 py-1 config-panel-toolbar-chip--active"
                    onClick={() => {
                      onSave(draft);
                    }}
                  >
                    Save changes
                  </button>
                  <button
                    type="button"
                    className="config-panel-toolbar-chip px-2 py-1"
                    onClick={() => onApply(draft, { loadIntoPanel })}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="config-panel-toolbar-chip px-2 py-1"
                    onClick={() => onDuplicate(draft)}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="config-panel-toolbar-chip px-2 py-1 text-red-400/90"
                    onClick={() => {
                      if (window.confirm(`Delete preset “${draft.name}”?`)) {
                        onDelete(draft.id);
                        setSelectedId(null);
                        setDraft(null);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
