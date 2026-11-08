import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NvramDiffPayload, NvramDiffRow } from "../lib/types";

/** How many diff rows fit in the recap before it summarises the rest. */
const MAX_ROWS = 12;

function fmtNumber(value: number | null): string {
  if (value === null) return "unknown";
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(2);
}

function rowBefore(row: NvramDiffRow): string {
  return row.before_text ?? fmtNumber(row.before);
}

function rowAfter(row: NvramDiffRow): string {
  return row.after_text ?? fmtNumber(row.after);
}

function rowDelta(row: NvramDiffRow): string {
  if (row.delta === null) return "";
  const value = row.delta;
  if (Number.isInteger(value)) return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function rowLabel(row: NvramDiffRow): string {
  return `${row.scope} ${row.field}`.toUpperCase();
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * NVRAM SNAP — capture a snapshot of what the app can see (NVML, engine stack + launch
 * inventory, learned rows, calibration, the glass state) and show the diff against the previous
 * one in the same recap chrome as MEMORY FORECAST SOURCE.
 *
 * Click captures; hover shows the last diff. Both sides are files under
 * `{app_root}/config/cache/nvram/`, so the same pair prints with
 * `blackwell-ops --nvram-diff before.json after.json`.
 */
export default function NvramSnapshotChip() {
  const [diff, setDiff] = useState<NvramDiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await invoke<NvramDiffPayload>("nvram_snapshot_compare");
      if (!mounted.current) return;
      setDiff(next);
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setDiff(null);
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const capture = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke<string>("capture_nvram_snapshot", { path: null });
      await refresh();
      setOpen(true);
    } catch (err) {
      if (mounted.current) setError(String(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy, refresh]);

  const rows = diff?.rows ?? [];
  const shown = rows.slice(0, MAX_ROWS);
  const hidden = rows.length - shown.length;

  return (
    <div
      className="vram-fc-snap"
      data-tip-open={open ? "1" : undefined}
      data-snap-state={busy ? "capturing" : "idle"}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="vram-fc-header__reprobe vram-fc-snap__button"
        data-snap-state={busy ? "capturing" : "idle"}
        disabled={busy}
        onClick={() => void capture()}
        title="Capture an NVRAM snapshot — hover shows the diff against the previous one"
      >
        {busy ? "SNAP…" : "SNAP"}
      </button>
      {open ? (
        <div className="vram-fc-recap vram-fc-snap__recap" role="tooltip">
          {diff ? (
            <>
              <div className="vram-fc-recap__summary">
                {diff.count === 0
                  ? `No change — ${clock(diff.before_at)} → ${clock(diff.after_at)}`
                  : `${diff.count} change${diff.count === 1 ? "" : "s"} — ${clock(diff.before_at)} → ${clock(diff.after_at)}`}
              </div>
              {shown.map((row, i) => (
                <div className="vram-fc-recap__row vram-fc-snap__row" key={`${row.scope}-${row.field}-${i}`}>
                  <span className="vram-fc-recap__k vram-fc-snap__k" title={rowLabel(row)}>
                    {rowLabel(row)}
                  </span>
                  <span className="vram-fc-recap__v vram-fc-recap__v--mono vram-fc-snap__values">
                    <span className="vram-fc-snap__before">{rowBefore(row)}</span>
                    <span className="vram-fc-snap__arrow" aria-hidden>
                      →
                    </span>
                    <span className="vram-fc-snap__after">{rowAfter(row)}</span>
                    {row.delta !== null ? (
                      <span className="vram-fc-snap__delta" data-dir={row.delta > 0 ? "up" : row.delta < 0 ? "down" : "flat"}>
                        {rowDelta(row)}
                      </span>
                    ) : (
                      <span className="vram-fc-snap__delta" data-dir="unknown">
                        {row.note ?? ""}
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {hidden > 0 ? (
                <div className="vram-fc-recap__row vram-fc-snap__row">
                  <span className="vram-fc-recap__k">MORE</span>
                  <span className="vram-fc-recap__v">
                    +{hidden} more — see the full table with blackwell-ops --nvram-diff
                  </span>
                </div>
              ) : null}
              <div className="vram-fc-recap__foot">click SNAP to capture the next point</div>
            </>
          ) : (
            <>
              <div className="vram-fc-recap__summary">NVRAM SNAPSHOT</div>
              <div className="vram-fc-recap__row">
                <span className="vram-fc-recap__k">NEED</span>
                <span className="vram-fc-recap__v">{error ?? "capture a second point to diff"}</span>
              </div>
              <div className="vram-fc-recap__foot">click SNAP to capture · then change a knob and SNAP again</div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
