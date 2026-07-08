/**
 * DEV only: start Vite on an internal port, pre-transform the client graph, then
 * expose :1420 via a proxy so Tauri cannot open the WebView until warmup finishes.
 *
 * Without the proxy, Tauri probes devUrl as soon as :1420 listens — cargo may still
 * be compiling, but the WebView often lands before HTTP warmup completes and pays the
 * full Vite 8 / Rolldown cold-compile cost (~8s).
 */
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const HOST = process.env.TAURI_DEV_HOST || "127.0.0.1";
/** Port Tauri probes (devUrl) — bound only after warmup. */
const PUBLIC_PORT = 1420;
/** Vite listens here first; not visible to Tauri until the proxy starts. */
const INTERNAL_PORT = 1421;
const INTERNAL_BASE = `http://${HOST}:${INTERNAL_PORT}`;

/** Root last — transformIndexHtml crawls /src/main.tsx and static imports. */
const WARM_PATHS = [
  "/src/main.tsx",
  "/src/App.tsx",
  "/src/components/Layout.tsx",
  "/src/components/ModelCatalog.tsx",
  "/src/components/EngineConfigPanel.tsx",
  "/src/index.css",
  "/index.html",
];

function fetchPath(base, path) {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}${path}`, (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`${path} -> HTTP ${res.statusCode}`));
            return;
          }
          resolve(res.statusCode ?? 0);
        });
      })
      .on("error", reject);
  });
}

async function waitForVite() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fetchPath(INTERNAL_BASE, "/index.html");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Vite did not become ready at ${INTERNAL_BASE} within 60s`);
}

function formatHeaders(headers) {
  return Object.entries(headers)
    .flatMap(([key, value]) => {
      if (value == null) return [];
      return Array.isArray(value) ? value.map((v) => `${key}: ${v}`) : [`${key}: ${value}`];
    })
    .join("\r\n");
}

function startProxy() {
  return new Promise((resolve, reject) => {
    const proxy = http.createServer((req, res) => {
      const upstream = http.request(
        {
          hostname: HOST,
          port: INTERNAL_PORT,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on("error", (err) => {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Vite proxy error: ${err.message}`);
      });
      req.pipe(upstream);
    });

    proxy.on("upgrade", (req, clientSocket, head) => {
      clientSocket.on("error", () => clientSocket.destroy());
      const upstream = net.connect({ host: HOST, port: INTERNAL_PORT }, () => {
        upstream.on("error", () => {
          clientSocket.destroy();
          upstream.destroy();
        });
        const reqLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
        upstream.write(`${reqLine}${formatHeaders(req.headers)}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
    });

    proxy.listen(PUBLIC_PORT, HOST, () => resolve(proxy));
    proxy.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${PUBLIC_PORT} is already in use — stop any stale "npm run dev" / Vite process, then retry.`,
          ),
        );
        return;
      }
      reject(err);
    });
  });
}

async function main() {
  const vite = spawn(`npx vite --port ${INTERNAL_PORT} --host ${HOST}`, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, NODE_ENV: "development" },
  });

  let proxy;
  const shutdown = (signal) => {
    proxy?.close();
    vite.kill(signal);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  vite.on("exit", (code) => {
    proxy?.close();
    process.exit(code ?? 0);
  });

  await waitForVite();
  console.log("[vite-warmup] internal dev server ready — pre-transforming client graph…");
  const warmT0 = Date.now();
  for (const path of WARM_PATHS) {
    const t0 = Date.now();
    try {
      await fetchPath(INTERNAL_BASE, path);
      console.log(`[vite-warmup] ok ${path} (${Date.now() - t0}ms)`);
    } catch (err) {
      console.warn(`[vite-warmup] skip ${path}:`, err);
    }
  }
  console.log(`[vite-warmup] graph warm: ${Date.now() - warmT0}ms total`);

  // Dep optimizer may still be bundling after the first main.tsx transform — wait until a
  // second fetch is fast so the WebView does not pay that cost on first paint.
  {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const t0 = Date.now();
      await fetchPath(INTERNAL_BASE, "/src/main.tsx");
      const ms = Date.now() - t0;
      if (ms < 400) {
        console.log(`[vite-warmup] deps settled (/src/main.tsx ${ms}ms)`);
        break;
      }
      console.log(`[vite-warmup] waiting for dep optimizer (/src/main.tsx ${ms}ms)…`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  proxy = await startProxy();
  console.log(
    `[vite-warmup] proxy ${HOST}:${PUBLIC_PORT} → :${INTERNAL_PORT} — tauri may open the window`,
  );

  await new Promise((resolve) => {
    proxy.on("close", resolve);
    vite.on("exit", resolve);
  });
}

main().catch((err) => {
  console.error("[vite-warmup] fatal:", err.message ?? err);
  process.exit(1);
});