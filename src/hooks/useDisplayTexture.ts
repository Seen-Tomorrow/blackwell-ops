import { useCallback, useState } from "react";
import {
  DISPLAY_TEXTURE_LABELS,
  DISPLAY_TEXTURE_ORDER,
  type DisplayTexture,
  nextDisplayTexture,
} from "../lib/displayTexture";
import { loadDisplayTexture, saveDisplayTexture } from "../lib/storage";

export function useDisplayTexture() {
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

  const position = DISPLAY_TEXTURE_ORDER.indexOf(texture);

  return {
    texture,
    label: DISPLAY_TEXTURE_LABELS[texture],
    position,
    setTexture,
    cycle,
  };
}