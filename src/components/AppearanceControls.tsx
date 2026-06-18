import { useTheme } from "../context/ThemeContext";
import { useDisplayTexture } from "../context/DisplayTextureContext";
import { APP_THEMES } from "../themes/app-themes";
import {
  DISPLAY_TEXTURE_SHORT_LABELS,
  type DisplayTexture,
} from "../lib/displayTexture";

const DISPLAY_PICKER_ORDER: DisplayTexture[] = ["phosphor-dark", "phosphor-light", "clean"];

interface AppearanceControlsProps {
  className?: string;
  /** Inside app-quick-settings — no outer border */
  embedded?: boolean;
}

export default function AppearanceControls({ className = "", embedded = false }: AppearanceControlsProps) {
  const { theme, setThemeId } = useTheme();
  const { texture, setTexture } = useDisplayTexture();

  const tabClass = (active: boolean) =>
    `app-appearance-tab px-1.5 py-0.5 text-[7px] font-mono rounded-sm transition-colors ${
      active ? "app-appearance-tab--active" : ""
    }`;

  return (
    <div
      className={`app-appearance-panel flex flex-col gap-px ${embedded ? "app-appearance-panel--embedded" : "rounded-sm px-1 py-0.5"} ${className}`}
      role="group"
      aria-label="Appearance"
    >
      <div className="app-appearance-section flex items-center gap-1 min-w-0">
        <span className="app-appearance-section__label text-[6px] font-mono tracking-widest uppercase">
          Color theme
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
      <div className="app-appearance-section flex items-center gap-1 min-w-0">
        <span className="app-appearance-section__label text-[6px] font-mono tracking-widest uppercase">
          Display
        </span>
        <div className="app-appearance-section__chips flex items-center gap-0.5 min-w-0">
          {DISPLAY_PICKER_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTexture(id as DisplayTexture)}
              className={tabClass(texture === id)}
              title={id}
            >
              {DISPLAY_TEXTURE_SHORT_LABELS[id]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}