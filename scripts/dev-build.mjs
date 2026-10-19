#!/usr/bin/env node
/**
 * One-command DEV loop: warm Vite (:1421 → proxy :1420), then start Tauri.
 *
 * `npm run server` owns the Vite/proxy pair; `npm run dev` owns the app.
 * Both stay in the foreground and share this process's stdio.
 */
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import process from "node:process";

const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";
const DEV_URL = "http://127.0.0.1:1420/index.html";
const START_TIMEOUT_MS = 120_000;

let server = null;
let app = null;
let shuttingDown = false;

function spawnNpm(script) {
  return spawn(npm, ["run", script], {
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
    shell: isWindows,
  });
}

function killTree(child) {
  if (!child?.pid) return;
  if (isWindows) {
    // npm.cmd -> node/vite or tauri -> app.exe; /T is the only reliable tree kill.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill("SIGTERM");
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(app);
  killTree(server);
  process.exit(code ?? 0);
}

function waitForServer() {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(DEV_URL, (res) => {
        res.resume();
        resolve();
      });
      req.setTimeout(2_000, () => req.destroy());
      req.on("error", () => {
        if (Date.now() - started > START_TIMEOUT_MS) {
          reject(new Error(`Vite did not answer ${DEV_URL} within ${START_TIMEOUT_MS / 1000}s`));
          return;
        }
        setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

async function main() {
  console.log("[devbuild] starting Vite server + proxy…");
  server = spawnNpm("server");
  server.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[devbuild] Vite server exited (${code ?? 0}) — stopping app`);
    shutdown(code ?? 1);
  });

  try {
    await waitForServer();
  } catch (error) {
    console.error(`[devbuild] ${error instanceof Error ? error.message : String(error)}`);
    shutdown(1);
    return;
  }

  console.log("[devbuild] Vite ready — starting Tauri app");
  app = spawnNpm("dev");
  app.on("exit", (code) => {
    if (shuttingDown) return;
    console.log(`[devbuild] app exited (${code ?? 0}) — stopping Vite`);
    shutdown(code ?? 0);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

main().catch((error) => {
  console.error("[devbuild]", error);
  shutdown(1);
});
