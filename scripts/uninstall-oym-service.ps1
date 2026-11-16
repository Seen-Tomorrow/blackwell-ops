#requires -Version 5.1
<#
.SYNOPSIS
  Stop and uninstall the OYM Link integrated service skeleton.
#>
param(
    [string] $ServiceDir = "$env:ProgramData\OYM\Link\service",
    [switch] $RemoveFiles
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell (Administrator)."
}

$baseDir = Join-Path $env:ProgramData "OYM\Link"
$actionMarker = Join-Path $baseDir "service-action.json"
Remove-Item $actionMarker -Force -ErrorAction SilentlyContinue

$wrapper = Join-Path $ServiceDir "OymLink.exe"
if (Test-Path $wrapper) {
    Push-Location $ServiceDir
    try {
        & $wrapper stop 2>$null | Out-Null
    }
    finally {
        Pop-Location
    }
}

# SCM only — never WinSW's `uninstall` verb. It deletes its own wrapper and the service
# binaries, which endpoint protection reads as a self-deleting executable: Bitdefender ATC
# classified the tray app as malware and blocked the whole OYM process tree (2026-11-16).
# Stopping and deleting the registration is all portable mode needs.
sc.exe stop OymLink 2>$null | Out-Null
for ($i = 0; $i -lt 40; $i++) {
    $query = sc.exe query OymLink 2>$null
    if (-not ($query -match "RUNNING")) { break }
    Start-Sleep -Milliseconds 250
}
sc.exe delete OymLink 2>$null | Out-Null

if ($RemoveFiles -and (Test-Path $ServiceDir)) {
    Remove-Item $ServiceDir -Recurse -Force
}
else {
    # The app detects installation by this XML. Leaving it behind made the UI
    # stay INTEGRATED after a successful uninstall.
    Remove-Item (Join-Path $ServiceDir "OymLink.xml") -Force -ErrorAction SilentlyContinue
}

sc.exe query OymLink 2>$null
$marker = @{ action = "uninstall"; ok = $true; at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() } | ConvertTo-Json
[IO.File]::WriteAllText($actionMarker, $marker, (New-Object System.Text.UTF8Encoding($false)))
