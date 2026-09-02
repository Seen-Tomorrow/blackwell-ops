import { useEffect, type ReactNode } from "react";
import { useDisplayTexture } from "./DisplayTextureContext";
import { applyDisplayFace } from "../lib/applyDisplayFace";

/**
 * Mount inside DisplayTextureProvider. Publishes the display face to <html> whenever
 * the texture changes. The face is derived from texture ALONE — colour is owned by the
 * colour themes, so a face change never depends on the active theme.
 */
export default function DisplayFaceSync({ children }: { children: ReactNode }) {
  const { texture } = useDisplayTexture();

  useEffect(() => {
    applyDisplayFace(texture);
  }, [texture]);

  return <>{children}</>;
}
