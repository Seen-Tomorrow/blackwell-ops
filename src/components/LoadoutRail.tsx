import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CompanionCandidate, CompanionReport, CompanionRole, CompanionSlot } from "../lib/types";

/**
 * LOADOUT — the SWAPS half of the rail.
 *
 * The SPEC half stays where it is for now (the Boost slider); this row owns the
 * independently attachable companions. Each socket shows its state without a tooltip:
 * AUTO (resolved), PINNED (user choice), PICK (candidates but no strong match), EMPTY.
 * Wheel over a socket cycles candidates; click opens the picker.
 */
interface LoadoutRailProps {
  modelPath?: string | null;
  /** SPEC control (the Boost slider) rendered inside the rail. */
  specSlot?: ReactNode;
}

const ROLE_LABEL: Record<CompanionRole, string> = {
  mmproj: "MMPROJ",
  engram: "ENGRAM",
};

function slotState(slot: CompanionSlot): { text: string; tone: string } {
  if (slot.pinned_off) return { text: "OFF", tone: "off" };
  if (slot.pinned) {
    const p = slot.candidates.find((c) => c.path === slot.pinned);
    return { text: `PINNED · ${p?.precision ?? "file"}`, tone: "pinned" };
  }
  if (slot.integrated) {
    const p = slot.candidates.find((c) => c.score >= 100);
    return { text: `INTEGRATED · ${p?.precision ?? "built-in"}`, tone: "integrated" };
  }
  if (slot.auto && slot.confidence === "strong") {
    return { text: `AUTO · ${slot.auto.precision}`, tone: "auto" };
  }
  if (slot.candidates.length > 0) {
    return { text: `PICK · ${slot.candidates.length}`, tone: "pick" };
  }
  return { text: "EMPTY · find", tone: "empty" };
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
      <span className="loadout-rail__zone font-mono">SPEC</span>
      <div className="loadout-rail__spec">{specSlot}</div>
      <span className="loadout-rail__zone font-mono">SWAPS</span>
      <div className="loadout-rail__sockets">
        {slots.map((slot) => (
          <CompanionSocket
            key={slot.role}
            slot={slot}
            disabled={busy}
            onOpen={() => setOpenRole(slot.role)}
            onCycle={(candidate) => void attach(slot.role, candidate.path)}
          />
        ))}
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

interface CompanionSocketProps {
  slot: CompanionSlot;
  disabled: boolean;
  onOpen: () => void;
  onCycle: (candidate: CompanionCandidate) => void;
}

function CompanionSocket({ slot, disabled, onOpen, onCycle }: CompanionSocketProps) {
  const state = slotState(slot);
  const ref = useRef<HTMLButtonElement | null>(null);

  // Wheel must not scroll the cockpit — attach a non-passive listener so the cycle can
  // preventDefault. Only candidates beyond the current pick are cycled.
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

  return (
    <button
      ref={ref}
      type="button"
      className={`loadout-socket loadout-socket--${state.tone} loadout-socket--role-${slot.role}`}
      onClick={onOpen}
      disabled={disabled}
      title={slot.reason || state.text}
      aria-label={`${ROLE_LABEL[slot.role]}: ${state.text}`}
    >
      <span className="loadout-socket__role font-mono">{ROLE_LABEL[slot.role]}</span>
      <span className="loadout-socket__state font-mono">{state.text}</span>
      {slot.candidates.length > 1 && (
        <span className="loadout-socket__count font-mono">{slot.candidates.length}</span>
      )}
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
              const active = slot.pinned
                ? c.path === slot.pinned
                : slot.auto?.path === c.path;
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
