import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { CompanionCandidate, CompanionReport, CompanionRole, CompanionSlot } from "../lib/types";

/**
 * LOADOUT — the mode rail and the file row it feeds.
 *
 * Two concerns, two controls:
 *
 *  - SPEC is the MODE control (the Boost slider, passed in whole). Clicking a stop
 *    changes the mode and nothing else.
 *  - The file row is a multi-purpose row of SLOTS, one per extra file a mode can load:
 *    DRAFT today, MMPROJ and ENGRAM from the companion report. Every slot renders from
 *    the same data — role, badge line, thumb, filled value plate, state — so wiring a
 *    fourth file kind is an entry in `slots`, not another hand-matched widget.
 *
 * Slots are evenly spaced and each one owns its ⊕ external badge, so the row speaks one
 * language regardless of how many kinds end up in it.
 */
export interface LoadoutFileSlot {
  id: string;
  /** Role word above the thumb: DRAFT / MMPROJ / ENGRAM. */
  role: string;
  /** Value in the plate under the thumb (precision, "built-in", "—"). */
  value: string;
  /** State under the plate: LOADED / MISSING / PINNED / AUTO / EMPTY. */
  state: string;
  /** Plate tint; unknown ids stay monochrome. */
  tone: "draft" | "mmproj" | "engram" | "neutral";
  active: boolean;
  /** Number of files behind the slot, shown after the state when > 1. */
  count: number;
  /** Opens the picker for this slot. */
  onOpen: () => void;
  /** Wheel cycles the slot's candidates; absent means the slot has none to cycle. */
  onCycle?: () => void;
}

interface LoadoutRailProps {
  /** SPEC group — the Boost slider rendered inside the rail. */
  specSlot?: ReactNode;
  /** File slots, in display order. */
  slots?: LoadoutFileSlot[];
  busy?: boolean;
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

function pathsEqual(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function stopState(slot: CompanionSlot): StopState {
  const precisionOf = (path?: string) =>
    slot.candidates.find((c) => pathsEqual(c.path, path))?.precision ?? "—";
  if (slot.pinned) {
    return { value: precisionOf(slot.pinned), state: "PINNED", tone: "pinned" };
  }
  if (slot.integrated) {
    const table = slot.candidates.find((c) => c.score >= 100) ?? slot.auto;
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

function nextCandidate(slot: CompanionSlot): CompanionCandidate | null {
  if (slot.candidates.length === 0) return null;
  const current = slot.pinned ?? slot.auto?.path;
  const idx = slot.candidates.findIndex((c) => pathsEqual(c.path, current));
  return slot.candidates[(idx + 1) % slot.candidates.length] ?? null;
}

/** Build the file slots from the companion report plus the caller's extra slots. */
export function companionSlots(
  report: CompanionReport | null,
  open: (role: CompanionRole) => void,
  cycle: (role: CompanionRole, candidate: CompanionCandidate, isDefaultAuto: boolean) => void,
): LoadoutFileSlot[] {
  if (!report) return [];
  return ([report.mmproj, report.engram] as CompanionSlot[]).map((slot) => {
    const state = stopState(slot);
    const active =
      slot.pinned != null || slot.integrated || (slot.auto != null && slot.confidence === "strong");
    const defaultAutoPath =
      slot.integrated || slot.confidence === "strong" ? slot.auto?.path : undefined;
    return {
      id: slot.role,
      role: ROLE_LABEL[slot.role],
      value: state.value,
      state: state.state,
      tone: slot.role,
      active,
      count: slot.candidates.length,
      onOpen: () => open(slot.role),
      onCycle:
        slot.candidates.length > 1
          ? () => {
              const next = nextCandidate(slot);
              if (next) cycle(slot.role, next, pathsEqual(next.path, defaultAutoPath));
            }
          : undefined,
    };
  });
}

export default function LoadoutRail({
  specSlot,
  slots = [],
  busy = false,
}: LoadoutRailProps) {
  return (
    <div className="loadout-rail" data-busy={busy ? "1" : undefined}>
      <div className="loadout-rail__group loadout-rail__group--spec">
        <div className="loadout-rail__zone-row">
          <span className="loadout-rail__zone font-mono">SPEC</span>
        </div>
        <div className="loadout-rail__band">
          <div className="loadout-rail__spec">{specSlot}</div>
        </div>
      </div>

      <span className="loadout-rail__bridge" aria-hidden="true" />

      <div className="loadout-rail__group loadout-rail__group--swaps">
        <span className="loadout-rail__zone font-mono">SWAPS</span>
        <div className="loadout-rail__band loadout-files">
          <div className="cockpit-slider-track loadout-files__line" aria-hidden="true" />
          {slots.map((slot, i) => (
            <FileStop
              key={slot.id}
              slot={slot}
              leftPct={((i + 0.5) / Math.max(1, slots.length)) * 100}
              disabled={busy}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function FileStop({
  slot,
  leftPct,
  disabled,
}: {
  slot: LoadoutFileSlot;
  leftPct: number;
  disabled: boolean;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);

  // Wheel must not scroll the cockpit — non-passive listener so cycling can prevent it.
  useEffect(() => {
    const el = ref.current;
    if (!el || disabled || !slot.onCycle) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      slot.onCycle?.();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [slot, disabled]);

  return (
    <button
      ref={ref}
      type="button"
      className={`loadout-stop loadout-stop--tone-${slot.tone}${
        slot.active ? " loadout-stop--active" : ""
      }`}
      style={{ left: `${leftPct}%` }}
      onClick={() => slot.onOpen()}
      disabled={disabled}
      title={`${slot.role} — ${slot.state}. Click to pick a file${
        slot.onCycle ? ", wheel to cycle" : ""
      }`}
      aria-label={`${slot.role}: ${slot.state}, ${slot.value}`}
    >

      <span className="loadout-stop__role font-mono">{slot.role}</span>
      <span className="cockpit-slider-thumb loadout-stop__thumb" aria-hidden="true" />
      <span
        className={`loadout-stop__value font-mono${slot.active ? " loadout-stop__value--on" : ""}`}
      >
        {slot.value}
      </span>
      <span className="loadout-stop__state font-mono">
        {slot.state}
        {slot.count > 1 ? ` · ${slot.count}` : ""}
      </span>
    </button>
  );
}
