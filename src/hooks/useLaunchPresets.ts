/**
 * Launch combo presets — list CRUD + capture helpers for UI.
 * Apply execution stays in the panel (needs launch_engine + models).
 */

import { useCallback, useEffect, useState } from "react";
import type { ModelEntry, StackEntry } from "../lib/types";
import type { LaunchPolicyId } from "../lib/launchPolicy";
import {
  type ComboPreset,
  type LaunchSeat,
  type PortPolicy,
  buildSoloCombo,
  buildTwinCombo,
  captureSeatFromPanel,
  captureSeatFromStack,
  deleteCombo,
  duplicateCombo,
  listCombos,
  saveCombo,
} from "../lib/launchPresets";

export function useLaunchPresets() {
  const [combos, setCombos] = useState<ComboPreset[]>(() => listCombos());

  const refresh = useCallback(() => {
    setCombos(listCombos());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const upsert = useCallback((combo: ComboPreset) => {
    const saved = saveCombo(combo);
    refresh();
    return saved;
  }, [refresh]);

  const remove = useCallback((id: string) => {
    deleteCombo(id);
    refresh();
  }, [refresh]);

  const duplicate = useCallback((combo: ComboPreset) => {
    const copy = duplicateCombo(combo);
    return upsert(copy);
  }, [upsert]);

  const saveSoloFromPanel = useCallback(
    (opts: {
      name: string;
      model: ModelEntry;
      providerId: string;
      binaryProfile?: string;
      policyId: LaunchPolicyId;
      config: Record<string, unknown>;
      portPolicy?: PortPolicy;
    }) => {
      const seat = captureSeatFromPanel({
        model: opts.model,
        providerId: opts.providerId,
        binaryProfile: opts.binaryProfile,
        policyId: opts.policyId,
        config: opts.config,
        role: "solo",
        portPolicy: opts.portPolicy,
      });
      return upsert(buildSoloCombo({ name: opts.name, seat }));
    },
    [upsert],
  );

  const saveTwinFromStack = useCallback(
    (opts: {
      name: string;
      brain: StackEntry;
      worker: StackEntry;
      sequenceBrainFirst?: boolean;
      policyIdBrain?: LaunchPolicyId;
      policyIdWorker?: LaunchPolicyId;
      panelConfig?: Record<string, unknown>;
      panelModelPath?: string | null;
      agentsOverride?: number;
    }) => {
      const brain = captureSeatFromStack({
        entry: opts.brain,
        role: "brain",
        policyId: opts.policyIdBrain ?? "full_auto",
        panelConfig: opts.panelConfig,
        panelModelPath: opts.panelModelPath,
      });
      const worker = captureSeatFromStack({
        entry: opts.worker,
        role: "worker",
        policyId: opts.policyIdWorker ?? "full_auto",
        panelConfig: opts.panelConfig,
        panelModelPath: opts.panelModelPath,
      });
      return upsert(
        buildTwinCombo({
          name: opts.name,
          brain,
          worker,
          sequenceBrainFirst: opts.sequenceBrainFirst,
          harness: {
            tool: "pi",
            defaultMode: "twin",
            agentsOverride: opts.agentsOverride,
          },
        }),
      );
    },
    [upsert],
  );

  return {
    combos,
    refresh,
    upsert,
    remove,
    duplicate,
    saveSoloFromPanel,
    saveTwinFromStack,
  };
}

export type { ComboPreset, LaunchSeat };
