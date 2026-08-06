/**
 * Launch mode surface — Full Auto vs Assisted Essentials vs Assisted Full.
 *
 * Derives LaunchPolicy from FIT toggle + config view. Owns only mode chrome state;
 * value profiles live in useConfigResolver.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConfigViewMode, SpawnProfile } from "../lib/types";
import {
  loadAutoVramEnabled,
  loadConfigView,
  saveAutoVramEnabled,
  saveConfigView,
} from "../lib/storage";
import {
  type LaunchPolicy,
  type LaunchPolicyId,
  getLaunchPolicy,
  resolveLaunchPolicyId,
} from "../lib/launchPolicy";
import {
  providerSupportsFitLaunch,
  resolveEssentialParamKeys,
} from "../lib/launchProfile";

export type UseLaunchModeOptions = {
  providerId: string;
  spawnProfile?: SpawnProfile;
};

export type UseLaunchModeResult = {
  fitLaunchSupported: boolean;
  fitLaunchEnabled: boolean;
  setFitLaunchEnabled: (enabled: boolean) => void;
  /** Persist FIT / Full Auto toggle. */
  setFullAuto: (fullAuto: boolean) => void;
  configView: ConfigViewMode;
  setConfigViewMode: (view: ConfigViewMode) => void;
  fullAutoMode: boolean;
  fullAutoFixed: boolean;
  powerCockpitMode: boolean;
  policyId: LaunchPolicyId;
  policy: LaunchPolicy;
  essentialFactoryKeys: Set<string>;
  /** Joe essentials presets only on Full Auto. */
  specSimpleMode: boolean;
};

export function useLaunchMode({
  providerId,
  spawnProfile,
}: UseLaunchModeOptions): UseLaunchModeResult {
  const fitLaunchSupported = providerSupportsFitLaunch(spawnProfile);
  const [fitLaunchEnabled, setFitLaunchEnabled] = useState(true);
  const [configView, setConfigView] = useState<ConfigViewMode>("essentials");

  const essentialFactoryKeys = useMemo(
    () => resolveEssentialParamKeys(spawnProfile),
    [spawnProfile],
  );

  useEffect(() => {
    if (!fitLaunchSupported) {
      setFitLaunchEnabled(false);
      return;
    }
    setFitLaunchEnabled(
      loadAutoVramEnabled(providerId, spawnProfile?.auto_vram ?? true),
    );
  }, [providerId, fitLaunchSupported, spawnProfile?.auto_vram]);

  useEffect(() => {
    setConfigView(loadConfigView(providerId, "essentials"));
  }, [providerId]);

  const fullAutoMode = fitLaunchSupported && fitLaunchEnabled;
  const policyId = useMemo(
    () => resolveLaunchPolicyId({ fullAutoMode, configView }),
    [fullAutoMode, configView],
  );
  const policy = useMemo(() => getLaunchPolicy(policyId), [policyId]);

  const setFullAuto = useCallback(
    (fullAuto: boolean) => {
      setFitLaunchEnabled(fullAuto);
      saveAutoVramEnabled(providerId, fullAuto);
      if (!fullAuto) {
        // Leaving Full Auto → land on Assisted Full (power surface).
        setConfigView("full");
        saveConfigView(providerId, "full");
      }
    },
    [providerId],
  );

  const setConfigViewMode = useCallback(
    (view: ConfigViewMode) => {
      setConfigView(view);
      saveConfigView(providerId, view);
    },
    [providerId],
  );

  return {
    fitLaunchSupported,
    fitLaunchEnabled,
    setFitLaunchEnabled,
    setFullAuto,
    configView,
    setConfigViewMode,
    fullAutoMode,
    fullAutoFixed: fullAutoMode,
    powerCockpitMode: policy.powerUser,
    policyId,
    policy,
    essentialFactoryKeys,
    specSimpleMode: fullAutoMode,
  };
}
