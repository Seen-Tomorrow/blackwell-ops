import type { ProviderConfig } from "../lib/types";
import {
  ENV_META,
  ENV_ORDER,
  getMinDriverMajorForCuda,
  isDriverSufficientForProfile,
  type Env,
} from "../lib/foundry_constants";

/**
 * Provider + binary-profile selector bar above the config toolbar. Pure
 * presentational — the orchestrator owns provider/profile selection state and
 * passes the enabled provider list, build/driver status, and setters down.
 */
export default function EngineProviderProfileBar(props: EngineProviderProfileBarProps) {
  const {
    providers: allProviders,
    selectedProvider,
    onSelectProvider,
    builtProfiles,
    selectedBinaryProfile,
    onSelectProfile,
    isProfileBuilding,
    driverVersion,
  } = props;

  if (!allProviders || allProviders.length === 0) return null;
  const providers = allProviders.filter((p) => p.enabled);

  return (
    <div className="px-4 py-2 border-b section-divider relative flex-shrink-0 config-provider-profile-bar">
      <div className="config-provider-profile-bar__half config-provider-profile-bar__half--providers">
        <span className="config-provider-profile-bar__label">PROVIDER</span>
        <div className="flex gap-1 flex-wrap flex-1 min-w-0">
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => onSelectProvider(p.id)}
              className={`flex-shrink-0 px-2 py-0.5 text-[9px] font-mono rounded-sm ${
                selectedProvider === p.id ? "provider-pill-active" : "provider-pill"
              }`}
            >
              {p.display_name || p.id}
              <span className="ml-1 opacity-40 text-[7px]">
                ({(p.userEditedTemplateParams || []).length})
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="config-provider-profile-bar__half config-provider-profile-bar__half--profile">
        <span className="config-provider-profile-bar__label">PROFILE</span>
        <div className="flex gap-1 flex-wrap flex-1 min-w-0">
          {ENV_ORDER.map((profile) => {
            const meta = ENV_META[profile];
            const hasBuild = builtProfiles.includes(profile);
            const building = isProfileBuilding(profile);
            const isSelected = selectedBinaryProfile === profile;
            const driverOk = isDriverSufficientForProfile(driverVersion, meta.cuda);
            const driverStatus = driverVersion
              ? driverOk
                ? "driver OK"
                : `driver too old (need ${meta.cuda} compat)`
              : "driver unknown";

            const driverClass =
              !hasBuild || building
                ? ""
                : driverOk
                  ? "ring-1 ring-nv-green/50"
                  : "ring-1 ring-red-400/60 text-red-300/90";

            return (
              <button
                key={profile}
                onClick={() => onSelectProfile(profile)}
                disabled={!hasBuild || building}
                className={`flex-shrink-0 px-2 py-0.5 text-[9px] font-mono rounded-sm ${
                  isSelected ? "provider-pill-active" : "provider-pill"
                } ${driverClass} ${
                  building
                    ? "opacity-40 cursor-not-allowed animate-pulse"
                    : !hasBuild
                      ? "opacity-25 cursor-not-allowed"
                      : ""
                }`}
                title={`${meta.label} — CUDA ${meta.cuda} (min driver ~${getMinDriverMajorForCuda(
                  meta.cuda,
                )}+)\n${meta.vs}\n${driverStatus}${
                  building ? "\n(build in progress)" : hasBuild ? "" : "\n(not yet built or mirrored)"
                }`}
              >
                {meta.label}
                {hasBuild && !building && (
                  <span
                    className={`ml-1 text-[7px] ${driverOk ? "text-nv-green/70" : "text-red-400/80"}`}
                  >
                    {driverOk ? "●" : "!"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export interface EngineProviderProfileBarProps {
  /** Raw resolved provider list (may be empty/undefined); enabled filter applied internally. */
  providers: ProviderConfig[] | undefined;
  selectedProvider: string;
  onSelectProvider: (id: string) => void;
  /** Profiles with a build/mirror present. */
  builtProfiles: Env[];
  selectedBinaryProfile: Env;
  onSelectProfile: (profile: Env) => void;
  isProfileBuilding: (profile: Env) => boolean;
  driverVersion: string | null;
}
