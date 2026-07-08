# Populates <app_root>/toolchain/ with portable VS + CUDA trees.
# Moderate CUDA trim only - removes obvious non-build bulk.
#
# Usage:
#   .\scripts\populate-foundry-toolchain.ps1
#   .\scripts\populate-foundry-toolchain.ps1 -AppRoot "C:\path\to\target\debug"
#   .\scripts\populate-foundry-toolchain.ps1 -SkipCuda

param(
    [string]$AppRoot = "",
    [switch]$SkipCuda
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $AppRoot) {
    $AppRoot = Join-Path $RepoRoot "src-tauri\target\debug"
}

$ToolchainRoot = Join-Path $AppRoot "toolchain"
$ManifestSrc = Join-Path $RepoRoot "toolchain\manifest.json"
$ManifestDst = Join-Path $ToolchainRoot "manifest.json"

$Vs2022Src = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
$Vs2026Src = "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools"
$PortableBase = "C:\BuildTools"
$CudaSrcRoot = "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA"

function Ensure-Dir([string]$Path) {
    if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

function Copy-Tree([string]$Source, [string]$Dest) {
    if (-not (Test-Path $Source)) {
        Write-Warning "Source not found, skipping: $Source"
        return
    }
    Ensure-Dir (Split-Path $Dest -Parent)
    Write-Host "  copy $Source -> $Dest"
    robocopy $Source $Dest /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE) for $Source" }
}

function Write-Devcmd([string]$Path, [string]$MsvcVersion, [string]$VsLabel) {
    $content = @"
@echo off
setlocal
set "INSTANCE_ROOT=%~dp0"
set "TOOLCHAIN_ROOT=%INSTANCE_ROOT%..\..\"
set "WindowsSDKDir=%TOOLCHAIN_ROOT%Windows Kits\10\"
set "WindowsSDKVersion=10.0.26100.0\"
set "VCToolsInstallDir=%INSTANCE_ROOT%VC\Tools\MSVC\$MsvcVersion"
set "VSCMD_ARG_TGT_ARCH=x64"
set "VSCMD_ARG_HOST_ARCH=x64"
set "VisualStudioVersion=$VsLabel"
set "INCLUDE=%VCToolsInstallDir%\include;%WindowsSDKDir%Include\10.0.26100.0\ucrt;%WindowsSDKDir%Include\10.0.26100.0\shared;%WindowsSDKDir%Include\10.0.26100.0\um;%WindowsSDKDir%Include\10.0.26100.0\winrt;%WindowsSDKDir%Include\10.0.26100.0\cppwinrt"
set "LIB=%VCToolsInstallDir%\lib\x64;%WindowsSDKDir%Lib\10.0.26100.0\ucrt\x64;%WindowsSDKDir%Lib\10.0.26100.0\um\x64"
set "BUILD_TOOLS_BIN=%VCToolsInstallDir%\bin\Hostx64\x64;%INSTANCE_ROOT%MSBuild\Current\Bin;%WindowsSDKDir%bin\10.0.26100.0\x64;%WindowsSDKDir%bin\10.0.26100.0\x64\ucrt"
set "PATH=%BUILD_TOOLS_BIN%;%PATH%"
endlocal & set "INCLUDE=%INCLUDE%" & set "LIB=%LIB%" & set "PATH=%PATH%" & set "VisualStudioVersion=%VisualStudioVersion%"
"@
    Ensure-Dir (Split-Path $Path -Parent)
    Set-Content -Path $Path -Value $content -Encoding ASCII
    Write-Host "  wrote $Path"
}

function Populate-VsInstance([string]$Name, [string]$SrcRoot, [string]$MsvcVersion, [string]$VsLabel) {
    $dest = Join-Path $ToolchainRoot "vs\$Name"
    Write-Host "`n--- VS $Name ($MsvcVersion) ---"
    Copy-Tree (Join-Path $SrcRoot "VC\Tools\MSVC\$MsvcVersion") (Join-Path $dest "VC\Tools\MSVC\$MsvcVersion")
    Copy-Tree (Join-Path $SrcRoot "VC\Auxiliary\Build") (Join-Path $dest "VC\Auxiliary\Build")
    Copy-Tree (Join-Path $SrcRoot "MSBuild") (Join-Path $dest "MSBuild")
    Copy-Tree (Join-Path $SrcRoot "Common7\Tools") (Join-Path $dest "Common7\Tools")
    Write-Devcmd (Join-Path $dest "devcmd.bat") $MsvcVersion $VsLabel
}

Write-Host "=== Foundry Toolchain Populate ===" -ForegroundColor Cyan
Write-Host "Destination: $ToolchainRoot"

Ensure-Dir $ToolchainRoot
Copy-Item $ManifestSrc $ManifestDst -Force

Write-Host "`n--- Shared Windows SDK ---" -ForegroundColor Yellow
if (Test-Path (Join-Path $PortableBase "Windows Kits")) {
    Copy-Tree (Join-Path $PortableBase "Windows Kits") (Join-Path $ToolchainRoot "Windows Kits")
} else {
    Copy-Tree "C:\Program Files (x86)\Windows Kits" (Join-Path $ToolchainRoot "Windows Kits")
}
$sdkSource = Join-Path $ToolchainRoot "Windows Kits\10\Source"
if (Test-Path $sdkSource) {
    Write-Host "  removing SDK Source/"
    Remove-Item $sdkSource -Recurse -Force
}

Populate-VsInstance "2022" $Vs2022Src "14.44.35207" "17.0"
Populate-VsInstance "2026" $Vs2026Src "14.51.36231" "18.0"

if (-not $SkipCuda) {
    Write-Host "`n--- CUDA toolkits ---" -ForegroundColor Yellow
    $stripScript = Join-Path $RepoRoot "scripts\strip-cuda-toolkit.ps1"
    foreach ($ver in @("12.8", "13.3")) {
        $src = Join-Path $CudaSrcRoot "v$ver"
        $dst = Join-Path $ToolchainRoot "cuda\v$ver"
        if (-not (Test-Path $src)) {
            Write-Warning "CUDA v$ver not found at $src - skipping"
            continue
        }
        & $stripScript -Source $src -Destination $dst
    }
}

Write-Host "`n=== Done ===" -ForegroundColor Green
$totalGb = [math]::Round((Get-ChildItem $ToolchainRoot -Recurse -File -EA SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB, 2)
Write-Host "Toolchain size: $totalGb GB at $ToolchainRoot"