# Regenerate portable VS devcmd.bat files from toolchain/manifest.json.
# Single source of truth — call before every pack or partial inject so you never
# hand-patch .bat files when MSVC/SDK versions change.
#
# Usage:
#   .\scripts\toolchain-devcmd.ps1
#   .\scripts\toolchain-devcmd.ps1 -ToolchainRoot "C:\path\to\toolchain"

param(
    [string]$ToolchainRoot = ""
)

$ErrorActionPreference = "Stop"

function Get-VisualStudioVersionLabel([string]$VsKey) {
    switch ($VsKey) {
        "2022" { return "17.0" }
        "2026" { return "18.0" }
        default { throw "Unknown VS key in manifest: $VsKey (add mapping in toolchain-devcmd.ps1)" }
    }
}

function Write-ToolchainDevcmdFile(
    [string]$Path,
    [string]$MsvcVersion,
    [string]$VsLabel,
    [string]$SdkVersion
) {
    $content = @"
@echo off
setlocal
set "INSTANCE_ROOT=%~dp0"
set "TOOLCHAIN_ROOT=%INSTANCE_ROOT%..\..\"
set "WindowsSDKDir=%TOOLCHAIN_ROOT%Windows Kits\10\"
set "WindowsSDKVersion=$SdkVersion\"
set "VCToolsInstallDir=%INSTANCE_ROOT%VC\Tools\MSVC\$MsvcVersion"
set "VSCMD_ARG_TGT_ARCH=x64"
set "VSCMD_ARG_HOST_ARCH=x64"
set "VisualStudioVersion=$VsLabel"
set "INCLUDE=%VCToolsInstallDir%\include;%WindowsSDKDir%Include\$SdkVersion\ucrt;%WindowsSDKDir%Include\$SdkVersion\shared;%WindowsSDKDir%Include\$SdkVersion\um;%WindowsSDKDir%Include\$SdkVersion\winrt;%WindowsSDKDir%Include\$SdkVersion\cppwinrt"
set "LIB=%VCToolsInstallDir%\lib\x64;%WindowsSDKDir%Lib\$SdkVersion\ucrt\x64;%WindowsSDKDir%Lib\$SdkVersion\um\x64"
set "BUILD_TOOLS_BIN=%VCToolsInstallDir%\bin\Hostx64\x64;%INSTANCE_ROOT%MSBuild\Current\Bin;%WindowsSDKDir%bin\$SdkVersion\x64;%WindowsSDKDir%bin\$SdkVersion\x64\ucrt"
set "CMAKE_BIN=%TOOLCHAIN_ROOT%cmake\bin"
set "PATH=%CMAKE_BIN%;%BUILD_TOOLS_BIN%;%PATH%"
endlocal & set "INCLUDE=%INCLUDE%" & set "LIB=%LIB%" & set "PATH=%PATH%" & set "VisualStudioVersion=%VisualStudioVersion%"
"@
    $parent = Split-Path $Path -Parent
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Set-Content -Path $Path -Value $content -Encoding ASCII
    Write-Host "  wrote $Path"
}

function Update-ToolchainDevcmd([string]$Root) {
    $manifestPath = Join-Path $Root "manifest.json"
    if (-not (Test-Path $manifestPath)) {
        throw "manifest.json missing at $manifestPath"
    }
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    $sdkVersion = $manifest.windows_sdk_version
    if (-not $sdkVersion) {
        throw "manifest.json missing windows_sdk_version"
    }

    Write-Host "=== Regenerate devcmd.bat ===" -ForegroundColor Cyan
    foreach ($prop in $manifest.vs.PSObject.Properties) {
        $vsKey = $prop.Name
        $vsDef = $prop.Value
        $devcmdRel = ($vsDef.devcmd -replace '/', '\')
        $devcmdPath = Join-Path $Root $devcmdRel
        $vsLabel = Get-VisualStudioVersionLabel $vsKey
        Write-ToolchainDevcmdFile $devcmdPath $vsDef.msvc_version $vsLabel $sdkVersion
    }
}

if ($ToolchainRoot) {
    Update-ToolchainDevcmd $ToolchainRoot
}