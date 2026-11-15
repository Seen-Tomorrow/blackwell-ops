#requires -Version 5.1
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
    [string] $Xml = "",
    # Opt-in: give this service the test-shell profile (docs/remote-servicing/TEST-SHELL.md).
    # Scoped to the service so the flag disappears with an uninstall, instead of a
    # machine-wide environment change that outlives the feature.
    [switch] $TestShell = $false,
    # Pinned on purpose. An installer that resolves its own dependency at run time
    # cannot be reproduced, and a swapped asset would be accepted silently.
    [string] $WinSWUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe",
    [string] $WinSWSha256 = "05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA"
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

# Windows locks a running service image, so the service is stopped before the
# files are replaced — but it is NOT uninstalled. Tearing down the registration
# on every update logs a 7045, costs ~13 s, and widens the window where the old
# child tree can outlive the service. Runtime configuration (executable,
# arguments, env, logging) is read from OymLink.xml at every start, so a
# stop/start cycle covers it; only SCM-owned settings (account, start mode,
# dependencies) need a real uninstall, which `uninstall-oym-service.ps1` does.
$serviceName = "OymLink"
$registered = $null -ne (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)
if ($registered) {
    Write-Host "Stopping $serviceName (registration kept)..."
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
        if ((Get-Service -Name $serviceName -ErrorAction SilentlyContinue).Status -eq "Stopped") { break }
        Start-Sleep -Milliseconds 500
    }
}

# A just-stopped service can hold its image for a moment, and an orphaned child
# can still hold the CLI. Retry instead of failing the whole install.
function Copy-WithRetry {
    param([string]$From, [string]$To, [int]$Attempts = 30)
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            Copy-Item -LiteralPath $From -Destination $To -Force -ErrorAction Stop
            return
        }
        catch {
            if ($i -eq $Attempts) { throw }
            Start-Sleep -Milliseconds 400
        }
    }
}

Copy-WithRetry $ServiceExe (Join-Path $ServiceDir "oym-link-service.exe")
Copy-WithRetry $Cli (Join-Path $ServiceDir "oym-link.exe")
if (Test-Path (Join-Path $ServiceDir "pi")) { Remove-Item (Join-Path $ServiceDir "pi") -Recurse -Force }
Copy-Item $PiDir (Join-Path $ServiceDir "pi") -Recurse
$xmlTarget = Join-Path $ServiceDir "OymLink.xml"
Copy-WithRetry $Xml $xmlTarget

# WinSW reads this file at every start, so runtime settings (executable,
# arguments, env, logging) can be changed by editing it and restarting — no
# uninstall needed. The test shell is injected here rather than set machine-wide.
if ($TestShell) {
    $xmlRaw = Get-Content -LiteralPath $xmlTarget -Raw
    if ($xmlRaw -notmatch 'OYM_TEST_SHELL') {
        $xmlRaw = $xmlRaw -replace '</service>', "  <env name=`"OYM_TEST_SHELL`" value=`"1`" />`n</service>"
        [IO.File]::WriteAllText($xmlTarget, $xmlRaw, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Test shell enabled for this service (OYM_TEST_SHELL=1)."
    }
}

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

# Pin the wrapper. An update reuses the installed binary when it already matches
# the audited hash: no 18 MB re-download, and a tampered copy is detected rather
# than silently accepted.
$wrapper = Join-Path $ServiceDir "OymLink.exe"
$wrapperAlreadyPinned = (Test-Path $wrapper) -and
    ((Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash -eq $WinSWSha256)

if ($WinSWPath) {
    if (-not (Test-Path $WinSWPath)) { throw "WinSW executable not found: $WinSWPath" }
    $actual = (Get-FileHash -LiteralPath $WinSWPath -Algorithm SHA256).Hash
    if ($actual -ne $WinSWSha256) {
        throw "WinSW hash mismatch for $WinSWPath; expected $WinSWSha256, got $actual"
    }
    Copy-WithRetry $WinSWPath $wrapper
}
elseif (-not $wrapperAlreadyPinned) {
    $cached = Join-Path $ServiceDir "WinSW-x64.exe"
    if (-not (Test-Path $cached)) {
        Write-Host "Downloading pinned WinSW..."
        Invoke-WebRequest $WinSWUrl -OutFile $cached -UseBasicParsing
    }
    $actual = (Get-FileHash -LiteralPath $cached -Algorithm SHA256).Hash
    if ($actual -ne $WinSWSha256) {
        Remove-Item -LiteralPath $cached -Force -ErrorAction SilentlyContinue
        throw "WinSW hash mismatch; expected $WinSWSha256, got $actual"
    }
    Copy-WithRetry $cached $wrapper
}

Push-Location $ServiceDir
try {
    if (-not $registered) {
        Write-Host "Registering $serviceName..."
        & $wrapper install | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "WinSW install failed with exit $LASTEXITCODE" }
    }
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
$marker = @{ action = "install"; ok = $true; at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() } | ConvertTo-Json
[IO.File]::WriteAllText($actionMarker, $marker, (New-Object System.Text.UTF8Encoding($false)))
