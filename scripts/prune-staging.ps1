#requires -Version 7.0
# Prune old staged release assets in .majestic-out.
#
# Keeps everything still referenced by the newest pack manifest (manifest-v*.json),
# runtime-catalog/engines.json and toolchain/manifest.json, plus one rollback copy per
# asset class. Everything else has already been uploaded to its channel.
#
# Best-effort by design: it runs after a successful ship and must never fail the ship.

param(
    [Parameter(Mandatory = $true)][string]$OutRoot,
    [string]$Root = ''
)

$ErrorActionPreference = 'SilentlyContinue'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }

try {
    if (-not (Test-Path -LiteralPath $OutRoot)) { exit 0 }

    $protected = @{}

    $manifest_file = Get-ChildItem -LiteralPath $OutRoot -Filter 'manifest-v*.json' -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($manifest_file) {
        $doc = Get-Content -LiteralPath $manifest_file.FullName -Raw | ConvertFrom-Json
        foreach ($f in @($doc.files)) {
            if ($f.path) { $protected[(Split-Path -Leaf $f.path)] = $true }
        }
    }

    $engines_manifest = Join-Path $Root 'src-tauri\runtime-catalog\engines.json'
    if (Test-Path -LiteralPath $engines_manifest) {
        $doc = Get-Content -LiteralPath $engines_manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($e in @($doc.enginePacks)) {
            if ($e.asset) { $protected[[string]$e.asset] = $true }
        }
    }

    $toolchain_manifest = Join-Path $Root 'toolchain\manifest.json'
    if (Test-Path -LiteralPath $toolchain_manifest) {
        $doc = Get-Content -LiteralPath $toolchain_manifest -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in @($doc.packs)) {
            if ($p.asset) { $protected[(Split-Path -Leaf ([string]$p.asset))] = $true }
        }
    }

    $classes = @('ENGINE_', 'APP_UPDATE_', 'FULL_SETUP_', 'LINK_', 'OYM_link', 'OYM_Link', 'toolchain-')
    $files = @(Get-ChildItem -LiteralPath $OutRoot -File)
    $removed = 0
    $freed = 0
    foreach ($prefix in $classes) {
        $group = @($files | Where-Object { $_.Name.StartsWith($prefix) } | Sort-Object LastWriteTime -Descending)
        $rank = 0
        foreach ($f in $group) {
            $rank++
            if ($rank -le 2 -or $protected.ContainsKey($f.Name)) { continue }
            $freed += $f.Length
            Remove-Item -LiteralPath $f.FullName -Force
            $removed++
        }
    }
    if ($removed -gt 0) {
        Write-Host ("[prune-staging] {0} old asset(s), {1:N1} MB freed" -f $removed, ($freed / 1MB)) -ForegroundColor DarkGray
    }
} catch {
    Write-Host ("[prune-staging] skipped: {0}" -f $_.Exception.Message) -ForegroundColor DarkGray
}

exit 0
