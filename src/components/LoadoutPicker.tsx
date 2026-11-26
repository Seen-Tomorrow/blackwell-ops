/**
 * LOADOUT picker — full-width LOCAL / REMOTE toggle overlay in the SWAPS half.
 *
 * Switching between LOCAL and REMOTE gives the file table the full panel width so
 * filenames, precision, size, and source/status tags are never squeezed into half-columns.
 * Nothing touches Hugging Face automatically; every remote request is an explicit click.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cachedInvoke, hfCooldownMs, noteHfError } from "../lib/hfCache";
import type { CompanionCandidate, CompanionRole, CompanionSlot, RepoCompanion } from "../lib/types";

export interface LocalFileRow {
  key: string;
  quant: string;
  size: string;
  name: string;
  active?: boolean;
  disabled?: boolean;
  /** Optional kind/source chip (DFLASH / DSPARK / MTP / SAME DIR / INTEGRATED / EXTRAS). */
  tag?: string;
  /** Tooltip detail (full path, match reason, etc.). */
  title?: string;
  onPick: () => void;
}

interface LoadoutPickerProps {
  title: string;
  role: CompanionRole | null;
  slot: CompanionSlot | null;
  localRows?: LocalFileRow[];

  modelPath: string;
  /** The model's own Hub repo id, so the DRAFT lane can list its repo like the Hub does. */
  modelHubId?: string;
  /** Which head kind the current SPEC lane accepts (mtp / dflash / dspark). */
  laneKind?: "mtp" | "dflash" | "dspark" | "eagle3" | null;
  /** A listed draft head the user picked: download + pin it. */
  onPickDraftFile?: (item: RepoCompanion) => void;
  onAttach: (role: CompanionRole, path: string) => void;
  onClear: (role: CompanionRole) => void;
  onDownloaded: () => void;

  onClose: () => void;
}

type PickerTab = "local" | "remote";

function pathsEqual(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function candidateSourceTag(
  candidate: CompanionCandidate,
  slot: CompanionSlot,
  isDefaultAuto: boolean,
): string {
  if (slot.role === "engram" && slot.integrated && isDefaultAuto) return "INTEGRATED";
  if (candidate.source === "folder") return "SAME DIR";
  if (candidate.source === "extras") return "EXTRAS";
  if (candidate.source === "library") return "LIBRARY";
  return candidate.source.toUpperCase();
}

export default function LoadoutPicker({
  title,
  role,
  slot,
  localRows,
  modelPath,
  modelHubId,
  laneKind,
  onPickDraftFile,
  onAttach,
  onClear,
  onDownloaded,
  onClose,
}: LoadoutPickerProps) {
  const initialLocalCount = localRows ? localRows.length : (slot?.candidates.length ?? 0);
  const [tab, setTab] = useState<PickerTab>(initialLocalCount > 0 ? "local" : "remote");

  const [repoItems, setRepoItems] = useState<RepoCompanion[] | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteRequested, setRemoteRequested] = useState(false);
  const [hfRepoRows, setHfRepoRows] = useState<LocalFileRow[] | null>(null);
  const [hfRepoBusy, setHfRepoBusy] = useState(false);
  const [hfRepoError, setHfRepoError] = useState<string | null>(null);
  const [hiddenHeads, setHiddenHeads] = useState<string[]>([]);
  const [hunting, setHunting] = useState(false);
  const [huntNote, setHuntNote] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [hfValue, setHfValue] = useState("");
  const [cooldownMs, setCooldownMs] = useState(() => hfCooldownMs());

  useEffect(() => {
    const tick = () => setCooldownMs(hfCooldownMs());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Head kind read from the file's own name. */
  const headKindOf = (name: string): "mtp" | "dflash" | "dspark" | "eagle3" | "other" => {
    if (/dspark/i.test(name)) return "dspark";
    if (/dflash/i.test(name)) return "dflash";
    if (/eagle/i.test(name)) return "eagle3";
    if (/mtp/i.test(name)) return "mtp";
    return "other";
  };

  /** Heads this lane can actually use. DSpark pairs through the DFlash slot. */
  const acceptsKind = useCallback(
    (kind: ReturnType<typeof headKindOf>): boolean => {
      if (!laneKind || kind === "other") return true;
      if (laneKind === "mtp") return kind === "mtp";
      if (laneKind === "dspark") return kind === "dspark" || kind === "dflash";
      return kind === "dflash" || kind === "dspark";
    },
    [laneKind],
  );

  const downloadRow = useCallback(
    async (item: RepoCompanion) => {
      if (!role) return;
      const key = `${item.repo_id}/${item.path_in_repo}`;
      setBusyKey(key);
      setHfRepoError(null);
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
      } catch (err) {
        setHfRepoError(typeof err === "string" ? err : "Could not start download");
      } finally {
        setBusyKey(null);
      }
    },
    [modelPath, role, onDownloaded],
  );

  /**
   * Bounded HF-wide search for a repo that carries a compatible draft head: one search,
   * a deterministic name filter, then at most three repo tree lookups.
   */
  const huntHead = useCallback(async () => {
    if (!modelHubId && !modelPath) return;
    const cool = hfCooldownMs();
    if (cool > 0) {
      setHuntNote(`Hub quota reached — retry in ${Math.ceil(cool / 60000)} min`);
      return;
    }
    setHunting(true);
    setHuntNote(null);
    setHfRepoError(null);
    setHiddenHeads([]);
    try {
      const report = await invoke<{
        repoId: string;
        searched: number;
        rejected: string[];
        rows: RepoCompanion[];
      }>("find_head_for_model", { modelPath, lane: laneKind ?? "dflash" });
      if (!report.rows.length) {
        setHfRepoRows([]);
        setHuntNote(
          `No repo among ${report.searched} name match(es) carries a usable head${
            report.rejected.length ? ` (checked ${report.rejected.length})` : ""
          }`,
        );
      } else {
        setHfRepoRows(
          report.rows.map((item) => ({
            key: `${item.repo_id}/${item.path_in_repo}`,
            quant: item.precision || "file",
            size: item.size_str,
            name: `${item.file_name} · ${item.repo_id}`,
            title: `${item.repo_id}/${item.path_in_repo}`,
            onPick: () => {
              if (role) void downloadRow(item);
              else onPickDraftFile?.(item);
            },
          })),
        );
        setHuntNote(
          `Found in ${report.repoId}${
            report.rejected.length
              ? ` · ${report.rejected.length} other repo(s) held no usable head`
              : ""
          }`,
        );
      }
      setRemoteRequested(true);
    } catch (err) {
      noteHfError(err);
      setHuntNote(typeof err === "string" ? err : "Head search failed");
    } finally {
      setHunting(false);
    }
  }, [modelHubId, modelPath, laneKind, role, onPickDraftFile, downloadRow]);

  /** List a specific HF repo's files for this role — nothing downloads until a row is clicked. */
  const submitHfRepo = useCallback(
    async (modelId: string) => {
      const cool = hfCooldownMs();
      if (cool > 0) {
        setHfRepoError(`Hub quota reached — retry in ${Math.ceil(cool / 60000)} min`);
        return;
      }
      setHfRepoBusy(true);
      setHfRepoError(null);
      setHuntNote(null);
      try {
        const items = role
          ? await invoke<RepoCompanion[]>("repo_companions_for", { modelId, role })
          : await invoke<RepoCompanion[]>("repo_draft_files", { modelId });
        const usable = items.filter(
          (item) => role != null || acceptsKind(headKindOf(item.file_name)),
        );
        setHiddenHeads(
          items.length - usable.length > 0
            ? [
                ...new Set(
                  items
                    .filter((i2) => !usable.includes(i2))
                    .map((i2) => headKindOf(i2.file_name).toUpperCase()),
                ),
              ]
            : [],
        );
        setHfRepoRows(
          usable.map((item) => ({
            key: `${item.repo_id}/${item.path_in_repo}`,
            quant: item.precision || "file",
            size: item.size_str,
            name: item.file_name,
            title: `${item.repo_id}/${item.path_in_repo}`,
            onPick: () => {
              if (role) void downloadRow(item);
              else onPickDraftFile?.(item);
            },
          })),
        );
        setRemoteRequested(true);
      } catch (err) {
        noteHfError(err);
        setHfRepoError(typeof err === "string" ? err : "Could not read that repo");
      } finally {
        setHfRepoBusy(false);
      }
    },
    [role, acceptsKind, onPickDraftFile, downloadRow],
  );

  /** Check this model's own HF repo for matching files. */
  const checkModelRepo = useCallback(() => {
    if (hfCooldownMs() > 0) return;
    setHuntNote(null);
    setHfRepoError(null);
    if (!role) {
      if (modelHubId) {
        setRemoteRequested(true);
        void submitHfRepo(modelHubId);
        return;
      }
      setRemoteRequested(true);
      setHfRepoError(
        "This model has no Hub id. Paste a repo under HF ID below, or run VERIFY HUB PAIRINGS in CONFIG → MODEL PATHS.",
      );
      return;
    }
    setRemoteRequested(true);
    setRemoteLoading(true);
    setHfRepoRows(null);
    cachedInvoke<RepoCompanion[]>("repo_companions", { modelPath, role })
      .then((items) => setRepoItems(items))
      .catch((err) => {
        noteHfError(err);
        setHfRepoError(typeof err === "string" ? err : "Could not read this model's repo");
        setRepoItems([]);
      })
      .finally(() => setRemoteLoading(false));
  }, [modelPath, modelHubId, role, submitHfRepo]);

  const defaultAutoPath =
    slot && (slot.integrated || slot.confidence === "strong") ? slot.auto?.path : undefined;

  const activePath = slot?.pinned ?? defaultAutoPath;
  const isOverridden = Boolean(slot?.pinned);

  /** Local rows: explicit caller rows (drafts) or companion candidates. */
  const localList: LocalFileRow[] = localRows
    ? localRows
    : slot
      ? slot.candidates.map((candidate) => {
          const isDefaultAuto = pathsEqual(defaultAutoPath, candidate.path);
          const isActive = pathsEqual(activePath, candidate.path);
          const isPinnedHere = pathsEqual(slot.pinned, candidate.path);
          const sourceTag = candidateSourceTag(candidate, slot, isDefaultAuto);
          const tag = isPinnedHere
            ? `${sourceTag} · PINNED`
            : isActive && isDefaultAuto && !slot.integrated
              ? `${sourceTag} · AUTO`
              : sourceTag;
          return {
            key: candidate.path,
            quant: candidate.precision,
            size: candidate.size_str,
            name: candidate.label,
            active: isActive,
            tag,
            title: candidate.reason
              ? `${candidate.path}\n${candidate.reason}`
              : candidate.path,
            onPick: () => {
              if (!role) return;
              if (isDefaultAuto) {
                if (isOverridden) {
                  // Clicking the default companion when overridden reverts to AUTO.
                  onClear(role);
                }
              } else if (!isPinnedHere) {
                onAttach(role, candidate.path);
              }
            },
          };
        })
      : [];

  const remoteList: LocalFileRow[] =
    hfRepoRows ??
    (repoItems ?? []).map((item) => {
      const key = `${item.repo_id}/${item.path_in_repo}`;
      return {
        key,
        quant: item.precision || "file",
        size: item.size_str,
        name: item.file_name,
        title: `${item.repo_id}/${item.path_in_repo}`,
        onPick: () => void downloadRow(item),
      };
    });

  const anyRemoteBusy = remoteLoading || hunting || hfRepoBusy;
  const laneLabel = laneKind ? laneKind.toUpperCase() : "draft";

  return (
    <div className="gp-scrim" onClick={onClose}>
      <div
        className="gp-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`${title} picker`}
      >
        <div className="gp-panel__head">
          <span className="gp-panel__title font-mono">{title}</span>

          <div className="gp-tabs" role="tablist" aria-label={`${title} source`}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "local"}
              className={`gp-tab font-mono${tab === "local" ? " gp-tab--active" : ""}`}
              onClick={() => setTab("local")}
            >
              LOCAL {localList.length}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "remote"}
              className={`gp-tab font-mono${tab === "remote" ? " gp-tab--active" : ""}`}
              onClick={() => setTab("remote")}
            >
              REMOTE{remoteList.length > 0 ? ` ${remoteList.length}` : ""}
            </button>
          </div>

          <div className="gp-panel__actions">
            {role && isOverridden ? (
              <button
                type="button"
                className="gp-panel__btn gp-panel__btn--accent font-mono"
                onClick={() => onClear(role)}
                title="Reset to default same-folder companion (AUTO)"
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
        </div>

        {tab === "local" ? (
          <div className="gp-body">
            <div className="gp-rows">
              {localList.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  className={`gp-row${row.active ? " gp-row--on" : ""}`}
                  onClick={row.onPick}
                  disabled={row.disabled}
                  title={row.title ?? row.name}
                >
                  <span className="gp-row__dot" aria-hidden />
                  <span className="gp-row__quant font-mono">{row.quant}</span>
                  <span className="gp-row__size font-mono">{row.size}</span>
                  <span className="gp-row__name font-mono">{row.name}</span>
                  {row.tag ? <span className="gp-row__tag font-mono">{row.tag}</span> : null}
                </button>
              ))}
              {localList.length === 0 ? (
                <span className="gp-empty font-mono">
                  Nothing on disk — switch to REMOTE to browse Hugging Face.
                </span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="gp-body">
            <div className="gp-rows">
              {anyRemoteBusy ? (
                <span className="gp-empty font-mono">
                  {hunting
                    ? `Searching Hugging Face for ${laneLabel} head repos…`
                    : "Reading Hugging Face repo tree…"}
                </span>
              ) : remoteList.length > 0 ? (
                remoteList.map((row) => {
                  const downloading = busyKey === row.key;
                  return (
                    <button
                      key={row.key}
                      type="button"
                      className="gp-row gp-row--repo"
                      onClick={row.onPick}
                      disabled={row.disabled || downloading}
                      title={row.title ?? row.name}
                    >
                      <span className="gp-row__dot" aria-hidden />
                      <span className="gp-row__quant font-mono">{row.quant}</span>
                      <span className="gp-row__size font-mono">{row.size}</span>
                      <span className="gp-row__name font-mono">{row.name}</span>
                      <span className="gp-row__tag font-mono">
                        {downloading ? "SAVING…" : "GET"}
                      </span>
                    </button>
                  );
                })
              ) : (
                <span className="gp-empty font-mono">
                  {cooldownMs > 0
                    ? `Hub quota reached — retry in ${Math.ceil(cooldownMs / 60000)} min`
                    : remoteRequested
                      ? "No matching files found."
                      : "Not searched yet — nothing is requested until you click."}
                </span>
              )}
              {huntNote ? <span className="gp-empty font-mono">{huntNote}</span> : null}
              {hiddenHeads.length > 0 ? (
                <span className="gp-empty font-mono">
                  Hidden incompatible head(s): {hiddenHeads.join(", ")}
                </span>
              ) : null}
            </div>

            <div className="gp-remote-actions">
              <div className="gp-remote-action">
                <button
                  type="button"
                  className="gp-search font-mono"
                  onClick={checkModelRepo}
                  disabled={anyRemoteBusy || cooldownMs > 0 || (!role && !modelHubId)}
                  title="List files inside this model's own Hugging Face repository"
                >
                  {remoteLoading || (hfRepoBusy && !hunting)
                    ? "CHECKING…"
                    : remoteRequested && !huntNote
                      ? "RECHECK MODEL REPO"
                      : "CHECK MODEL REPO"}
                </button>
                <span className="gp-remote-action__desc font-mono">
                  {modelHubId
                    ? `List files in ${modelHubId}`
                    : role
                      ? "List files in this model's HF repo"
                      : "No Hub repo linked to this model"}
                </span>
              </div>

              {role === null ? (
                <div className="gp-remote-action">
                  <button
                    type="button"
                    className="gp-search font-mono"
                    onClick={() => void huntHead()}
                    disabled={anyRemoteBusy || cooldownMs > 0}
                    title="Search across Hugging Face for external repos carrying a compatible draft head (up to 3 repos inspected)"
                  >
                    {hunting ? "SEARCHING HF…" : "SEARCH HF FOR HEADS"}
                  </button>
                  <span className="gp-remote-action__desc font-mono">
                    Find external {laneLabel} head repos across Hugging Face
                  </span>
                </div>
              ) : null}
            </div>

            <div className="gp-panel__hf">
              <span className="gp-col__label font-mono">HF ID</span>
              <input
                className="gp-hf__input font-mono"
                value={hfValue}
                placeholder="author/model"
                onChange={(e) => setHfValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hfValue.trim() && !anyRemoteBusy) {
                    void submitHfRepo(hfValue.trim());
                  }
                }}
              />
              <button
                type="button"
                className="gp-hf__go font-mono"
                disabled={anyRemoteBusy || cooldownMs > 0 || !hfValue.trim()}
                onClick={() => void submitHfRepo(hfValue.trim())}
                title="List files from a specific Hugging Face repo"
              >
                {hfRepoBusy ? "…" : "LIST REPO"}
              </button>
              {hfRepoError ? (
                <span className="gp-hf__error font-mono">{hfRepoError}</span>
              ) : null}
            </div>
          </div>
        )}

        {/* Keeps the content in the opaque part; the rail shows through the fade below. */}
        <div className="gp-fade" aria-hidden />
      </div>
    </div>
  );
}
