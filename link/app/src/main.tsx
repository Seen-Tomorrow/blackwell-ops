import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import TerminalView from "./TerminalView";
import "./app.css";

const isTerminal =
  new URLSearchParams(window.location.search).get("terminal") === "1";

ReactDOM.createRoot(document.getElementById("root")!).render(
  isTerminal ? (
    <TerminalView />
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  ),
);
