# Cloudflare named tunnel for OYM Link

Goal: one stable hostname (for example `help.example.com`) that fronts the local
gateway on `127.0.0.1:7443`, so pairing commands and support invites never change.

## Prerequisites

- The domain is added to Cloudflare and its nameservers are active.
- `cloudflared` is installed on the gateway PC.
- The OYM app is running with its gateway on `127.0.0.1:7443` (REMOTE → STATUS).

Install the connector on Windows:

```powershell
winget install --id Cloudflare.cloudflared
cloudflared --version
```

## Create the tunnel (dashboard)

1. Open **Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel**.
2. Choose **Cloudflared**, name it `oym`, save.
3. Copy the Windows install command shown by the dashboard. It looks like:

   ```powershell
   cloudflared.exe service install <TUNNEL_TOKEN>
   ```

   Run it in an elevated PowerShell. The connector should show **HEALTHY**.
4. Open the tunnel → **Public Hostname → Add a public hostname**:
   - Subdomain: `help` (or `link`)
   - Domain: your domain
   - Path: leave empty
   - Service: `HTTP://127.0.0.1:7443`
5. Save. Cloudflare creates the DNS record automatically.

Do **not** put a Cloudflare Access policy on the `/link` hostname. The gateway
already authenticates every device token; Access would intercept the WebSocket
before the gateway sees it. If Access is wanted for an admin UI, use a separate
hostname.

## Point OYM at the permanent host

The gateway reads `public_url.txt` from its config directory:

- DEV: `src-tauri\target\debug\config\remote\public_url.txt`
- REL: `<app root>\config\remote\public_url.txt`

Write the hostname (no trailing slash, no `/link`):

```powershell
Set-Content -Path "src-tauri\target\debug\config\remote\public_url.txt" `
  -Value "https://help.example.com" -NoNewline
```

Restart the gateway (or the app) so REMOTE → STATUS shows the permanent URL.

## Verify

```powershell
curl https://help.example.com/healthz
```

Expect JSON with `"ok": true`. Then pair a test device from REMOTE → STATUS; the
pairing command should show `wss://help.example.com/link`, and the link app
should report ONLINE.

## `.cz` registrars: NSSET, not individual nameservers

Czech registrars (tele3.cz, Wedos, …) require a **NSSET** object. The domain
points at the NSSET, and the NSSET points at two or more nameservers.

1. Add both Cloudflare nameservers under **Nameservery → Nový Nameserver**.
2. Create **Nový NSSET** with a short unique ID such as `NOVERIA-OYM-2026`.
   Do not put a hostname in the NSSET ID field — `NSSET ID` is a label, not a
   nameserver name.
3. Select both Cloudflare nameservers and the admin/authorization contact.
4. Edit the domain and choose that NSSET.

If the registrar says the NSSET already exists, the ID is globally taken; pick
a more unique label. If it says a nameserver does not exist, add that nameserver
first. Once the registry publishes the pair, `Resolve-DnsName oym.cz -Type NS`
shows the Cloudflare nameservers and Cloudflare flips the zone to Active.

`scripts/cloudflare-zone-status.ps1 -Domain oym.cz -Hostname help.oym.cz -Watch`
polls until the delegation and `/healthz` are live.
## Support invites

Once this host is stable, build a one-file helper:

```powershell
pwsh scripts/make-oym-helper-sfx.ps1 `
  -Server https://help.example.com `
  -Code <one-time-pair-code> `
  -Owner Alex `
  -OutFile tmp/OYM-Help-Alex.exe
```

The code is the normal one-time gateway pairing code. Generate it immediately
before building the SFX; it expires. The next step is a gateway-issued invite
token with a longer TTL and single use, so the file can be prepared in advance.

## Notes

- WebSockets work through Cloudflare without extra configuration.
- The tunnel is outbound-only; no router ports or public IP are required.
- Keep the quick-tunnel script for ad-hoc testing; use the named tunnel for
  anything sent to another person.
