# Aggressive trim for portable Foundry toolchain (Windows x64 only).
# Goal: single 7z under GitHub 2 GB with -mx7 while keeping Foundry cmake builds + ggml CUDA runtime DLLs.
#
# Usage:
#   .\scripts\slim-foundry-toolchain.ps1 -ToolchainRoot "C:\path\to\toolchain"
#   .\scripts\slim-foundry-toolchain.ps1 -ToolchainRoot "...\target\debug\toolchain" -PackProfile frontier
#   .\scripts\slim-foundry-toolchain.ps1 -ToolchainRoot "...\target\debug\toolchain" -WhatIf

param(
    [Parameter(Mandatory)]
    [string]$ToolchainRoot,
    [ValidateSet("full", "frontier")]
    [string]$PackProfile = "full",
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

function Remove-TreeIfExists([string]$Path) {
    if (-not (Test-Path $Path)) { return 0 }
    $bytes = (Get-ChildItem $Path -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum
    if (-not $WhatIf) { Remove-Item $Path -Recurse -Force }
    return $bytes
}

function Remove-FileIfExists([string]$Path) {
    if (-not (Test-Path $Path)) { return 0 }
    $bytes = (Get-Item $Path).Length
    if (-not $WhatIf) { Remove-Item $Path -Force }
    return $bytes
}

function Remove-GlobFiles([string]$Root, [string]$Pattern) {
    $freed = 0L
    Get-ChildItem $Root -Recurse -File -Filter $Pattern -EA SilentlyContinue | ForEach-Object {
        $freed += $_.Length
        if (-not $WhatIf) { Remove-Item $_.FullName -Force }
    }
    return $freed
}

function Remove-CudaBinBloat([string]$CudaVerRoot) {
    $freed = 0L
    $binDirs = @(
        (Join-Path $CudaVerRoot "bin"),
        (Join-Path $CudaVerRoot "bin\x64")
    )
    $dropDllPatterns = @(
        "cufft*.dll", "cufftw*.dll",
        "cusparse*.dll", "cusolver*.dll",
        "curand*.dll", "npp*.dll",
        "nvjpeg*.dll", "nvblas*.dll",
        "cuinj*.dll"
    )
    $dropExePatterns = @(
        "nvprof.exe", "nvvp.exe", "nsys*.exe",
        "cuda-memcheck*.exe", "compute-sanitizer.exe"
    )
    foreach ($binDir in $binDirs) {
        if (-not (Test-Path $binDir)) { continue }
        foreach ($pattern in $dropDllPatterns) {
            $freed += Remove-GlobFiles $binDir $pattern
        }
        foreach ($pattern in $dropExePatterns) {
            $freed += Remove-GlobFiles $binDir $pattern
        }
    }
    return $freed
}

if (-not (Test-Path $ToolchainRoot)) {
    throw "Toolchain root not found: $ToolchainRoot"
}

$manifest = Join-Path $ToolchainRoot "manifest.json"
if (-not (Test-Path $manifest)) {
    throw "manifest.json missing under $ToolchainRoot"
}

Write-Host "=== Slim Foundry Toolchain ===" -ForegroundColor Cyan
Write-Host "Root: $ToolchainRoot"
Write-Host "Pack profile: $PackProfile"
if ($WhatIf) { Write-Host "WhatIf: no files will be deleted" -ForegroundColor Yellow }

$totalFreed = 0L

# --- CUDA: keep nvcc + headers + small link stubs + bin/x64 runtime DLLs ---
$cudaRoot = Join-Path $ToolchainRoot "cuda"
if (Test-Path $cudaRoot) {
    Write-Host "`n--- CUDA ---" -ForegroundColor Yellow
    $cudaLibDrop = @(
        "nvrtc_static.lib",
        "nvJitLink_static.lib",
        "nvptxcompiler_static.lib"
    )
    foreach ($verDir in Get-ChildItem $cudaRoot -Directory) {
        $libX64 = Join-Path $verDir.FullName "lib\x64"
        foreach ($name in $cudaLibDrop) {
            $totalFreed += Remove-FileIfExists (Join-Path $libX64 $name)
        }
        # NPP / solver / FFT / sparse — not used by ggml llama CUDA builds
        foreach ($pattern in @("npp*.lib", "cusolver*.lib", "cufft*.lib", "curand*.lib", "cusparse*.lib", "nvjpeg*.lib", "nvblas*.lib")) {
            $totalFreed += Remove-GlobFiles $libX64 $pattern
        }
        foreach ($dir in @("doc", "docs", "samples", "src", "compute-sanitizer", "libnvvp", "extras", "tools")) {
            $totalFreed += Remove-TreeIfExists (Join-Path $verDir.FullName $dir)
        }
        Get-ChildItem $verDir.FullName -Directory -EA SilentlyContinue |
            Where-Object { $_.Name -match '^(?i)nsight' } |
            ForEach-Object { $totalFreed += Remove-TreeIfExists $_.FullName }
        foreach ($f in @("EULA.txt", "CUDA_Toolkit_Release_Notes.txt", "LICENSE")) {
            $totalFreed += Remove-FileIfExists (Join-Path $verDir.FullName $f)
        }
        # Runtime DLL bloat (cufft/NPP/solver) — ggml needs cublas/Lt + cudart + nvJitLink/nvrtc only
        $totalFreed += Remove-CudaBinBloat $verDir.FullName
    }
    # Drop CUDA versions not in manifest profiles (frontier=13.3, stable=12.8)
    $keepCuda = if ($PackProfile -eq "frontier") { @("v13.3") } else { @("v12.8", "v13.3") }
    foreach ($verDir in Get-ChildItem $cudaRoot -Directory) {
        if ($keepCuda -notcontains $verDir.Name) {
            Write-Host "  remove cuda/$($verDir.Name) (pack profile $PackProfile)"
            $totalFreed += Remove-TreeIfExists $verDir.FullName
        }
    }
}

# --- MSVC: x64 desktop only ---
$vsRoot = Join-Path $ToolchainRoot "vs"
if (Test-Path $vsRoot) {
    Write-Host "`n--- Visual Studio ---" -ForegroundColor Yellow
    $keepVs = if ($PackProfile -eq "frontier") { @("2026") } else { @("2022", "2026") }
    foreach ($vsDir in Get-ChildItem $vsRoot -Directory) {
        if ($keepVs -notcontains $vsDir.Name) {
            Write-Host "  remove vs/$($vsDir.Name) (pack profile $PackProfile)"
            $totalFreed += Remove-TreeIfExists $vsDir.FullName
            continue
        }
        $msvcRoot = Get-ChildItem (Join-Path $vsDir.FullName "VC\Tools\MSVC") -Directory -EA SilentlyContinue | Select-Object -First 1
        if (-not $msvcRoot) { continue }
        $libRoot = Join-Path $msvcRoot.FullName "lib"
        foreach ($arch in @("arm64", "x86", "onecore")) {
            $totalFreed += Remove-TreeIfExists (Join-Path $libRoot $arch)
        }
        $binRoot = Join-Path $msvcRoot.FullName "bin"
        foreach ($hostDir in @("Hostx86", "HostArm64")) {
            $totalFreed += Remove-TreeIfExists (Join-Path $binRoot $hostDir)
        }
        # MSBuild cruft (Python Tools only — harmless to delete for cmake builds)
        $pyTools = Get-ChildItem (Join-Path $vsDir.FullName "MSBuild\Microsoft") -Recurse -Directory -Filter "Python Tools" -EA SilentlyContinue
        foreach ($d in $pyTools) { $totalFreed += Remove-TreeIfExists $d.FullName }
    }
}

# --- CMake: keep bin + Modules; drop docs/man ---
$cmakeRoot = Join-Path $ToolchainRoot "cmake"
if (Test-Path $cmakeRoot) {
    Write-Host "`n--- Portable CMake ---" -ForegroundColor Yellow
    foreach ($dir in @("doc", "man")) {
        $totalFreed += Remove-TreeIfExists (Join-Path $cmakeRoot $dir)
    }
    Get-ChildItem (Join-Path $cmakeRoot "share") -Directory -EA SilentlyContinue |
        Where-Object { $_.Name -notmatch '^cmake-' } |
        ForEach-Object { $totalFreed += Remove-TreeIfExists $_.FullName }
}

# --- Windows SDK: native C/C++ only (no WinRT / cppwinrt) ---
$kitsInc = Join-Path $ToolchainRoot "Windows Kits\10\Include\10.0.26100.0"
if (Test-Path $kitsInc) {
    Write-Host "`n--- Windows SDK headers ---" -ForegroundColor Yellow
    foreach ($dir in @("winrt", "cppwinrt")) {
        $totalFreed += Remove-TreeIfExists (Join-Path $kitsInc $dir)
    }
}
$kitsRedist = Join-Path $ToolchainRoot "Windows Kits\10\Redist"
if (Test-Path $kitsRedist) {
    $totalFreed += Remove-TreeIfExists $kitsRedist
}

$freedGb = [math]::Round($totalFreed / 1GB, 2)
$remainGb = [math]::Round((Get-ChildItem $ToolchainRoot -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB, 2)
Write-Host "`n=== Slim complete ===" -ForegroundColor Green
Write-Host "Freed: $freedGb GB"
Write-Host "Remaining: $remainGb GB"