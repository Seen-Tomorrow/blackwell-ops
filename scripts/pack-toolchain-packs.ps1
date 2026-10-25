# Build the split CUDA-runtime toolchain packs and pin their digests in the manifest.
#
#   toolchain-rt-13.4-v<N>.7z   -> toolchain/cuda/v13.4/bin[/x64]/{cublas,cublasLt,cudart}
#   toolchain-rt-12.8-v<N>.7z   -> toolchain/cuda/v12.8/bin/{cublas,cublasLt,cudart}
#
# Why split: engine launch needs exactly those three DLLs (verified with dumpbin:
# ggml-cuda.dll -> cublas64_*.dll -> cublasLt64_*.dll). VS Build Tools, Windows SDK, cmake and
# nvcc are only needed to COMPILE in Foundry, so the wizard must not force them on a user who
# only runs engines. See docs/ENGINE-PACKS.md.
#
# The archive keeps the `toolchain/` prefix, same as the full pack, so
# resolve_toolchain_extract_dest extracts it into the app root unchanged.
#
# Usage:
#   .\scripts\pack-toolchain-packs.ps1
#   .\scripts\pack-toolchain-packs.ps1 -ToolchainRoot D:\toolchain -OutDir D:\out
#
# Never run this against a tree that is missing a runtime DLL: a pack that extracts to an
# incomplete runtime is worse than no pack (the engine fails at LoadLibrary).

param(
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

$manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
# v4 introduces `packs`; bump once. Re-running this script must not keep bumping.
$version = 4
if ($manifest.version -ge 4) { $version = [int]$manifest.version }

$existing = @{}
if ($manifest.packs) {
    foreach ($p in $manifest.packs) { $existing[$p.id] = $p }
}

$packs = @()
$work_root = Join-Path $root 'work\toolchain-pack-staging'
if (Test-Path -LiteralPath $work_root) { Remove-Item -LiteralPath $work_root -Recurse -Force }
New-Item -ItemType Directory -Path $work_root -Force | Out-Null

foreach ($cuda in $runtime.Keys) {
    $id = "runtime-$cuda"
    $src = Resolve-CudaDllDir -CudaVersion $cuda
    if (-not $src) {
        throw ("CUDA {0} runtime DLLs not found under {1}\cuda\v{0}\{{bin,bin\x64}}. Expected: {2}" -f `
            $cuda, $ToolchainRoot, ($runtime[$cuda] -join ', '))
    }

    $stage = Join-Path $work_root "rt-$cuda"
    $dest = Join-Path $stage ("toolchain\cuda\v{0}\{1}" -f $cuda, ($src.Substring((Join-Path $ToolchainRoot ("cuda\v{0}" -f $cuda)).Length).TrimStart('\')))
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
    $sha = (Get-FileHash -LiteralPath $zip_path -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ("[toolchain-pack] {0}  {1:N1} MB  sha256={2}" -f $asset, ($file.Length / 1MB), $sha) -ForegroundColor Green

    $packs += [ordered]@{
        id        = $id
        kind      = 'runtime'
        cuda      = $cuda
        asset     = $asset
        sha256    = $sha
        sizeBytes = [long]$file.Length
    }
}

# The full pack is still the Foundry path (build tools + both runtimes). Keep its existing
# asset name until ship-toolchain moves to versioned names; pin the digest if the archive is
# present locally, otherwise carry the previous entry forward.
$full_asset = 'toolchain.7z'
$full_archive = Join-Path $root "work\$full_asset"
if (Test-Path -LiteralPath $full_archive) {
    $full_file = Get-Item -LiteralPath $full_archive
    $packs += [ordered]@{
        id        = 'full'
        kind      = 'full'
        asset     = $full_asset
        sha256    = (Get-FileHash -LiteralPath $full_archive -Algorithm SHA256).Hash.ToLowerInvariant()
        sizeBytes = [long]$full_file.Length
    }
} elseif ($existing['full']) {
    $packs += $existing['full']
    Write-Host '[toolchain-pack] full pack not present locally - carried the previous digest forward' -ForegroundColor Yellow
}

$manifest | Add-Member -NotePropertyName 'packs' -NotePropertyValue $packs -Force
$manifest.version = $version
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$json = $manifest | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($ManifestPath, $json + "`n", $utf8NoBom)

Write-Host ("[toolchain-pack] wrote {0} pack(s) to manifest v{1}: {2}" -f $packs.Count, $version, (($packs | ForEach-Object { $_.id }) -join ', ')) -ForegroundColor Cyan
