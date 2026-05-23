import { StrictMode } from "react";
import App from "./App";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./controls.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
