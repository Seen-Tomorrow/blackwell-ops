# Pack per-provider profile runtime archives for selective in-app download.
# Layout (extract into app root):
#
#   runtime/{provider}/{profile}/   # slim dist binaries
#   runtime/{provider}/config/      # factory JSON (new-fork promotion)
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
    throw "runtime-bundle missing at $BundleRoot - run prepare-release-runtime.ps1 first"
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

    $zip_name = "$Prov-$Prof.7z"
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
    $item = Pack-OneProviderProfile -Prov $ProviderId -Prof $ProfileId
    if ($item) { $packed += $item }
} else {
    foreach ($provider in (Get-ChildItem -LiteralPath $BundleRoot -Directory)) {
        $prov = $provider.Name
        if (-not (Test-RuntimeBundleProvider -ProviderId $prov)) { continue }
        foreach ($prof in (Get-RuntimeBundleProfiles -ProviderId $prov)) {
            $item = Pack-OneProviderProfile -Prov $prov -Prof $prof
            if ($item) { $packed += $item }
        }
    }
}

Remove-Item -LiteralPath $work_root -Recurse -Force -ErrorAction SilentlyContinue

if ($packed.Count -eq 0) {
    throw 'No provider packs created'
}

Write-Host ("[pack-provider] Done: {0} archive(s) in {1}" -f $packed.Count, $OutDir) -ForegroundColor Cyan
# Paths are listed for humans only - do not emit on success stream (breaks majestic assignment)
foreach ($item in $packed) {
    Write-Host ("[pack-provider]   {0}" -f $item.FullName) -ForegroundColor DarkGray
}
