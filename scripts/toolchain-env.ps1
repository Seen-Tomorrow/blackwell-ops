# Activate the portable MSVC / Windows SDK toolchain in the current shell.
#
# Rust (linker = rust-lld) and every C/asm dependency need LIB, INCLUDE and a PATH
# with cl.exe / cmake / ninja. On a normal box those come from a machine-wide
# "VS Build Tools" install. When that is uninstalled nothing provides them, and the
# link fails with "rust-lld: error: could not open 'kernel32.lib'".
#
# This repo already ships the toolchain under <app root>\toolchain, described by
# toolchain/manifest.json; vs/<ver>/devcmd.bat is generated from it. This script
# applies the same environment to the current PowerShell session, so cargo,
# `npm run dev`, `npm run build:rust`, `cargo test` and cl.exe all work.
#
# Usage (dot-source so the variables stay in your shell):
#   . .\scripts\toolchain-env.ps1
#   npm run dev
#
# Optional arguments:
#   -ToolchainRoot "D:\path\to\toolchain"   explicit toolchain directory
#   -Vs 2026                                pick the manifest VS entry (default 2022)
#   -Quiet                                  no summary output (for $PROFILE)

[CmdletBinding()]
param(
    [string]$ToolchainRoot = "",
    [string]$Vs = "2022",
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"

function Resolve-ToolchainRoot {
    if ($ToolchainRoot) {
        return (Resolve-Path -LiteralPath $ToolchainRoot).Path
    }
    if ($env:BOC_TOOLCHAIN) {
        return (Resolve-Path -LiteralPath $env:BOC_TOOLCHAIN).Path
    }
    $repoRoot = Split-Path $PSScriptRoot -Parent
    # App root is target/<profile> in DEV, the portable folder in REL.
    foreach ($rel in @("src-tauri\target\debug\toolchain", "src-tauri\target\release\toolchain")) {
        $candidate = Join-Path $repoRoot $rel
        if (Test-Path -LiteralPath (Join-Path $candidate "manifest.json")) {
            return $candidate
        }
    }
    throw "No portable toolchain found. Expected src-tauri\target\debug\toolchain\manifest.json (or pass -ToolchainRoot)."
}

function Prepend-Unique([string]$Name, [string]$Value) {
    $current = [Environment]::GetEnvironmentVariable($Name, "Process")
    $parts = @()
    if ($current) { $parts = $current -split ';' | Where-Object { $_ } }
    $new = $Value -split ';' | Where-Object { $_ }
    $existing = @($parts | ForEach-Object { $_.TrimEnd('\').ToLowerInvariant() })
    $kept = @()
    foreach ($entry in $new) {
        $key = $entry.TrimEnd('\').ToLowerInvariant()
        if ($existing -notcontains $key -and $kept -notcontains $key) { $kept += $entry }
    }
    $combined = @($kept + $parts) -join ';'
    [Environment]::SetEnvironmentVariable($Name, $combined, "Process")
}

$root = Resolve-ToolchainRoot
$manifestPath = Join-Path $root "manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "manifest.json missing at $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$sdkVersion = $manifest.windows_sdk_version
if (-not $sdkVersion) { throw "manifest.json missing windows_sdk_version" }

$vsKeys = @($manifest.vs.PSObject.Properties.Name)
$vsKey = $Vs
if ($vsKeys -notcontains $vsKey) {
    $vsKey = $vsKeys[-1]
}
$vsDef = $manifest.vs.$vsKey
if (-not $vsDef) { throw "manifest.json has no vs entry '$vsKey'" }

$msvcVersion = $vsDef.msvc_version
$msvcRoot = Join-Path $root "vs\$vsKey\VC\Tools\MSVC\$msvcVersion"
$sdkRoot = Join-Path $root "Windows Kits\10"
$cmakeBin = Join-Path $root "cmake\bin"
$msbuildBin = Join-Path $root "vs\$vsKey\MSBuild\Current\Bin"
$clBin = Join-Path $msvcRoot "bin\Hostx64\x64"

$lib = @(
    (Join-Path $msvcRoot "lib\x64"),
    (Join-Path $sdkRoot "Lib\$sdkVersion\ucrt\x64"),
    (Join-Path $sdkRoot "Lib\$sdkVersion\um\x64")
) -join ';'

$include = @(
    (Join-Path $msvcRoot "include"),
    (Join-Path $sdkRoot "Include\$sdkVersion\ucrt"),
    (Join-Path $sdkRoot "Include\$sdkVersion\shared"),
    (Join-Path $sdkRoot "Include\$sdkVersion\um"),
    (Join-Path $sdkRoot "Include\$sdkVersion\winrt"),
    (Join-Path $sdkRoot "Include\$sdkVersion\cppwinrt")
) -join ';'

$path = @(
    $cmakeBin,
    $clBin,
    $msbuildBin,
    (Join-Path $sdkRoot "bin\$sdkVersion\x64"),
    (Join-Path $sdkRoot "bin\$sdkVersion\x64\ucrt")
) -join ';'

foreach ($probe in @(
    (Join-Path $msvcRoot "lib\x64\legacy_stdio_definitions.lib"),
    (Join-Path $sdkRoot "Lib\$sdkVersion\um\x64\kernel32.lib"),
    (Join-Path $sdkRoot "Lib\$sdkVersion\ucrt\x64\ucrt.lib"),
    (Join-Path $clBin "cl.exe")
)) {
    if (-not (Test-Path -LiteralPath $probe)) {
        throw "Toolchain incomplete: missing $probe (profile '$vsKey', SDK $sdkVersion). Re-provision the toolchain pack."
    }
}

[Environment]::SetEnvironmentVariable("LIB", $lib, "Process")
[Environment]::SetEnvironmentVariable("INCLUDE", $include, "Process")
Prepend-Unique -Name "PATH" -Value $path
[Environment]::SetEnvironmentVariable("VSCMD_ARG_TGT_ARCH", "x64", "Process")
[Environment]::SetEnvironmentVariable("VSCMD_ARG_HOST_ARCH", "x64", "Process")

if (-not $Quiet) {
    Write-Host "Toolchain active: VS $vsKey (MSVC $msvcVersion), Windows SDK $sdkVersion" -ForegroundColor Green
    Write-Host "  root : $root"
    Write-Host "  LIB  : 3 dirs   INCLUDE : 6 dirs   PATH : cmake + cl + msbuild + sdk"
    Write-Host "  cl   : $((Get-Command cl.exe -ErrorAction SilentlyContinue).Source)"
}
