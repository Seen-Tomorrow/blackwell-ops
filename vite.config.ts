import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// 127.0.0.1 — not 0.0.0.0/localhost. Elevated WebView2 on Windows breaks Origin validation with localhost.
const host = process.env.TAURI_DEV_HOST || "127.0.0.1";
const __dirname = dirname(fileURLToPath(import.meta.url));

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

export default defineConfig(async ({ command, mode }) => {
  const isDev = command === "serve" || mode === "development";
  const buildMode = isDev ? "dev" : "release";
  let tauriVersion = "0.0.0";
  try {
    const confPath = resolve(__dirname, "src-tauri", isDev ? "tauri.conf.dev.json" : "tauri.conf.json");
    const conf = JSON.parse(readFileSync(confPath, "utf-8"));
    tauriVersion = conf.version || "0.0.0";
  } catch {}
  const modeLabel = isDev ? "DEV" : "REL";
  const appVersion = `${modeLabel} ${buildNumber}`;
  return {
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
        // `majestic pack` runs `npm run build` (rewrites dist/) and `majestic bump`
        // rewrites the root package.json while a DEV release job is running. Watching
        // either reloads the WebView and kills the DISTRIBUTION panel's job polling.
        "**/dist/**",
        "**/package.json",
        "**/scripts/distribution-policy.json",
        "**/foundry/**",
        "**/work/**",
        "**/runtime-catalog/**",
        "**/llama.cpp/**",
        "**/node_modules/**",
        "**/.majestic-out/**",
        // npm/update leaves a locked `.package-lock.json.<pid>.<uuid>.tmpdir`
        // in the repo root; chokidar surfaces EBUSY as an unhandled watcher
        // error and kills the dev server even though nothing in src changed.
        "**/.package-lock.json.*.tmpdir/**",
        "**/.package-lock.json.*",
        "**/*.tmp",
        // zg (zvec-grep) daemon holds RocksDB LOCK files here with a share mode
        // that makes fs.watch fail with EBUSY on Windows. chokidar only
        // suppresses EPERM/EACCES — an EBUSY watcher error kills the dev server.
        "**/.zvec-grep/**",
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
};
});
