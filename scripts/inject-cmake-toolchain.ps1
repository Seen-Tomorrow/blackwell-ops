# Add portable CMake to an existing toolchain tree (no CUDA/VS repopulate).
#
# Usage:
#   .\scripts\inject-cmake-toolchain.ps1
#   .\scripts\inject-cmake-toolchain.ps1 -ToolchainRoot "C:\path\to\toolchain"
#   .\scripts\inject-cmake-toolchain.ps1 -CmakeSrc "C:\Program Files\CMake"

param(
    [string]$ToolchainRoot = "",
    [string]$CmakeSrc = "C:\Program Files\CMake"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $ToolchainRoot) {
    $ToolchainRoot = Join-Path $RepoRoot "src-tauri\target\debug\toolchain"
}
if (-not (Test-Path (Join-Path $ToolchainRoot "manifest.json"))) {
    throw "Toolchain manifest missing at $ToolchainRoot"
}

$CmakeExe = Join-Path $CmakeSrc "bin\cmake.exe"
if (-not (Test-Path $CmakeExe)) {
    throw "cmake.exe not found at $CmakeExe"
}

function Copy-Tree([string]$Source, [string]$Dest) {
    if (-not (Test-Path $Source)) { throw "Source missing: $Source" }
    $parent = Split-Path $Dest -Parent
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Write-Host "  copy $Source -> $Dest"
    robocopy $Source $Dest /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) for $Source" }
}

$CmakeDest = Join-Path $ToolchainRoot "cmake"
Write-Host "=== Inject CMake ===" -ForegroundColor Cyan
Write-Host "Source: $CmakeSrc"
Write-Host "Target: $CmakeDest"

if (Test-Path $CmakeDest) {
    Remove-Item $CmakeDest -Recurse -Force
}
Copy-Tree (Join-Path $CmakeSrc "bin") (Join-Path $CmakeDest "bin")
Copy-Tree (Join-Path $CmakeSrc "share") (Join-Path $CmakeDest "share")

foreach ($dir in @("doc", "man")) {
    $p = Join-Path $CmakeDest $dir
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "  trimmed $dir/" }
}
Get-ChildItem (Join-Path $CmakeDest "share") -Directory -EA SilentlyContinue |
    Where-Object { $_.Name -notmatch '^cmake-' } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force; Write-Host "  trimmed share/$($_.Name)/" }

& (Join-Path $RepoRoot "scripts\toolchain-devcmd.ps1") -ToolchainRoot $ToolchainRoot

$destExe = Join-Path $CmakeDest "bin\cmake.exe"
if (-not (Test-Path $destExe)) { throw "Inject failed - $destExe missing" }
& $destExe --version
$mb = [math]::Round((Get-ChildItem $CmakeDest -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "`nCMake injected: $mb MB at $CmakeDest" -ForegroundColor Green