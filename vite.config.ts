import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const host = process.env.TAURI_DEV_HOST || "0.0.0.0";
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Build mode ────────────────────────────────────────────────────────
const isDev = process.env.NODE_ENV === "development";
const buildMode = isDev ? "dev" : "release";

// ── Auto-incrementing build counter (shared, every build) ─────────────
let buildNumber = 0;
{
  const counterFile = resolve(__dirname, ".build_counter.json");
  try {
    const raw = JSON.parse(readFileSync(counterFile, "utf-8"));
    buildNumber = (raw.count || 0) + 1;
    writeFileSync(counterFile, JSON.stringify({ count: buildNumber }));
  } catch {}
}

// ── Version string ────────────────────────────────────────────────────
const modeLabel = isDev ? "DEV" : "REL";
const appVersion = `${modeLabel} ${buildNumber}`;

// https://tauri.app/start
export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_MODE__: JSON.stringify(buildMode),
  },

  server: {
    host,
    port: 1420,
  },

  build: {
    target: "esnext",
    minify: true,
  },
}));
