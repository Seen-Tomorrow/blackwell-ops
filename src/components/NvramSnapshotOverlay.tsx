import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NvramSnapshotMatrix, NvramMatrixCell } from "../lib/types";

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

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Full-glass NVRAM snapshot overlay: the newest snapshots side by side, so a launch (or a knob
 * change) reads as a flow — what it was, what it became, by how much.
 *
 * Opened from the bezel control; captured in place (CAPTURE) so the overlay is the workspace.
 * Files live under `{app_root}/config/cache/nvram/` and print with
 * `blackwell-ops --nvram-diff before.json after.json`.
 */
export default function NvramSnapshotOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [matrix, setMatrix] = useState<NvramSnapshotMatrix | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<NvramSnapshotMatrix>("nvram_snapshot_matrix", { limit: COLUMNS });
      setMatrix(next);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const capture = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke<string>("capture_nvram_snapshot", { path: null, phase: "manual" });
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  if (!open) return null;

  const columns = matrix?.columns ?? [];
  const rows = matrix?.rows ?? [];

  return (
    <div className="vram-snap-ov" role="dialog" aria-label="NVRAM snapshots">
      <div className="vram-snap-ov__bar">
        <span className="vram-snap-ov__title">NVRAM SNAPSHOTS</span>
        <span className="vram-snap-ov__count">
          {columns.length === 0
            ? "none yet"
            : `${columns.length} of last ${COLUMNS} · ${clock(columns[columns.length - 1].captured_at)}`}
        </span>
        <button
          type="button"
          className="vram-snap-ov__action"
          onClick={() => void capture()}
          disabled={busy}
          title="Capture a snapshot of what the app can see right now"
        >
          {busy ? "CAPTURING…" : "CAPTURE"}
        </button>
        <button
          type="button"
          className="vram-snap-ov__action vram-snap-ov__action--close"
          onClick={onClose}
          title="Close (Esc)"
        >
          CLOSE
        </button>
      </div>

      {columns.length === 0 ? (
        <div className="vram-snap-ov__empty">
          No snapshots yet. CAPTURE records NVML per card, the engine stack with its launch
          inventory, the learned rows, the calibration and the glass state — then change a knob and
          CAPTURE again to see the flow.
        </div>
      ) : (
        <div className="vram-snap-ov__scroll">
          <table className="vram-snap-ov__table">
            <thead>
              <tr>
                <th className="vram-snap-ov__rowlab" scope="col">
                  MEASUREMENT
                </th>
                {columns.map((column, i) => (
                  <th key={column.file} scope="col" className="vram-snap-ov__col">
                    <span className="vram-snap-ov__phase">{column.phase.toUpperCase()}</span>
                    <span className="vram-snap-ov__when">{clock(column.captured_at)}</span>
                    <span className="vram-snap-ov__ord">{i + 1}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.scope}-${row.field}`}>
                  <th scope="row" className="vram-snap-ov__rowlab" title={`${row.scope} ${row.field}`}>
                    <span className="vram-snap-ov__scope">{row.scope}</span>
                    <span className="vram-snap-ov__field">{row.field}</span>
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
              ))}
            </tbody>
          </table>
          <div className="vram-snap-ov__foot">
            Δ is against the column to its left · files in <code>config/cache/nvram/</code> · full
            table: <code>blackwell-ops --nvram-diff a.json b.json</code>
          </div>
        </div>
      )}

      {error ? <div className="vram-snap-ov__error">{error}</div> : null}
    </div>
  );
}

