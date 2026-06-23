# Sync src-tauri/runtime -> src-tauri/target/debug/runtime for DEV (npm run predev).
# Usage: .\scripts\sync-dev-runtime.ps1
#
# Copies factory configs for every provider folder, then mirrors only active
# profiles (frontier + stable). Retired vanguard/fresh are omitted and pruned
# from the debug runtime tree.

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

$runtime_root = Join-Path $root 'src-tauri\runtime'
$dest_root = Join-Path $root 'src-tauri\target\debug\runtime'

if (-not (Test-Path -LiteralPath $runtime_root)) {
    Write-Host '[sync-dev-runtime] No src-tauri/runtime/ - nothing to sync.' -ForegroundColor Yellow
    exit 0
}

New-Item -ItemType Directory -Path $dest_root -Force | Out-Null

$copied_configs = 0
$copied_profiles = 0

foreach ($provider in Get-ChildItem -LiteralPath $runtime_root -Directory) {
    $provider_id = $provider.Name

    if (-not (Test-RuntimeBundleProvider -ProviderId $provider_id)) {
        continue
    }

    $config_src = Join-Path $provider.FullName 'config'
    if (Test-Path -LiteralPath $config_src) {
        $config_dst = Join-Path $dest_root "$provider_id\config"
        New-Item -ItemType Directory -Path $config_dst -Force | Out-Null
        Copy-Item -Path (Join-Path $config_src '*') -Destination $config_dst -Recurse -Force
        $copied_configs++
    }

    foreach ($profile_id in (Get-RuntimeBundleProfiles -ProviderId $provider_id)) {
        if (Test-RuntimeProfileRetired -ProfileId $profile_id) {
            continue
        }

        $profile_src = Join-Path $provider.FullName $profile_id
        if (-not (Test-Path -LiteralPath $profile_src)) {
            Write-Host ("[sync-dev-runtime] {0}/{1} missing in source - skipped." -f $provider_id, $profile_id) -ForegroundColor DarkGray
            continue
        }

        $profile_dst = Join-Path $dest_root "$provider_id\$profile_id"
        if (Test-Path -LiteralPath $profile_dst) {
            Remove-Item -LiteralPath $profile_dst -Recurse -Force
        }
        New-Item -ItemType Directory -Path $profile_dst -Force | Out-Null
        Copy-Item -Path (Join-Path $profile_src '*') -Destination $profile_dst -Recurse -Force
        $copied_profiles++

        Write-Host ("[sync-dev-runtime] {0}/{1} -> target/debug/runtime/{0}/{1}" -f $provider_id, $profile_id) -ForegroundColor Green
    }
}

$pruned = Remove-RetiredRuntimeProfileDirs -Root $dest_root
if ($pruned -gt 0) {
    Write-Host ("[sync-dev-runtime] Pruned {0} retired profile dir(s) from debug runtime." -f $pruned) -ForegroundColor DarkGray
}

$removed_providers = 0
foreach ($dest_provider in Get-ChildItem -LiteralPath $dest_root -Directory -ErrorAction SilentlyContinue) {
    if (-not (Test-RuntimeBundleProvider -ProviderId $dest_provider.Name)) {
        Remove-Item -LiteralPath $dest_provider.FullName -Recurse -Force
        $removed_providers++
    }
}
if ($removed_providers -gt 0) {
    Write-Host ("[sync-dev-runtime] Removed {0} provider dir(s) outside bundle policy." -f $removed_providers) -ForegroundColor DarkGray
}

if ($copied_profiles -eq 0 -and $copied_configs -eq 0) {
    Write-Host '[sync-dev-runtime] Nothing copied - check src-tauri/runtime/.' -ForegroundColor Yellow
    exit 0
}

Write-Host ("[sync-dev-runtime] Ready: {0} profile(s), {1} config tree(s)." -f $copied_profiles, $copied_configs) -ForegroundColor Cyan