#requires -Version 7.0
<#
.SYNOPSIS
  Sign local OYM binaries with a self-signed development certificate.

.DESCRIPTION
  Creates (once) a code-signing certificate in Cert:\CurrentUser\My, signs the
  requested files with signtool, and optionally trusts the certificate for the
  current user so Windows shows the publisher instead of "Unknown publisher".

  This is for development only. It does not help SmartScreen reputation and it
  does not replace a public code-signing certificate.

.EXAMPLE
  pwsh scripts/sign-dev.ps1 -Trust
  pwsh scripts/sign-dev.ps1 -Files tmp\OYM-Help-Alex.exe
#>
param(
    [string[]] $Files = @(),
    [switch] $Trust,
    [string] $Subject = "CN=OYM Dev Code Signing",
    [string] $TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if ($Files.Count -eq 0) {
    $Files = @(
        (Join-Path $root "link/app/src-tauri/target/release/oym-link-app.exe"),
        (Join-Path $root "link/target/release/oym-link.exe")
    )
    $sfx = Join-Path $root "tmp/OYM-Help.exe"
    if (Test-Path $sfx) { $Files += $sfx }
}

$signtool = @(
    "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe",
    "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x86\signtool.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $signtool) {
    $signtool = (Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Select-Object -First 1 -ExpandProperty FullName)
}
if (-not $signtool) { throw "signtool.exe not found. Install the Windows SDK signing tools." }

$cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
    Select-Object -First 1

if (-not $cert) {
    Write-Host "Creating self-signed code-signing certificate: $Subject"
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $Subject `
        -KeyUsage DigitalSignature `
        -KeySpec Signature `
        -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddYears(3)
    Write-Host "Thumbprint: $($cert.Thumbprint)"
}

if ($Trust) {
    $cer = Join-Path $root "tmp/oym-dev-codesign.cer"
    New-Item -ItemType Directory -Force -Path (Split-Path $cer) | Out-Null
    Export-Certificate -Cert $cert -FilePath $cer -Force | Out-Null
    foreach ($store in @("Cert:\CurrentUser\TrustedPublisher", "Cert:\CurrentUser\Root")) {
        $already = Get-ChildItem $store | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
        if (-not $already) {
            Import-Certificate -FilePath $cer -CertStoreLocation $store | Out-Null
            Write-Host "Trusted in $store"
        }
    }
}

foreach ($file in $Files) {
    if (-not (Test-Path $file)) {
        Write-Warning "skip missing: $file"
        continue
    }
    Write-Host "Signing $file"
    & $signtool sign /sha1 $cert.Thumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $file
    if ($LASTEXITCODE -ne 0) { throw "signtool failed for $file (exit $LASTEXITCODE)" }
    & $signtool verify /pa /v $file | Select-Object -Last 6
    if ($LASTEXITCODE -ne 0) { throw "signature verification failed for $file" }
}

Write-Host ""
Write-Host "Signed with a self-signed development certificate."
Write-Host "This does not establish SmartScreen reputation; use a public OV/EV certificate for distribution."
