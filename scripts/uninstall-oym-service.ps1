#requires -Version 7.0
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
        & $wrapper uninstall | Out-Host
    }
    finally {
        Pop-Location
    }
}
else {
    sc.exe stop OymLink 2>$null | Out-Null
    sc.exe delete OymLink 2>$null | Out-Null
}

if ($RemoveFiles -and (Test-Path $ServiceDir)) {
    Remove-Item $ServiceDir -Recurse -Force
}
else {
    # The app detects installation by this XML. Leaving it behind made the UI
    # stay INTEGRATED after a successful uninstall.
    Remove-Item (Join-Path $ServiceDir "OymLink.xml") -Force -ErrorAction SilentlyContinue
}

sc.exe query OymLink 2>$null
@{ action = "uninstall"; ok = $true; at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() } |
    ConvertTo-Json | Set-Content $actionMarker -Encoding utf8NoBOM
