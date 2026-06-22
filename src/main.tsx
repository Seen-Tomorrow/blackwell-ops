import { StrictMode } from "react";
import { initDebugFlags } from "./lib/debugFlags";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./controls.css";
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
applyAppTheme(getThemeById(readStorage(KEYS.appTheme) ?? "matrix"));

void initDebugFlags().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
});
