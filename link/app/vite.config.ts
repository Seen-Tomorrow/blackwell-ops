import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The flyout is a compact window; the dev server is deliberately separate from
// the main Blackwell OPS Vite server (1420/1421).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // The root app shares this node_modules tree. Keep a separate optimizer cache:
  // Vite's default `node_modules/.vite` is common to both and invalidating it
  // breaks the main app's dynamic imports mid-session.
  cacheDir: "node_modules/.vite-link",
  server: {
    port: 1422,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
  },
});
