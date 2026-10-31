#requires -Version 7.0
<#
.SYNOPSIS
  Detached runner for OYM Link builds.

.DESCRIPTION
  Mirrors scripts/majestic/run-detached-chain.ps1: the visible PowerShell is
  the job, writes a status file the app polls, and mirrors all build output to
  a log. The app can restart without killing the build.
#>
param(
    [Parameter(Mandatory)]
    [ValidateSet("dev", "rel", "installer")]
    [string] $Profile,
    [Parameter(Mandatory)]
    [string] $StatusFile,
    [Parameter(Mandatory)]
    [string] $LogFile
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not [IO.Path]::IsPathRooted($StatusFile)) { $StatusFile = Join-Path $root $StatusFile }
if (-not [IO.Path]::IsPathRooted($LogFile)) { $LogFile = Join-Path $root $LogFile }

function Write-Status {
    param(
        [string] $State,
        [string] $Message,
        $Result = $null
    )
    $payload = [ordered]@{
        state     = $State
        profile   = $Profile
        message   = $Message
        updatedAt = (Get-Date).ToString("o")
        result    = $Result
    }
    $json = $payload | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText($StatusFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StatusFile) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null
[IO.File]::WriteAllText($LogFile, "", (New-Object System.Text.UTF8Encoding($false)))

try {
    Write-Status "running" "Starting $Profile build…"

    $builder = Join-Path $root "scripts/build-link.ps1"
    & $builder -Profile $Profile *>&1 | Tee-Object -FilePath $LogFile
    if ($LASTEXITCODE -ne 0) {
        throw "build-link.ps1 exited $LASTEXITCODE"
    }

    $app = if ($Profile -eq "dev") {
        Join-Path $root "link/app/src-tauri/target/debug/oym-link-app.exe"
    } else {
        Join-Path $root "link/app/src-tauri/target/release/oym-link-app.exe"
    }
    $cli = if ($Profile -eq "dev") {
        $null
    } else {
        Join-Path $root "link/target/release/oym-link.exe"
    }
    $package = if ($Profile -eq "dev") {
        $null
    } else {
        Join-Path $root "tmp/link-rel-package"
    }
    $installer = $null
    if ($Profile -eq "installer") {
        $built = Join-Path $root "tmp/OYM-Link-Setup.exe"
        $downloads = Join-Path $env:USERPROFILE "Downloads"
        $final = Join-Path $downloads "OYM-Link-Setup.exe"
        try {
            New-Item -ItemType Directory -Force -Path $downloads | Out-Null
            Copy-Item $built $final -Force
            $installer = $final
        } catch {
            Add-Content $LogFile "Could not copy installer to Downloads: $($_.Exception.Message)"
            $installer = $built
        }
    }

    $result = [ordered]@{
        profile   = $Profile
        app       = $app
        cli       = $cli
        package   = $package
        installer = $installer
    }
    Write-Status "success" "Built $Profile." $result
} catch {
    $message = $_.Exception.Message
    Add-Content $LogFile "FAILED: $message"
    Write-Status "failed" $message
    exit 1
}
