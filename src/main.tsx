import { StrictMode } from "react";
import App from "./App";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./controls.css";
import { applyAppTheme, getThemeById } from "./themes/app-themes";
import { KEYS } from "./lib/storage";

// Apply saved theme before first paint to avoid flash
try {
  const saved = localStorage.getItem(KEYS.appTheme);
  applyAppTheme(getThemeById(saved ?? "matrix"));
} catch {
  applyAppTheme(getThemeById("matrix"));
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
