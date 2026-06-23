import { useTheme } from "../context/ThemeContext";
import { useDisplayTexture } from "../context/DisplayTextureContext";
import { useIndustrialBezelTexture } from "../context/IndustrialBezelTextureContext";
import { APP_THEMES } from "../themes/app-themes";
import { DISPLAY_TEXTURE_SHORT_LABELS } from "../lib/displayTexture";
import { INDUSTRIAL_BEZEL_TEXTURE_SHORT_LABELS } from "../lib/industrialBezelTexture";

interface AppearanceControlsProps {
  className?: string;
  /** Inside app-quick-settings — no outer border */
  embedded?: boolean;
}

export default function AppearanceControls({ className = "", embedded = false }: AppearanceControlsProps) {
  const { theme, setThemeId } = useTheme();
  const { texture: displayTexture, label: displayLabel, cycle: cycleDisplayTexture } = useDisplayTexture();
  const { texture: frameTexture, label: frameLabel, cycle: cycleFrameTexture } = useIndustrialBezelTexture();

  const tabClass = (active: boolean) =>
    `app-appearance-tab px-1.5 py-0.5 text-[7px] font-mono rounded-sm transition-colors ${
      active ? "app-appearance-tab--active" : ""
    }`;

  const quickSep = (
    <span className="app-quick-settings__sep app-chrome-control-btn text-[8px] font-mono opacity-40 flex-shrink-0" aria-hidden>
      |
    </span>
  );

  return (
    <div
      className={`app-appearance-panel ${embedded ? "app-appearance-panel--embedded" : "rounded-sm px-1 py-0.5"} ${className}`}
      role="group"
      aria-label="Appearance"
    >
      <div className="app-appearance-section app-appearance-section--inline flex items-center gap-1 min-w-0">
        <div className="app-appearance-inline-group flex items-center gap-0.5 min-w-0">
          <span className="app-appearance-section__label app-appearance-section__label--compact text-[6px] font-mono tracking-widest uppercase">
            Theme
          </span>
          <div className="app-appearance-section__chips flex items-center gap-0.5 min-w-0">
            {APP_THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setThemeId(t.id)}
                className={tabClass(theme.id === t.id)}
                title={t.description}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
        {quickSep}
        <div className="app-appearance-inline-group flex items-center gap-0.5 flex-shrink-0">
          <span className="app-appearance-section__label app-appearance-section__label--compact text-[6px] font-mono tracking-widest uppercase">
            Display
          </span>
          <button
            type="button"
            onClick={cycleDisplayTexture}
            className={`app-appearance-cycle ${tabClass(true)}`}
            title={`Display texture: ${displayLabel} — click to cycle`}
          >
            {DISPLAY_TEXTURE_SHORT_LABELS[displayTexture]}
          </button>
        </div>
        {quickSep}
        <div className="app-appearance-inline-group flex items-center gap-0.5 flex-shrink-0">
          <span className="app-appearance-section__label app-appearance-section__label--compact text-[6px] font-mono tracking-widest uppercase">
            Frame
          </span>
          <button
            type="button"
            onClick={cycleFrameTexture}
            className={`app-appearance-cycle ${tabClass(true)}`}
            title={`Bezel texture: ${frameLabel} — click to cycle`}
          >
            {INDUSTRIAL_BEZEL_TEXTURE_SHORT_LABELS[frameTexture]}
          </button>
        </div>
      </div>
    </div>
  );
}