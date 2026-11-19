/**
 * LOADOUT picker — full-grid overlay, two columns and one HF row.
 *
 * While a file is being picked the sliders are not needed, so the overlay covers the
 * whole 2x2 grid and the content sits in the SWAPS half, where the slots that opened it
 * live. That is the largest area the cockpit can give up without moving anything, and
 * it means the lists never have to be squeezed.
 *
 * Layout: LOCAL | REMOTE side by side (two different decisions — instant vs download),
 * three rows each by default with a "show all" expander, and one row for a direct HF id.
 * The surface is the cockpit's neutral `--theme-panel-accent`, never `--theme-panel`.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cachedInvoke, hfCooldownMs, noteHfError } from "../lib/hfCache";
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
  role: CompanionRole | null;
  slot: CompanionSlot | null;
  localRows?: LocalFileRow[];
  /** Remote rows supplied by the caller (drafts); otherwise fetched for the role. */
  remoteRows?: LocalFileRow[];
  onSearchRemote?: () => void;
  modelPath: string;
  onAttach: (role: CompanionRole, path: string) => void;
  onDetach: (role: CompanionRole) => void;
  onClear: (role: CompanionRole) => void;
  onDownloaded: () => void;
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
  role,
  slot,
  localRows,
  remoteRows,
  onSearchRemote,
  modelPath,
  onAttach,
  onDetach,
  onClear,
  onDownloaded,
  hfInput,
  onClose,
}: LoadoutPickerProps) {
  const [repoItems, setRepoItems] = useState<RepoCompanion[] | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteRequested, setRemoteRequested] = useState(false);
  // Hub quota countdown: while it runs, no button can spend a request and the reason is
  // visible, never a blinking error.
  const [cooldownMs, setCooldownMs] = useState(() => hfCooldownMs());

  useEffect(() => {
    const tick = () => setCooldownMs(hfCooldownMs());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  const [busy, setBusy] = useState<string | null>(null);
  const [hfValue, setHfValue] = useState("");


  /**
   * Nothing here touches the Hub on its own. Every remote read is a click: flipping
   * through slots while the local library already has the file must not spend quota.
   */
  const loadRemote = useCallback(() => {
    if (hfCooldownMs() > 0) return;
    if (!role) {
      onSearchRemote?.();
      return;
    }
    setRemoteLoading(true);
    cachedInvoke<RepoCompanion[]>("repo_companions", { modelPath, role })
      .then((items) => setRepoItems(items))
      .catch((err) => {
        noteHfError(err);
        setRepoItems([]);
      })
      .finally(() => setRemoteLoading(false));
  }, [modelPath, onSearchRemote, role]);


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

  /** Local rows: the caller's explicit rows (drafts) or the companion candidates. */
  const localList: LocalFileRow[] = localRows
    ? localRows
    : slot
      ? slot.candidates.map((candidate) => ({
          key: candidate.path,
          quant: candidate.precision,
          size: candidate.size_str,
          name: candidate.label,
          active: activePath === candidate.path,
          onPick: () => {
            if (role) {
              activePath === candidate.path
                ? onDetach(role)
                : onAttach(role, candidate.path);
            }
          },
        }))
      : [];

  // No cap: the column scrolls, so a big library is never truncated into a "show more".
  const remoteList: LocalFileRow[] = remoteRows
    ? remoteRows
    : (repoItems ?? []).map((item) => ({
        key: item.path_in_repo,
        quant: item.precision || "file",
        size: item.size_str,
        name: item.file_name,
        onPick: () => void download(item),
      }));

  return (
    <div className="gp-scrim" onClick={onClose}>
      <div className="gp-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${title} picker`}>
        <div className="gp-panel__head">
          <span className="gp-panel__title font-mono">{title}</span>
          <span className="gp-panel__count font-mono">
            {localList.length} local · {role ? remoteList.length : 0} remote
          </span>
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
              AUTO
            </button>
          ) : null}
          <button
            type="button"
            className="gp-panel__x font-mono"
            onClick={onClose}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="gp-panel__cols">
          <div className="gp-col">
            <span className="gp-col__label font-mono">LOCAL {localList.length || ""}</span>
            <div className="gp-col__rows">
              {localList.map((row) => (
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
              {localList.length === 0 ? (
                <span className="gp-empty font-mono">nothing on disk</span>
              ) : null}
            </div>
          </div>

          <div className="gp-col">
            <span className="gp-col__label font-mono">REMOTE {remoteList.length || ""}</span>
            <div className="gp-col__rows">
              {remoteLoading ? (
                <span className="gp-empty font-mono">reading the Hub tree…</span>
              ) : null}
              {!remoteLoading && remoteList.length === 0 ? (
                <span className="gp-empty font-mono">
                  {cooldownMs > 0
                    ? `Hub quota reached — retry in ${Math.ceil(cooldownMs / 60000)} min`
                    : remoteRequested
                      ? "nothing found on the Hub"
                      : "not searched yet"}
                </span>
              ) : (
                remoteList.map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    className="gp-row gp-row--repo"
                    onClick={row.onPick}
                    disabled={row.disabled}
                    title={row.name}
                  >
                    <span className="gp-row__dot" aria-hidden />
                    <span className="gp-row__quant font-mono">{row.quant}</span>
                    <span className="gp-row__size font-mono">{row.size}</span>
                    <span className="gp-row__name font-mono">{row.name}</span>
                    <span className="gp-row__tag font-mono">GET</span>
                  </button>
                ))
              )}

            </div>
            <button
              type="button"
              className="gp-search font-mono"
              onClick={() => {
                setRemoteRequested(true);
                loadRemote();
              }}
              disabled={remoteLoading}
              title="Ask the Hub for this repo's files — nothing is requested until you click"
            >
              {remoteLoading
                ? "SEARCHING…"
                : remoteRequested
                  ? "SEARCH AGAIN"
                  : "SEARCH HF"}
            </button>
          </div>
        </div>

        {hfInput ? (
          <div className="gp-panel__hf">
            <span className="gp-col__label font-mono">HF ID</span>
            <input
              className="gp-hf__input font-mono"
              value={hfValue}
              placeholder={hfInput.placeholder}
              onChange={(e) => setHfValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && hfValue.trim()) hfInput.onSubmit(hfValue.trim());
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
            {hfInput.error ? (
              <span className="gp-empty font-mono">{hfInput.error}</span>
            ) : null}
          </div>
        ) : null}

        {/* Keeps the content in the opaque part; the rail shows through the fade below. */}
        <div className="gp-fade" aria-hidden />


      </div>
    </div>
  );
}
