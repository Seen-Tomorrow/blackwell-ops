import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { CompanionCandidate, CompanionRole, CompanionReport, CompanionSlot } from "../lib/types";
import type { PickSlotId } from "./LoadoutPicker";

/**
 * LOADOUT — one rail, two groups.
 *
 * SPEC is the Boost slider (passed in whole). SWAPS is the same slider grammar used
 * twice: a continuous track, one thumb per role stopping at MMPROJ / ENGRAM, the role
 * word above it, the attached precision below it and the state under that. Both halves
 * are functionally independent — the rail only makes them look like one control.
 *
 * The companion report is owned by the cockpit (it also renders the picker block over
 * the grid), so this rail is presentational: it draws the stops and reports clicks.
 */
interface LoadoutRailProps {
  modelPath?: string | null;
  /** SPEC group — the Boost slider rendered inside the rail. */
  specSlot?: ReactNode;
  report: CompanionReport | null;
  busy?: boolean;
  /** Ask the cockpit to open its picker block on a stop (SPEC zone label or a SWAP). */
  onOpenSlot?: (slot: PickSlotId) => void;
  /** Cycle to a candidate — the only gesture a stop performs by itself. */
  onCycle?: (role: CompanionRole, candidate: CompanionCandidate) => void;
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

/** Next candidate after the current one — shared by click and wheel. */
function nextCandidate(slot: CompanionSlot): CompanionCandidate | null {
  if (slot.candidates.length === 0) return null;
  const current = slot.pinned ?? slot.auto?.path;
  const idx = slot.candidates.findIndex((c) => c.path === current);
  return slot.candidates[(idx + 1) % slot.candidates.length] ?? null;
}

export default function LoadoutRail({
  specSlot,
  report,
  busy = false,
  onOpenSlot,
  onCycle,
}: LoadoutRailProps) {
  const slots = report ? [report.mmproj, report.engram] : [];

  return (
    <div className="loadout-rail" data-busy={busy ? "1" : undefined}>
      <div className="loadout-rail__group loadout-rail__group--spec">
        <button
          type="button"
          className="loadout-rail__zone loadout-rail__zone--btn font-mono"
          onClick={() => onOpenSlot?.("spec")}
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
              onOpen={() => onOpenSlot?.(slot.role)}
              onCycle={(candidate) => onCycle?.(slot.role, candidate)}
            />
          ))}
        </div>
      </div>
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
  const active = slot.pinned != null || (slot.auto != null && slot.confidence === "strong");
  const ref = useRef<HTMLButtonElement | null>(null);

  // Wheel must not scroll the cockpit — non-passive listener so the cycle can
  // preventDefault. Only files already trusted enough to be candidates are cycled.
  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return;
    const onWheel = (e: WheelEvent) => {
      const next = nextCandidate(slot);
      if (!next) return;
      e.preventDefault();
      onCycle(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [slot, disabled, onCycle]);

  return (
    <button
      ref={ref}
      type="button"
      className={`loadout-stop loadout-stop--${state.tone}${active ? " loadout-stop--active" : ""} loadout-stop--role-${slot.role}`}
      style={{ left: `${leftPct}%` }}
      onClick={onOpen}
      disabled={disabled}
      title={slot.reason || `${state.state} — click to open the picker, wheel to cycle`}
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
