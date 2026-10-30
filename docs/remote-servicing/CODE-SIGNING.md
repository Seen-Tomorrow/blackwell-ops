# Code signing OYM Link

## What it does

Windows Authenticode signs the PE with a certificate. It answers **who published
this file** and **whether it changed after signing**. It does not require an app
review or a Microsoft Store listing.

Unsigned files show **Unknown publisher** and usually trigger SmartScreen
("Windows protected your PC"). A trusted signature removes the unknown-publisher
warning; SmartScreen still weighs reputation, which is why EV certificates and
download volume matter.

## Options

| Option | Cost (approx.) | SmartScreen | Notes |
|---|---|---|---|
| Self-signed certificate | free | no help | Only for internal testing; still "Unknown publisher" |
| OV code-signing certificate | $200–400/yr | builds reputation over time | Business identity validation; private key on HSM/token |
| EV code-signing certificate | $300–600/yr | immediate reputation in most cases | Stricter identity validation; HSM/token required |
| Azure Trusted Signing | ~$10/month + validation | good; Microsoft-managed cert | No hardware token; eligibility rules apply |

Since June 2023, public CAs must keep code-signing private keys in a FIPS 140-2/3
HSM or hardware token. Many CAs sell a cloud-signing service so the key never
sits on the build PC.

**Azure Trusted Signing** is Microsoft's managed signing service. It is not an
app approval process, but it does require identity validation (individual or
organization) and has eligibility requirements — organization validation
generally expects a verifiable business history. Check the current eligibility
before buying; if eligible it is the least painful route for a small team.

## What to sign

- `OYM-Help.exe` (the SFX users double-click) — most important.
- `OYM-Help.exe`'s inner app (`oym-link-app.exe`) and `oym-link.exe`.
- Any future installer (`OYM-Setup.exe`).

Sign the final SFX, not only the files inside it: SmartScreen evaluates the file
the user runs.

## Signing and verification

Signature must be SHA-256 with an RFC 3161 timestamp:

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /a OYM-Help.exe
signtool verify /pa /v OYM-Help.exe
```

For Azure Trusted Signing, use the `TrustedSigning` dlib with `signtool`:

```powershell
signtool sign /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
  /dlib "$env:USERPROFILE\.trusted-signing\Azure.CodeSigning.Dlib.dll" `
  /dmdf trusted-signing.json OYM-Help.exe
```

## Until signing is in place

An unsigned SFX will often show SmartScreen. The recipient can use **More info →
Run anyway**, but that is not acceptable for a regular user. For family support
during the trial, send it with a one-line instruction; before wider distribution,
sign the SFX.

Do not buy a certificate just to "register with Microsoft" — there is no such
registration for normal desktop apps. Buy a trusted code-signing certificate (or
use Azure Trusted Signing) and timestamp every build.
