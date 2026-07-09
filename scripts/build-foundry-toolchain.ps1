# One-step Foundry toolchain rebuild + pack for GitHub release upload.
# Full build prerequisites: VS 2022/2026 Build Tools, Windows SDK, CUDA 12.8 + 13.3, CMake.
#
# Usage:
#   .\scripts\build-foundry-toolchain.ps1
#   .\scripts\build-foundry-toolchain.ps1 -RepackOnly

param(
    [string]$AppRoot = "",
    [string]$Output = "",
    [switch]$RepackOnly,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $AppRoot) {
    $AppRoot = Join-Path $RepoRoot "src-tauri\target\debug"
}
if (-not $Output) {
    $Output = Join-Path $RepoRoot "work\toolchain.7z"
}
$ToolchainRoot = Join-Path $AppRoot "toolchain"
$SevenZip = Join-Path $RepoRoot "src-tauri\bin\7z.exe"

function Test-HostPath([string]$Label, [string]$Path, [switch]$Required) {
    if (Test-Path $Path) {
        Write-Host "  [ok] $Label" -ForegroundColor Green
        return $true
    }
    Write-Host "  [missing] $Label`n         $Path" -ForegroundColor Red
    if ($Required) { $script:PreflightFailed = $true }
    return $false
}

function Invoke-Step([string]$Title, [scriptblock]$Action) {
    Write-Host "`n=== $Title ===" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        throw "$Title failed (exit $LASTEXITCODE)"
    }
}

Write-Host "=== Foundry Toolchain Build ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"
Write-Host "App root: $AppRoot"
Write-Host "Output: $Output"
if ($RepackOnly) {
    Write-Host "Mode: REPACK ONLY (existing tree, no host VS/CUDA)" -ForegroundColor Yellow
} else {
    Write-Host "Mode: FULL (preflight + populate from host)" -ForegroundColor Yellow
}

if (-not (Test-Path $SevenZip)) {
    throw "Bundled 7z.exe not found at $SevenZip"
}

if ($RepackOnly) {
    Write-Host "Using existing tree: $ToolchainRoot" -ForegroundColor Green
    & (Join-Path $RepoRoot "scripts\toolchain-validate.ps1") -ToolchainRoot $ToolchainRoot
} else {
    $PreflightFailed = $false
    Write-Host "`n--- Preflight (host installs) ---" -ForegroundColor Yellow
    Test-HostPath "VS 2022 Build Tools" "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" -Required | Out-Null
    Test-HostPath "VS 2026 Build Tools" "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools" -Required | Out-Null
    $sdkOk = (Test-Path "C:\BuildTools\Windows Kits") -or (Test-Path "C:\Program Files (x86)\Windows Kits")
    if ($sdkOk) {
        Write-Host "  [ok] Windows SDK" -ForegroundColor Green
    } else {
        Write-Host "  [missing] Windows SDK`n         C:\BuildTools\Windows Kits or Program Files (x86)\Windows Kits" -ForegroundColor Red
        $PreflightFailed = $true
    }
    Test-HostPath "CUDA 12.8" "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.8" -Required | Out-Null
    Test-HostPath "CUDA 13.3" "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3" -Required | Out-Null
    $cmakeOk = (Test-Path "C:\Program Files\CMake\bin\cmake.exe") `
        -or (Test-Path "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe") `
        -or (Test-Path "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe")
    if ($cmakeOk) {
        Write-Host "  [ok] CMake" -ForegroundColor Green
    } else {
        Write-Host "  [missing] CMake`n         Install standalone CMake or VS CMake component" -ForegroundColor Red
        $PreflightFailed = $true
    }
    if ($PreflightFailed) {
        throw "Preflight failed - install missing components in default locations, then re-run. For slim/pack only use: -RepackOnly"
    }

    $answer = Read-Host "`nFull rebuild from host VS/CUDA? This replaces $ToolchainRoot [Y/n]"
    if ($answer -match '^[Nn]') {
        throw "Aborted - use -RepackOnly to slim/pack an existing tree."
    }
    Invoke-Step "Populate from host" {
        & (Join-Path $RepoRoot "scripts\populate-foundry-toolchain.ps1") -AppRoot $AppRoot
    }
    if (-not $SkipSmokeTest) {
        $smoke = Read-Host "Run cmake smoke tests (frontier + stable)? [y/N]"
        if ($smoke -match '^[Yy]') {
            foreach ($profile in @("frontier", "stable")) {
                Invoke-Step "Smoke test ($profile)" {
                    & (Join-Path $RepoRoot "scripts\test-foundry-configure.ps1") -AppRoot $AppRoot -Profile $profile
                }
            }
        }
    }
}

Invoke-Step "Slim + pack" {
    & (Join-Path $RepoRoot "scripts\pack-foundry-toolchain.ps1") -AppRoot $AppRoot -Output $Output
}

$zipMb = [math]::Round((Get-Item $Output).Length / 1MB, 1)
$zipGb = [math]::Round((Get-Item $Output).Length / 1GB, 3)
if ($zipMb -lt 100) {
    throw "Refusing success: archive is only $zipMb MB - expected about 1100+ MB. Tree was empty or pack failed."
}
Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "Archive: $Output"
Write-Host "Size: $zipMb MB ($zipGb GB)"
Write-Host "Upload toolchain.7z to GitHub release tag: toolchain"