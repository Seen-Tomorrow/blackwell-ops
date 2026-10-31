#requires -Version 7.0
<#
.SYNOPSIS
  Install the OYM Link integrated service skeleton (WinSW host, LocalSystem).

.DESCRIPTION
  Copies the service host and WinSW into %ProgramData%\OYM\Link\service, installs
  the `OymLink` service, and starts it. Requires an elevated PowerShell.

  This is a skeleton: the service writes a heartbeat status file. It does not own
  the remote link yet, so Portable remains the functional servicing mode.
#>
param(
    [string] $ServiceDir = "$env:ProgramData\OYM\Link\service",
    [string] $WinSWPath = "",
    [string] $Bootstrap = "",
    [string] $ServiceExe = "",
    [string] $Cli = "",
    [string] $PiDir = "",
    [string] $Xml = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell (Administrator)."
}

$installLogDir = Join-Path $env:ProgramData "OYM\Link"
New-Item -ItemType Directory -Force -Path $installLogDir | Out-Null
$actionMarker = Join-Path $installLogDir "service-action.json"
Remove-Item $actionMarker -Force -ErrorAction SilentlyContinue
try {
    Start-Transcript -Path (Join-Path $installLogDir "service-install.log") -Force | Out-Null
}
catch {}

if (-not $ServiceExe) {
    $candidates = @(
        (Join-Path $root "link\service\target\release\oym-link-service.exe"),
        (Join-Path $root "link\service\target\debug\oym-link-service.exe")
    )
    $ServiceExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $ServiceExe -or -not (Test-Path $ServiceExe)) {
    throw "oym-link-service.exe not found. Build it: cargo build --release --manifest-path link\service\Cargo.toml"
}
if (-not $Cli) {
    $Cli = Join-Path $root "link/target/release/oym-link.exe"
}
if (-not $PiDir) {
    $PiDir = Join-Path $root "tmp/blackwell-link-package/pi"
}
if (-not (Test-Path $Cli)) { throw "Missing link CLI: $Cli" }
if (-not (Test-Path (Join-Path $PiDir "pi.exe"))) { throw "Missing Pi package: $PiDir" }
if (-not $Xml) {
    $Xml = Join-Path $root "link\service\OymLink.xml"
}
if (-not (Test-Path $Xml)) { throw "Missing service XML: $Xml" }

New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null
# Stop/uninstall the old service before copying: Windows locks the running
# service exe, and the previous order silently left the old binary in place.
$existingWrapper = Join-Path $ServiceDir "OymLink.exe"
if (Test-Path $existingWrapper) {
    Push-Location $ServiceDir
    try {
        & $existingWrapper stop 2>$null | Out-Null
        & $existingWrapper uninstall 2>$null | Out-Null
    }
    finally {
        Pop-Location
    }
    Start-Sleep -Seconds 2
}
Copy-Item $ServiceExe (Join-Path $ServiceDir "oym-link-service.exe") -Force
Copy-Item $Cli (Join-Path $ServiceDir "oym-link.exe") -Force
if (Test-Path (Join-Path $ServiceDir "pi")) { Remove-Item (Join-Path $ServiceDir "pi") -Recurse -Force }
Copy-Item $PiDir (Join-Path $ServiceDir "pi") -Recurse
Copy-Item $Xml (Join-Path $ServiceDir "OymLink.xml") -Force

# The desktop app writes the paired identity/token into a user-only bootstrap.
# Move it into ProgramData with a SYSTEM/Administrators-only ACL before the
# service starts. The service consumes and deletes it.
$baseDir = Join-Path $env:ProgramData "OYM\Link"
New-Item -ItemType Directory -Force -Path $baseDir | Out-Null
$controlDir = Join-Path $baseDir "control"
New-Item -ItemType Directory -Force -Path $controlDir | Out-Null
# Authenticated Users may flip the emergency network-off flag without UAC;
# the service watches it and kills its link child immediately.
& icacls $controlDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "*S-1-5-11:(OI)(CI)(M)" | Out-Null
$serviceData = Join-Path $baseDir "service-data"
New-Item -ItemType Directory -Force -Path $serviceData | Out-Null
& icacls $serviceData /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" | Out-Null
# Reuse the portable Pi tool cache so SYSTEM sessions do not re-download fd/rg
# on every reconnect.
$localTools = Join-Path $env:LOCALAPPDATA "OYM\Link\local-pi-home\bin"
$serviceTools = Join-Path $serviceData "tools\bin"
New-Item -ItemType Directory -Force -Path $serviceTools | Out-Null
foreach ($tool in @("fd.exe", "rg.exe")) {
    $source = Join-Path $localTools $tool
    if (Test-Path $source) {
        Copy-Item $source (Join-Path $serviceTools $tool) -Force
    }
}
if ($Bootstrap -ne "") {
    if (-not (Test-Path $Bootstrap)) { throw "Bootstrap file not found: $Bootstrap" }
    # A fresh install must not inherit a malformed identity/token from an older
    # service-data directory.
    Remove-Item (Join-Path $serviceData "identity.json") -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $serviceData "device.token") -Force -ErrorAction SilentlyContinue
    $target = Join-Path $baseDir "service-bootstrap.json"
    Copy-Item $Bootstrap $target -Force
    & icacls $target /inheritance:r /grant:r "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null
    Remove-Item $Bootstrap -Force -ErrorAction SilentlyContinue
}

if (-not $WinSWPath) {
    $WinSWPath = Join-Path $ServiceDir "WinSW.exe"
    if (-not (Test-Path $WinSWPath)) {
        Invoke-WebRequest "https://github.com/winsw/winsw/releases/latest/download/WinSW-x64.exe" `
            -OutFile $WinSWPath -UseBasicParsing
    }
}
if (-not (Test-Path $WinSWPath)) { throw "WinSW executable not found: $WinSWPath" }

$wrapper = Join-Path $ServiceDir "OymLink.exe"
Copy-Item $WinSWPath $wrapper -Force

Push-Location $ServiceDir
try {
    & $wrapper stop 2>$null | Out-Null
    & $wrapper uninstall 2>$null | Out-Null
    & $wrapper install | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "WinSW install failed with exit $LASTEXITCODE" }
    & $wrapper start | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "WinSW start failed with exit $LASTEXITCODE" }
}
finally {
    Pop-Location
}

Start-Sleep -Seconds 2
sc.exe query OymLink
Get-Content "$env:ProgramData\OYM\Link\service-status.json" -ErrorAction SilentlyContinue
try { Stop-Transcript | Out-Null } catch {}
@{ action = "install"; ok = $true; at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() } |
    ConvertTo-Json | Set-Content $actionMarker -Encoding utf8NoBOM
