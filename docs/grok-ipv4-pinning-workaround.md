# Grok Streaming Failures — IPv4 Pinning Workaround (Vodafone CZ)

**Status:** ACTIVE workaround (2026-08-14). Verified working.
**Affects:** SuperGrok / x.ai API streaming from this machine (`dreambox`, on Vodafone Czech mobile 5G/DSL, CGNAT).
**Root cause:** Flaky IPv6 path through Vodafone's mobile/CGNAT backhaul killing long-lived streaming connections.

---

## Symptom

- Constant `reqwest error — stream: error sending request` when streaming from Grok.
- Retries for minutes to hours, making work impossible.
- Also: frequent RDP dropouts when connecting home → this machine.
- Local network itself is fine (gateway, IPv4 internet, DNS, HTTPS all pass).

## Diagnosis

Everything at Layers 1–4 checks out (gateway ping, 8.8.8.8 ping, DNS, HTTPS 200).
The failure is **intermittent congestion on the Vodafone mobile/CGNAT path**, and it
manifests on **long-lived, loss-sensitive connections** (SSE/streaming HTTP, RDP) — not
on short ICMP pings.

The critical detail: **`api.x.ai` / `grok.com` resolve IPv6-first** from the local resolver,
and the **IPv6 path through Vodafone CGNAT is the unstable one**. Pinning the Grok
endpoints to their **IPv4 (Cloudflare)** addresses bypasses the flaky IPv6 route.

## The Fix (applied)

### 1. Grok IPv4 pinning — `C:\Windows\System32\drivers\etc\hosts`

Added under the marker `# === Grok IPv4 pinning`:

```
104.18.19.80 api.x.ai
104.18.28.234 grok.com
104.18.18.80 x.ai
104.18.18.80 console.x.ai
104.18.28.234 cli-chat-proxy.grok.com   # the STREAMING proxy (critical)
```

- **`cli-chat-proxy.grok.com` is the actual streaming host** the SuperGrok client uses.
  It was the reason the fix relapsed after ~1 min: `api.x.ai` pin fixed the auth/rest
  handshake, but streaming went back to IPv6 through `cli-chat-proxy.grok.com`.
  Pin it too (resolves 104.18.28.234 / 104.18.29.234).
- These are Cloudflare IPs (verified reachable, 22–45 ms, no loss).
- After adding: `powershell Clear-DnsClientCache` (or `ipconfig /flushdns`).
- **Must restart the Grok client** so it re-resolves to IPv4 and opens fresh sockets.
- Verified: `Resolve-DnsName api.x.ai -Type A` → `104.18.19.80`;
  `https://api.x.ai/v1/models` → HTTP 401 (server reached, auth required = correct).
- **Result: Grok streaming fixed immediately.**

> Note: `nslookup` bypasses the hosts file (queries DNS servers directly), so it will
> still show IPv6 — that is expected and not a sign the pin failed. Use
> `Resolve-DnsName` to confirm.

### 2. RDP / TCP keepalive (registry) — helps RDP survive micro-dropouts

```
HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\KeepAliveTime = 30000 (DWord)
HKLM\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services\KeepAliveEnable = 1 (DWord)
```

- `KeepAliveTime` = 30 s → dead/stalled connections detected & re-established in seconds
  instead of the 2-hour default.
- `KeepAliveEnable` = 1 → RDP sends keepalives to hold the session through brief drops.
- **`KeepAliveTime` requires a reboot to take full effect.** RDP keepalive applies on the
  next RDP session.

---

## Reverting

### Undo hosts pin
Delete the 4 lines under `# === Grok IPv4 pinning` in
`C:\Windows\System32\drivers\etc\hosts`, then `Clear-DnsClientCache` and restart the client.

### Undo keepalive registry changes
```
Remove-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters' -Name KeepAliveTime
Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services' -Name KeepAliveEnable
```
(reboot after removing KeepAliveTime)

---

## Notes / gotchas

- **simplewall** is firewall-level, not DNS — does not override the hosts pin. No conflict.
  Just don't block the `104.18.x.x` Cloudflare range or Grok breaks.
- **Tailscale** is installed and working (this machine = `dreambox`, home = `karlabox`).
- The Grok fix is a **workaround**, not a fix for the underlying Vodafone congestion.

## Harness terminal fix (elevated cmd → Windows Terminal)

The elevated PI harness console used to open in legacy `cmd.exe`/conhost because the
harness spawns it with `Start-Process cmd.exe` / `CREATE_NEW_CONSOLE`, which bypasses the
Windows "default terminal = Windows Terminal" setting.

- Set `HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Console\%%Startup`
  `DelegationConsole` = `{06EC847C-C0A5-46B8-92CB-7C92F6E35CD5}` and
  `DelegationTerminal` = `{86633F1F-6454-40EC-89CE-DA4EBA977EE2}` (Windows Terminal GUIDs).
  This alone was NOT enough for the harness's `CREATE_NEW_CONSOLE` spawns.
- Real fix: launch `wt.exe` (Windows Terminal) for the visible elevated console instead
  of `cmd.exe`/`CREATE_NEW_CONSOLE`. `wt.exe` is at
  `C:\Users\<user>\AppData\Local\Microsoft\WindowsApps\wt.exe`.
  Spawn sites: `src-tauri/src/pi_code.rs` (`spawn_pi_console_user` + `spawn_pi_console_elevated`),
  `src-tauri/src/engine.rs` (`spawn_nobsproof_cmd_window`).
- **Direct `wt.exe` spawn works from BOTH elevated and non-elevated contexts** (confirmed).
  Windows Terminal is single-instance, so new windows reuse one process — don't judge
  success by process count.
- `wt_exe()` helper added in `src-tauri/src/sidecar_elevate.rs`.
- gsudo `--new` path left as legacy console (gsudo must elevate; passing wt.exe + args
  through gsudo is unreliable — UWP activation drops the args). Only relevant when the
  app is NOT already elevated.
- **Verified working** — elevated window now opens in modern Windows Terminal.

## Long-term fix (recommended, not yet applied)

Route this machine's internet traffic through the **stable home 2 Gbps line** via a
Tailscale exit node on **KARLABOX** (home PC):

1. On KARLABOX (physical access needed, once):
   ```
   tailscale up --advertise-exit-node
   ```
2. Approve in dashboard: https://login.tailscale.com/admin/machines → KARLABOX →
   "Edit route settings" → "Use as exit node".
   (The dashboard checkbox is disabled until the node advertises itself — must be done
   on the machine first.)
3. On this machine:
   ```
   tailscale set --exit-node=karlabox
   ```
   (optionally add `--exit-node-allow-lan-access` to keep local LAN/admin reachable)

This also stabilizes RDP (RDP traffic would ride the home line). Waiting on new line /
full public IPv4 is the eventual real fix.
