import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

export default function TerminalView() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10_000,
      theme: {
        background: "#0a0c10",
        foreground: "#e7ebf2",
        cursor: "#6ee7ff",
        cursorAccent: "#0a0c10",
        selectionBackground: "#1d3a44",
        black: "#0a0c10",
        red: "#ff6b7a",
        green: "#63e6a2",
        yellow: "#ffc857",
        blue: "#6ee7ff",
        magenta: "#c792ea",
        cyan: "#6ee7ff",
        white: "#e7ebf2",
        brightBlack: "#5b6472",
        brightRed: "#ff8a95",
        brightGreen: "#8cf0bc",
        brightYellow: "#ffd98a",
        brightBlue: "#a5f3ff",
        brightMagenta: "#dbb4ff",
        brightCyan: "#a5f3ff",
        brightWhite: "#ffffff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);

    const safeFit = () => {
      try {
        fit.fit();
      } catch {
        // The host can be 0x0 during the first layout pass.
      }
    };
    safeFit();

    const disposers: Array<() => void> = [];
    let disposed = false;

    const boot = async () => {
      disposers.push(
        await listen<number[]>("assistant-output", (event) => {
          if (!disposed) term.write(new Uint8Array(event.payload));
        }),
      );
      disposers.push(
        await listen("assistant-exit", () => {
          if (!disposed) {
            term.write(
              "\r\n\x1b[38;2;255;107;122m[assistant exited]\x1b[0m\r\n",
            );
          }
        }),
      );

      term.onData((data) => {
        void invoke("assistant_input", { data }).catch(() => {});
      });
      term.onResize(({ rows, cols }) => {
        void invoke("assistant_resize", { rows, cols }).catch(() => {});
      });

      safeFit();
      try {
        await invoke("assistant_start", { rows: term.rows, cols: term.cols });
      } catch (error) {
        term.write(
          `\r\n\x1b[38;2;255;107;122m[${String(error)}]\x1b[0m\r\n`,
        );
      }
    };
    void boot();

    const observer = new ResizeObserver(() => safeFit());
    observer.observe(element);
    window.addEventListener("resize", safeFit);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", safeFit);
      disposers.forEach((dispose) => dispose());
      term.dispose();
      void invoke("assistant_stop").catch(() => {});
    };
  }, []);

  const close = () => {
    void invoke("assistant_close").catch(() => {});
  };

  return (
    <div className="term">
      <header className="term-bar" data-tauri-drag-region>
        <div className="term-brand" data-tauri-drag-region>
          <span className="term-mark">O</span>
          <span className="term-name">OYM</span>
          <span className="term-chip">ASSISTANT · POWER USER</span>
        </div>
        <button className="term-close" title="Close" onClick={close}>
          ×
        </button>
      </header>
      <div className="term-host" ref={host} />
    </div>
  );
}
