# Pack slimmed portable toolchain into a single 7z (GitHub 2 GB asset limit).
#
# Usage:
#   .\scripts\pack-foundry-toolchain.ps1
#   .\scripts\pack-foundry-toolchain.ps1 -AppRoot "C:\path\to\install" -Output "C:\out\toolchain.7z"
#   .\scripts\pack-foundry-toolchain.ps1 -CompressionLevel 7

param(
    [string]$AppRoot = "",
    [string]$Output = "",
    [ValidateSet("full", "frontier")]
    [string]$PackProfile = "full",
    [ValidateRange(1, 9)]
    [int]$CompressionLevel = 7
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $AppRoot) {
    $AppRoot = Join-Path $RepoRoot "src-tauri\target\debug"
}
$ToolchainRoot = Join-Path $AppRoot "toolchain"
if (-not $Output) {
    $Output = Join-Path $RepoRoot "work\toolchain.7z"
}

if (-not (Test-Path $ToolchainRoot)) {
    throw "Toolchain not found: $ToolchainRoot — run populate-foundry-toolchain.ps1 first"
}

& (Join-Path $RepoRoot "scripts\slim-foundry-toolchain.ps1") -ToolchainRoot $ToolchainRoot -PackProfile $PackProfile

$outDir = Split-Path $Output -Parent
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
if (Test-Path $Output) { Remove-Item $Output -Force }

$beforeGb = [math]::Round((Get-ChildItem $ToolchainRoot -Recurse -File | Measure-Object Length -Sum).Sum / 1GB, 2)
Write-Host "Packing $beforeGb GB from $ToolchainRoot -> $Output (mx=$CompressionLevel)" -ForegroundColor Cyan

# Archive paths must be under toolchain/ so 1-click extract lands in app_root/toolchain/
$toolchainParent = Split-Path $ToolchainRoot -Parent
Push-Location $toolchainParent
try {
    & 7z a -t7z "-mx=$CompressionLevel" -mmt=on $Output "toolchain\*"
} finally {
    Pop-Location
}
if ($LASTEXITCODE -ne 0) { throw "7z failed with exit $LASTEXITCODE" }

$zipMb = [math]::Round((Get-Item $Output).Length / 1MB, 1)
$zipGb = [math]::Round((Get-Item $Output).Length / 1GB, 3)
Write-Host "Archive: $zipMb MB ($zipGb GB)" -ForegroundColor Green
if ($zipGb -ge 2.0) {
    Write-Warning "Over GitHub 2 GB single-file limit — trim more or split."
}