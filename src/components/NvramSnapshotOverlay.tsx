import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTauriListen } from "../hooks/useTauriListen";
import type { NvramMatrixCell, NvramMatrixRow, NvramSnapshotMatrix } from "../lib/types";

/** How many snapshots sit side by side. */
const COLUMNS = 3;

function cellText(cell: NvramMatrixCell | undefined): string {
  if (!cell) return "—";
  if (cell.text != null && cell.text !== "") return cell.text;
  if (cell.number == null) return "—";
  return Number.isInteger(cell.number)
    ? cell.number.toLocaleString("en-US")
    : cell.number.toFixed(2);
}

function deltaText(prev: NvramMatrixCell | undefined, cur: NvramMatrixCell | undefined): string | null {
  if (prev?.number == null || cur?.number == null) return null;
  const delta = cur.number - prev.number;
  if (Math.abs(delta) < 1e-9) return null;
  const text = Number.isInteger(delta) ? delta.toLocaleString("en-US") : delta.toFixed(2);
  return `${delta > 0 ? "+" : ""}${text}`;
}

/** `pre_launch` is the card before the model loads, so the column reads IDLE → RUNNING → STOPPED. */
function stateLabel(phase: string): string {
  switch (phase) {
    case "pre_launch":
      return "IDLE";
    case "ready":
      return "RUNNING";
    case "stopped":
      return "STOPPED";
    case "probe":
      return "PROBE";
    default:
      return phase.replace(/_/g, " ").toUpperCase();
  }
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function isEmptyCell(cell: NvramMatrixCell | undefined): boolean {
  if (!cell) return true;
  return cell.number == null && (cell.text == null || cell.text === "");
}

/** Which block a matrix row belongs to. Order follows the backend's emission order. */
function groupOf(scope: string): { key: string; label: string } {
  if (scope.startsWith("gpu")) return { key: "gpu", label: "GPU" };
  if (scope.startsWith("slot")) return { key: "engine", label: "ENGINE" };
  if (scope.startsWith("learned")) return { key: "learned", label: "MEASURED LAUNCHES" };
  if (scope.startsWith("ui.bars")) return { key: "bars", label: "FORECAST · BARS" };
  if (scope.startsWith("ui.plan")) return { key: "plan", label: "FORECAST · PLAN" };
  if (scope.startsWith("ui")) return { key: "forecast", label: "FORECAST" };
  return { key: "other", label: "OTHER" };
}

/** `gpu0` → `GPU 0`; `learned ctx=262144 kv=…` → `CTX 262,144`. */
/** Block order: the live states first, the measured archive last. */
const GROUP_RANK: Record<string, number> = {
  gpu: 0,
  engine: 1,
  forecast: 2,
  bars: 3,
  plan: 4,
  learned: 5,
  other: 6,
};

function rowLabel(scope: string, field: string): { primary: string; secondary: string | null } {
  const gpu = /^gpu(\d+)$/.exec(scope);
  if (gpu) return { primary: field, secondary: `GPU ${gpu[1]}` };
  const slot = /^slot(\d+)$/.exec(scope);
  if (slot) return { primary: field, secondary: `ENGINE ${slot[1]}` };
  if (scope.startsWith("learned")) {
    const ctx = /ctx=(\d+)/.exec(scope);
    const kv = /kv=([a-z0-9_]+)/i.exec(scope);
    // Two rows can share a ctx (different kv/split measurement): name the kv so they do not read
    // as a duplicate row.
    const parts = [
      ctx ? `CTX ${Number(ctx[1]).toLocaleString("en-US")}` : "LEARNED",
      kv ? kv[1] : null,
    ].filter(Boolean);
    return { primary: field, secondary: parts.join(" · ") };
  }
  return { primary: field, secondary: null };
}

/**
 * Memory log: the newest launch as a flow — IDLE → RUNNING → STOPPED — grouped into GPU /
 * ENGINE / MEASURED LAUNCHES / FORECAST blocks.
 *
 * Opens from the bezel control (which also carries CAPTURE) and refreshes itself: the Rust side
 * writes a snapshot at each lifecycle boundary, so a stop/relaunch must appear without reopening.
 * On the fusion screen it starts just under the engine identity rail so STOP stays reachable.
 */
export default function NvramSnapshotOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [matrix, setMatrix] = useState<NvramSnapshotMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<NvramSnapshotMatrix>("nvram_snapshot_matrix", { limit: COLUMNS });
      setMatrix(next);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  const columns = matrix?.columns ?? [];
  const rows = matrix?.rows ?? [];

  // The bezel control keeps its own state; Esc is the keyboard way out.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Live log: every capture emits `nvram-snapshot-changed` (lifecycle hooks, bezel button,
  // automation), so a stop or relaunch lands in the columns immediately — no polling.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useTauriListen<{ phase?: string }>(
    "nvram-snapshot-changed",
    () => {
      void refresh();
    },
    [refresh],
  );

  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: 0 });
  }, [open]);

  // The fusion identity rail (CONTEXT · alias · FULL · STOP) stays on top and clickable; the log
  // starts just under it. Two pixels of overlap hide the rail's own bottom border.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const badge = root?.parentElement;
    if (!open || !root || !badge) return;
    const rail = badge.querySelector<HTMLElement>(".fusion-identity-rail");
    const offset = rail
      ? Math.max(0, rail.getBoundingClientRect().bottom - badge.getBoundingClientRect().top - 3)
      : 0;
    root.style.top = `${offset}px`;
  }, [open, columns.length, rows.length]);

  const groups = useMemo(() => {
    const visible = rows.filter((row) => row.cells.some((cell) => !isEmptyCell(cell)));
    // Group by block id, not by runs of adjacent rows: the matrix is the union of the columns'
    // keys, so a row that only exists in the newest snapshot can appear after a later block.
    const out: Array<{ key: string; label: string; rows: NvramMatrixRow[] }> = [];
    const byKey = new Map<string, { key: string; label: string; rows: NvramMatrixRow[] }>();
    for (const row of visible) {
      const group = groupOf(row.scope);
      let bucket = byKey.get(group.key);
      if (!bucket) {
        bucket = { ...group, rows: [] };
        byKey.set(group.key, bucket);
        out.push(bucket);
      }
      bucket.rows.push(row);
    }
    return out.sort((a, b) => (GROUP_RANK[a.key] ?? 9) - (GROUP_RANK[b.key] ?? 9));
  }, [rows]);

  if (!open) return null;

  return (
    <div className="vram-snap-ov" role="dialog" aria-label="Memory log" ref={rootRef}>
      {columns.length === 0 ? (
        <div className="vram-snap-ov__empty">
          No snapshots yet. CAPTURE on the bezel records NVML per card, the engine stack with its
          launch inventory, the learned rows, the calibration and the glass state — then change a
          knob and CAPTURE again to see the flow.
        </div>
      ) : (
        <div className="vram-snap-ov__scroll" ref={scrollRef}>
          <table className="vram-snap-ov__table">
            <thead>
              <tr>
                <th className="vram-snap-ov__rowlab" scope="col">
                  ENGINE STATE
                </th>
                {columns.map((column, i) => (
                  <th key={column.file} scope="col" className="vram-snap-ov__col">
                    {i > 0 ? (
                      <span className="vram-snap-ov__flow" aria-hidden>
                        →
                      </span>
                    ) : null}
                    <span className="vram-snap-ov__phase">{stateLabel(column.phase)}</span>
                    <span className="vram-snap-ov__when">{clock(column.captured_at)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.key}>
                <tr className="vram-snap-ov__group-row">
                  <th className="vram-snap-ov__group" scope="colgroup" colSpan={1 + columns.length}>
                    {group.label}
                  </th>
                </tr>
                {group.rows.map((row) => {
                  const label = rowLabel(row.scope, row.field);
                  return (
                    <tr key={`${row.scope}-${row.field}`}>
                      <th scope="row" className="vram-snap-ov__rowlab" title={`${row.scope} ${row.field}`}>
                        {label.secondary ? (
                          <span className="vram-snap-ov__scope">{label.secondary}</span>
                        ) : null}
                        <span className="vram-snap-ov__field">{label.primary}</span>
                        {row.unit ? <span className="vram-snap-ov__unit">{row.unit}</span> : null}
                      </th>
                      {row.cells.map((cell, i) => {
                        const delta = i > 0 ? deltaText(row.cells[i - 1], cell) : null;
                        return (
                          <td key={i} className="vram-snap-ov__cell">
                            <span className="vram-snap-ov__val">{cellText(cell)}</span>
                            {delta ? (
                              <span
                                className="vram-snap-ov__delta"
                                data-dir={delta.startsWith("+") ? "up" : "down"}
                              >
                                {delta}
                              </span>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
          <div className="vram-snap-ov__foot">
            Δ against the column to its left · files in <code>config/cache/nvram/</code> · full table:
            <code> blackwell-ops --nvram-diff a.json b.json</code>
          </div>
        </div>
      )}

      {error ? <div className="vram-snap-ov__error">{error}</div> : null}
    </div>
  );
}
