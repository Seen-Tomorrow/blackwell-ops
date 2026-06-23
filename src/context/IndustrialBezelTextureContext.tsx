import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  INDUSTRIAL_BEZEL_TEXTURE_LABELS,
  type IndustrialBezelTexture,
  nextIndustrialBezelTexture,
} from "../lib/industrialBezelTexture";
import { loadIndustrialBezelTexture, saveIndustrialBezelTexture } from "../lib/storage";

interface IndustrialBezelTextureContextValue {
  texture: IndustrialBezelTexture;
  label: string;
  setTexture: (texture: IndustrialBezelTexture) => void;
  cycle: () => void;
}

const IndustrialBezelTextureContext = createContext<IndustrialBezelTextureContextValue | null>(null);

export function IndustrialBezelTextureProvider({ children }: { children: React.ReactNode }) {
  const [texture, setTextureState] = useState<IndustrialBezelTexture>(loadIndustrialBezelTexture);

  const setTexture = useCallback((next: IndustrialBezelTexture) => {
    setTextureState(next);
    saveIndustrialBezelTexture(next);
  }, []);

  const cycle = useCallback(() => {
    setTextureState((prev) => {
      const next = nextIndustrialBezelTexture(prev);
      saveIndustrialBezelTexture(next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-industrial-bezel", texture);
  }, [texture]);

  const value = useMemo(
    () => ({
      texture,
      label: INDUSTRIAL_BEZEL_TEXTURE_LABELS[texture],
      setTexture,
      cycle,
    }),
    [texture, setTexture, cycle],
  );

  return (
    <IndustrialBezelTextureContext.Provider value={value}>
      {children}
    </IndustrialBezelTextureContext.Provider>
  );
}

export function useIndustrialBezelTexture(): IndustrialBezelTextureContextValue {
  const ctx = useContext(IndustrialBezelTextureContext);
  if (!ctx) {
    throw new Error("useIndustrialBezelTexture must be used within IndustrialBezelTextureProvider");
  }
  return ctx;
}