import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// A link-specific cumulative build counter. The footer shows it so a stale
// binary is obvious when testing installers.
let buildNumber = 0;
{
  const counterFile = resolve(__dirname, ".build_counter.json");
  try {
    const raw = JSON.parse(readFileSync(counterFile, "utf-8"));
    buildNumber = (raw.count || 0) + 1;
  } catch {
    buildNumber = 1;
  }
  try {
    writeFileSync(counterFile, JSON.stringify({ count: buildNumber }));
  } catch {}
}

// The flyout is a compact window; the dev server is deliberately separate from
// the main Blackwell OPS Vite server (1420/1421).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: {
    __LINK_BUILD__: JSON.stringify(buildNumber),
  },
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
