import { useEffect, useMemo, useState } from "react";
import type { ProviderConfig } from "../lib/types";
import type { FoundrySubTab } from "../lib/appNav";
import TabPageHeader from "./TabPageHeader";
import FoundryBuildForm, { type FoundryMode } from "./FoundryBuildForm";
import FoundryBuildView from "./FoundryBuildView";
import FoundryCachePanel from "./FoundryCachePanel";
import FoundryEnginePicker from "./FoundryEnginePicker";
import FoundryLogView from "./FoundryLogView";
import { useFoundry } from "../hooks/useFoundry";
import { ENV_META, ENV_ORDER, normalizeBinaryProfile, type Env } from "../lib/foundry_constants";
import { phaseKey, phaseLabel } from "../lib/foundryPhases";
import "../styles/foundry-page.css";

export type { FoundrySubTab } from "../lib/appNav";

interface FoundryPageProps {
  providers: ProviderConfig[];
  subTab: FoundrySubTab;
  onSubTabChange: (tab: FoundrySubTab) => void;
  /** CONFIG → ENGINE, where provider/profile selection also lives. */
  onOpenEngine: () => void;
}

/**
 * FOUNDRY is the build flow now: one BUILD surface for setup/progress/result plus a
 * CACHE tab for the retained tree + sccache. No modal; leaving the page is background.
 */
export default function FoundryPage({
  providers,
  subTab,
  onSubTabChange,
  onOpenEngine,
}: FoundryPageProps) {
  const { buildProgress, foundryTarget } = useFoundry();

  const [providerId, setProviderId] = useState(() =>
    buildProgress?.providerId ?? foundryTarget?.providerId ?? providers[0]?.id ?? "",
  );
  const [mode, setMode] = useState<FoundryMode>(() => {
    const env = foundryTarget?.environment ?? buildProgress?.environment;
    return env === "stable" ? "stable" : "edge";
  });
  const [cacheProfile, setCacheProfile] = useState<Env>(() =>
    normalizeBinaryProfile(foundryTarget?.environment ?? buildProgress?.environment),
  );

  // ENGINE shortcut: adopt its target once the event lands in the provider.
  useEffect(() => {
    if (!foundryTarget) return;
    setProviderId(foundryTarget.providerId);
    setMode(foundryTarget.environment === "stable" ? "stable" : "edge");
    setCacheProfile(foundryTarget.environment);
  }, [foundryTarget?.providerId, foundryTarget?.environment]);

  // Queue advancing EDGE → STABLE should keep the page pointed at the live profile
  // when the user dismisses the result and returns to the form.
  useEffect(() => {
    if (!buildProgress?.providerId) return;
    setProviderId(buildProgress.providerId);
    setMode(prev =>
      prev === "both"
        ? "both"
        : normalizeBinaryProfile(buildProgress.environment) === "stable" ? "stable" : "edge",
    );
    setCacheProfile(normalizeBinaryProfile(buildProgress.environment));
  }, [buildProgress?.providerId, buildProgress?.environment]);

  // Keep the provider selector valid as the provider list arrives/changes.
  useEffect(() => {
    if (providers.length === 0) {
      if (providerId) setProviderId("");
      return;
    }
    if (!providers.some((p) => p.id === providerId)) {
      setProviderId(providers[0].id);
    }
  }, [providers, providerId]);

  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const primaryEnv: Env = mode === "stable" ? "stable" : "edge";
  const providerLabel = provider?.display_name || provider?.id || "";

  const meta = useMemo(() => {
    if (!buildProgress) {
      return <span className="fnd-page-status fnd-page-status--idle">IDLE</span>;
    }
    const key = phaseKey(buildProgress.step);
    if (!buildProgress.buildId) {
      return <span className="fnd-page-status fnd-page-status--active">STARTING</span>;
    }
    const tone = key === "complete" ? "complete" : key === "error" ? "error" : "active";
    return (
      <span className={`fnd-page-status fnd-page-status--${tone}`}>
        {key === "complete"
          ? "DONE"
          : key === "error"
            ? "FAILED"
            : key === "waiting-confirm"
              ? "REVIEW"
              : phaseLabel(buildProgress.step)}
      </span>
    );
  }, [buildProgress]);

  return (
    <div className="h-full flex flex-col overflow-hidden" data-foundry-page>
      <TabPageHeader title="FOUNDRY" meta={meta} />

      <div
        className={`flex-1 min-h-0 ${
          subTab === "log" ? "overflow-hidden" : "overflow-y-auto custom-scrollbar"
        }`}
      >
        <div className={subTab === "log" ? "h-full min-h-0 p-4" : "fnd-page-scroll"}>
          {subTab === "log" ? (
            <section className="industrial-panel-face fnd-page-card fnd-page-card--log">
              <FoundryLogView />
            </section>
          ) : !provider ? (
            <section className="industrial-panel-face fnd-page-card">
              <p className="fnd-page-kicker">NO ENGINES CONFIGURED</p>
              <h3 className="fnd-page-title">Add an engine first.</h3>
              <p className="fnd-page-copy">
                Foundry builds a provider from CONFIG → ENGINE. Add one there, then come back.
              </p>
              <button type="button" className="fnd-form__btn fnd-form__btn--primary" onClick={onOpenEngine}>
                GO TO ENGINE
              </button>
            </section>
          ) : subTab === "cache" ? (
            <section className="industrial-panel-face fnd-page-card">
              <div className="fnd-page-card__head">
                <div>
                  <p className="fnd-page-kicker">CACHE</p>
                  <h3 className="fnd-page-title">{providerLabel}</h3>
                </div>
                <div className="fnd-page-target">
                  <div className="fnd-page-field">
                    <span className="fnd-page-field__label">ENGINE</span>
                    <FoundryEnginePicker
                      providers={providers}
                      value={provider.id}
                      onChange={setProviderId}
                      ariaLabel="Cache engine"
                    />
                  </div>
                  <div className="fnd-page-field">
                    <span className="fnd-page-field__label">PROFILE</span>
                    <div className="fnd-page-env" role="group" aria-label="Cache profile">
                      {ENV_ORDER.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={`fnd-page-env__btn${cacheProfile === option ? " fnd-page-env__btn--active" : ""}`}
                          aria-pressed={cacheProfile === option}
                          onClick={() => setCacheProfile(option)}
                        >
                          {ENV_META[option].label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <p className="fnd-page-copy">
                The build tree is a retained CMake/ninja directory. sccache stores compiled
                objects by content hash. They are independent: clearing the tree keeps sccache.
              </p>
              <FoundryCachePanel
                providerId={provider.id}
                providerLabel={providerLabel}
                profile={cacheProfile}
                disabled={Boolean(
                  buildProgress?.buildId
                  && phaseKey(buildProgress.step) !== "complete"
                  && phaseKey(buildProgress.step) !== "error",
                )}
              />
            </section>
          ) : buildProgress ? (
            <section className="industrial-panel-face fnd-page-card">
              <FoundryBuildView onOpenLog={() => onSubTabChange("log")} />
            </section>
          ) : (
            <section className="industrial-panel-face fnd-page-card">
              <FoundryBuildForm
                providers={providers}
                provider={provider}
                mode={mode}
                onProviderChange={setProviderId}
                onModeChange={setMode}
                onManageCache={() => {
                  setCacheProfile(primaryEnv);
                  onSubTabChange("cache");
                }}
              />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
