# Build src-tauri/runtime-bundle/ for NSIS - configs + minimal engine binaries only.
# Usage: .\scripts\prepare-release-runtime.ps1
#
# Keeps src-tauri/runtime/ untouched (DEV sync via predev filters active profiles).
# Release bundles runtime-bundle/ -> Tauri resource "runtime/" beside the installed exe.
#
# Profile policy (see runtime-distribution.ps1):
#   NSIS core: ggml-master -> frontier, stable (pre-installed engines)
#   Optional forks: catalog metadata in NSIS + App .7z; engines via provider packs only
#   vanguard/fresh retired - not bundled
#
# Distribution binaries per profile:
#   - llama-server.exe + supporting DLLs
#   - llama-fit-params.exe (VRAM fit scan)
# GGUF metadata scan uses llama-server (not llama-gguf* tools).

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

$runtime_root = Join-Path $root 'src-tauri\runtime'
$bundle_root = Join-Path $root 'src-tauri\runtime-bundle'

if (-not (Test-Path -LiteralPath $runtime_root)) {
    Write-Host '[prepare-release-runtime] No src-tauri/runtime/ - nothing to bundle.' -ForegroundColor Yellow
    exit 0
}

if (Test-Path -LiteralPath $bundle_root) {
    Remove-Item -LiteralPath $bundle_root -Recurse -Force
}
New-Item -ItemType Directory -Path $bundle_root -Force | Out-Null

$providers = Get-ChildItem -LiteralPath $runtime_root -Directory
$copied_profiles = 0
$copied_configs = 0
$copied_files = 0
$skipped_files = 0
$missing_required = @()

foreach ($provider in $providers) {
    $provider_id = $provider.Name

    if (-not (Test-RuntimeNsisProvider -ProviderId $provider_id)) {
        continue
    }

    $allowed_profiles = Get-RuntimeNsisProfiles -ProviderId $provider_id

    $config_src = Join-Path $provider.FullName 'config'
    if (Test-Path -LiteralPath $config_src) {
        $config_dst = Join-Path $bundle_root "$provider_id\config"
        New-Item -ItemType Directory -Path $config_dst -Force | Out-Null
        # Path (not LiteralPath) so wildcards expand - LiteralPath treats '*' as a literal name.
        Copy-Item -Path (Join-Path $config_src '*') -Destination $config_dst -Recurse -Force
        $copied_configs++

        $bundled_default_config = Join-Path $config_dst "$provider_id-default-config.json"
        if ($allowed_profiles.Count -gt 0 -and -not (Test-Path -LiteralPath $bundled_default_config)) {
            $missing_required += ('{0}/config/{0}-default-config.json (factory provider config not bundled)' -f $provider_id)
        }
    } elseif ($allowed_profiles.Count -gt 0) {
        $missing_required += ('{0}/config/ (factory provider config dir missing)' -f $provider_id)
    }

    $profile_dirs = $allowed_profiles | ForEach-Object {
        Get-Item -LiteralPath (Join-Path $provider.FullName $_) -ErrorAction SilentlyContinue
    } | Where-Object { $_ -ne $null }

    foreach ($env_dir in $profile_dirs) {
        $profile_id = $env_dir.Name

        if (-not (Test-RuntimeNsisProfile -ProviderId $provider_id -ProfileId $profile_id)) {
            continue
        }

        $dist_files = Get-RuntimeDistributionFiles -Directory $env_dir.FullName
        $has_server = Test-Path -LiteralPath (Join-Path $env_dir.FullName 'llama-server.exe')

        if ($allowed_profiles.Count -gt 0 -and -not $has_server) {
            $missing_required += ('{0}/{1} (llama-server.exe missing - build + mirror first)' -f $provider_id, $profile_id)
            continue
        }

        if ($dist_files.Count -eq 0) {
            Write-Host ('[prepare-release-runtime] {0}/{1} - no distribution binaries, skipping profile.' -f $provider_id, $profile_id) -ForegroundColor DarkGray
            continue
        }

        $dest = Join-Path $bundle_root "$provider_id\$profile_id"
        New-Item -ItemType Directory -Path $dest -Force | Out-Null

        foreach ($file in $dist_files) {
            Copy-Item -LiteralPath $file.FullName -Destination $dest -Force
            $copied_files++
        }

        $all_files = Get-ChildItem -LiteralPath $env_dir.FullName -File
        $skipped_files += ($all_files.Count - $dist_files.Count)
        $copied_profiles++

        Write-Host ('[prepare-release-runtime] {0}/{1} -> runtime-bundle/{0}/{1} ({2} files)' -f $provider_id, $profile_id, $dist_files.Count) -ForegroundColor Green
    }
}

if ($missing_required.Count -gt 0) {
    Write-Host '[prepare-release-runtime] Required bundle content missing:' -ForegroundColor Red
    foreach ($item in $missing_required) {
        Write-Host ('  - {0}' -f $item) -ForegroundColor Red
    }
    exit 1
}

if ($copied_profiles -eq 0) {
    Write-Host '[prepare-release-runtime] No engine profiles prepared. Run mirror-artifacts.ps1 after a foundry build.' -ForegroundColor Yellow
    exit 1
}

$catalog_dst = Join-Path $bundle_root 'catalog'
& (Join-Path $script_dir 'generate-plugin-catalog.ps1') -OutDir $catalog_dst
if ($LASTEXITCODE -ne 0) {
    throw 'generate-plugin-catalog.ps1 failed'
}

$bundle_bytes = (Get-ChildItem -LiteralPath $bundle_root -Recurse -File | Measure-Object -Property Length -Sum).Sum
$bundle_mb = [math]::Round($bundle_bytes / 1MB, 1)

Write-Host ('[prepare-release-runtime] Ready: {0} profile(s), {1} config tree(s), {2} file(s), plugin catalog ({3} MB).' -f $copied_profiles, $copied_configs, $copied_files, $bundle_mb) -ForegroundColor Cyan
if ($skipped_files -gt 0) {
    Write-Host ('[prepare-release-runtime] Omitted {0} non-distribution binary file(s) from DEV runtime.' -f $skipped_files) -ForegroundColor DarkGray
}