# Pack per-provider profile runtime archives for selective in-app download.
# Layout (extract into app root):
#
#   runtime/{provider}/{profile}/   # slim dist binaries
#   runtime/{provider}/config/      # factory JSON (new-fork promotion)
#
# Names:
#   PLUGIN_{provider}-{profile}.7z  — catalog plugins (default when packing "all")
#   CORE_{provider}-{profile}.7z    — NSIS core (ggml-master) only when -ProviderId is explicit
#
# Full NSIS already embeds core engines — do not bulk-pack ggml-master on weekly Full.
#
# Usage:
#   .\scripts\pack-provider-runtime.ps1 -OutDir .majestic-out
#   .\scripts\pack-provider-runtime.ps1 -ProviderId ggml-master -ProfileId frontier

param(
    [string]$BundleRoot = '',
    [string]$OutDir = '',
    [string]$ProviderId = '',
    [string]$ProfileId = ''
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

$SevenZip = Join-Path $root 'src-tauri\bin\7z.exe'
if (-not (Test-Path -LiteralPath $SevenZip)) {
    throw "Bundled 7z.exe not found at $SevenZip"
}

if (-not $BundleRoot) {
    $BundleRoot = Join-Path $root 'src-tauri\runtime-bundle'
}
if (-not (Test-Path -LiteralPath $BundleRoot)) {
    New-Item -ItemType Directory -Path $BundleRoot -Force | Out-Null
    Write-Host "[pack-provider] Created runtime-bundle (optional provider pack)" -ForegroundColor DarkGray
}

$runtime_root = Join-Path $root 'src-tauri\runtime'

function Sync-ProviderTreeToBundle {
    param(
        [string]$Prov,
        [string]$Prof
    )
    if (-not (Test-RuntimeBundleProvider -ProviderId $Prov)) {
        return
    }
    if (-not (Test-RuntimeBundleProfile -ProviderId $Prov -ProfileId $Prof)) {
        return
    }

    $runtime_profile = Join-Path $runtime_root "$Prov\$Prof"
    $bundle_profile = Join-Path $BundleRoot "$Prov\$Prof"
    if (-not (Test-Path -LiteralPath $bundle_profile) -and (Test-Path -LiteralPath $runtime_profile)) {
        New-Item -ItemType Directory -Path $bundle_profile -Force | Out-Null
        foreach ($file in (Get-RuntimeDistributionFiles -Directory $runtime_profile)) {
            Copy-Item -LiteralPath $file.FullName -Destination $bundle_profile -Force
        }
        Write-Host "[pack-provider] staged $Prov/$Prof from runtime/ -> runtime-bundle/" -ForegroundColor DarkGray
    }

    $runtime_config = Join-Path $runtime_root "$Prov\config"
    $bundle_config = Join-Path $BundleRoot "$Prov\config"
    if ((Test-Path -LiteralPath $runtime_config) -and -not (Test-Path -LiteralPath $bundle_config)) {
        New-Item -ItemType Directory -Path $bundle_config -Force | Out-Null
        Copy-Item -Path (Join-Path $runtime_config '*') -Destination $bundle_config -Recurse -Force
        Write-Host "[pack-provider] staged $Prov/config from runtime/" -ForegroundColor DarkGray
    }
}

if (-not $OutDir) {
    $OutDir = Join-Path $root '.majestic-out'
}
if (-not [System.IO.Path]::IsPathRooted($OutDir)) {
    $OutDir = Join-Path (Get-Location).Path $OutDir
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$work_root = Join-Path $root 'work\provider-pack-staging'
if (Test-Path -LiteralPath $work_root) {
    Remove-Item -LiteralPath $work_root -Recurse -Force
}
New-Item -ItemType Directory -Path $work_root -Force | Out-Null

$packed = @()

function Pack-OneProviderProfile {
    param(
        [string]$Prov,
        [string]$Prof
    )

    Sync-ProviderTreeToBundle -Prov $Prov -Prof $Prof

    $profile_src = Join-Path $BundleRoot "$Prov\$Prof"
    if (-not (Test-Path -LiteralPath $profile_src)) {
        Write-Host "[pack-provider] skip missing profile tree: $Prov/$Prof" -ForegroundColor Yellow
        return $null
    }

    $dist_files = @(Get-RuntimeDistributionFiles -Directory $profile_src)
    if ($dist_files.Count -eq 0) {
        Write-Host "[pack-provider] skip empty: $Prov/$Prof" -ForegroundColor Yellow
        return $null
    }

    $stage = Join-Path $work_root "$Prov-$Prof"
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }

    $profile_dst = Join-Path $stage "runtime\$Prov\$Prof"
    New-Item -ItemType Directory -Path $profile_dst -Force | Out-Null
    foreach ($file in $dist_files) {
        Copy-Item -LiteralPath $file.FullName -Destination $profile_dst -Force
    }

    $config_src = Join-Path $BundleRoot "$Prov\config"
    if (Test-Path -LiteralPath $config_src) {
        $config_dst = Join-Path $stage "runtime\$Prov\config"
        New-Item -ItemType Directory -Path $config_dst -Force | Out-Null
        Copy-Item -Path (Join-Path $config_src '*') -Destination $config_dst -Recurse -Force
    }

    # CORE_ for NSIS core engines; PLUGIN_ for optional catalog forks.
    $kind = if (Test-RuntimeNsisProvider -ProviderId $Prov) { 'CORE' } else { 'PLUGIN' }
    $zip_name = "${kind}_${Prov}-${Prof}.7z"
    $zip_path = Join-Path $OutDir $zip_name
    if (Test-Path -LiteralPath $zip_path) {
        Remove-Item -LiteralPath $zip_path -Force
    }

    Push-Location $stage
    try {
        $seven_out = & $SevenZip a -t7z -mx=7 -mmt=on $zip_path 'runtime' 2>&1
        $seven_exit = $LASTEXITCODE
        if ($seven_exit -ne 0) {
            foreach ($line in @($seven_out)) { Write-Host $line }
            throw "7z pack failed for $zip_name (exit $seven_exit)"
        }
    } finally {
        Pop-Location
    }

    $size_mb = [math]::Round((Get-Item -LiteralPath $zip_path).Length / 1MB, 2)
    Write-Host ("[pack-provider] OK: {0} ({1} MB, {2} files)" -f $zip_name, $size_mb, $dist_files.Count) -ForegroundColor Green
    return (Get-Item -LiteralPath $zip_path)
}

if ($ProviderId -and $ProfileId) {
    # Explicit single pack (core or plugin) — used by DISTRIBUTION Pack+Ship per profile.
    $item = Pack-OneProviderProfile -Prov $ProviderId -Prof $ProfileId
    if ($item) { $packed += $item }
} else {
    # Bulk pack for Full ship: plugins only. NSIS core (ggml-master) stays inside Setup.exe.
    foreach ($kv in $script:OptionalDownloadProviders.GetEnumerator()) {
        $prov = $kv.Key
        foreach ($prof in @($kv.Value)) {
            if (Test-RuntimeProfileRetired -ProfileId $prof) { continue }
            $item = Pack-OneProviderProfile -Prov $prov -Prof $prof
            if ($item) { $packed += $item }
        }
    }
}

Remove-Item -LiteralPath $work_root -Recurse -Force -ErrorAction SilentlyContinue

if ($packed.Count -eq 0) {
    if ($ProviderId -and $ProfileId) {
        throw "No provider pack created for $ProviderId/$ProfileId"
    }
    # Full pack with no plugins ready is OK — NSIS + App still ship.
    Write-Host '[pack-provider] No plugin packs created (ok if plugins not built)' -ForegroundColor DarkGray
    exit 0
}

Write-Host ("[pack-provider] Done: {0} archive(s) in {1}" -f $packed.Count, $OutDir) -ForegroundColor Cyan
# Paths are listed for humans only - do not emit on success stream (breaks majestic assignment)
foreach ($item in $packed) {
    Write-Host ("[pack-provider]   {0}" -f $item.FullName) -ForegroundColor DarkGray
}
