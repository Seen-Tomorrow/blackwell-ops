# Sync src-tauri/runtime -> src-tauri/target/debug/runtime for DEV (npm run predev).
# Usage: .\scripts\sync-dev-runtime.ps1
#
# Copies factory configs for every provider folder, then mirrors only active
# profiles (frontier + stable). Retired vanguard/fresh are omitted and pruned
# from the debug runtime tree.
#
# Locked engine dirs (running llama-server / blackwell-ops still holding DLLs)
# are skipped with a warning — config still syncs so DEV can start.

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
$skipped_locked = 0

function Copy-ProfileTreeSafe {
    param(
        [string]$Src,
        [string]$Dst,
        [string]$Label
    )
    # Prefer wipe+copy for a clean mirror; if locked, overlay files and continue.
    if (Test-Path -LiteralPath $Dst) {
        try {
            Remove-Item -LiteralPath $Dst -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Host ("[sync-dev-runtime] {0} locked - overlay copy (stop engines / close app for clean mirror)." -f $Label) -ForegroundColor Yellow
            $script:skipped_locked++
            if (-not (Test-Path -LiteralPath $Dst)) {
                New-Item -ItemType Directory -Path $Dst -Force | Out-Null
            }
            Get-ChildItem -LiteralPath $Src -Force -ErrorAction SilentlyContinue | ForEach-Object {
                $target = Join-Path $Dst $_.Name
                try {
                    if ($_.PSIsContainer) {
                        if (-not (Test-Path -LiteralPath $target)) {
                            New-Item -ItemType Directory -Path $target -Force | Out-Null
                        }
                        Copy-Item -Path (Join-Path $_.FullName '*') -Destination $target -Recurse -Force -ErrorAction SilentlyContinue
                    } else {
                        Copy-Item -LiteralPath $_.FullName -Destination $target -Force -ErrorAction SilentlyContinue
                    }
                } catch {
                    Write-Host ("[sync-dev-runtime]   skip locked file: {0}" -f $_.Name) -ForegroundColor DarkYellow
                }
            }
            return $true
        }
    }
    New-Item -ItemType Directory -Path $Dst -Force | Out-Null
    Copy-Item -Path (Join-Path $Src '*') -Destination $Dst -Recurse -Force
    return $true
}

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
        $label = "$provider_id/$profile_id"
        if (Copy-ProfileTreeSafe -Src $profile_src -Dst $profile_dst -Label $label) {
            $copied_profiles++
            Write-Host ("[sync-dev-runtime] {0} -> target/debug/runtime/{0}" -f $label) -ForegroundColor Green
        }
    }
}

$pruned = Remove-RetiredRuntimeProfileDirs -Root $dest_root
if ($pruned -gt 0) {
    Write-Host ("[sync-dev-runtime] Pruned {0} retired profile dir(s) from debug runtime." -f $pruned) -ForegroundColor DarkGray
}

$removed_providers = 0
foreach ($dest_provider in Get-ChildItem -LiteralPath $dest_root -Directory -ErrorAction SilentlyContinue) {
    if (-not (Test-RuntimeBundleProvider -ProviderId $dest_provider.Name)) {
        try {
            Remove-Item -LiteralPath $dest_provider.FullName -Recurse -Force -ErrorAction Stop
            $removed_providers++
        } catch {
            Write-Host ("[sync-dev-runtime] Could not remove stale provider {0} (locked)." -f $dest_provider.Name) -ForegroundColor Yellow
        }
    }
}
if ($removed_providers -gt 0) {
    Write-Host ("[sync-dev-runtime] Removed {0} provider dir(s) outside bundle policy." -f $removed_providers) -ForegroundColor DarkGray
}

$catalog_src = Join-Path $runtime_root 'catalog'
if (Test-Path -LiteralPath $catalog_src) {
    $catalog_dst = Join-Path $dest_root 'catalog'
    New-Item -ItemType Directory -Path $catalog_dst -Force | Out-Null
    Copy-Item -Path (Join-Path $catalog_src '*') -Destination $catalog_dst -Recurse -Force
    Write-Host '[sync-dev-runtime] catalog -> target/debug/runtime/catalog' -ForegroundColor Green
}

if ($copied_profiles -eq 0 -and $copied_configs -eq 0) {
    Write-Host '[sync-dev-runtime] Nothing copied - check src-tauri/runtime/.' -ForegroundColor Yellow
    exit 0
}

if ($skipped_locked -gt 0) {
    Write-Host ("[sync-dev-runtime] {0} profile dir(s) were locked (overlay used). Stop engines for a full mirror." -f $skipped_locked) -ForegroundColor Yellow
}

Write-Host ("[sync-dev-runtime] Ready: {0} profile(s), {1} config tree(s)." -f $copied_profiles, $copied_configs) -ForegroundColor Cyan
