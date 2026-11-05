#!/usr/bin/env node
/**
 * Drive the running DEV glass without a screenshot.
 *
 * The automation queue can launch engines but cannot press a button, and TAKEOVER / APPLY are
 * clicks. WebView2 exposes the page over CDP, so this evaluates JS inside it — enough to click
 * a control and to read what the glass paints.
 *
 * Start the app with the debugging port first (DevTools-only; release builds never see it):
 *
 *     $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
 *     npm run dev
 *
 * Then, from the repo root:
 *
 *     node scripts/ui-probe.mjs "document.querySelector('[data-takeover]').click()"
 *     node scripts/ui-probe.mjs --reload --console "location.reload()"   # capture console lines
 *     node scripts/ui-probe.mjs "(async () => window.__TAURI__.core.invoke('get_gpu_calibration'))()"
 *
 * Read `config/automation/ui/vram-badge.json` afterwards for what the glass decided — it is
 * the durable artifact; this tool only presses the button and can look at the DOM.
 *
 * Flags: --reload (Page.reload first, after enabling Runtime), --console (print console lines),
 *         --port <n> (default 9222, or CDP_PORT).
 */

import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    reload: { type: "boolean", default: false },
    console: { type: "boolean", default: false },
    wait: { type: "string" },
  },
});

const port = values.port ?? process.env.CDP_PORT ?? "9222";
const expression = positionals[0];
if (!expression) {
  console.error("usage: node scripts/ui-probe.mjs [--reload] [--console] \"<expression>\"");
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((target) => target.type === "page");
if (!page?.webSocketDebuggerUrl) {
  console.error(`no page target on :${port} — start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=${port}'`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();

const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id != null) {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
    return;
  }
  if (values.console && msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args ?? [])
      .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? arg.type))
      .join(" ");
    console.log(text);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  setTimeout(() => reject(new Error("CDP open timeout")), 8000);
});

try {
  if (values.console) await call("Runtime.enable");
  if (values.reload) await call("Page.reload", { ignoreCache: false });
  const result = await call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    console.error("EXCEPTION:", JSON.stringify(result.exceptionDetails, null, 2));
    process.exitCode = 1;
  } else {
    const value = result.result?.value;
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
  const waitMs = Number(values.wait ?? 0);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
} finally {
  ws.close();
}
