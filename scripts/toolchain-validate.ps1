# Sanity checks before slim/pack - refuse empty or gutted toolchain trees.
#
# Usage:
#   .\scripts\toolchain-validate.ps1 -ToolchainRoot "C:\path\to\toolchain"

param(
    [Parameter(Mandatory)]
    [string]$ToolchainRoot
)

$ErrorActionPreference = "Stop"

function Test-ToolchainFile([string]$Label, [string]$RelativePath) {
    $path = Join-Path $ToolchainRoot ($RelativePath -replace '/', '\')
    if (Test-Path $path) { return $path }
    throw "Toolchain incomplete: missing $Label at $path"
}

function Get-ToolchainUncompressedGb([string]$Root) {
    if (-not (Test-Path $Root)) { return 0 }
    $bytes = (Get-ChildItem $Root -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
    return [math]::Round($bytes / 1GB, 2)
}

if (-not (Test-Path (Join-Path $ToolchainRoot "manifest.json"))) {
    throw "manifest.json missing under $ToolchainRoot"
}

$manifest = Get-Content (Join-Path $ToolchainRoot "manifest.json") -Raw | ConvertFrom-Json
foreach ($prop in $manifest.vs.PSObject.Properties) {
    $vsKey = $prop.Name
    $vsDef = $prop.Value
    $devcmdRel = ($vsDef.devcmd -replace '/', '\')
    Test-ToolchainFile "VS $vsKey devcmd" $devcmdRel | Out-Null
    $clRel = "vs/$vsKey/VC/Tools/MSVC/$($vsDef.msvc_version)/bin/Hostx64/x64/cl.exe"
    Test-ToolchainFile "VS $vsKey cl.exe" $clRel | Out-Null
}

foreach ($prof in $manifest.profiles) {
    $nvccRel = "cuda/v$($prof.cuda)/bin/nvcc.exe"
    Test-ToolchainFile "CUDA $($prof.cuda) nvcc" $nvccRel | Out-Null
}

Test-ToolchainFile "portable cmake" "cmake/bin/cmake.exe" | Out-Null
Test-ToolchainFile "Windows SDK" "Windows Kits/10/Include/10.0.26100.0/um/windows.h" | Out-Null

$gb = Get-ToolchainUncompressedGb $ToolchainRoot
if ($gb -lt 1.0) {
    throw @"
Toolchain tree is too small ($gb GB under $ToolchainRoot).
Expected about 4+ GB uncompressed (VS + SDK + CUDA + CMake).

Your debug tree may have been wiped or never populated. Restore options:
  1. Extract a good toolchain.7z into src-tauri\target\debug (Extract Here)
  2. Copy work\pack-test-full-trimmed -> target\debug\toolchain, then inject-cmake if needed
  3. Full rebuild: build-foundry-toolchain.ps1 (requires host VS/CUDA)
"@
}

Write-Host "Toolchain OK: $gb GB at $ToolchainRoot" -ForegroundColor Green