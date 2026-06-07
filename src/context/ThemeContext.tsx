import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { KEYS, readStorage, writeStorage } from "../lib/storage";
import {
  APP_THEMES,
  DEFAULT_THEME_ID,
  applyAppTheme,
  getThemeById,
  type AppTheme,
} from "../themes/app-themes";

interface ThemeContextValue {
  theme: AppTheme;
  themeIndex: number;
  setThemeId: (id: string) => void;
  cycleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function loadThemeId(): string {
  const saved = readStorage(KEYS.appTheme);
  if (saved && APP_THEMES.some(t => t.id === saved)) return saved;
  return DEFAULT_THEME_ID;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeIdState] = useState(loadThemeId);

  const theme = useMemo(() => getThemeById(themeId), [themeId]);
  const themeIndex = useMemo(
    () => Math.max(0, APP_THEMES.findIndex(t => t.id === theme.id)),
    [theme.id],
  );

  useEffect(() => {
    applyAppTheme(theme);
  }, [theme]);

  const setThemeId = useCallback((id: string) => {
    const resolved = getThemeById(id);
    setThemeIdState(resolved.id);
    writeStorage(KEYS.appTheme, resolved.id);
  }, []);

  const cycleTheme = useCallback(() => {
    const idx = APP_THEMES.findIndex(t => t.id === themeId);
    const next = APP_THEMES[(idx + 1) % APP_THEMES.length];
    setThemeId(next.id);
  }, [themeId, setThemeId]);

  const value = useMemo(
    () => ({ theme, themeIndex, setThemeId, cycleTheme }),
    [theme, themeIndex, setThemeId, cycleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}