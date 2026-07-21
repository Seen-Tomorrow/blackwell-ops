# Sync src-tauri/runtime -> src-tauri/target/debug/runtime for DEV (npm run predev).
# Usage:
#   .\scripts\sync-dev-runtime.ps1
#   .\scripts\sync-dev-runtime.ps1 -Force   # ignore fingerprint, full mirror
#
# Copies factory configs for every provider folder, then mirrors only active
# profiles (frontier + stable). Retired vanguard/fresh are omitted and pruned
# from the debug runtime tree.
#
# Fast path: SHA-256 of (relative path | size | LastWriteTimeUtc) for every file
# that would be synced. Unchanged source → skip all copies (saves SSD on 100+/day
# predev runs when foundry/runtime did not change).
#
# Locked engine dirs (running llama-server / blackwell-ops still holding DLLs)
# are skipped with a warning — config still syncs so DEV can start.

param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

$runtime_root = Join-Path $root 'src-tauri\runtime'
$dest_root = Join-Path $root 'src-tauri\target\debug\runtime'
# Bump when sync rules change (which profiles/providers) so caches invalidate.
$sync_schema = '3'
$fingerprint_path = Join-Path $dest_root '.blackwell-dev-runtime-sync'

if (-not (Test-Path -LiteralPath $runtime_root)) {
    Write-Host '[sync-dev-runtime] No src-tauri/runtime/ - nothing to sync.' -ForegroundColor Yellow
    exit 0
}

function Get-CatalogSourceRoot {
    $catalog = Join-Path (Split-Path -Parent $runtime_root) 'runtime-catalog'
    if (Test-Path -LiteralPath (Join-Path $catalog 'plugins.json')) {
        return $catalog
    }
    $legacy = Join-Path $runtime_root 'catalog'
    if (Test-Path -LiteralPath $legacy) {
        return $legacy
    }
    return $null
}

# Collect absolute directories that participate in the mirror (same set as copy loops).
function Get-SyncSourceRoots {
    $dirs = [System.Collections.Generic.List[string]]::new()
    foreach ($provider in Get-ChildItem -LiteralPath $runtime_root -Directory -ErrorAction SilentlyContinue) {
        $provider_id = $provider.Name
        if (-not (Test-RuntimeBundleProvider -ProviderId $provider_id)) {
            continue
        }
        $config_src = Join-Path $provider.FullName 'config'
        if (Test-Path -LiteralPath $config_src) {
            $dirs.Add($config_src)
        }
        foreach ($profile_id in (Get-RuntimeBundleProfiles -ProviderId $provider_id)) {
            if (Test-RuntimeProfileRetired -ProfileId $profile_id) {
                continue
            }
            $profile_src = Join-Path $provider.FullName $profile_id
            if (Test-Path -LiteralPath $profile_src) {
                $dirs.Add($profile_src)
            }
        }
    }
    $catalog = Get-CatalogSourceRoot
    if ($catalog) {
        $dirs.Add($catalog)
    }
    return $dirs
}

function Get-SourceFingerprint {
    param([string[]]$SourceDirs)

    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add("schema=$sync_schema")

    foreach ($dir in ($SourceDirs | Sort-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $dir)) {
            continue
        }
        Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue |
            Sort-Object FullName |
            ForEach-Object {
                # Relative to repo root so the fingerprint is path-stable.
                $rel = $_.FullName.Substring($root.Length).TrimStart('\', '/')
                $lines.Add(('{0}|{1}|{2}' -f $rel, $_.Length, $_.LastWriteTimeUtc.Ticks))
            }
    }

    $payload = ($lines -join "`n") + "`n"
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload))
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Test-DestLooksPresent {
    # Avoid "fingerprint match but empty dest" after a partial clean of target/debug.
    if (-not (Test-Path -LiteralPath $dest_root)) {
        return $false
    }
    $any = Get-ChildItem -LiteralPath $dest_root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne '.' } |
        Select-Object -First 1
    return $null -ne $any
}

$source_dirs = @(Get-SyncSourceRoots)
$fingerprint = Get-SourceFingerprint -SourceDirs $source_dirs

if (-not $Force -and (Test-Path -LiteralPath $fingerprint_path) -and (Test-DestLooksPresent)) {
    $prev = (Get-Content -LiteralPath $fingerprint_path -Raw -ErrorAction SilentlyContinue).Trim()
    if ($prev -eq $fingerprint) {
        Write-Host ('[sync-dev-runtime] Unchanged (fingerprint {0}...) - skip copy.' -f $fingerprint.Substring(0, 12)) -ForegroundColor DarkGray
        exit 0
    }
}

if ($Force) {
    Write-Host '[sync-dev-runtime] -Force: full mirror (fingerprint ignored).' -ForegroundColor Cyan
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

# Plugin metadata lives under runtime-catalog/ (not runtime/catalog/)
$catalog_src = Get-CatalogSourceRoot
if ($catalog_src) {
    $catalog_dst = Join-Path (Split-Path -Parent $dest_root) 'runtime-catalog'
    New-Item -ItemType Directory -Path $catalog_dst -Force | Out-Null
    Copy-Item -Path (Join-Path $catalog_src '*') -Destination $catalog_dst -Recurse -Force
    Write-Host '[sync-dev-runtime] plugins.json -> target/debug/runtime-catalog/' -ForegroundColor Green
}

# Only stamp fingerprint after a successful (or overlay) mirror so a failed half-copy re-runs next time.
# Locked overlay still stamps — dest may be imperfect until engines stop + -Force.
Set-Content -LiteralPath $fingerprint_path -Value $fingerprint -NoNewline -Encoding ascii

if ($copied_profiles -eq 0 -and $copied_configs -eq 0) {
    Write-Host '[sync-dev-runtime] Nothing copied - check src-tauri/runtime/.' -ForegroundColor Yellow
    exit 0
}

if ($skipped_locked -gt 0) {
    Write-Host ("[sync-dev-runtime] {0} profile dir(s) were locked (overlay used). Stop engines for a full mirror." -f $skipped_locked) -ForegroundColor Yellow
}

Write-Host ("[sync-dev-runtime] Ready: {0} profile(s), {1} config tree(s). fingerprint={2}..." -f $copied_profiles, $copied_configs, $fingerprint.Substring(0, 12)) -ForegroundColor Cyan
