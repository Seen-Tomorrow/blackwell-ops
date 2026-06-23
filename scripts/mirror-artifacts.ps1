# Mirror foundry artifacts from DEV to runtime (FULL tree - for DEV + release prep)
# Usage: .\scripts\mirror-artifacts.ps1
# Run before release; follow with prepare-release-runtime.ps1 to strip for NSIS.
#
# Profile policy (see runtime-distribution.ps1):
#   ggml-master, ggml-tom -> frontier, stable
#   vanguard/fresh retired - not mirrored
#
# Flow:
#   1. Clear stale binaries in each allowed profile dir (runtime/<provider>/<env>/)
#   2. Copy ALL Release binaries from foundry artifacts (foundry/artifacts/<provider>/<env>/Release/)
#   3. Config files at runtime/<provider>/config/ are NOT touched
#
# DEV sync uses npm run predev (sync-dev-runtime.ps1). Distribution ships only
# llama-server.exe, llama-fit-params.exe, and DLLs (see prepare-release-runtime.ps1).

$ErrorActionPreference = "Stop"

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir "runtime-distribution.ps1")

$artifacts_root = Join-Path $root "src-tauri\target\debug\foundry\artifacts"
$runtime_root   = Join-Path $root "src-tauri\runtime"

if (-not (Test-Path $artifacts_root)) {
    Write-Host "[mirror-artifacts] No artifacts found - nothing to mirror." -ForegroundColor Yellow
    exit 0
}

$providers = Get-ChildItem -LiteralPath $artifacts_root -Directory

$copied = 0
$skipped = 0

foreach ($provider in $providers) {
    $provider_id = $provider.Name

    if (-not (Test-RuntimeBundleProvider -ProviderId $provider_id)) {
        Write-Host "[mirror-artifacts] $provider_id not in bundle policy - skipping." -ForegroundColor DarkGray
        $skipped++
        continue
    }

    $allowed_profiles = Get-RuntimeBundleProfiles -ProviderId $provider_id
    $env_dirs = $allowed_profiles | ForEach-Object {
        Join-Path $provider.FullName $_
    } | Where-Object { Test-Path -LiteralPath $_ }

    foreach ($env_dir in $env_dirs) {
        $env_name = Split-Path -Leaf $env_dir

        if (-not (Test-RuntimeBundleProfile -ProviderId $provider_id -ProfileId $env_name)) {
            $skipped++
            continue
        }

        $release_dir = Join-Path $env_dir "Release"

        if (-not (Test-Path $release_dir)) {
            Write-Host "[mirror-artifacts] No Release dir for $provider_id/$env_name - skipping." -ForegroundColor DarkGray
            $skipped++
            continue
        }

        $dest = Join-Path $runtime_root "$provider_id\$env_name"

        if (-not (Test-Path $dest)) {
            New-Item -ItemType Directory -Path $dest -Force | Out-Null
        }

        Get-ChildItem -LiteralPath $dest -File -ErrorAction SilentlyContinue | Remove-Item -Force
        Get-ChildItem -LiteralPath $release_dir | Copy-Item -Destination $dest -Force
        $copied++

        Write-Host "[mirror-artifacts] $provider_id/$env_name/Release -> runtime/$provider_id/$env_name" -ForegroundColor Green
    }
}

if ($copied -eq 0) {
    Write-Host "[mirror-artifacts] No profiles found to mirror." -ForegroundColor Yellow
} else {
    Write-Host ("[mirror-artifacts] Mirrored {0} profile(s). Skipped {1}." -f $copied, $skipped) -ForegroundColor Cyan
}