# blackwell-remote

Loopback-only gateway for the Blackwell Ops remote control room.

Public routes (normally behind Cloudflare Tunnel):

| Route | Purpose |
|---|---|
| `GET /healthz` (alias `/health`) | tunnel/gateway health, no secrets |
| `POST /pair` | one-time pairing code → device token |
| `GET /agent` | authenticated WebSocket; device control, PTY, model frames |

Everything else stays on loopback. The gateway never exposes an engine port,
Tauri IPC, or engine-management endpoints.

## Standalone smoke gateway

```powershell
cargo run --manifest-path remote/Cargo.toml --bin blackwell-gateway -- `
  --bind 127.0.0.1:7443 `
  --data-dir tmp\remote-gw `
  --engine-port 8888 `
  --model BRAIN `
  --pair-code
```

`--auto-session` starts a session as soon as a device connects; it exists for
client smoke tests, not production UI flow.

## Persistence

`{data-dir}\devices.json` contains device metadata and SHA-256 token hashes.
Pairing codes live only in memory and expire after five minutes. No transcript
or command log is written.
