# Build the split toolchain packs and pin their digests in toolchain/manifest.json.
#
#   toolchain-rt-13.4-v<N>.7z   -> toolchain/cuda/v13.4/bin[/x64]/{cublas,cublasLt,cudart}
#   toolchain-rt-12.8-v<N>.7z   -> toolchain/cuda/v12.8/bin/{cublas,cublasLt,cudart}
#   toolchain-build-v<N>.7z     -> everything else (VS Build Tools, Windows SDK, cmake, nvcc)
#
# Why split: engine launch needs exactly those three DLLs (verified with dumpbin:
# ggml-cuda.dll -> cublas64_*.dll -> cublasLt64_*.dll). The build tools are only needed to
# COMPILE in Foundry, so a user who runs engines must not be forced to download them. See
# docs/ENGINE-PACKS.md.
#
# Every archive keeps the `toolchain/` prefix, so resolve_toolchain_extract_dest extracts it
# into the app root unchanged and partial packs merge instead of replacing.
#
# Usage:
#   .\scripts\pack-toolchain-packs.ps1                    # runtime + build
#   .\scripts\pack-toolchain-packs.ps1 -Packs runtime     # both runtime packs only
#   .\scripts\pack-toolchain-packs.ps1 -Packs build       # build pack only (slow: ~3.9 GB)
#
# Never run this against a tree that is missing a runtime DLL: a pack that extracts to an
# incomplete runtime is worse than no pack (the engine fails at LoadLibrary).

param(
    [ValidateSet('all', 'runtime', 'build')]
    [string]$Packs = 'all',
    [string]$ToolchainRoot = '',
    [string]$OutDir = '',
    [string]$ManifestPath = '',
    [string]$SevenZip = ''
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir

if (-not $ToolchainRoot) { $ToolchainRoot = Join-Path $root 'src-tauri\target\debug\toolchain' }
if (-not $OutDir) { $OutDir = Join-Path $root '.majestic-out' }
if (-not $ManifestPath) { $ManifestPath = Join-Path $root 'toolchain\manifest.json' }
if (-not $SevenZip) { $SevenZip = Join-Path $root 'src-tauri\bin\7z.exe' }

foreach ($p in @($ToolchainRoot, $ManifestPath, $SevenZip)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "Missing required path: $p" }
}
$toolchain_leaf = Split-Path $ToolchainRoot -Leaf
if ($toolchain_leaf -ne 'toolchain') {
    throw "ToolchainRoot must be a directory named 'toolchain' (got '$toolchain_leaf') - the archive prefix depends on it."
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# CUDA version -> the three DLLs that must exist, relative to the toolchain root.
# 13.4 ships them under bin\x64; 12.8 under bin. Check both so a layout change cannot silently
# produce an empty pack.
$runtime = [ordered]@{
    '13.4' = @('cublas64_13.dll', 'cublasLt64_13.dll', 'cudart64_13.dll')
    '12.8' = @('cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll')
}

function Resolve-CudaDllDir {
    param([string]$CudaVersion)
    $root_v = Join-Path $ToolchainRoot "cuda\v$CudaVersion"
    foreach ($sub in @('bin\x64', 'bin')) {
        $dir = Join-Path $root_v $sub
        if (-not (Test-Path -LiteralPath $dir)) { continue }
        $all = $true
        foreach ($dll in $runtime[$CudaVersion]) {
            if (-not (Test-Path -LiteralPath (Join-Path $dir $dll))) { $all = $false; break }
        }
        if ($all) { return $dir }
    }
    return $null
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
# v4 introduces `packs`; re-running must not keep bumping the version.
$version = 4
if ($manifest.version -ge 4) { $version = [int]$manifest.version }

$existing = @{}
if ($manifest.packs) {
    foreach ($p in $manifest.packs) { $existing[$p.id] = $p }
}
$built = @{}

$work_root = Join-Path $root 'work\toolchain-pack-staging'
if (Test-Path -LiteralPath $work_root) { Remove-Item -LiteralPath $work_root -Recurse -Force }
New-Item -ItemType Directory -Path $work_root -Force | Out-Null

$do_runtime = $Packs -in @('all', 'runtime')
$do_build = $Packs -in @('all', 'build')

if ($do_runtime) {
    foreach ($cuda in $runtime.Keys) {
        $id = "runtime-$cuda"
        $src = Resolve-CudaDllDir -CudaVersion $cuda
        if (-not $src) {
            throw ("CUDA {0} runtime DLLs not found under {1}\cuda\v{0}\{{bin,bin\x64}}. Expected: {2}" -f `
                $cuda, $ToolchainRoot, ($runtime[$cuda] -join ', '))
        }

        $stage = Join-Path $work_root "rt-$cuda"
        $rel = $src.Substring((Join-Path $ToolchainRoot ("cuda\v{0}" -f $cuda)).Length).TrimStart('\')
        $dest = Join-Path $stage ("toolchain\cuda\v{0}\{1}" -f $cuda, $rel)
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        foreach ($dll in $runtime[$cuda]) {
            Copy-Item -LiteralPath (Join-Path $src $dll) -Destination $dest -Force
        }

        $asset = "toolchain-rt-$cuda-v$version.7z"
        $zip_path = Join-Path $OutDir $asset
        if (Test-Path -LiteralPath $zip_path) { Remove-Item -LiteralPath $zip_path -Force }

        Push-Location $stage
        try {
            $seven_out = & $SevenZip a -t7z -mx=7 -mmt=on $zip_path 'toolchain' 2>&1
            if ($LASTEXITCODE -ne 0) {
                foreach ($line in @($seven_out)) { if ($line) { Write-Host $line } }
                throw "7z failed for $asset (exit $LASTEXITCODE)"
            }
        } finally {
            Pop-Location
        }

        $file = Get-Item -LiteralPath $zip_path
        $built[$id] = [ordered]@{
            id        = $id
            kind      = 'runtime'
            cuda      = $cuda
            asset     = $asset
            sha256    = (Get-Sha256 $zip_path)
            sizeBytes = [long]$file.Length
        }
        Write-Host ("[toolchain-pack] {0}  {1:N1} MB  sha256={2}" -f $asset, ($file.Length / 1MB), $built[$id].sha256) -ForegroundColor Green
    }
}

if ($do_build) {
    # Exclude the six runtime DLLs by name: they are unique to the runtime packs and anything
    # else named like them is not something a build needs.
    $excludes = @()
    foreach ($cuda in $runtime.Keys) {
        foreach ($dll in $runtime[$cuda]) { $excludes += "-xr!$dll" }
    }

    $asset = "toolchain-build-v$version.7z"
    $zip_path = Join-Path $OutDir $asset
    if (Test-Path -LiteralPath $zip_path) { Remove-Item -LiteralPath $zip_path -Force }

    $parent = Split-Path $ToolchainRoot -Parent
    Write-Host "[toolchain-pack] compressing build tools (~3.9 GB, single-threaded 7z; expect many minutes)" -ForegroundColor Cyan
    Push-Location $parent
    try {
        $args_list = @('a', '-t7z', '-mx=7', '-mmt=on', $zip_path, $toolchain_leaf) + $excludes
        $seven_out = & $SevenZip @args_list 2>&1
        if ($LASTEXITCODE -ne 0) {
            foreach ($line in @($seven_out)) { if ($line) { Write-Host $line } }
            throw "7z failed for $asset (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }

    $file = Get-Item -LiteralPath $zip_path
    $built['build'] = [ordered]@{
        id        = 'build'
        kind      = 'build'
        asset     = $asset
        sha256    = (Get-Sha256 $zip_path)
        sizeBytes = [long]$file.Length
    }
    Write-Host ("[toolchain-pack] {0}  {1:N1} MB  sha256={2}" -f $asset, ($file.Length / 1MB), $built['build'].sha256) -ForegroundColor Green
}

# Preserve the full pack entry if the archive is present locally; otherwise carry the old one.
$full_asset = 'toolchain.7z'
$full_archive = Join-Path $root "work\$full_asset"
if (Test-Path -LiteralPath $full_archive) {
    $full_file = Get-Item -LiteralPath $full_archive
    $built['full'] = [ordered]@{
        id        = 'full'
        kind      = 'full'
        asset     = $full_asset
        sha256    = (Get-Sha256 $full_archive)
        sizeBytes = [long]$full_file.Length
    }
} elseif ($existing['full']) {
    $built['full'] = $existing['full']
}

# Stable order, merge built entries over existing ones so a `-Packs build` run keeps the
# runtime digests instead of dropping them.
$order = @('runtime-13.4', 'runtime-12.8', 'build', 'full')
$pack_entries = @()
foreach ($id in $order) {
    if ($built.ContainsKey($id)) { $pack_entries += $built[$id] }
    elseif ($existing.ContainsKey($id)) { $pack_entries += $existing[$id] }
}
foreach ($id in $built.Keys) {
    if ($order -notcontains $id) { $pack_entries += $built[$id] }
}

$manifest | Add-Member -NotePropertyName 'packs' -NotePropertyValue $pack_entries -Force
$manifest.version = $version
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$json = $manifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($ManifestPath, $json + "`n", $utf8NoBom)

Write-Host ("[toolchain-pack] manifest v{0} now lists: {1}" -f $version, (($pack_entries | ForEach-Object { $_.id }) -join ', ')) -ForegroundColor Cyan
