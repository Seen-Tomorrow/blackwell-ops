import { useTheme } from "../context/ThemeContext";
import { APP_THEMES } from "../themes/app-themes";

interface ThemePickerProps {
  /** compact = small cycle button; full = labeled chip with dropdown-style list */
  variant?: "compact" | "full";
  className?: string;
}

export default function ThemePicker({ variant = "compact", className = "" }: ThemePickerProps) {
  const { theme, cycleTheme, setThemeId } = useTheme();

  if (variant === "compact") {
    return (
      <button
        type="button"
        onClick={cycleTheme}
        className={`px-2 py-0.5 text-[7px] font-mono tracking-wider border border-stealth-border/50 text-stealth-muted hover:text-white hover:border-white/30 transition-colors rounded-sm ${className}`}
        title={`Theme: ${theme.name} — ${theme.description}. Click to cycle.`}
      >
        ◈ {theme.name}
      </button>
    );
  }

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {APP_THEMES.map(t => (
        <button
          key={t.id}
          type="button"
          onClick={() => setThemeId(t.id)}
          className={`px-1.5 py-0 text-[7px] font-mono rounded-sm transition-colors ${
            theme.id === t.id ? "value-chip-active" : "value-chip"
          }`}
          title={t.description}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}