import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CompanionCandidate, CompanionReport, CompanionRole, CompanionSlot } from "../lib/types";
import LoadoutPicker, { type PickSlotId, type SpecPickRow } from "./LoadoutPicker";

/**
 * LOADOUT — one rail, two groups.
 *
 * SPEC is the Boost slider (passed in whole). SWAPS is the same slider grammar used
 * twice: a continuous track, one thumb per role stopping at MMPROJ / ENGRAM, the role
 * word above it, the attached precision below it and the state under that. Both halves
 * are functionally independent — the rail only makes them look like one control.
 */
interface LoadoutRailProps {
  modelPath?: string | null;
  /** SPEC group — the Boost slider rendered inside the rail. */
  specSlot?: ReactNode;
  /** Current SPEC stop id, so the picker can show and change it. */
  specValue?: string;
  /** SPEC marks, mirrored into the picker's table. */
  specRows?: SpecPickRow[];
  onSpecPick?: (id: string) => void;
  /** Opens the retained draft picker for the active spec lane. */
  onChangeSpecDraft?: () => void;
}

const ROLE_LABEL: Record<CompanionRole, string> = {
  mmproj: "MMPROJ",
  engram: "ENGRAM",
};

interface StopState {
  value: string;
  state: string;
  tone: string;
}

function stopState(slot: CompanionSlot): StopState {
  const precisionOf = (path?: string) =>
    slot.candidates.find((c) => c.path === path)?.precision ?? "—";
  if (slot.pinned_off) return { value: "—", state: "OFF", tone: "off" };
  if (slot.pinned) {
    return { value: precisionOf(slot.pinned), state: "PINNED", tone: "pinned" };
  }
  if (slot.integrated) {
    const table = slot.candidates.find((c) => c.score >= 100);
    return { value: table?.precision ?? "built-in", state: "INTEGRATED", tone: "integrated" };
  }
  if (slot.auto && slot.confidence === "strong") {
    return { value: slot.auto.precision, state: "AUTO", tone: "auto" };
  }
  if (slot.candidates.length > 0) {
    return { value: "—", state: `PICK · ${slot.candidates.length}`, tone: "pick" };
  }
  return { value: "—", state: "EMPTY", tone: "empty" };
}

export default function LoadoutRail({
  modelPath,
  specSlot,
  specValue,
  specRows,
  onSpecPick,
  onChangeSpecDraft,
}: LoadoutRailProps) {
  const [report, setReport] = useState<CompanionReport | null>(null);
  const [openSlot, setOpenSlot] = useState<PickSlotId | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!modelPath) {
      setReport(null);
      return;
    }
    try {
      setReport(await invoke<CompanionReport>("resolve_companions", { modelPath }));
    } catch {
      setReport(null);
    }
  }, [modelPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const attach = useCallback(
    async (role: CompanionRole, path: string | null) => {
      if (!modelPath) return;
      setBusy(true);
      try {
        await invoke("set_companion_pin", { modelPath, role, path });
        await load();
      } finally {
        setBusy(false);
        setOpenSlot(null);
      }
    },
    [modelPath, load],
  );

  const clear = useCallback(
    async (role: CompanionRole) => {
      if (!modelPath) return;
      setBusy(true);
      try {
        await invoke("clear_companion_pin", { modelPath, role });
        await load();
      } finally {
        setBusy(false);
        setOpenSlot(null);
      }
    },
    [modelPath, load],
  );

  const slots = useMemo(
    () => (report ? ([report.mmproj, report.engram] as CompanionSlot[]) : []),
    [report],
  );

  /** What the picker shows in its slot list — one line per configurable thing. */
  const summaries = useMemo(() => {
    const specRow = specRows?.find((row) => row.id === specValue);
    const mm = report ? stopState(report.mmproj) : { value: "—", state: "—" };
    const en = report ? stopState(report.engram) : { value: "—", state: "—" };
    return {
      spec: {
        value: specRow?.aboveLabel ?? specRow?.label ?? "—",
        state: specRow?.label ?? "—",
      },
      mmproj: { value: mm.value, state: mm.state },
      engram: { value: en.value, state: en.state },
    };
  }, [report, specRows, specValue]);

  if (!modelPath) return null;

  return (
    <div className="loadout-rail" data-busy={busy ? "1" : undefined}>
      <div className="loadout-rail__group loadout-rail__group--spec">
        <button
          type="button"
          className="loadout-rail__zone loadout-rail__zone--btn font-mono"
          onClick={() => setOpenSlot("spec")}
          title="Open the SPEC picker"
        >
          SPEC
        </button>
        <div className="loadout-rail__spec">{specSlot}</div>
      </div>

      <span className="loadout-rail__bridge" aria-hidden="true" />

      <div className="loadout-rail__group loadout-rail__group--swaps">
        <span className="loadout-rail__zone font-mono">SWAPS</span>
        <div className="loadout-swaps">
          <div className="cockpit-slider-track loadout-swaps__line" aria-hidden="true" />
          {slots.map((slot, i) => (
            <CompanionStop
              key={slot.role}
              slot={slot}
              leftPct={slots.length > 1 ? 26 + i * 48 : 50}
              disabled={busy}
              onOpen={() => setOpenSlot(slot.role)}
              onCycle={(candidate) => void attach(slot.role, candidate.path)}
            />
          ))}
        </div>
      </div>

      {openSlot && report ? (
        <LoadoutPicker
          initialSlot={openSlot}
          summaries={summaries}
          specValue={specValue ?? ""}
          specRows={specRows ?? []}
          onSpecPick={(id) => {
            onSpecPick?.(id);
            setOpenSlot(null);
          }}
          onChangeSpecDraft={
            onChangeSpecDraft
              ? () => {
                  onChangeSpecDraft();
                  setOpenSlot(null);
                }
              : undefined
          }
          mmproj={report.mmproj}
          engram={report.engram}
          modelPath={modelPath}
          onAttach={(role, path) => void attach(role, path)}
          onDetach={(role) => void attach(role, null)}
          onClear={(role) => void clear(role)}
          onDownloaded={() => {
            void load();
            setOpenSlot(null);
          }}
          onClose={() => setOpenSlot(null)}
        />
      ) : null}
    </div>
  );
}

interface CompanionStopProps {
  slot: CompanionSlot;
  leftPct: number;
  disabled: boolean;
  onOpen: () => void;
  onCycle: (candidate: CompanionCandidate) => void;
}

function CompanionStop({ slot, leftPct, disabled, onOpen, onCycle }: CompanionStopProps) {
  const state = stopState(slot);
  const ref = useRef<HTMLButtonElement | null>(null);

  // Wheel must not scroll the cockpit — non-passive listener so the cycle can
  // preventDefault. Only files already trusted enough to be candidates are cycled.
  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      if (slot.candidates.length === 0) return;
      e.preventDefault();
      const current = slot.pinned ?? slot.auto?.path;
      const idx = slot.candidates.findIndex((c) => c.path === current);
      const next =
        slot.candidates[(idx + (e.deltaY > 0 ? 1 : -1) + slot.candidates.length) % slot.candidates.length];
      if (next) onCycle(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [slot, disabled, onCycle]);

  const active = state.tone !== "empty" && state.tone !== "off";

  return (
    <button
      ref={ref}
      type="button"
      className={`loadout-stop loadout-stop--${state.tone}${active ? " loadout-stop--active" : ""} loadout-stop--role-${slot.role}`}
      style={{ left: `${leftPct}%` }}
      onClick={onOpen}
      disabled={disabled}
      title={slot.reason || state.state}
      aria-label={`${ROLE_LABEL[slot.role]}: ${state.state}, ${state.value}`}
    >
      <span className="loadout-stop__role font-mono">{ROLE_LABEL[slot.role]}</span>
      <span className="cockpit-slider-thumb loadout-stop__thumb" aria-hidden="true" />
      <span className="loadout-stop__value font-mono">{state.value}</span>
      <span className="loadout-stop__state font-mono">
        {state.state}
        {slot.candidates.length > 1 ? ` · ${slot.candidates.length}` : ""}
      </span>
    </button>
  );
}
