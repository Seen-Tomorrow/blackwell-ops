#requires -Version 7.0
<#
.SYNOPSIS
  Upload the newest LINK_OYM-Link-*.7z update asset to a GitHub release.
#>
param(
    [string] $Tag = "",
    [string] $Asset = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $Tag) {
    $version = (Get-Content -LiteralPath (Join-Path $root "src-tauri/tauri.conf.json") -Raw | ConvertFrom-Json).version
    $Tag = "v$version"
}
if (-not $Asset) {
    $Asset = Get-ChildItem -LiteralPath (Join-Path $root ".majestic-out") -File -Filter "LINK_OYM-Link-*.7z" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Asset -or -not (Test-Path -LiteralPath $Asset)) {
    throw "No LINK_OYM-Link-*.7z asset found. Run npm run majestic:pack:link first."
}

gh release view $Tag 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Release $Tag does not exist. Ship the app first, then upload the link asset."
}
Write-Host "Uploading $Asset to $Tag…"
gh release upload $Tag $Asset --clobber
if ($LASTEXITCODE -ne 0) {
    throw "gh release upload failed with exit $LASTEXITCODE"
}
Write-Host "UPLOADED=$Asset"
