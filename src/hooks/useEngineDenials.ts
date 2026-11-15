import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DenialsView, DenialRuleView } from "../lib/types";

/**
 * Engine denial table — the same JSON (`runtime/engine-denials.json`) the launch guard
 * and the FIT probe use. One place declares "this knob value is refused for this model
 * family"; the UI uses it to disable exactly that value and nothing else.
 */
export function useEngineDenials(): DenialsView | null {
  const [denials, setDenials] = useState<DenialsView | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invoke<DenialsView>("get_engine_denials")
      .then((next) => {
        if (!cancelled) setDenials(next);
      })
      .catch(() => {
        // Missing table / broken command: keep every knob enabled, the backend refuses.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return denials;
}

/**
 * The rule that denies `knob=value` for `architecture`, or null.
 *
 * Mirrors `engine_denials::evaluate` exactly: case-insensitive, an empty `values` list
 * denies every value, an empty `architectures` list applies to every model, and an
 * unknown architecture (empty string) does not trigger an arch-scoped rule.
 */
export function deniedKnobRule(
  view: DenialsView | null,
  knob: string,
  value: string,
  architecture: string,
): DenialRuleView | null {
  const wantKnob = knob.trim().toLowerCase();
  const wantValue = value.trim().toLowerCase();
  const arch = architecture.trim().toLowerCase();

  const rule = view?.denials.find(
    (candidate) =>
      candidate.knob.trim().toLowerCase() === wantKnob &&
      (candidate.values.length === 0 ||
        candidate.values.some((v) => v.trim().toLowerCase() === wantValue)) &&
      (candidate.architectures.length === 0 ||
        candidate.architectures.some((a) => a.trim().toLowerCase() === arch)),
  );
  return rule ?? null;
}
