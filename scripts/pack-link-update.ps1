#requires -Version 7.0
<#
.SYNOPSIS
  Pack the OYM Link installer into the GitHub update asset.

.DESCRIPTION
  Produces .majestic-out/LINK_OYM-Link-<build>.7z containing the already-built
  silent installer. OYM Link downloads this asset, extracts it, and runs the
  installer (which closes the old instance, replaces it and relaunches).
#>
param(
    [string] $Installer = "",
    [string] $Output = "",
    [int] $Build = 0
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$sevenZip = Join-Path $root "src-tauri/bin/7z.exe"
if (-not (Test-Path -LiteralPath $sevenZip)) {
    throw "Bundled 7z.exe not found: $sevenZip"
}
if (-not $Installer) {
    $Installer = Join-Path $root "tmp/OYM-Link-Setup.exe"
}
if (-not (Test-Path -LiteralPath $Installer)) {
    throw "Link installer not found: $Installer (run BUILD LINK INSTALLER first)"
}
if ($Build -le 0) {
    $counter = Join-Path $root "link/app/.build_counter.json"
    if (-not (Test-Path -LiteralPath $counter)) {
        throw "Link build counter missing: $counter"
    }
    $Build = [int]((Get-Content -LiteralPath $counter -Raw | ConvertFrom-Json).count)
}
if ($Build -le 0) {
    throw "Could not determine the link build number"
}
if (-not $Output) {
    $outDir = Join-Path $root ".majestic-out"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $Output = Join-Path $outDir "LINK_OYM-Link-$Build.7z"
}
if (-not [IO.Path]::IsPathRooted($Output)) {
    $Output = Join-Path $root $Output
}
if (-not $Output.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write outside the repo: $Output"
}

$work = Join-Path $root "tmp/link-update-pack-$Build"
if (Test-Path -LiteralPath $work) {
    Remove-Item -LiteralPath $work -Recurse -Force
}
New-Item -ItemType Directory -Path $work -Force | Out-Null
Copy-Item -LiteralPath $Installer -Destination (Join-Path $work "OYM-Link-Setup.exe") -Force
if (Test-Path -LiteralPath $Output) {
    Remove-Item -LiteralPath $Output -Force
}

Push-Location $work
try {
    $sevenOut = & $sevenZip a -t7z -mx=9 -mmt=on $Output 'OYM-Link-Setup.exe' 2>&1
    $sevenExit = $LASTEXITCODE
    if ($sevenExit -ne 0) {
        foreach ($line in @($sevenOut)) { Write-Host $line }
        throw "7z pack failed with exit $sevenExit"
    }
}
finally {
    Pop-Location
}

$sizeMb = [Math]::Round((Get-Item -LiteralPath $Output).Length / 1MB, 1)
$hash = (Get-FileHash -LiteralPath $Output -Algorithm SHA256).Hash
Write-Host ""
Write-Host "PACKED=$Output"
Write-Host "BUILD=$Build"
Write-Host "SIZE=$sizeMb MB"
Write-Host "SHA256=$hash"
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
