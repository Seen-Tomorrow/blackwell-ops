# Pack *bare minimum* CUDA runtime DLLs (cublas + cudart only) for driver-only machines.
# Matches exactly what upstream llama.cpp ships in their cudart-llama-bin-*.zip packages.
# Use the full toolchain pack if you need to run Foundry cmake builds.
#
# Usage:
#   .\scripts\pack-foundry-runtime.ps1
#   .\scripts\pack-foundry-runtime.ps1 -AppRoot "C:\path\to\target\debug" -Output "work\toolchain-runtime.7z"

param(
    [string]$AppRoot = "",
    [string]$ToolchainRoot = "",
    [string]$Output = "",
    [ValidateRange(1, 9)]
    [int]$CompressionLevel = 7
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Use the bundled 7z from src-tauri/bin (always available, no dependency on user's system).
$SevenZip = Join-Path $RepoRoot "src-tauri\bin\7z.exe"
if (-not (Test-Path $SevenZip)) {
    throw "Bundled 7z.exe not found at $SevenZip. Make sure it (and 7z.dll) are in src-tauri\bin."
}

if ($ToolchainRoot) {
    $SourceRoot = $ToolchainRoot
} else {
    if (-not $AppRoot) {
        $AppRoot = Join-Path $RepoRoot "src-tauri\target\debug"
    }
    $SourceRoot = Join-Path $AppRoot "toolchain"
}
if (-not $Output) {
    $Output = Join-Path $RepoRoot "work\toolchain-runtime.7z"
}

# Force $Output to an absolute path. This prevents 7z from resolving it
# relative to the staging directory during Push-Location (the root cause
# of archives landing in the wrong place like pack-runtime-staging/work/).
if (-not [System.IO.Path]::IsPathRooted($Output)) {
    $Output = Join-Path $RepoRoot $Output
}
$Output = [System.IO.Path]::GetFullPath($Output)

if (-not (Test-Path (Join-Path $SourceRoot "manifest.json"))) {
    throw "Toolchain not found: $SourceRoot — run populate-foundry-toolchain.ps1 first"
}

$staging = Join-Path $RepoRoot "work\pack-runtime-staging"
$destRoot = Join-Path $staging "toolchain"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $destRoot -Force | Out-Null

Copy-Item (Join-Path $SourceRoot "manifest.json") (Join-Path $destRoot "manifest.json")

$keepDllPatterns = @(
    "cublas64_*.dll", "cublasLt64_*.dll", "cudart64_*.dll"
)

foreach ($ver in @("v12.8", "v13.3")) {
    $srcCuda = Join-Path $SourceRoot "cuda\$ver"
    if (-not (Test-Path $srcCuda)) { continue }
    foreach ($binRel in @("bin", "bin\x64")) {
        $srcBin = Join-Path $srcCuda $binRel
        if (-not (Test-Path $srcBin)) { continue }
        $dstBin = Join-Path $destRoot "cuda\$ver\$binRel"
        New-Item -ItemType Directory -Path $dstBin -Force | Out-Null
        foreach ($pattern in $keepDllPatterns) {
            Get-ChildItem $srcBin -File -Filter $pattern -EA SilentlyContinue | ForEach-Object {
                Copy-Item $_.FullName (Join-Path $dstBin $_.Name) -Force
            }
        }
    }
    $verJson = Join-Path $srcCuda "version.json"
    if (Test-Path $verJson) {
        $dstVerDir = Join-Path $destRoot "cuda\$ver"
        Copy-Item $verJson (Join-Path $dstVerDir "version.json") -Force
    }
}

$beforeMb = [math]::Round((Get-ChildItem $destRoot -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "Runtime staging: $beforeMb MB" -ForegroundColor Cyan

$outDir = Split-Path $Output -Parent
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
if (Test-Path $Output) { Remove-Item $Output -Force }

# Use absolute paths for both the archive and the source tree.
# This avoids any relative-path resolution problems when the CWD changes
# (previously caused archives to be written inside pack-runtime-staging\work\).
$sourceToPack = Join-Path $staging "toolchain"
& $SevenZip a -t7z "-mx=$CompressionLevel" -mmt=on $Output $sourceToPack
if ($LASTEXITCODE -ne 0) { throw "7z failed with exit $LASTEXITCODE" }

$zipMb = [math]::Round((Get-Item $Output).Length / 1MB, 1)
Write-Host "Archive: $zipMb MB -> $Output" -ForegroundColor Green