/**
 * LOADOUT picker — variant B: one surface, three slots.
 *
 * Left column lists what the rail configures (SPEC · MMPROJ · ENGRAM) with the value
 * each is currently on; the right pane is the table for the selected slot. That is the
 * separation of concerns the rail promises: pick SPEC first, attach SWAPS only if the
 * model needs them.
 *
 * Every attachment row leads with QUANT and SIZE — that is the choice being made — and
 * the file name is the secondary column. SPEC is a mode list rather than a file list, so
 * its rows carry the mode, and the draft file itself still opens in the existing draft
 * picker (retained, not rebuilt).
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CompanionRole, CompanionSlot, RepoCompanion } from "../lib/types";

export type PickSlotId = "spec" | CompanionRole;

export interface SpecPickRow {
  id: string;
  label: string;
  aboveLabel?: string;
  blurb?: string;
  disabled?: boolean;
}

export interface SlotSummary {
  value: string;
  state: string;
}

interface LoadoutPickerProps {
  initialSlot: PickSlotId;
  summaries: Record<PickSlotId, SlotSummary>;
  specValue: string;
  specRows: SpecPickRow[];
  onSpecPick: (id: string) => void;
  onChangeSpecDraft?: () => void;
  mmproj: CompanionSlot;
  engram: CompanionSlot;
  modelPath: string;
  onAttach: (role: CompanionRole, path: string) => void;
  onDetach: (role: CompanionRole) => void;
  onClear: (role: CompanionRole) => void;
  onDownloaded: () => void;
  onClose: () => void;
}

const SLOT_ORDER: PickSlotId[] = ["spec", "mmproj", "engram"];

const SLOT_LABEL: Record<PickSlotId, string> = {
  spec: "SPEC",
  mmproj: "MMPROJ",
  engram: "ENGRAM",
};

export default function LoadoutPicker({
  initialSlot,
  summaries,
  specValue,
  specRows,
  onSpecPick,
  onChangeSpecDraft,
  mmproj,
  engram,
  modelPath,
  onAttach,
  onDetach,
  onClear,
  onDownloaded,
  onClose,
}: LoadoutPickerProps) {
  const [slot, setSlot] = useState<PickSlotId>(initialSlot);
  const [repoItems, setRepoItems] = useState<RepoCompanion[] | null>(null);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const role: CompanionRole | null = slot === "spec" ? null : slot;
  const companion = role === "mmproj" ? mmproj : role === "engram" ? engram : null;

  useEffect(() => {
    if (!role) return;
    let alive = true;
    setRepoItems(null);
    setRepoError(null);
    invoke<RepoCompanion[]>("repo_companions", { modelPath, role })
      .then((items) => {
        if (alive) setRepoItems(items);
      })
      .catch((err) => {
        if (alive) setRepoError(typeof err === "string" ? err : "repo lookup failed");
      });
    return () => {
      alive = false;
    };
  }, [modelPath, role]);

  const download = async (item: RepoCompanion) => {
    if (!role) return;
    setDownloading(item.path_in_repo);
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
      setRepoError(typeof err === "string" ? err : "download failed");
    } finally {
      setDownloading(null);
    }
  };

  const activePath = companion
    ? companion.pinned ?? (companion.confidence === "strong" ? companion.auto?.path : undefined)
    : undefined;

  return (
    <div className="loadout-picker loadout-picker--unified" role="dialog" aria-label="LOADOUT picker">
      <div className="loadout-picker__slots">
        {SLOT_ORDER.map((id) => {
          const summary = summaries[id];
          return (
            <button
              key={id}
              type="button"
              className={`loadout-slot${slot === id ? " loadout-slot--on" : ""}`}
              onClick={() => setSlot(id)}
              aria-pressed={slot === id}
            >
              <span className="loadout-slot__role type-micro font-mono">{SLOT_LABEL[id]}</span>
              <span className="loadout-slot__value type-tiny font-mono">{summary.value}</span>
              <span className="loadout-slot__state type-hairline font-mono">{summary.state}</span>
            </button>
          );
        })}
        <button
          type="button"
          className="loadout-picker__btn loadout-picker__x type-micro font-mono"
          onClick={onClose}
          title="Close"
        >
          ✕
        </button>
      </div>

      <div className="loadout-picker__pane">
        {role === null ? (
          <>
            <div className="loadout-table loadout-table--spec" role="list">
              {specRows.map((row) => {
                const current = row.id === specValue;
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="listitem"
                    className={`loadout-table__row${current ? " loadout-table__row--on" : ""}`}
                    onClick={() => onSpecPick(row.id)}
                    disabled={row.disabled}
                    title={row.blurb}
                  >
                    <span className="loadout-table__quant font-mono">
                      {row.aboveLabel ?? "—"}
                    </span>
                    <span className="loadout-table__size font-mono">
                      {row.disabled ? "N/A" : "—"}
                    </span>
                    <span className="loadout-table__name font-mono">
                      <span className="loadout-table__src">SPEC</span>
                      {row.label}
                    </span>
                    <span className="loadout-table__act font-mono">
                      {current ? "ACTIVE" : row.disabled ? "LOCKED" : "PICK"}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="loadout-picker__foot">
              {onChangeSpecDraft ? (
                <button
                  type="button"
                  className="loadout-picker__btn type-micro font-mono"
                  onClick={onChangeSpecDraft}
                >
                  CHANGE DRAFT…
                </button>
              ) : null}
            </div>
          </>
        ) : companion ? (
          <>
            <div className="loadout-table" role="list">
              {companion.candidates.map((candidate) => {
                const active = activePath === candidate.path;
                return (
                  <button
                    key={candidate.path}
                    type="button"
                    role="listitem"
                    className={`loadout-table__row${active ? " loadout-table__row--on" : ""}`}
                    onClick={() => onAttach(role, candidate.path)}
                    title={candidate.reason || candidate.path}
                  >
                    <span className="loadout-table__quant font-mono">{candidate.precision}</span>
                    <span className="loadout-table__size font-mono">{candidate.size_str}</span>
                    <span className="loadout-table__name font-mono">
                      <span className="loadout-table__src">LOCAL</span>
                      {candidate.label}
                    </span>
                    <span className="loadout-table__act font-mono">
                      {active ? "ACTIVE" : candidate.score >= 100 ? "USE" : `SCORE ${candidate.score}`}
                    </span>
                  </button>
                );
              })}

              {repoError ? (
                <p className="loadout-picker__empty type-tiny font-mono">{repoError}</p>
              ) : repoItems === null ? (
                <p className="loadout-picker__empty type-tiny font-mono">reading the Hub tree…</p>
              ) : (
                repoItems.map((item) => (
                  <button
                    key={item.path_in_repo}
                    type="button"
                    role="listitem"
                    className="loadout-table__row"
                    onClick={() => void download(item)}
                    disabled={downloading === item.path_in_repo}
                    title={item.path_in_repo}
                  >
                    <span className="loadout-table__quant font-mono">{item.precision || "file"}</span>
                    <span className="loadout-table__size font-mono">{item.size_str}</span>
                    <span className="loadout-table__name font-mono">
                      <span className="loadout-table__src loadout-table__src--repo">REPO</span>
                      {item.file_name}
                    </span>
                    <span className="loadout-table__act font-mono">
                      {downloading === item.path_in_repo ? "QUEUED" : "GET"}
                    </span>
                  </button>
                ))
              )}

              {companion.candidates.length === 0 && (repoItems?.length ?? 0) === 0 && !repoError ? (
                <p className="loadout-picker__empty type-tiny font-mono">
                  Nothing on disk and the repo publishes no {SLOT_LABEL[slot].toLowerCase()} of its own.
                </p>
              ) : null}
            </div>
            <div className="loadout-picker__foot">
              <button
                type="button"
                className="loadout-picker__btn type-micro font-mono"
                onClick={() => onDetach(role)}
              >
                DETACH
              </button>
              <button
                type="button"
                className="loadout-picker__btn type-micro font-mono"
                onClick={() => onClear(role)}
              >
                RESET TO AUTO
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
