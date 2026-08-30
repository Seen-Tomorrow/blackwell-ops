import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// 127.0.0.1 — not 0.0.0.0/localhost. Elevated WebView2 on Windows breaks Origin validation with localhost.
const host = process.env.TAURI_DEV_HOST || "127.0.0.1";
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

// ── Tauri app version from tauri.conf.json ────────────────────────────
let tauriVersion = "0.0.0";
{
  try {
    const confPath = resolve(__dirname, "src-tauri", isDev ? "tauri.conf.dev.json" : "tauri.conf.json");
    const conf = JSON.parse(readFileSync(confPath, "utf-8"));
    tauriVersion = conf.version || "0.0.0";
  } catch {}
}

// ── Version string ────────────────────────────────────────────────────
const modeLabel = isDev ? "DEV" : "REL";
const appVersion = `${modeLabel} ${buildNumber}`;

// https://tauri.app/start
// NOTE: the dep-optimizer cache key includes the resolved config (plugin list,
// resolve aliases, define, optimizeDeps). Keep this config STATIC across runs or
// every dev server start re-bundles node_modules deps ("Re-optimizing dependencies
// because vite config has changed"). The async factory is fine; just don't inject
// per-run values (timestamps, counters) into any hashed field.
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  define: {
    __TAURI_VERSION__: JSON.stringify(tauriVersion),
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_MODE__: JSON.stringify(buildMode),
  },

  server: {
    host,
    port: 1420,
    fs: {
      deny: [
        "**/foundry/**",
        "**/src-tauri/target/**",
        "**/work/**",
        "**/llama.cpp/**",
      ],
    },
    watch: {
      // Ignore ALL of src-tauri — Vite watching Rust files triggers a frontend reload
      // at the exact moment Rust starts recompiling, causing a race condition on the
      // WebView window. The sub-patterns below are kept for explicitness (target, runtime).
      ignored: [
        "**/src-tauri/**",
        "**/scripts/distribution-policy.json",
        "**/foundry/**",
        "**/work/**",
        "**/runtime-catalog/**",
        "**/llama.cpp/**",
        "**/node_modules/**",
        "**/.majestic-out/**",
        "**/*.exe",
        "**/*.dll",
        "**/*.7z",
      ],
      // Locked pack outputs / antivirus holds must not crash the dev server.
      ignorePermissionErrors: true,
    },
  },

  optimizeDeps: {
    // Explicit entry list (instead of the default repo-wide `**/*.html` glob) —
    // the dep scanner only crawls index.html → main.tsx → the client graph.
    // Keep it explicit if you ever add other HTML shells.
    entries: ["index.html"],
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "@tauri-apps/api",
      "@tauri-apps/api/core",
      "@tauri-apps/api/event",
      "@tauri-apps/api/window",
      "@tauri-apps/plugin-shell",
      "html-to-image",
    ],
  },

  build: {
    target: "esnext",
    minify: true,
  },
}));
