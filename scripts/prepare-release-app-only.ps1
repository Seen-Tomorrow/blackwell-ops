# Build src-tauri/runtime-bundle/ for App-Only update.
# Usage: .\scripts\prepare-release-app-only.ps1
#
# Ships:
#   - Core provider templates only (ggml-master) — always in PROVIDERS
#   - runtime-catalog/plugins.json — optional plugin metadata (NOT full templates)
# Optional engines install via provider packs from UPDATES catalog.

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

$runtime_root = Join-Path $root 'src-tauri\runtime'
$bundle_root = Join-Path $root 'src-tauri\runtime-bundle'

if (-not (Test-Path -LiteralPath $runtime_root)) {
    Write-Host '[prepare-release-app-only] No src-tauri/runtime/ - nothing to bundle.' -ForegroundColor Yellow
    exit 1
}

if (Test-Path -LiteralPath $bundle_root) {
    Remove-Item -LiteralPath $bundle_root -Recurse -Force
}
New-Item -ItemType Directory -Path $bundle_root -Force | Out-Null

$providers = Get-ChildItem -LiteralPath $runtime_root -Directory
$copied_configs = 0
$missing_required = @()

foreach ($provider in $providers) {
    $provider_id = $provider.Name

    if (-not (Test-RuntimeNsisProvider -ProviderId $provider_id)) {
        continue
    }

    $config_src = Join-Path $provider.FullName 'config'
    if (-not (Test-Path -LiteralPath $config_src)) {
        $missing_required += ('{0}/config/ (core provider templates missing)' -f $provider_id)
        continue
    }

    $config_dst = Join-Path $bundle_root "$provider_id\config"
    New-Item -ItemType Directory -Path $config_dst -Force | Out-Null
    Copy-Item -Path (Join-Path $config_src '*') -Destination $config_dst -Recurse -Force
    $copied_configs++

    $bundled_default_config = Join-Path $config_dst "$provider_id-default-config.json"
    if (-not (Test-Path -LiteralPath $bundled_default_config)) {
        $missing_required += ('{0}/config/{0}-default-config.json (template JSON missing)' -f $provider_id)
    }
}

if ($missing_required.Count -gt 0) {
    Write-Host '[prepare-release-app-only] Required template content missing:' -ForegroundColor Red
    foreach ($item in $missing_required) {
        Write-Host ('  - {0}' -f $item) -ForegroundColor Red
    }
    exit 1
}

if ($copied_configs -eq 0) {
    Write-Host '[prepare-release-app-only] No core provider config trees prepared.' -ForegroundColor Red
    exit 1
}

# Bundle as runtime-catalog/ so App .7z extracts to app/runtime-catalog/plugins.json
$catalog_dst = Join-Path $bundle_root 'runtime-catalog'
# PowerShell .ps1 success does not clear $LASTEXITCODE from earlier native tools.
& (Join-Path $script_dir 'generate-plugin-catalog.ps1') -OutDir $catalog_dst
if (-not $?) {
    throw 'generate-plugin-catalog.ps1 failed'
}

$bundle_bytes = (Get-ChildItem -LiteralPath $bundle_root -Recurse -File | Measure-Object -Property Length -Sum).Sum
$bundle_mb = [math]::Round($bundle_bytes / 1MB, 2)

Write-Host ('[prepare-release-app-only] Ready: {0} core template(s) + plugin catalog, {1} MB (no engine binaries).' -f $copied_configs, $bundle_mb) -ForegroundColor Cyan