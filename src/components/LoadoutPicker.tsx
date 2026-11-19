/**
 * LOADOUT picker — contextual file picker, one stop at a time.
 *
 * This overlay never changes the SPEC mode (that is the rail's job). It only picks the
 * extra files a mode needs: a draft head, an MMPROJ, or an ENGRAM table. It opens over
 * the grid, centred above the stop that asked for it, at about a third of the width —
 * the rest of the grid is dimmed so the eye goes to the panel, and the panel is opaque
 * so nothing behind it competes.
 *
 * Local files and repo downloads are separated (LOCAL / REMOTE) because they are
 * different decisions: one is instant, the other is a download.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CompanionRole, CompanionSlot, RepoCompanion } from "../lib/types";

export interface LocalFileRow {
  key: string;
  quant: string;
  size: string;
  name: string;
  active?: boolean;
  disabled?: boolean;
  onPick: () => void;
}

interface LoadoutPickerProps {
  title: string;
  /** 0..1 position of the stop that opened this panel, across the cockpit width. */
  anchor: number;
  role: CompanionRole | null;
  slot: CompanionSlot | null;
  localRows?: LocalFileRow[];
  modelPath: string;
  onAttach: (role: CompanionRole, path: string) => void;
  onDetach: (role: CompanionRole) => void;
  onClear: (role: CompanionRole) => void;
  onDownloaded: () => void;
  /** Renders the HF-id input for lanes that can resolve one (draft heads). */
  hfInput?: {
    placeholder: string;
    busy: boolean;
    error: string | null;
    onSubmit: (id: string) => void;
  };
  onClose: () => void;
}

export default function LoadoutPicker({
  title,
  anchor,
  role,
  slot,
  localRows,
  modelPath,
  onAttach,
  onDetach,
  onClear,
  onDownloaded,
  hfInput,
  onClose,
}: LoadoutPickerProps) {
  const [repoItems, setRepoItems] = useState<RepoCompanion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hfValue, setHfValue] = useState("");

  useEffect(() => {
    if (!role) return;
    let alive = true;
    setRepoItems(null);
    invoke<RepoCompanion[]>("repo_companions", { modelPath, role })
      .then((items) => {
        if (alive) setRepoItems(items);
      })
      .catch(() => {
        if (alive) setRepoItems([]);
      });
    return () => {
      alive = false;
    };
  }, [modelPath, role]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = async (item: RepoCompanion) => {
    if (!role) return;
    setBusy(item.path_in_repo);
    try {
      await invoke("download_companion", {
        modelPath,
        role,
        repoId: item.repo_id,
        pathInRepo: item.path_in_repo,
        sizeBytes: item.size_bytes,
        url: item.url,
        lfsOid: item.lfs_oid,
      });
      onDownloaded();
    } finally {
      setBusy(null);
    }
  };

  const activePath =
    slot?.pinned ?? (slot && slot.confidence === "strong" ? slot.auto?.path : undefined);

  return (
    <div className="gp-scrim" onClick={onClose}>
      <div
        className="gp-panel"
        style={{ left: `calc(${Math.round(anchor * 100)}% - 14.5rem)` }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${title} picker`}
      >
        <div className="gp-panel__head">
          <span className="gp-panel__title font-mono">{title}</span>
          <button
            type="button"
            className="gp-panel__x font-mono"
            onClick={onClose}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="gp-panel__body">
          <div className="gp-section">
            <span className="gp-section__label font-mono">LOCAL</span>
            <div className="gp-rows">
              {(localRows ?? []).map((row) => (
                <button
                  key={row.key}
                  type="button"
                  className={`gp-row${row.active ? " gp-row--on" : ""}`}
                  onClick={row.onPick}
                  disabled={row.disabled}
                  title={row.name}
                >
                  <span className="gp-row__dot" aria-hidden />
                  <span className="gp-row__quant font-mono">{row.quant}</span>
                  <span className="gp-row__size font-mono">{row.size}</span>
                  <span className="gp-row__name font-mono">{row.name}</span>
                </button>
              ))}
              {role && slot
                ? slot.candidates.map((candidate) => (
                    <button
                      key={candidate.path}
                      type="button"
                      className={`gp-row${activePath === candidate.path ? " gp-row--on" : ""}`}
                      onClick={() =>
                        activePath === candidate.path
                          ? onDetach(role)
                          : onAttach(role, candidate.path)
                      }
                      title={candidate.reason || candidate.path}
                    >
                      <span className="gp-row__dot" aria-hidden />
                      <span className="gp-row__quant font-mono">{candidate.precision}</span>
                      <span className="gp-row__size font-mono">{candidate.size_str}</span>
                      <span className="gp-row__name font-mono">{candidate.label}</span>
                    </button>
                  ))
                : null}
              {!role && (localRows?.length ?? 0) === 0 ? (
                <span className="gp-empty font-mono">nothing on disk</span>
              ) : null}
              {role && slot && slot.candidates.length === 0 ? (
                <span className="gp-empty font-mono">nothing on disk</span>
              ) : null}
            </div>
          </div>

          {role ? (
            <div className="gp-section">
              <span className="gp-section__label font-mono">REMOTE</span>
              <div className="gp-rows">
                {repoItems === null ? (
                  <span className="gp-empty font-mono">reading the Hub tree…</span>
                ) : repoItems.length === 0 ? (
                  <span className="gp-empty font-mono">repo publishes no file of its own</span>
                ) : (
                  repoItems.map((item) => (
                    <button
                      key={item.path_in_repo}
                      type="button"
                      className="gp-row gp-row--repo"
                      onClick={() => void download(item)}
                      disabled={busy === item.path_in_repo}
                      title={item.path_in_repo}
                    >
                      <span className="gp-row__dot" aria-hidden />
                      <span className="gp-row__quant font-mono">{item.precision || "file"}</span>
                      <span className="gp-row__size font-mono">{item.size_str}</span>
                      <span className="gp-row__name font-mono">{item.file_name}</span>
                      <span className="gp-row__tag font-mono">
                        {busy === item.path_in_repo ? "QUEUED" : "GET"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {hfInput ? (
            <div className="gp-section">
              <span className="gp-section__label font-mono">HF ID</span>
              <div className="gp-hf">
                <input
                  className="gp-hf__input font-mono"
                  value={hfValue}
                  placeholder={hfInput.placeholder}
                  onChange={(e) => setHfValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && hfValue.trim()) {
                      hfInput.onSubmit(hfValue.trim());
                    }
                  }}
                />
                <button
                  type="button"
                  className="gp-hf__go font-mono"
                  disabled={hfInput.busy || !hfValue.trim()}
                  onClick={() => hfInput.onSubmit(hfValue.trim())}
                >
                  {hfInput.busy ? "…" : "RESOLVE"}
                </button>
              </div>
              {hfInput.error ? (
                <span className="gp-empty font-mono">{hfInput.error}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="gp-panel__foot">
          {role && slot?.pinned ? (
            <button
              type="button"
              className="gp-panel__btn font-mono"
              onClick={() => onDetach(role)}
            >
              DETACH
            </button>
          ) : null}
          {role ? (
            <button
              type="button"
              className="gp-panel__btn font-mono"
              onClick={() => onClear(role)}
            >
              RESET TO AUTO
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
