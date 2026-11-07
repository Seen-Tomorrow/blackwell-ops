# Build src-tauri/runtime-bundle/ for NSIS - configs + minimal engine binaries only.
# Usage: .\scripts\prepare-release-runtime.ps1
#
# Keeps src-tauri/runtime/ configs untouched; engine binaries come from Foundry artifacts.
# Release bundles runtime-bundle/ -> Tauri resource "runtime/" beside the installed exe.
#
# Profile policy (see runtime-distribution.ps1):
#   NSIS core: ggml-master -> edge, stable (pre-installed engines)
#   Optional forks: catalog metadata in NSIS + App .7z; engines via provider packs only
#   vanguard/fresh retired - not bundled
#
# Distribution binaries per profile:
#   - llama-server.exe + supporting DLLs
#   - llama-fit-params.exe (VRAM fit scan)
#   - llama-bench.exe (industry PP/TG reference)
# GGUF metadata scan uses llama-server (not llama-gguf* tools).

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

# REL tauri.conf.json bundles gitignored src-tauri/pi-ext/ as a resource.
$piext_pkg = Join-Path $root 'src-tauri\pi-ext\pi-subagents\package.json'
if (-not (Test-Path -LiteralPath $piext_pkg)) {
    Write-Host '[prepare-release-runtime] Missing src-tauri/pi-ext/pi-subagents (gitignored).' -ForegroundColor Red
    Write-Host '  Tauri will fail: resource path `pi-ext` does not exist.' -ForegroundColor Red
    Write-Host '  Restore pi-ext then re-run.' -ForegroundColor Yellow
    exit 1
}

$runtime_root = Join-Path $root 'src-tauri\runtime'
$artifacts_root = Join-Path $root 'src-tauri\target\debug\foundry\artifacts'
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

    $config = Copy-ProviderFactoryConfig -ProviderId $provider_id -RuntimeRoot $runtime_root -DestRoot $bundle_root
    if ($config) {
        $copied_configs++
        if ($allowed_profiles.Count -gt 0 -and -not $config.HasDefault) {
            $missing_required += ('{0}/config/{0}-default-config.json (factory provider config not bundled)' -f $provider_id)
        }
    } elseif ($allowed_profiles.Count -gt 0) {
        $missing_required += ('{0}/config/ (factory provider config dir missing)' -f $provider_id)
    }

    foreach ($profile_id in $allowed_profiles) {
        if (-not (Test-RuntimeNsisProfile -ProviderId $provider_id -ProfileId $profile_id)) {
            continue
        }

        $env_dir = Join-Path $artifacts_root "$provider_id\$profile_id\Release"
        if (-not (Test-Path -LiteralPath $env_dir)) {
            if ($allowed_profiles.Count -gt 0) {
                $missing_required += ('{0}/{1} (no Foundry artifact - build it first)' -f $provider_id, $profile_id)
            }
            continue
        }

        $dist_files = Get-RuntimeDistributionFiles -Directory $env_dir
        $has_server = Test-Path -LiteralPath (Join-Path $env_dir 'llama-server.exe')

        if ($allowed_profiles.Count -gt 0 -and -not $has_server) {
            $missing_required += ('{0}/{1} (llama-server.exe missing - build it in Foundry first)' -f $provider_id, $profile_id)
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

        $all_files = Get-ChildItem -LiteralPath $env_dir -File
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
    Write-Host '[prepare-release-runtime] No engine profiles prepared. Build the profiles in Foundry first.' -ForegroundColor Yellow
    exit 1
}

$catalog_dst = Join-Path $bundle_root 'runtime-catalog'
# PowerShell .ps1 success does not clear $LASTEXITCODE from earlier native tools.
# Prefer $? / exception (ErrorAction Stop) over exit-code after &.
& (Join-Path $script_dir 'generate-plugin-catalog.ps1') -OutDir $catalog_dst
if (-not $?) {
    throw 'generate-plugin-catalog.ps1 failed'
}

# Stage the x64 MSVC C runtime beside every llama-server.exe in the bundle. Must run
# after the profile copy so the engine dirs exist, and before the size report.
Install-MsvcCrtIntoDirs -Root $bundle_root -ToolchainRoot (Join-Path $root 'toolchain')

$bundle_bytes = (Get-ChildItem -LiteralPath $bundle_root -Recurse -File | Measure-Object -Property Length -Sum).Sum
$bundle_mb = [math]::Round($bundle_bytes / 1MB, 1)

Write-Host ('[prepare-release-runtime] Ready: {0} profile(s), {1} config tree(s), {2} file(s), plugin catalog ({3} MB).' -f $copied_profiles, $copied_configs, $copied_files, $bundle_mb) -ForegroundColor Cyan
if ($skipped_files -gt 0) {
    Write-Host ('[prepare-release-runtime] Omitted {0} non-distribution binary file(s) from DEV runtime.' -f $skipped_files) -ForegroundColor DarkGray
}

exit 0
