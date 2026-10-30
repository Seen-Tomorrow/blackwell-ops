# RustDesk — emergency remote desktop companion

Status: evaluation note. Not integrated into Blackwell OPS yet.

RustDesk is the shortest path to “click a machine and see its screen” without
enabling RDP, opening an inbound port, or creating a Windows/domain account.
The target runs the RustDesk client, connects outbound to a self-hosted relay,
and the operator connects from the RustDesk client.

## Why it fits the emergency case

- Works through CGNAT/NAT; no inbound port on the target.
- Screen + keyboard/mouse, no RDP enable and no domain account.
- Service mode can show the Windows login screen and survive reboots.
- The existing Blackwell Link client can stay the control channel; RustDesk is
  only the desktop viewer.
- No need to make the portable Blackwell client a privileged service just to
  bootstrap RDP.

It is not zero-trust magic: the target still has a RustDesk device ID and
password, and the relay is a public service endpoint.

## Deployment constraint

**Do not run the RustDesk server on the Blackwell host.** That host is behind
Vodafone CGNAT. RustDesk uses its own TCP/UDP ports, not the HTTP Cloudflare
Tunnel. Run the server on a small public Linux VPS (or a host with a public IP).

Use a pinned image tag; do not use `latest` in production.

## Server: Docker

Two services:

- `hbbs` — ID/rendezvous server
- `hbbr` — relay

Ports:

| Port | Protocol | Purpose |
|---:|---|---|
| 21115 | TCP | NAT type test |
| 21116 | TCP + UDP | ID registration/heartbeat |
| 21117 | TCP | Relay |
| 21118 | TCP | Optional web client |
| 21119 | TCP | Optional web client |

Linux host networking is the simplest layout because it preserves the UDP
behavior and avoids Docker port-mapping quirks:

```yaml
services:
  hbbs:
    image: rustdesk/rustdesk-server:<pinned-version>
    command: hbbs -r relay.example.com:21117
    network_mode: host
    volumes:
      - ./data:/root

  hbbr:
    image: rustdesk/rustdesk-server:<pinned-version>
    command: hbbr
    network_mode: host
    volumes:
      - ./data:/root
```

Start both, then read the public key:

```bash
cat ./data/id_ed25519.pub
```

Keep `./data` backed up. It contains the server key pair; losing it means
reconfiguring every client.

Firewall the VPS to only the ports above. If the optional web client is not
used, do not expose 21118/21119 publicly.

## Client configuration

On each Windows target:

1. Install RustDesk (service mode for unattended/lock-screen access).
2. Set the ID server to `hbbs.example.com:21116`.
3. Set the relay to `hbbr.example.com:21117` (or let the ID server advertise it).
4. Paste the `id_ed25519.pub` key.
5. Set a long, unique permanent password.
6. Test a reboot, the Windows login screen, and UAC.

For a handful of machines, configure by hand. For a fleet, generate a
preconfigured client or use RustDesk Server Pro’s address book/management.

Check the current RustDesk release against Windows Server 2012 R2 before
standardizing; old Windows may need an older client build.

## Blackwell integration

Cheap integration:

- store each device’s RustDesk ID next to the Blackwell device record
- add a `DESKTOP` button that launches the local RustDesk client with
  `--connect <id>`
- the operator enters the RustDesk password

Do not embed the desktop pixels into the Blackwell terminal. A separate
window is acceptable for the emergency path and avoids building a screen
codec, input injection, and secure-desktop handling.

## OSS vs Pro

The OSS server is rendezvous + relay only: no web console, address book, or
central device management. RustDesk Server Pro adds management features and a
web console. For a few servers, OSS is enough.

## Security notes

- RustDesk traffic is encrypted; the relay still sees connection metadata.
- Strong per-device passwords are mandatory.
- Do not expose the optional web client without TLS and access control.
- Public relay ports attract scanning; monitor and firewall them.
- Keep clients updated.
- Treat the RustDesk password like a local admin credential.
- Do not use the public RustDesk relay for production without understanding
  its trust and availability model.

## Operational checklist

- [ ] Public VPS provisioned; Docker installed
- [ ] `hbbs` + `hbbr` running with pinned image
- [ ] `data/` backed up off-box
- [ ] Firewall only 21115–21117 (and 21118/21119 if web client)
- [ ] RustDesk client installed as a service on each target
- [ ] ID/relay/key configured
- [ ] Unique permanent password set
- [ ] Login-screen and reboot test passed
- [ ] Desktop button/ID mapping added to Blackwell (optional)
