import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { CompanionCandidate, CompanionRole, CompanionReport, CompanionSlot } from "../lib/types";

/**
 * LOADOUT — one rail, two groups, plus the always-on status line under it.
 *
 * SPEC is the Boost slider (passed in whole) and it is the MODE control: clicking a
 * stop changes the mode and nothing else. Picking the external file a mode needs is a
 * separate affordance ("SELECT EXTERNAL" beside the current mode), because that is a
 * different decision from choosing the mode.
 *
 * SWAPS is the same slider grammar used twice; clicking either stop opens the file
 * picker for that role, and the wheel cycles.
 *
 * Under the rail, the status line always says what each stop is currently on — SPEC
 * shows its single selected mode, the swaps show precision + state.
 */
interface LoadoutRailProps {
  /** SPEC group — the Boost slider rendered inside the rail. */
  specSlot?: ReactNode;
  /** Current SPEC mode name, printed in the header and in the status line. */
  specLabel?: string;
  /** True when the current mode reads an external draft file. */
  canPickExternal?: boolean;
  onPickExternal?: (anchor: number) => void;
  /** 0..1 x of the selected SPEC mark, so its EXTERNAL badge sits over that stop. */
  specMarkPct?: number;
  report: CompanionReport | null;
  busy?: boolean;
  /** Open the file picker for a stop; anchor is 0..1 across the rail. */
  onOpenSlot?: (slot: CompanionRole, anchor: number) => void;
  /** Cycle to a candidate — the wheel gesture. */
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

function nextCandidate(slot: CompanionSlot): CompanionCandidate | null {
  if (slot.candidates.length === 0) return null;
  const current = slot.pinned ?? slot.auto?.path;
  const idx = slot.candidates.findIndex((c) => c.path === current);
  return slot.candidates[(idx + 1) % slot.candidates.length] ?? null;
}

export default function LoadoutRail({
  specSlot,
  specLabel,
  canPickExternal = false,
  onPickExternal,
  specMarkPct = 0,
  report,
  busy = false,
  onOpenSlot,
  onCycle,
}: LoadoutRailProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const slots = report ? [report.mmproj, report.engram] : [];

  /** Where the clicked control sits across the rail, so the panel opens above it. */
  const anchorOf = (el: HTMLElement | null): number => {
    const rail = railRef.current;
    if (!el || !rail) return 0.5;
    const r = el.getBoundingClientRect();
    const rr = rail.getBoundingClientRect();
    if (rr.width <= 0) return 0.5;
    return Math.min(1, Math.max(0, (r.left + r.width / 2 - rr.left) / rr.width));
  };

  return (
    <div className="loadout-rail" data-busy={busy ? "1" : undefined} ref={railRef}>
      <div className="loadout-rail__group loadout-rail__group--spec">
        <div className="loadout-rail__zone-row">
          <span className="loadout-rail__zone font-mono">SPEC</span>
        </div>
        {/* Same anatomy as the SWAPS half: one band that owns its badge line and its
            content, so both sides position the badge, role and value from one set of
            numbers instead of two. */}
        <div className="loadout-rail__band">
          {canPickExternal ? (
            <button
              type="button"
              className="loadout-rail__external font-mono"
              style={{ left: `${specMarkPct * 100}%` }}
              onClick={(e) => onPickExternal?.(anchorOf(e.currentTarget))}
              title="Pick the external file this mode reads"
            >
              <span className="loadout-rail__external-icon" aria-hidden>
                ⊕
              </span>
              external
            </button>
          ) : null}
          <div className="loadout-rail__spec">{specSlot}</div>
        </div>
      </div>

      <span className="loadout-rail__bridge" aria-hidden="true" />

      <div className="loadout-rail__group loadout-rail__group--swaps">
        <span className="loadout-rail__zone font-mono">SWAPS</span>
        <div className="loadout-rail__band loadout-swaps">
          <div className="cockpit-slider-track loadout-swaps__line" aria-hidden="true" />
          {slots.map((slot, i) => (
            <CompanionStop
              key={slot.role}
              slot={slot}
              leftPct={slots.length > 1 ? 26 + i * 48 : 50}
              disabled={busy}
              onOpen={(el) => onOpenSlot?.(slot.role, anchorOf(el))}
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
  onOpen: (el: HTMLElement | null) => void;
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
      onClick={() => onOpen(ref.current)}
      disabled={disabled}
      title={slot.reason || `${state.state} — click to pick a file, wheel to cycle`}
      aria-label={`${ROLE_LABEL[slot.role]}: ${state.state}, ${state.value}`}
    >
      <span className="loadout-stop__external font-mono" aria-hidden>
        <span className="loadout-rail__external-icon">⊕</span>
        external
      </span>
      <span className="loadout-stop__role font-mono">{ROLE_LABEL[slot.role]}</span>
      <span className="cockpit-slider-thumb loadout-stop__thumb" aria-hidden="true" />
      <span
        className={`loadout-stop__value font-mono${active ? " loadout-stop__value--on" : ""}`}
      >
        {state.value}
      </span>
      <span className="loadout-stop__state font-mono">
        {state.state}
        {slot.candidates.length > 1 ? ` · ${slot.candidates.length}` : ""}
      </span>
    </button>
  );
}
