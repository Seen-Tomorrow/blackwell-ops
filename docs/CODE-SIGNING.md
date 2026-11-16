# Code signing

**Status: nothing is signed yet.** This is the plan, the free option, and what has to be signed when
we get there. Written 2026-11-16 after Bitdefender quarantined the Link binaries on a mode switch.

## 1. Why this exists

Two different problems wear the same clothes:

| Problem | Cause | Fixed by |
|---|---|---|
| File/reputation detections — "unknown publisher", SmartScreen warning, quarantine by hash | no Authenticode signature | a real CA certificate |
| Behavioural detections — ATC blocking a process tree | what the process *does* | code hygiene, not signing |

2026-11-16, Bitdefender ATC on the DEV box: `Malware · OYM Link.exe`, **58 applications blocked**
(tray app, WebView2 children, CLI), and quarantine-by-hash that took every copy — the portable
install under `%LOCALAPPDATA%\OYM\LinkApp` *and* the integrated service binaries under
`%ProgramData%\OYM\Link\service`. Trigger: portable→integrated→portable switching, where the
uninstall path ran a hidden elevated PowerShell that invoked WinSW's `uninstall` (which deletes its
own wrapper and the service binaries). Unsigned exe + hidden elevated shell + service deletion +
self-deleting executable = dropper shape.

That behaviour is gone: `service_uninstall` re-enters our own exe (`--service-uninstall`) and does
the SCM stop/delete natively, and the shipped `uninstall-oym-service.ps1` uses `sc.exe stop` +
`sc.exe delete` with no file removal. **Signing would not have prevented that block** — it addresses
the other column. Both are needed.

## 2. What must be signed

Every PE we hand a user, and the installer that carries them:

| Binary | Built by | Notes |
|---|---|---|
| `blackwell-ops.exe` | `tauri build` | main app |
| `OYM Link.exe` | `link/app` | tray app; shipped inside the NSIS package |
| `oym-link.exe` | `link` | device CLI |
| `oym-link-service.exe` | `link/service` | SYSTEM service host |
| `OYM-Link-Setup.exe` | `scripts/make-link-installer.ps1` | NSIS wrapper |
| its `Uninstall.exe` | NSIS | **must** be signed — an unsigned uninstaller beside signed files is a heuristic signal |
| engine PEs (`llama-server.exe`, …) | Foundry packs | third-party build; optional, sign only if we take ownership of the pack |

Rules:

- **Timestamp every signature** (`/tr` + `/td sha256`). Without it every signature dies with the
  certificate, and old releases stop verifying.
- Sign **before** packing, so the hash in `channel.json` is the hash of the signed file.
- Never re-sign in place and re-publish under an existing `channel.json` — the manifest is the
  contract (see `docs/RELEASE-CHANNELS.md`).

## 3. Free: SignPath Foundation (OSS programme)

This is the only genuinely free route for us, and the repository qualifies.

Eligibility, checked against this repo:

| Requirement | Ours |
|---|---|
| Public repository | ✅ `github.com/Seen-Tomorrow/blackwell-ops` |
| OSI-approved license, no commercial dual-licensing | ✅ GPL-3.0-only |
| No proprietary components from maintainers | ✅ GPL code + third-party OSS |
| Actively maintained | ✅ |
| Already released in the form to be signed | ✅ GitHub releases exist |
| Functionality documented on the download page | ✅ README |

How it works: the certificate lives in SignPath's HSM (CA/B Forum requires an HSM for code-signing
keys since June 2023, so an OSS project cannot get a usable local `.pfx` any more), and signing runs
as a CI step calling their API. Keys are never on this machine.

What that means for our flow: **local `majestic` builds cannot be signed.** The release artifact has
to be produced in a workflow, signed there, and published from there. DEV builds stay unsigned —
which is fine, they never leave the box.

Sketch of the flow, once approved:

1. Apply at `about.signpath.io/foundation` with: repo URL, license, release page, a maintainer
   contact. Review takes days, not minutes.
2. Add the SignPath GitHub App to the repo, with the project slug + policy slug they issue.
3. A workflow step uploads the built `*.exe` set as an artifact, requests signing with an
   artifact configuration naming the files to sign (`**/*.exe` over the package directory), then
   downloads the signed result.
4. Publish the **signed** artifacts, then compute `channel.json` hashes from them.
5. CI never holds a key: the action authenticates with a short-lived token scoped to one artifact.

## 4. Paid: Azure Artifact Signing (~$9.99/month)

Formerly "Trusted Signing". Microsoft acts as the CA and signing is a **local** `signtool` call
against their service, so it fits the current local `majestic` release flow with no CI dependency.

Availability: organizations in USA / Canada / **EU** / UK; individuals only USA / Canada. Czech
entity qualifies on the organization tier.

Reputation still has to build — the first releases can still warn. Cheap enough that it is the
pragmatic choice if the CI move in §3 is unwanted.

## 5. Self-signed (local testing only)

Free and immediate, but it buys nothing off this machine: an untrusted chain reads to scanners as
*worse* than unsigned. Legitimate uses: local installs, and adding the certificate to Bitdefender's
trusted signers while testing the Link service.

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Blackwell Ops DEV" `
    -KeyUsage DigitalSignature -FriendlyName "Blackwell Ops DEV" `
    -CertStoreLocation Cert:\CurrentUser\My
# export, then:
signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /f dev.pfx /p <pass> app.exe
```

Never ship a self-signed build; the installer's "unknown publisher" is more honest than a warning
about an untrusted certificate.

## 6. Until we are signed

- **Local test machines**: exclude the folders, or Bitdefender re-quarantines every rebuild —
  `%LOCALAPPDATA%\OYM\LinkApp`, `%ProgramData%\OYM\Link`, `link\app\src-tauri\target\debug`,
  `link\target\debug`.
- **Report false positives** rather than only excluding: Bitdefender's sample submission form
  (category *False Positive*, detection name as shown in the event, screenshot, file ≤25 MB or
  zipped). Corrections usually land within hours and unblock every user who runs BD.
- **Prefer boring behaviour** — every hidden elevated shell, service deletion and self-deleting
  executable is what gets flagged, signed or not.

## 7. Related

- `docs/RELEASE-CHANNELS.md` — channels, `channel.json`, hashing rules.
- `AGENTS.md` → Release-build process spawn — why short-lived helpers use `CREATE_NO_WINDOW` and
  engines are the exception.
- `docs/AGENTS-REFERENCE.md` → Release-build process spawn.
