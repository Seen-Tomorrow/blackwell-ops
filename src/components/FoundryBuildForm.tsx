import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FoundryChangelog, FoundrySourcePreview, ProviderConfig } from "../lib/types";
import { profileEnvLookup } from "../lib/types";
import { useTelemetry } from "../context/TelemetryContext";
import { ENV_META, type Env } from "../lib/foundry_constants";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import { engineVersionParts } from "../lib/engineOverview";
import { useFoundry } from "../hooks/useFoundry";
import FoundryToolchainPanel from "./FoundryToolchainPanel";
import FoundryCachePanel from "./FoundryCachePanel";
import FoundryChangelogPane from "./FoundryChangelog";
import FoundryEnginePicker from "./FoundryEnginePicker";
import {
  CUDA_ARCH_BUILD_OPTIONS,
  DEFAULT_CUDA_ARCH_CODES,
  DEFAULT_FOUNDRY_CMAKE_BASE,
  formatCudaArchitecturesCmakeLine,
  mergeBuildProfileWithArchitectures,
  orderCudaArchCodes,
  resolveSelectedCudaArchitectures,
  stripCudaArchitecturesFromCmake,
} from "../lib/cudaArchUtils";

export type FoundryMode = "edge" | "stable" | "both";

interface FoundryBuildFormProps {
  providers: ProviderConfig[];
  provider: ProviderConfig;
  mode: FoundryMode;
  onProviderChange: (id: string) => void;
  onModeChange: (mode: FoundryMode) => void;
  onManageCache: () => void;
}

interface StackEngineStatus {
  alias: string;
  provider_type: string;
  provider_name?: string;
  status: string;
  gpu?: string;
  binaryProfile?: string;
}

interface Verdict {
  tone: "green" | "amber" | "cyan" | "muted" | "red";
  badge: string;
  line: string;
}

function splitProfile(raw: string): { base: string; archCodes: string[] } {
  const trimmed = raw.trim();
  return {
    base: stripCudaArchitecturesFromCmake(trimmed) || DEFAULT_FOUNDRY_CMAKE_BASE,
    archCodes: resolveSelectedCudaArchitectures(trimmed),
  };
}

/** Human verdict for the backend's source-preview status. */
function sourceVerdict(
  preview: FoundrySourcePreview | null,
  loading: boolean,
  env: Env,
): Verdict {
  const envLabel = ENV_META[env].label;
  if (loading) {
    return { tone: "muted", badge: "CHECKING", line: "Checking source and installed engine…" };
  }
  if (!preview) {
    return { tone: "muted", badge: "UNKNOWN", line: "Couldn’t check source right now." };
  }
  switch (preview.status) {
    case "up_to_date":
      return {
        tone: "green",
        badge: "UP TO DATE",
        line: `The installed ${envLabel} engine is built from this source.`,
      };
    case "binary_present_unknown_rev":
      return {
        tone: "muted",
        badge: "INSTALLED",
        line: `Engine installed; its source revision isn't recorded yet. A rebuild records it.`,
      };
    case "update_available":
      return {
        tone: "amber",
        badge: "NEW SOURCE",
        line: "Origin is ahead — rebuild to pick it up.",
      };
    case "binary_stale":
      return {
        tone: "amber",
        badge: "NEWER",
        line: "Source is newer than the installed engine — rebuild recommended.",
      };
    case "no_binary":
      return {
        tone: "amber",
        badge: "NO ENGINE",
        line: `No ${envLabel} engine built for this profile yet.`,
      };
    case "first_clone":
      return {
        tone: "cyan",
        badge: "FIRST BUILD",
        line: "First build downloads llama.cpp. Slow internet can take a while.",
      };
    case "offline":
      return {
        tone: "muted",
        badge: "CHECK FAILED",
        line: "Origin couldn’t be checked; the local source can still build.",
      };
    default:
      return {
        tone: "muted",
        badge: "UNKNOWN",
        line: "Couldn’t compare source and engine.",
      };
  }
}

/**
 * The one build surface: target, source verdict, architecture, cache summary,
 * advanced flags/PR/threads, and a single BUILD button.
 */
export default function FoundryBuildForm({
  providers,
  provider,
  mode,
  onProviderChange,
  onModeChange,
  onManageCache,
}: FoundryBuildFormProps) {
  const { cpu } = useTelemetry();
  const { startBuild } = useFoundry();
  const cpuThreads = cpu?.threads ?? 0;
  const cpuPhysical = cpu?.cores ?? 0;

  /** Primary profile; BOTH always starts EDGE and queues STABLE. */
  const environment: Env = mode === "stable" ? "stable" : "edge";
  const envMeta = ENV_META[environment];
  const envLabel = envMeta.label;
  const providerLabel = provider.display_name || provider.id;

  const initial = useMemo(() => splitProfile(provider.build_profile ?? ""), [provider]);
  const [buildProfile, setBuildProfile] = useState(initial.base);
  const [selectedArchs, setSelectedArchs] = useState<string[]>(initial.archCodes);
  const [generator, setGenerator] = useState(provider.foundry_generator ?? "");
  const [prUrl, setPrUrl] = useState("");
  const [maxCores, setMaxCores] = useState<number | null>(null);
  const [includeExtraTools, setIncludeExtraTools] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showFlags, setShowFlags] = useState(false);

  const [sourcePreview, setSourcePreview] = useState<FoundrySourcePreview | null>(null);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [changelog, setChangelog] = useState<FoundryChangelog | null>(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [changelogError, setChangelogError] = useState<string | null>(null);
  const [toolchainReady, setToolchainReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [engineWarning, setEngineWarning] = useState<string | null>(null);

  // Provider change re-seeds the form (the page owns the target). Keyed on the
  // fields that actually define the saved build, so a provider-list refresh that
  // only changes object identity never wipes in-progress edits.
  const seedKeyRef = useRef("");
  useEffect(() => {
    const seedKey = `${provider.id}|${provider.build_profile ?? ""}|${provider.foundry_generator ?? ""}`;
    if (seedKeyRef.current === seedKey) return;
    seedKeyRef.current = seedKey;
    const next = splitProfile(provider.build_profile ?? "");
    setBuildProfile(next.base);
    setSelectedArchs(next.archCodes);
    setGenerator(provider.foundry_generator ?? "");
    setPrUrl("");
    setMaxCores(null);
    setIncludeExtraTools(false);
    setShowFlags(false);
    setStartError(null);
    setEngineWarning(null);
    setChangelogOpen(false);
    setChangelog(null);
    setChangelogError(null);
  }, [provider.id, provider.build_profile, provider.foundry_generator]);

  useEffect(() => {
    let cancelled = false;
    setSourceLoading(true);
    void invoke<FoundrySourcePreview>("foundry_preview_source", {
      providerId: provider.id,
      environment,
    })
      .then((preview) => { if (!cancelled) setSourcePreview(preview); })
      .catch(() => { if (!cancelled) setSourcePreview(null); })
      .finally(() => { if (!cancelled) setSourceLoading(false); });
    return () => { cancelled = true; };
  }, [provider.id, environment]);

  const prHistory = useMemo(
    () =>
      profileEnvLookup(provider.prHistoryPerEnv, environment)?.slice(0, 3) ??
      (profileEnvLookup(provider.lastPrPerEnv, environment)
        ? [profileEnvLookup(provider.lastPrPerEnv, environment) as string]
        : []),
    [provider.prHistoryPerEnv, provider.lastPrPerEnv, environment],
  );

  const orderedArchs = orderCudaArchCodes(selectedArchs);
  const archCmakePreview = formatCudaArchitecturesCmakeLine(orderedArchs);
  const mergedProfile = mergeBuildProfileWithArchitectures(buildProfile, selectedArchs);
  const savedProfile = provider.build_profile?.trim() ?? "";
  const defaultMerged = mergeBuildProfileWithArchitectures(initial.base, initial.archCodes);
  const flagsSummary =
    savedProfile && mergedProfile === savedProfile
      ? "SAVED"
      : mergedProfile === defaultMerged
        ? "DEFAULT"
        : "MODIFIED";

  const verdict = sourceVerdict(sourcePreview, sourceLoading, environment);
  const summaryLine = [
    sourcePreview?.local_commit ? `local ${sourcePreview.local_commit}` : null,
    sourcePreview?.remote_commit ? `remote ${sourcePreview.remote_commit}` : null,
    sourcePreview?.installed_commit
      ? `engine ${sourcePreview.installed_commit}`
      : sourcePreview?.installed_version
        ? `engine ${sourcePreview.installed_version}`
        : null,
  ].filter(Boolean).join(" · ");
  const shortCommit = (value?: string | null) => (value ? value.slice(0, 8) : "—");
  const localShort = shortCommit(sourcePreview?.local_commit);
  const remoteShort = shortCommit(sourcePreview?.remote_commit);
  const installedShort = sourcePreview?.installed_commit
    ? shortCommit(sourcePreview.installed_commit)
    : "—";
  const installedInfo = profileEnvLookup(provider.buildInfoPerEnv, environment);
  const installedEngine = engineVersionParts(
    sourcePreview?.installed_version ?? installedInfo?.version,
  );
  const installedBuildDate = installedInfo?.buildDate ?? "";
  const relation = !sourcePreview?.remote_commit
    ? "?"
    : sourcePreview.local_commit && sourcePreview.local_commit === sourcePreview.remote_commit
      ? "="
      : "→";

  const toggleChangelog = useCallback(async () => {
    if (changelogOpen) {
      setChangelogOpen(false);
      return;
    }
    setChangelogOpen(true);
    if (changelog || changelogLoading) return;
    setChangelogLoading(true);
    setChangelogError(null);
    try {
      const data = await invoke<FoundryChangelog>("foundry_remote_changelog", {
        providerId: provider.id,
      });
      setChangelog(data);
    } catch (err) {
      setChangelogError(
        typeof err === "string" ? err : "Could not load the upstream changelog.",
      );
    } finally {
      setChangelogLoading(false);
    }
  }, [changelogOpen, changelog, changelogLoading, provider.id]);

  const toggleArch = (code: string) => {
    setSelectedArchs(prev => {
      const set = new Set(prev);
      if (set.has(code)) {
        if (set.size <= 1) return prev;
        set.delete(code);
      } else {
        set.add(code);
      }
      return orderCudaArchCodes([...set]);
    });
  };

  const matchingEngines = useCallback(async (): Promise<StackEngineStatus[]> => {
    const stack = await invoke<StackEngineStatus[]>("get_stack_status");
    const profiles = new Set<string>([environment]);
    if (mode === "both") profiles.add("stable");
    return stack.filter((engine) =>
      engine.provider_type === provider.id
      && engine.status !== "IDLE"
      && profiles.has((engine.binaryProfile || "edge").toLowerCase()),
    );
  }, [environment, mode, provider.id]);

  const doStart = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const chosenGenerator = generator.trim();
      const savedGenerator = provider.foundry_generator?.trim() ?? "";
      if (mergedProfile !== savedProfile || chosenGenerator !== savedGenerator) {
        await invoke("save_provider", {
          provider: {
            ...provider,
            build_profile: mergedProfile,
            foundry_generator: chosenGenerator,
          },
        });
        dispatchAppEvent(EVENTS.reloadProviders);
      }
      await startBuild({
        providerId: provider.id,
        environment,
        alsoEnvironment: mode === "both" ? "stable" : null,
        prUrl: prUrl.trim() || null,
        maxCores,
        cmakeFlags: mergedProfile || null,
        generator: chosenGenerator || null,
        includeExtraTools,
      });
    } catch (err) {
      setStartError(typeof err === "string" ? err : "Could not start the build.");
      setEngineWarning(null);
    } finally {
      setStarting(false);
    }
  }, [
    environment, generator, includeExtraTools, maxCores, mergedProfile, mode,
    prUrl, provider, savedProfile, startBuild,
  ]);

  const handleBuild = useCallback(async () => {
    setStartError(null);
    try {
      const matching = await matchingEngines();
      if (matching.length > 0) {
        setEngineWarning(
          matching.map((engine) =>
            `${engine.alias} (${engine.provider_name || engine.provider_type}) · ${(engine.binaryProfile || "edge").toUpperCase()} on GPU ${engine.gpu ?? "?"}`,
          ).join("\n"),
        );
        return;
      }
      await doStart();
    } catch (err) {
      setStartError(typeof err === "string" ? err : "Could not read running engines.");
    }
  }, [doStart, matchingEngines]);

  return (
    <div className="fnd-form">
      <section className="fnd-form__target">
        <div className="fnd-form__field">
          <span className="fnd-form__label">ENGINE</span>
          <FoundryEnginePicker
            providers={providers}
            value={provider.id}
            onChange={onProviderChange}
            ariaLabel="Build engine"
          />
        </div>

        <div className="fnd-form__field">
          <span className="fnd-form__label">PROFILE</span>
          <div className="fnd-mode" role="group" aria-label="Build profile">
            {(["edge", "stable", "both"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`fnd-mode__btn${mode === option ? " fnd-mode__btn--active" : ""}`}
                aria-pressed={mode === option}
                onClick={() => onModeChange(option)}
              >
                {option === "both" ? "BOTH" : ENV_META[option].label}
              </button>
            ))}
          </div>
        </div>

        <span className="fnd-form__meta">
          CUDA {envMeta.cuda} · {envMeta.vs}
        </span>
      </section>

      <section className={`fnd-source fnd-source--${verdict.tone}`}>
        <div className="fnd-source__top">
          <span className="fnd-source__label">SOURCE</span>
          <span className="fnd-source__badge">{verdict.badge}</span>
          {sourcePreview?.branch && (
            <span className="fnd-source__branch">{sourcePreview.branch}</span>
          )}
        </div>

        <div className="fnd-source__commits">
          <div className="fnd-source__commit fnd-source__commit--local">
            <span className="fnd-source__commit-label">LOCAL COMMIT</span>
            <strong className="fnd-source__commit-value">{localShort}</strong>
          </div>
          <span className="fnd-source__relation" aria-hidden>{relation}</span>
          <div className="fnd-source__commit fnd-source__commit--remote">
            <span className="fnd-source__commit-label">REMOTE COMMIT</span>
            <strong className="fnd-source__commit-value">{remoteShort}</strong>
            <button
              type="button"
              className="fnd-form__btn fnd-source__changelog-btn"
              onClick={() => void toggleChangelog()}
            >
              {changelogOpen ? "HIDE CHANGELOG" : "VIEW CHANGELOG"}
            </button>
          </div>
          <div className="fnd-source__commit fnd-source__commit--installed">
            <span className="fnd-source__commit-label">INSTALLED COMMIT</span>
            <strong
              className="fnd-source__commit-value"
              title={sourcePreview?.installed_version ?? undefined}
            >
              {installedShort}
            </strong>
          </div>
        </div>

        <p className="fnd-source__line">{verdict.line}</p>

        <p className="fnd-source__engine">
          <span className="fnd-source__engine-env">{envLabel} ENGINE</span>
          {installedEngine.name && <span>version: {installedEngine.name}</span>}
          {installedEngine.build && <span>build: {installedEngine.build}</span>}
          {installedBuildDate && <span>built: {installedBuildDate}</span>}
          {!installedEngine.name && !installedEngine.build && (
            <span>no installed engine</span>
          )}
        </p>

        <div className="fnd-source__actions">
          {sourcePreview?.message && (
            <details className="fnd-source__details">
              <summary>DETAILS</summary>
              <span>
                {sourcePreview.message}
                {summaryLine ? ` · ${summaryLine}` : ""}
              </span>
            </details>
          )}
        </div>

        {changelogOpen && (
          <div className="fnd-source__changelog">
            {changelogLoading ? (
              <p className="fnd-source__changelog-status">LOADING UPSTREAM RELEASE…</p>
            ) : changelogError ? (
              <p className="fnd-source__changelog-error">{changelogError}</p>
            ) : changelog ? (
              <FoundryChangelogPane changelog={changelog} />
            ) : null}
          </div>
        )}
      </section>

      <FoundryToolchainPanel
        compact
        requiredProfile={environment}
        onReadyChange={setToolchainReady}
      />

      <section className="fnd-form__section">
        <div className="fnd-form__section-head">
          <span className="fnd-form__label">GPU ARCHITECTURE</span>
          <span className="fnd-form__hint">Pick only the GPUs you own — each one adds compile time.</span>
        </div>
        <div className="fnd-arch">
          {CUDA_ARCH_BUILD_OPTIONS.map((opt) => {
            const active = selectedArchs.includes(opt.code);
            return (
              <button
                key={opt.code}
                type="button"
                onClick={() => toggleArch(opt.code)}
                className={`fnd-arch__chip${active ? " fnd-arch__chip--active" : ""}`}
                title={opt.hint}
              >
                <span className="fnd-arch__name">{opt.label}</span>
                <span className="fnd-arch__sm">sm_{opt.code}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setSelectedArchs([...DEFAULT_CUDA_ARCH_CODES])}
            className={`fnd-arch__chip fnd-arch__chip--all${
              orderedArchs.length === DEFAULT_CUDA_ARCH_CODES.length ? " fnd-arch__chip--active" : ""
            }`}
          >
            ALL
          </button>
        </div>
        {archCmakePreview && <p className="fnd-form__code">{archCmakePreview}</p>}
      </section>

      <FoundryCachePanel
        variant="summary"
        providerId={provider.id}
        providerLabel={provider.display_name || provider.id}
        profile={environment}
        onManage={onManageCache}
      />

      <section className="fnd-form__section fnd-form__section--row">
        <div>
          <span className="fnd-form__label">BUILD FLAGS</span>
          <span className={`fnd-form__badge fnd-form__badge--${flagsSummary === "MODIFIED" ? "warn" : "ok"}`}>
            {flagsSummary}
          </span>
          <p className="fnd-form__hint">
            {flagsSummary === "DEFAULT"
              ? "Default flags — nothing custom."
              : flagsSummary === "SAVED"
                ? "Same as the last saved build."
                : "Custom flags changed for this build."}
          </p>
        </div>
        <button
          type="button"
          className="fnd-form__btn"
          onClick={() => setShowFlags(open => !open)}
        >
          {showFlags ? "CLOSE" : "EDIT"}
        </button>
      </section>
      {showFlags && (
        <textarea
          rows={7}
          className="fnd-form__textarea"
          value={buildProfile}
          onChange={(event) => setBuildProfile(event.target.value)}
          spellCheck={false}
          placeholder={"-DGGML_CUDA=ON\n-DGGML_AVX512=ON\n-DGGML_NATIVE=OFF"}
        />
      )}

      <button
        type="button"
        className="fnd-form__advanced"
        onClick={() => setShowAdvanced(open => !open)}
        aria-expanded={showAdvanced}
      >
        <span aria-hidden>{showAdvanced ? "▾" : "▸"}</span> ADVANCED
      </button>

      {showAdvanced && (
        <div className="fnd-form__advanced-body">
          <section className="fnd-form__section">
            <span className="fnd-form__label">PULL REQUEST</span>
            <input
              type="text"
              className="fnd-form__input"
              placeholder="1234, 1299 or https://github.com/owner/repo/pull/N"
              value={prUrl}
              onChange={(event) => setPrUrl(event.target.value)}
            />
            <p className="fnd-form__hint">
              Comma/space separated. Applied in order; any failure aborts the build.
            </p>
            {prHistory.length > 0 && (
              <div className="fnd-pr-history">
                <span className="fnd-pr-history__label">HISTORY</span>
                {prHistory.map((ref) => (
                  <button
                    key={ref}
                    type="button"
                    className={`fnd-pr-history__chip${prUrl.trim() === ref ? " fnd-pr-history__chip--active" : ""}`}
                    onClick={() => setPrUrl(ref)}
                    title={ref}
                  >
                    {ref}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="fnd-form__section">
            <span className="fnd-form__label">CPU THREADS</span>
            <div className="fnd-cores">
              {[4, 6, 8, 10, 12, 14, 16].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`fnd-cores__btn${maxCores === n ? " fnd-cores__btn--active" : ""}`}
                  onClick={() => setMaxCores(n)}
                >
                  {n}
                </button>
              ))}
              <button
                type="button"
                className={`fnd-cores__btn${maxCores === null ? " fnd-cores__btn--active" : ""}`}
                onClick={() => setMaxCores(null)}
              >
                ALL{cpuThreads > 0 ? ` (${cpuThreads})` : ""}
              </button>
            </div>
            {cpuThreads > 0 && (
              <p className="fnd-form__hint">
                {cpuThreads} threads / {cpuPhysical} physical. Leave 2+ free to keep Windows responsive.
              </p>
            )}
          </section>

          <section className="fnd-form__section">
            <span className="fnd-form__label">CMAKE GENERATOR</span>
            <select
              className="fnd-form__select"
              value={generator}
              onChange={(event) => setGenerator(event.target.value)}
            >
              <option value="">AUTO — Ninja (recommended)</option>
              <option value="ninja">NINJA — fastest</option>
              <option value="visual-studio">VISUAL STUDIO — fallback</option>
            </select>
          </section>

          <label className="fnd-form__check">
            <input
              type="checkbox"
              checked={includeExtraTools}
              onChange={(event) => setIncludeExtraTools(event.target.checked)}
            />
            <span>
              <strong>Build every upstream tool</strong>
              <span className="fnd-form__hint">
                Always builds llama-server, fit-params and bench. This adds cli, quantize, tts and every other target.
              </span>
            </span>
          </label>
        </div>
      )}

      {engineWarning && (
        <section className="fnd-engine-warn">
          <p className="fnd-engine-warn__title">
            {mode === "both" ? "ENGINES ON BOTH PROFILES" : "RUNNING ENGINES"}
          </p>
          <pre className="fnd-engine-warn__list">{engineWarning}</pre>
          <p className="fnd-engine-warn__note">
            Only these engines will stop. Others keep running.
          </p>
          <div className="fnd-form__actions">
            <button type="button" className="fnd-form__btn" onClick={() => setEngineWarning(null)}>
              CANCEL
            </button>
            <button type="button" className="fnd-form__btn fnd-form__btn--danger" onClick={() => void doStart()}>
              STOP ENGINES &amp; BUILD
            </button>
          </div>
        </section>
      )}

      <div className="fnd-form__footer">
        <p className="fnd-form__note">
          Only {providerLabel} on{" "}
          {mode === "both" ? "EDGE and STABLE modes" : `${envMeta.label} mode`} will be affected —
          other engines can keep running.
          {mode === "both" ? " EDGE builds first, then STABLE." : ""}
        </p>
        <button
          type="button"
          className="fnd-form__build"
          disabled={!toolchainReady || starting}
          onClick={() => void handleBuild()}
        >
          {starting
            ? "STARTING…"
            : mode === "both"
              ? "BUILD ENGINE EDGE + STABLE"
              : `BUILD ENGINE ${envMeta.label}`}
        </button>
      </div>

      {startError && <p className="fnd-form__error" role="alert">{startError}</p>}
    </div>
  );
}
