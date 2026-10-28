import type { ProviderConfig } from "../lib/types";

interface FoundryEnginePickerProps {
  providers: ProviderConfig[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
}

/**
 * ENGINE selector as buttons instead of a dropdown.
 *
 * Foundry targets are a short list (typically 1–5 providers); a native select hides
 * them and adds a click. The segmented button group shows every engine at once and
 * matches the PROFILE switch next to it.
 */
export default function FoundryEnginePicker({
  providers,
  value,
  onChange,
  ariaLabel = "Engine",
}: FoundryEnginePickerProps) {
  return (
    <div className="fnd-engine-picker" role="group" aria-label={ariaLabel}>
      {providers.map((provider) => (
        <button
          key={provider.id}
          type="button"
          className={`fnd-engine-picker__btn${
            provider.id === value ? " fnd-engine-picker__btn--active" : ""
          }`}
          aria-pressed={provider.id === value}
          onClick={() => onChange(provider.id)}
        >
          {provider.display_name || provider.id}
        </button>
      ))}
    </div>
  );
}
