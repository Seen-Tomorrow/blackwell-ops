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
      // Pack/foundry drop locked .exe under work/; watching them throws EBUSY and
      // kills Vite (unhandled FSWatcher error). Keep in sync with server.fs.deny.
      ignored: [
        "**/src-tauri/target/**",
        "**/src-tauri/runtime/**",
        "**/src-tauri/runtime-bundle/**",
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
    entries: ["./index.html"],
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
