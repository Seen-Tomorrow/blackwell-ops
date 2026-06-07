import { StrictMode } from "react";
import App from "./App";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./controls.css";
import { applyAppTheme, getThemeById } from "./themes/app-themes";
import { KEYS, migrateLegacyStorageKeys, readStorage } from "./lib/storage";

migrateLegacyStorageKeys();

// Apply saved theme before first paint to avoid flash
applyAppTheme(getThemeById(readStorage(KEYS.appTheme) ?? "matrix"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
