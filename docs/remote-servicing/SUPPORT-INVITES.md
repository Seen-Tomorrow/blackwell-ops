# Support invites

A support invite replaces the short-lived pairing code for helper packages. It is
minted locally by the owner, stored only as a SHA-256 hash, expires, is
single-use, and can be revoked. There is **no remote endpoint that can create an
invite**; only the gateway data directory can add one.

## Create

DEV gateway data directory is `src-tauri\target\debug\config\remote`.
REL is `<app root>\config\remote`.

```powershell
.\remote\target\debug\oym-invite.exe create `
  --data-dir .\src-tauri\target\debug\config\remote `
  --owner Alex `
  --ttl-hours 72
```

The output is the plaintext token (`oym_inv_…`), its id and expiry. Copy it into
the helper package. It is not stored in plaintext anywhere.

`--json` gives the same data for scripts.

## List and revoke

```powershell
.\remote\target\debug\oym-invite.exe list   --data-dir <gateway-data-dir>
.\remote\target\debug\oym-invite.exe revoke --data-dir <gateway-data-dir> --id inv_...
```

`list` shows `unused`, `used`, or `revoked`, the owner label and expiry.

## Build the helper

```powershell
pwsh scripts/make-oym-helper-sfx.ps1 `
  -Server https://help.oym.cz `
  -Invite oym_inv_... `
  -Owner Alex `
  -OutFile tmp/OYM-Help-Alex.exe
```

Exactly one of `-Invite` or `-Code` is required. The helper writes the invite into
`oym-invite.json`; the app redeems it on first run, saves the device token, and
deletes the invite file.

## Security properties

- 256-bit random token, prefix `oym_inv_`; only its hash is at rest.
- TTL 1 hour … 30 days (default 72 h); expired/used/revoked tokens are rejected.
- Redemption touches only `/pair`; a leaked Cloudflare URL cannot mint invites.
- The resulting device appears in REMOTE like any other device; revoke the device
  if a package is lost after it has been used.
- Invite creation requires local filesystem access to the gateway data dir.

## Current status

The gateway, `/pair`, CLI, helper package and the main app’s **REMOTE → STATUS →
SUPPORT INVITES** panel support invites. The panel creates a token (shown once),
copies it, lists unused/used/revoked/expired invites, and revokes unused ones.
After creating an invite, **BUILD HELPER .EXE** runs the packer and writes
`OYM-Help-<owner>.exe` to Downloads.
