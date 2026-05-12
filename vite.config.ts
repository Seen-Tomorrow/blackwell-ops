import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";

const host = process.env.TAURI_DEV_HOST || "0.0.0.0";

// Build-time version: tauri.conf.json version + git short hash
let appVersion = "0.1.0";
try {
  const gitHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  appVersion = `0.1.0-${gitHash}`;
} catch { /* fallback */ }

// https://tauri.app/start
export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev`/`tauri serve`
  server: {
    host,
    port: 1420,
  },

  build: {
    target: "esnext",
    minify: true,
  },
}));
