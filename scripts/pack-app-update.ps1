# Pack lean App update archive: blackwell-ops.exe + factory templates + bundled 7z.
# Target size ~5 MB. Layout (prefixed for safe extract):
#
#   app/
#     blackwell-ops.exe
#     runtime/<provider>/config/*.json
#     bin/7z.exe, bin/7z.dll
#
# Usage:
#   .\scripts\pack-app-update.ps1
#   .\scripts\pack-app-update.ps1 -Version 1.0.12 -Output .majestic-out\CORE_Blackwell-Ops-App-v1.0.12.7z
#   .\scripts\pack-app-update.ps1 -ExePath src-tauri\target\release\blackwell-ops.exe

param(
    [string]$Version = '',
    [string]$Output = '',
    [string]$ExePath = '',
    [string]$BundleRoot = ''
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

$SevenZip = Join-Path $root 'src-tauri\bin\7z.exe'
$SevenZipDll = Join-Path $root 'src-tauri\bin\7z.dll'
if (-not (Test-Path -LiteralPath $SevenZip)) {
    throw "Bundled 7z.exe not found at $SevenZip"
}
if (-not (Test-Path -LiteralPath $SevenZipDll)) {
    throw "Bundled 7z.dll not found at $SevenZipDll"
}

if (-not $Version) {
    $tauri_conf = Join-Path $root 'src-tauri\tauri.conf.json'
    $Version = (Get-Content -LiteralPath $tauri_conf -Raw | ConvertFrom-Json).version
}

if (-not $ExePath) {
    $ExePath = Join-Path $root 'src-tauri\target\release\blackwell-ops.exe'
}
if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "Release exe not found: $ExePath - build first (tauri build --no-bundle or npm run build:exe)"
}

# Refuse to pack DEV-config / wrong-version PEs (DISTRIBUTION / majestic integrity).
$assert_exe = Join-Path $script_dir 'assert-release-exe.ps1'
if (Test-Path -LiteralPath $assert_exe) {
    & $assert_exe -ExePath $ExePath -ExpectedVersion $Version -ExpectedProductName 'Blackwell Ops'
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "assert-release-exe failed (exit $LASTEXITCODE)"
    }
}

if (-not $BundleRoot) {
    $BundleRoot = Join-Path $root 'src-tauri\runtime-bundle'
}
if (-not (Test-Path -LiteralPath $BundleRoot)) {
    throw "runtime-bundle missing at $BundleRoot - run prepare-release-app-only.ps1 first"
}

if (-not $Output) {
    $out_dir = Join-Path $root '.majestic-out'
    New-Item -ItemType Directory -Path $out_dir -Force | Out-Null
    $Output = Join-Path $out_dir "CORE_Blackwell-Ops-App-v$Version.7z"
}
# Absolute path required: we chdir into work/ for 7z packing
if (-not [System.IO.Path]::IsPathRooted($Output)) {
    $Output = Join-Path (Get-Location).Path $Output
}
$Output = [System.IO.Path]::GetFullPath($Output)

$work = Join-Path $root "work\app-update-pack-$Version"
if (Test-Path -LiteralPath $work) {
    Remove-Item -LiteralPath $work -Recurse -Force
}
$app_stage = Join-Path $work 'app'
New-Item -ItemType Directory -Path $app_stage -Force | Out-Null

# Main executable
Copy-Item -LiteralPath $ExePath -Destination (Join-Path $app_stage 'blackwell-ops.exe') -Force

# Factory templates only (never engines)
$providers = Get-ChildItem -LiteralPath $BundleRoot -Directory -ErrorAction SilentlyContinue
$template_count = 0
foreach ($provider in $providers) {
    $config_src = Join-Path $provider.FullName 'config'
    if (-not (Test-Path -LiteralPath $config_src)) { continue }
    $config_dst = Join-Path $app_stage "runtime\$($provider.Name)\config"
    New-Item -ItemType Directory -Path $config_dst -Force | Out-Null
    Copy-Item -Path (Join-Path $config_src '*') -Destination $config_dst -Recurse -Force
    $template_count++
}
# Prefer runtime-catalog/ layout; accept legacy bundle/catalog/
$catalog_src = Join-Path $BundleRoot 'runtime-catalog'
if (-not (Test-Path -LiteralPath $catalog_src)) {
    $catalog_src = Join-Path $BundleRoot 'catalog'
}
if (Test-Path -LiteralPath $catalog_src) {
    $catalog_dst = Join-Path $app_stage 'runtime-catalog'
    New-Item -ItemType Directory -Path $catalog_dst -Force | Out-Null
    Copy-Item -Path (Join-Path $catalog_src '*') -Destination $catalog_dst -Recurse -Force
    Write-Host "[pack-app-update] Included plugin catalog (runtime-catalog/)" -ForegroundColor DarkGray
}

if ($template_count -eq 0) {
    throw "No provider config trees under $BundleRoot"
}

# Always ship 7z so App update apply works even on bare/minimal installs
$bin_dst = Join-Path $app_stage 'bin'
New-Item -ItemType Directory -Path $bin_dst -Force | Out-Null
Copy-Item -LiteralPath $SevenZip -Destination (Join-Path $bin_dst '7z.exe') -Force
Copy-Item -LiteralPath $SevenZipDll -Destination (Join-Path $bin_dst '7z.dll') -Force

$out_parent = Split-Path -Parent $Output
if ($out_parent -and -not (Test-Path -LiteralPath $out_parent)) {
    New-Item -ItemType Directory -Path $out_parent -Force | Out-Null
}
if (Test-Path -LiteralPath $Output) {
    Remove-Item -LiteralPath $Output -Force
}

Push-Location $work
try {
    # Prefix layout: app/blackwell-ops.exe, app/runtime/..., app/bin/...
    # Discard native 7z stdout/stderr so this script never pollutes caller assignment.
    $seven_out = & $SevenZip a -t7z -mx=9 -mmt=on $Output 'app' 2>&1
    $seven_exit = $LASTEXITCODE
    if ($seven_exit -ne 0) {
        foreach ($line in @($seven_out)) { Write-Host $line }
        throw "7z pack failed with exit $seven_exit"
    }
} finally {
    Pop-Location
}

$size_mb = [math]::Round((Get-Item -LiteralPath $Output).Length / 1MB, 2)
Write-Host ("[pack-app-update] OK: {0} ({1} MB) - {2} provider template tree(s) + exe + 7z" -f $Output, $size_mb, $template_count) -ForegroundColor Cyan

# Cleanup staging (keep archive)
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
