import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  DISPLAY_TEXTURE_LABELS,
  DISPLAY_TEXTURE_ORDER,
  type DisplayTexture,
  nextDisplayTexture,
} from "../lib/displayTexture";
import { loadDisplayTexture, saveDisplayTexture } from "../lib/storage";

interface DisplayTextureContextValue {
  texture: DisplayTexture;
  label: string;
  position: number;
  setTexture: (texture: DisplayTexture) => void;
  cycle: () => void;
}

const DisplayTextureContext = createContext<DisplayTextureContextValue | null>(null);

export function DisplayTextureProvider({ children }: { children: React.ReactNode }) {
  const [texture, setTextureState] = useState<DisplayTexture>(loadDisplayTexture);

  const setTexture = useCallback((next: DisplayTexture) => {
    setTextureState(next);
    saveDisplayTexture(next);
  }, []);

  const cycle = useCallback(() => {
    setTextureState((prev) => {
      const next = nextDisplayTexture(prev);
      saveDisplayTexture(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      texture,
      label: DISPLAY_TEXTURE_LABELS[texture],
      position: DISPLAY_TEXTURE_ORDER.indexOf(texture),
      setTexture,
      cycle,
    }),
    [texture, setTexture, cycle],
  );

  return (
    <DisplayTextureContext.Provider value={value}>
      {children}
    </DisplayTextureContext.Provider>
  );
}

export function useDisplayTexture(): DisplayTextureContextValue {
  const ctx = useContext(DisplayTextureContext);
  if (!ctx) {
    throw new Error("useDisplayTexture must be used within DisplayTextureProvider");
  }
  return ctx;
}