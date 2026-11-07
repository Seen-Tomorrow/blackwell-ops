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
      label: (
        <span className="runtime-mode">
          <span className="runtime-mode__name">{meta.label}</span>
          <span className="runtime-mode__cuda">CUDA {meta.cuda}</span>
        </span>
      ),
    };
  });

  return (
    <div className="px-4 py-2 border-b section-divider relative flex-shrink-0 config-provider-profile-bar">
      <div className="config-provider-profile-bar__half config-provider-profile-bar__half--providers">
        <span className="config-provider-profile-bar__label">ENGINE</span>
        <div className="config-provider-profile-bar__control">
          {providerOptions.length > 0 && (
            <ProviderProfileSegment
              ariaLabel="Engine"
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
        <svg
          className="runtime-mode-traces"
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 1600 44"
          preserveAspectRatio="none"
        >
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          >
            {/* long buses with 45° jogs — one draw, no tiling repetition */}
            <path d="M0 5H300L308 13H640L648 5H980L988 13H1300L1308 5H1600" />
            <path d="M0 21H180L188 29H460L468 21H760" />
            <path d="M820 21H1040L1048 29H1360L1368 21H1600" />
            <path d="M0 37H240L248 29H520" />
            <path d="M560 37H860L868 29H1160L1168 37H1600" />
            {/* verticals tie the buses into a fabric */}
            <path d="M120 0V5" />
            <path d="M300 5V0" />
            <path d="M400 13V21" />
            <path d="M700 0V21" />
            <path d="M1120 21V37" />
            <path d="M1500 5V13" />
            <path d="M240 37V44" />
            {/* pads at bends and ends */}
            <circle cx="300" cy="5" r="2.4" />
            <circle cx="308" cy="13" r="2.4" />
            <circle cx="640" cy="13" r="2.4" />
            <circle cx="648" cy="5" r="2.4" />
            <circle cx="980" cy="5" r="2.4" />
            <circle cx="988" cy="13" r="2.4" />
            <circle cx="1300" cy="13" r="2.4" />
            <circle cx="1308" cy="5" r="2.4" />
            <circle cx="180" cy="21" r="2.4" />
            <circle cx="188" cy="29" r="2.4" />
            <circle cx="460" cy="29" r="2.4" />
            <circle cx="468" cy="21" r="2.4" />
            <circle cx="760" cy="21" r="2.4" />
            <circle cx="820" cy="21" r="2.4" />
            <circle cx="1040" cy="21" r="2.4" />
            <circle cx="1048" cy="29" r="2.4" />
            <circle cx="1360" cy="29" r="2.4" />
            <circle cx="1368" cy="21" r="2.4" />
            <circle cx="240" cy="37" r="2.4" />
            <circle cx="248" cy="29" r="2.4" />
            <circle cx="520" cy="29" r="2.4" />
            <circle cx="860" cy="37" r="2.4" />
            <circle cx="868" cy="29" r="2.4" />
            <circle cx="1160" cy="29" r="2.4" />
            <circle cx="1168" cy="37" r="2.4" />
            {/* isolated vias */}
            <circle cx="80" cy="13" r="1.8" />
            <circle cx="700" cy="37" r="1.8" />
            <circle cx="1420" cy="13" r="1.8" />
            <circle cx="1050" cy="37" r="1.8" />
            <circle cx="250" cy="13" r="1.8" />
          </g>
        </svg>
        <span className="config-provider-profile-bar__label">RUNTIME MODE</span>
        <div className="config-provider-profile-bar__control config-provider-profile-bar__control--end">
            <ProviderProfileSegment
              ariaLabel="Runtime mode"
              options={profileOptions}
              selectedId={selectedBinaryProfile}
              onSelect={(id) => onSelectProfile(id as Env)}
              size="fit"
              tone="amber"
              className="runtime-mode-switch"
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
