import { useTheme } from "../context/ThemeContext";
import { APP_THEMES } from "../themes/app-themes";

interface ThemePickerProps {
  /** compact = cycle button; full = chip row; header = app chrome nav tabs */
  variant?: "compact" | "full" | "header";
  className?: string;
}

export default function ThemePicker({ variant = "compact", className = "" }: ThemePickerProps) {
  const { theme, cycleTheme, setThemeId } = useTheme();

  if (variant === "compact") {
    return (
      <button
        type="button"
        onClick={cycleTheme}
        className={`app-chrome-control-btn px-2 py-0.5 text-[7px] font-mono tracking-wider border border-transparent hover:border-[color:var(--theme-chrome-control-border)] transition-colors rounded-sm ${className}`}
        title={`Theme: ${theme.name} — ${theme.description}. Click to cycle.`}
      >
        ◈ {theme.name}
      </button>
    );
  }

  const chipClass = (active: boolean) => {
    if (variant === "header") {
      return `app-nav-tab px-1.5 py-0.5 text-[7px] font-mono rounded-sm transition-all ${active ? "app-nav-tab-active" : ""}`;
    }
    return `px-1.5 py-0 text-[7px] font-mono rounded-sm transition-colors ${active ? "value-chip-active" : "value-chip"}`;
  };

  return (
    <div className={`flex items-center gap-0.5 ${className}`} role="group" aria-label="App theme">
      {APP_THEMES.map(t => (
        <button
          key={t.id}
          type="button"
          onClick={() => setThemeId(t.id)}
          className={chipClass(theme.id === t.id)}
          title={t.description}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}