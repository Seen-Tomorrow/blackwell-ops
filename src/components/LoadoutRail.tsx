import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CompanionCandidate, CompanionReport, CompanionRole, CompanionSlot } from "../lib/types";

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

export default function LoadoutRail({ modelPath, specSlot }: LoadoutRailProps) {
  const [report, setReport] = useState<CompanionReport | null>(null);
  const [openRole, setOpenRole] = useState<CompanionRole | null>(null);
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
        setOpenRole(null);
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
        setOpenRole(null);
      }
    },
    [modelPath, load],
  );

  const slots = useMemo(
    () => (report ? ([report.mmproj, report.engram] as CompanionSlot[]) : []),
    [report],
  );

  if (!modelPath) return null;

  return (
    <div className="loadout-rail" data-busy={busy ? "1" : undefined}>
      <div className="loadout-rail__group loadout-rail__group--spec">
        <span className="loadout-rail__zone font-mono">SPEC</span>
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
              onOpen={() => setOpenRole(slot.role)}
              onCycle={(candidate) => void attach(slot.role, candidate.path)}
            />
          ))}
        </div>
      </div>

      <span className="loadout-rail__note font-mono">
        {report ? "attach independently · wheel to cycle · click to pick" : "scan a model to resolve companions"}
      </span>

      {openRole && report ? (
        <CompanionPickPanel
          slot={openRole === "mmproj" ? report.mmproj : report.engram}
          onClose={() => setOpenRole(null)}
          onAttach={(path) => void attach(openRole, path)}
          onDetach={() => void attach(openRole, null)}
          onClear={() => void clear(openRole)}
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

interface CompanionPickPanelProps {
  slot: CompanionSlot;
  onClose: () => void;
  onAttach: (path: string) => void;
  onDetach: () => void;
  onClear: () => void;
}

function CompanionPickPanel({ slot, onClose, onAttach, onDetach, onClear }: CompanionPickPanelProps) {
  return (
    <div className="loadout-picker" role="dialog" aria-label={`Pick ${ROLE_LABEL[slot.role]}`}>
      <div className="loadout-picker__head">
        <span className="type-micro font-mono tracking-[0.16em]">PICK {ROLE_LABEL[slot.role]}</span>
        <span className="loadout-picker__reason type-tiny font-mono">{slot.reason}</span>
        <button type="button" className="loadout-picker__x type-micro font-mono" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="loadout-picker__section">
        <span className="type-tiny font-mono loadout-picker__label">ON THIS MACHINE</span>
        {slot.candidates.length === 0 ? (
          <p className="loadout-picker__empty type-tiny font-mono">
            Nothing on disk. Drop a {ROLE_LABEL[slot.role]} file into an extras folder — the rail picks it up on
            the next catalog scan.
          </p>
        ) : (
          <ul className="loadout-picker__list">
            {slot.candidates.map((c) => {
              const active = slot.pinned ? c.path === slot.pinned : slot.auto?.path === c.path;
              return (
                <li key={c.path}>
                  <button
                    type="button"
                    className={`loadout-card${active ? " loadout-card--active" : ""}`}
                    onClick={() => onAttach(c.path)}
                  >
                    <span className="loadout-card__name font-mono">{c.label}</span>
                    <span className="loadout-card__meta type-tiny font-mono">
                      {c.precision} · {c.size_str} · {c.source} · {c.reason || "no match detail"}
                    </span>
                    <span className="loadout-card__score type-tiny font-mono">{c.score}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="loadout-picker__foot">
        <button type="button" className="loadout-picker__btn type-micro font-mono" onClick={onDetach}>
          DETACH
        </button>
        <button type="button" className="loadout-picker__btn type-micro font-mono" onClick={onClear}>
          RESET TO AUTO
        </button>
        <button type="button" className="loadout-picker__btn type-micro font-mono" onClick={onClose}>
          CLOSE
        </button>
      </div>
    </div>
  );
}
