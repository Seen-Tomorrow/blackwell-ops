/**
 * LOADOUT picker — a block over the 2x2 grid, not a modal.
 *
 * While you are tuning SPEC or SWAPS you do not need the sliders, so this takes the
 * grid's exact footprint instead of floating over it: three columns, one per stop, each
 * a wheel-scrollable column of candidates stacked above each other. QUANT and SIZE lead
 * every attachment row (the name is the secondary fact), and the current pick is lit.
 *
 * The surface is the cockpit's neutral `--theme-panel-accent`, never `--theme-panel`:
 * that token carries a blue cast and this block has to read as part of the same metal.
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

interface LoadoutPickerProps {
  specValue: string;
  specRows: SpecPickRow[];
  onSpecPick: (id: string) => void;
  mmproj: CompanionSlot;
  engram: CompanionSlot;
  modelPath: string;
  onAttach: (role: CompanionRole, path: string) => void;
  onDetach: (role: CompanionRole) => void;
  onClear: (role: CompanionRole) => void;
  onDownloaded: () => void;
  onClose: () => void;
}

const ROLE_LABEL: Record<CompanionRole, string> = {
  mmproj: "MMPROJ",
  engram: "ENGRAM",
};

function currentOf(slot: CompanionSlot): string {
  if (slot.pinned_off) return "OFF";
  if (slot.pinned) {
    return slot.candidates.find((c) => c.path === slot.pinned)?.precision ?? "PINNED";
  }
  if (slot.integrated) return "built-in";
  if (slot.auto && slot.confidence === "strong") return slot.auto.precision;
  return "—";
}

function AttachColumn({
  role,
  slot,
  modelPath,
  onAttach,
  onDetach,
  onClear,
  onDownloaded,
}: {
  role: CompanionRole;
  slot: CompanionSlot;
  modelPath: string;
  onAttach: (role: CompanionRole, path: string) => void;
  onDetach: (role: CompanionRole) => void;
  onClear: (role: CompanionRole) => void;
  onDownloaded: () => void;
}) {
  const [repoItems, setRepoItems] = useState<RepoCompanion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
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

  const download = async (item: RepoCompanion) => {
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

  const active = slot.pinned ?? (slot.confidence === "strong" ? slot.auto?.path : undefined);

  return (
    <div className="gp-col">
      <div className="gp-col__head">
        <span className="gp-col__role font-mono">{ROLE_LABEL[role]}</span>
        <span className="gp-col__now font-mono">{currentOf(slot)}</span>
        <button
          type="button"
          className="gp-col__auto font-mono"
          onClick={() => onClear(role)}
          title="Clear the pin and let the rail pick automatically"
        >
          AUTO
        </button>
      </div>
      <div className="gp-col__list">
        {slot.candidates.map((candidate) => (
          <button
            key={candidate.path}
            type="button"
            className={`gp-row${active === candidate.path ? " gp-row--on" : ""}`}
            onClick={() =>
              active === candidate.path ? onDetach(role) : onAttach(role, candidate.path)
            }
            title={candidate.reason || candidate.path}
          >
            <span className="gp-row__dot" aria-hidden />
            <span className="gp-row__quant font-mono">{candidate.precision}</span>
            <span className="gp-row__size font-mono">{candidate.size_str}</span>
            <span className="gp-row__name font-mono">{candidate.label}</span>
            <span className="gp-row__tag font-mono">
              {active === candidate.path ? "ACTIVE" : "LOCAL"}
            </span>
          </button>
        ))}
        {(repoItems ?? []).map((item) => (
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
              {busy === item.path_in_repo ? "QUEUED" : "REPO"}
            </span>
          </button>
        ))}
        {slot.candidates.length === 0 && (repoItems?.length ?? 0) === 0 ? (
          <span className="gp-col__empty font-mono">nothing available</span>
        ) : null}
      </div>
    </div>
  );
}

export default function LoadoutPicker({
  specValue,
  specRows,
  onSpecPick,
  mmproj,
  engram,
  modelPath,
  onAttach,
  onDetach,
  onClear,
  onDownloaded,
  onClose,
}: LoadoutPickerProps) {
  const specCurrent = specRows.find((row) => row.id === specValue);

  return (
    <div className="gp-block" role="dialog" aria-label="LOADOUT picker">
      <div className="gp-col">
        <div className="gp-col__head">
          <span className="gp-col__role font-mono">SPEC</span>
          <span className="gp-col__now font-mono">{specCurrent?.label ?? "—"}</span>
        </div>
        <div className="gp-col__list">
          {specRows.map((row) => (
            <button
              key={row.id}
              type="button"
              className={`gp-row${row.id === specValue ? " gp-row--on" : ""}`}
              onClick={() => onSpecPick(row.id)}
              disabled={row.disabled}
              title={row.blurb}
            >
              <span className="gp-row__dot" aria-hidden />
              <span className="gp-row__quant font-mono">{row.aboveLabel ?? "—"}</span>
              <span className="gp-row__size font-mono" />
              <span className="gp-row__name font-mono">{row.label}</span>
              <span className="gp-row__tag font-mono">
                {row.id === specValue ? "ACTIVE" : row.disabled ? "LOCKED" : "PICK"}
              </span>
            </button>
          ))}
        </div>
      </div>

      <AttachColumn
        role="mmproj"
        slot={mmproj}
        modelPath={modelPath}
        onAttach={onAttach}
        onDetach={onDetach}
        onClear={onClear}
        onDownloaded={onDownloaded}
      />
      <AttachColumn
        role="engram"
        slot={engram}
        modelPath={modelPath}
        onAttach={onAttach}
        onDetach={onDetach}
        onClear={onClear}
        onDownloaded={onDownloaded}
      />

      <button
        type="button"
        className="gp-block__close font-mono"
        onClick={onClose}
        title="Close (Esc)"
      >
        ✕
      </button>
    </div>
  );
}
