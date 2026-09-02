import { useEffect, type ReactNode } from "react";
import { useTheme } from "./ThemeContext";
import { useDisplayTexture } from "./DisplayTextureContext";
import { applyDisplayFace } from "../lib/applyDisplayFace";

/**
 * Mount inside ThemeProvider + DisplayTextureProvider. Publishes the derived display
 * face to <html> whenever either input changes. Kept as its own component because the
 * face is a function of BOTH settings, and each provider owns only one.
 */
export default function DisplayFaceSync({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  const { texture } = useDisplayTexture();

  useEffect(() => {
    applyDisplayFace(theme.id, texture);
  }, [theme.id, texture]);

  return <>{children}</>;
}
