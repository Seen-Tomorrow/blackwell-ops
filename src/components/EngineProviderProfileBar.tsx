import type { ProviderConfig } from "../lib/types";
import {
  ENV_META,
  ENV_ORDER,
  type Env,
} from "../lib/foundry_constants";
import ProviderProfileSegment from "./ProviderProfileSegment";

/**
 * Provider + binary-profile selector bar above the config toolbar. Pure
 * presentational — the orchestrator owns provider/profile selection state and
 * passes the enabled provider list, build status, and setters down.
 *
 * Both halves share fit size + amber tone (symmetric segment chrome).
 * Building profiles keep a shine animation on the option.
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
  } = props;

  if (!allProviders || allProviders.length === 0) return null;
  const providers = allProviders.filter((p) => p.enabled);

  const providerOptions = providers.map((p) => ({
    id: p.id,
    title: p.display_name || p.id,
    label: p.display_name || p.id,
  }));

  const profileOptions = ENV_ORDER.map((profile) => {
    const meta = ENV_META[profile];
    const hasBuild = builtProfiles.includes(profile);
    const building = isProfileBuilding(profile);

    return {
      id: profile,
      disabled: !hasBuild || building,
      className: building ? "segment-switch__option--building" : undefined,
      title: `${meta.label} — CUDA ${meta.cuda}\n${meta.vs}${
        building ? "\n(build in progress)" : hasBuild ? "" : "\n(not yet built or mirrored)"
      }`,
      label: meta.label,
    };
  });

  return (
    <div className="px-4 py-2 border-b section-divider relative flex-shrink-0 config-provider-profile-bar">
      <div className="config-provider-profile-bar__half config-provider-profile-bar__half--providers">
        <span className="config-provider-profile-bar__label">PROVIDER</span>
        <div className="config-provider-profile-bar__control">
          {providerOptions.length > 0 && (
            <ProviderProfileSegment
              ariaLabel="Engine provider"
              options={providerOptions}
              selectedId={selectedProvider}
              onSelect={onSelectProvider}
              size="fit"
              tone="amber"
            />
          )}
        </div>
      </div>
      <div className="config-provider-profile-bar__half config-provider-profile-bar__half--profile">
        <span className="config-provider-profile-bar__label">PROFILE</span>
        <div className="config-provider-profile-bar__control config-provider-profile-bar__control--end">
            <ProviderProfileSegment
              ariaLabel="Runtime profile"
              options={profileOptions}
              selectedId={selectedBinaryProfile}
              onSelect={(id) => onSelectProfile(id as Env)}
              size="fit"
              tone="amber"
            />
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
}
