#requires -Version 7.0
<#
.SYNOPSIS
  Build the OYM Link device app (and CLI for REL) from the Blackwell dashboard.

.DESCRIPTION
  DEV: cargo build of link/app in debug mode. It still needs the link Vite
       server at :1422 to render; this only produces the exe.
  REL: frontend build + release app (embedded assets, no Vite) + release CLI.
       The NSIS helper packer consumes these REL artifacts.
#>
param(
    [Parameter(Mandatory)]
    [ValidateSet("dev", "rel", "installer")]
    [string] $Profile
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$appManifest = Join-Path $root "link/app/src-tauri/Cargo.toml"
$cliManifest = Join-Path $root "link/Cargo.toml"

if ($Profile -eq "installer") {
    & $PSCommandPath -Profile rel
    if (-not $?) { throw "REL build failed; installer not built" }
    & cargo build --release --locked --manifest-path (Join-Path $root "link/service/Cargo.toml")
    if ($LASTEXITCODE -ne 0) { throw "service build failed with exit $LASTEXITCODE" }
    $installer = Join-Path $root "tmp/OYM-Link-Setup.exe"
    & (Join-Path $root "scripts/make-link-installer.ps1") -OutFile $installer
    if (-not $?) { throw "NSIS installer build failed" }
    Write-Host ""
    Write-Host "INSTALLER=$installer"
    exit 0
}

if ($Profile -eq "dev") {
    & cargo build --locked --manifest-path $appManifest
    if ($LASTEXITCODE -ne 0) { throw "cargo build (link DEV) failed with exit $LASTEXITCODE" }
    $app = Join-Path $root "link/app/src-tauri/target/debug/oym-link-app.exe"
    Write-Host ""
    Write-Host "APP=$app"
    Write-Host "NOTE=DEV needs the link Vite server at http://127.0.0.1:1422"
    exit 0
}

Push-Location (Join-Path $root "link/app")
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "link frontend build failed with exit $LASTEXITCODE" }
}
finally {
    Pop-Location
}

# Force a rebuild so the embedded dist is refreshed even when Rust sources did
# not change. A stale build-script cache has twice produced a PE carrying the
# Blackwell Ops DEV resource and window config; clean the app package so
# tauri-build re-reads link/app/src-tauri/tauri.conf.json.
(Get-Item $appManifest).LastWriteTime = Get-Date
$releaseTarget = Join-Path $root "link/app/src-tauri/target/release"
Get-ChildItem (Join-Path $releaseTarget "build") -Directory -Filter "oym-link-app-*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
Get-ChildItem (Join-Path $releaseTarget ".fingerprint") -Directory -Filter "oym-link-app-*" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
Remove-Item (Join-Path $releaseTarget "oym-link-app.exe") -Force -ErrorAction SilentlyContinue
& cargo build --locked --release --features custom-protocol --manifest-path $appManifest
if ($LASTEXITCODE -ne 0) { throw "cargo build (link REL app) failed with exit $LASTEXITCODE" }
$releaseApp = Join-Path $root "link/app/src-tauri/target/release/oym-link-app.exe"
$linkVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($releaseApp)
if ($linkVersion.ProductName -ne "OYM Link") {
    throw "link release PE has wrong metadata: ProductName='$($linkVersion.ProductName)' FileDescription='$($linkVersion.FileDescription)'"
}

$env:CARGO_TARGET_DIR = Join-Path $root "link/target"
& cargo build --locked --release --manifest-path $cliManifest
if ($LASTEXITCODE -ne 0) { throw "cargo build (link REL cli) failed with exit $LASTEXITCODE" }

$app = Join-Path $root "link/app/src-tauri/target/release/oym-link-app.exe"
$cli = Join-Path $root "link/target/release/oym-link.exe"
$pi = Join-Path $root "tmp/blackwell-link-package/pi"

# Stage a runnable portable folder. A raw app exe copied somewhere else cannot
# find oym-link.exe/pi; this keeps the exe-relative layout find_tool expects.
$package = Join-Path $root "tmp/link-rel-package"
if (Test-Path $package) { Remove-Item $package -Recurse -Force }
New-Item -ItemType Directory -Force -Path $package | Out-Null
Copy-Item $app (Join-Path $package "OYM Link.exe")
$runtime = Join-Path $package "runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item $cli (Join-Path $runtime "oym-link.exe")
if (Test-Path (Join-Path $pi "pi.exe")) {
    Copy-Item $pi (Join-Path $runtime "pi") -Recurse
}

Write-Host ""
Write-Host "APP=$app"
Write-Host "CLI=$cli"
Write-Host "PACKAGE=$package"
