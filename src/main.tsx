import { StrictMode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { initDebugFlags } from "./lib/debugFlags";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./controls.css";
import { applyNativeWindowTheme } from "./lib/nativeWindowTheme";
import { applyAppTheme, getThemeById } from "./themes/app-themes";
import {
  dispatchClearLocalStorage,
  dispatchReplaySetupGuide,
  dispatchReplaySetupGuideOnboardingOnly,
} from "./lib/events";
import {
  KEYS,
  migrateLegacyStorageKeys,
  readStorage,
  resetSetupGuideState,
} from "./lib/storage";

// Signal Rust to suppress WebView IPC before JS context dies (F5 / page reload).
// Fire-and-forget: the beforeunload handler must be synchronous.
window.addEventListener("beforeunload", () => {
  // Post a marker to the app debug console so it's visible before the page dies.
  const now = new Date().toISOString().slice(11, 12 + 3).replace("T", " ");
  window.__TAURI__?.event?.emit("engine-system", {
    slot: -1,
    alias: "--",
    text: "[LIFECYCLE] frontend_will_unload — IPC suppression engaged",
    timestamp: now,
  });
  void invoke("frontend_will_unload").catch(() => {});
});

migrateLegacyStorageKeys();

if (__BUILD_MODE__ === "dev") {
  document.documentElement.classList.add("app-build--dev");
  interface BlackOpsDevTools {
    /** Replay welcome (3s) + setup guide in the VRAM display, then reload. */
    previewSetupWelcome: () => void;
    /** Exit preview mode and clear onboarding keys, then reload. */
    resetSetupGuide: () => void;
    /** Wipe all `BlackOps-*` localStorage keys and reload. */
    clearLocalStorage: () => void;
  }
  (window as Window & { __blackopsDev?: BlackOpsDevTools }).__blackopsDev = {
    previewSetupWelcome: () => {
      dispatchReplaySetupGuideOnboardingOnly();
    },
    resetSetupGuide: () => { void dispatchReplaySetupGuide(); },
    clearLocalStorage: () => { dispatchClearLocalStorage(true); },
  };
}

// Apply saved theme before first paint to avoid flash
const bootTheme = getThemeById(readStorage(KEYS.appTheme) ?? "matrix");
applyAppTheme(bootTheme);
void applyNativeWindowTheme(bootTheme);

void invoke("startup_frontend_ping").catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

void initDebugFlags();
