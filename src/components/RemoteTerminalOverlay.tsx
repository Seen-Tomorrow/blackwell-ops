import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTauriListen } from "../hooks/useTauriListen";
import type { RemoteEvent } from "../lib/remote";

type Props = {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
  onRestart: () => void;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default function RemoteTerminalOverlay({ deviceId, deviceName, onClose, onRestart }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [terminateBusy, setTerminateBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [fontSize, setFontSize] = useState(13);

  const adjustFont = useCallback((delta: number) => {
    setFontSize((current) => Math.max(9, Math.min(28, current + delta)));
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    // Let xterm re-measure before fitting, otherwise it computes rows with the
    // old glyph height and the PTY resize lags one step behind.
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [fontSize]);

  useEffect(() => {
    const node = overlayRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      adjustFont(event.deltaY < 0 ? 1 : -1);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey) return;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        event.stopPropagation();
        adjustFont(1);
      } else if (event.key === "-") {
        event.preventDefault();
        event.stopPropagation();
        adjustFont(-1);
      } else if (event.key === "0") {
        event.preventDefault();
        event.stopPropagation();
        setFontSize(13);
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false, capture: true });
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      node.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [adjustFont]);

  useTauriListen<RemoteEvent>("remote-event", (event) => {
    if (!("deviceId" in event) || event.deviceId !== deviceId) return;
    if (event.type === "session_data") {
      try {
        termRef.current?.write(base64ToBytes(event.data));
      } catch {
        // A malformed frame is not allowed to tear down the terminal.
      }
    } else if (event.type === "session_ready") {
      setClosed(false);
      termRef.current?.reset();
      termRef.current?.writeln(
        `\r\n\x1b[90m[session ready${event.pid ? ` · pid ${event.pid}` : ""}${
          event.integrity ? ` · ${event.integrity} integrity` : ""
        }]\x1b[0m`,
      );
    } else if (event.type === "session_exit") {
      setClosed(true);
      termRef.current?.writeln(
        `\r\n\x1b[90m[session exited${event.code != null ? ` · code ${event.code}` : ""}]\x1b[0m`,
      );
    } else if (event.type === "device_disconnected" || event.type === "device_removed") {
      setClosed(true);
      termRef.current?.writeln("\r\n\x1b[90m[device disconnected]\x1b[0m");
    }
  }, [deviceId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', monospace",
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 50000,
      theme: {
        background: "#0b0b0d",
        foreground: "#d8d8e0",
        cursor: "#c8c8d0",
        black: "#1a1a22",
        red: "#ff6b6b",
        green: "#8fd694",
        yellow: "#e6c86e",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#d8d8e0",
        brightBlack: "#5a5a6a",
        brightRed: "#ff8a8a",
        brightGreen: "#a6e3a1",
        brightYellow: "#f9e2af",
        brightBlue: "#89b4fa",
        brightMagenta: "#cba6f7",
        brightCyan: "#89dceb",
        brightWhite: "#f5f5fa",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();
    termRef.current = term;
    fitRef.current = fit;

    const sendSize = () => {
      if (term.cols < 20 || term.rows < 5) return;
      try {
        void invoke("remote_session_resize", {
          deviceId,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      } catch {
        // session may already be gone
      }
    };
    const sendBytes = (bytes: Uint8Array) => {
      const encoded = bytesToBase64(bytes);
      void invoke("remote_session_input", { deviceId, data: encoded }).catch(() => {});
    };
    const copySelection = (text: string) => {
      void navigator.clipboard.writeText(text).catch(() => {
        // Clipboard permission can be denied in WebView2; leave selection intact.
      });
    };
    const pasteFromClipboard = async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) term.paste(text);
      } catch {
        // Ctrl+V normally arrives through the textarea paste event; this path is
        // only a fallback for shortcuts that do not generate one.
      }
    };

    // xterm owns the textarea, so handle the DOM paste event explicitly. This
    // is what makes Ctrl+V / right-click paste work inside the WebView.
    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      term.paste(text);
    };
    host.addEventListener("paste", handlePaste, true);

    // Ctrl+C with no selection must be the interrupt byte, not a browser copy.
    // With a selection it copies, matching normal terminal behavior.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
      if (ctrl && key === "c" && !event.shiftKey) {
        const selection = term.getSelection();
        if (selection) {
          copySelection(selection);
        } else {
          sendBytes(new TextEncoder().encode("\x03"));
        }
        return false;
      }
      if (ctrl && event.shiftKey && key === "c") {
        const selection = term.getSelection();
        if (selection) copySelection(selection);
        return false;
      }
      if (event.shiftKey && key === "insert") {
        event.preventDefault();
        void pasteFromClipboard();
        return false;
      }
      if (ctrl && event.shiftKey && key === "v") {
        event.preventDefault();
        void pasteFromClipboard();
        return false;
      }
      return true;
    });

    const dataDisposable = term.onData((data) => {
      sendBytes(new TextEncoder().encode(data));
    });
    const resizeDisposable = term.onResize(() => sendSize());
    sendSize();

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // container hidden during transition
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      host.removeEventListener("paste", handlePaste, true);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [deviceId]);

  const terminate = useCallback(async () => {
    setTerminateBusy(true);
    try {
      await invoke("remote_session_terminate", { deviceId });
    } catch {
      // Surface terminal exit through the event stream; keep the overlay open.
    } finally {
      setTerminateBusy(false);
    }
  }, [deviceId]);

  return createPortal(
    <div className="remote-terminal-overlay" data-remote-terminal ref={overlayRef}>
      <div className="remote-terminal-shell">
        <header className="remote-terminal-head">
          <div className="min-w-0">
            <div className="type-micro font-mono remote-kicker">REMOTE SESSION</div>
            <div className="type-body font-mono remote-terminal-title">
              {deviceName} <span className="remote-muted">/ pi-maintenance</span>
            </div>
            <div className="type-tiny font-mono remote-muted">
              CTRL+C interrupt · CTRL+V paste · CTRL+wheel terminal zoom
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="remote-terminal-zoom" title="Terminal content zoom — independent of app zoom">
              <button
                type="button"
                className="remote-action"
                aria-label="Zoom terminal out"
                disabled={fontSize <= 9}
                onClick={() => {
                  adjustFont(-1);
                  termRef.current?.focus();
                }}
              >
                −
              </button>
              <span>{Math.round((fontSize / 13) * 100)}%</span>
              <button
                type="button"
                className="remote-action"
                aria-label="Zoom terminal in"
                disabled={fontSize >= 28}
                onClick={() => {
                  adjustFont(1);
                  termRef.current?.focus();
                }}
              >
                +
              </button>
            </div>
            <span className={`remote-state ${closed ? "is-down" : "is-live"}`}>
              {closed ? "EXITED" : "LIVE"}
            </span>
            <button
              type="button"
              className="remote-action remote-action--accent"
              disabled={!closed}
              onClick={onRestart}
            >
              RESTART SESSION
            </button>
            <button
              type="button"
              className="remote-action remote-action--danger"
              disabled={terminateBusy || closed}
              onClick={() => void terminate()}
            >
              {terminateBusy ? "TERMINATING…" : "TERMINATE"}
            </button>
            <button type="button" className="remote-action" onClick={onClose}>
              CLOSE
            </button>
          </div>
        </header>
        <div className="remote-terminal-body" ref={hostRef} />
      </div>
    </div>,
    document.body,
  );
}
