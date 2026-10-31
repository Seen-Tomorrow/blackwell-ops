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
    [string] $Bootstrap = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell (Administrator)."
}

$candidates = @(
    (Join-Path $root "link\service\target\release\oym-link-service.exe"),
    (Join-Path $root "link\service\target\debug\oym-link-service.exe")
)
$serviceExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $serviceExe) {
    throw "oym-link-service.exe not found. Build it: cargo build --release --manifest-path link\service\Cargo.toml"
}
$cli = Join-Path $root "remote-client/target/release/oym-link.exe"
$pi = Join-Path $root "tmp/blackwell-link-package/pi/pi.exe"
if (-not (Test-Path $cli)) { throw "Missing link CLI: $cli" }
if (-not (Test-Path $pi)) { throw "Missing Pi package: $pi" }

$xml = Join-Path $root "link\service\OymLink.xml"
if (-not (Test-Path $xml)) { throw "Missing $xml" }

New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null
Copy-Item $serviceExe (Join-Path $ServiceDir "oym-link-service.exe") -Force
Copy-Item $cli (Join-Path $ServiceDir "oym-link.exe") -Force
if (Test-Path (Join-Path $ServiceDir "pi")) { Remove-Item (Join-Path $ServiceDir "pi") -Recurse -Force }
Copy-Item (Split-Path -Parent $pi) (Join-Path $ServiceDir "pi") -Recurse
Copy-Item $xml (Join-Path $ServiceDir "OymLink.xml") -Force

# The desktop app writes the paired identity/token into a user-only bootstrap.
# Move it into ProgramData with a SYSTEM/Administrators-only ACL before the
# service starts. The service consumes and deletes it.
$baseDir = Join-Path $env:ProgramData "OYM\Link"
New-Item -ItemType Directory -Force -Path $baseDir | Out-Null
$serviceData = Join-Path $baseDir "service-data"
New-Item -ItemType Directory -Force -Path $serviceData | Out-Null
& icacls $serviceData /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" | Out-Null
if ($Bootstrap -ne "") {
    if (-not (Test-Path $Bootstrap)) { throw "Bootstrap file not found: $Bootstrap" }
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
