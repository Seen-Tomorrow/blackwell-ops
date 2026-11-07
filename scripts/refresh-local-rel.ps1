#requires -Version 7.0
# DEV-only: refresh the local portable REL from the current working tree.
#
# Builds the release exe, then copies into the local test install:
#   - src-tauri\target\release\blackwell-ops.exe
#   - Foundry EDGE artifact (ggml-master/edge/Release)        -> runtime\ggml-master\edge
#   - factory template (src-tauri\runtime\ggml-master\config) -> runtime\ggml-master\config
#
# No packing, no bump, no upload. The REL app must be closed: this script never kills it.
#
# Destination: -Dest, else BLACKWELL_LOCAL_REL_DIR, else the hardcoded dev box path.

param(
    [string]$Dest = '',
    # Test hook: reuse src-tauri\target\release instead of rebuilding.
    [switch]$SkipBuild,
    # Test hook: do not copy the learned cache.
    [switch]$SkipCache
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

if (-not $Dest) {
    $Dest = if ($env:BLACKWELL_LOCAL_REL_DIR) { $env:BLACKWELL_LOCAL_REL_DIR } else { 'C:\AI-MASTER\Blackwell OPS portable' }
}
$Dest = [System.IO.Path]::GetFullPath($Dest)
if (-not (Test-Path -LiteralPath $Dest)) {
    throw "Local REL folder not found: $Dest"
}
$dest_exe = Join-Path $Dest 'blackwell-ops.exe'
if (-not (Test-Path -LiteralPath $dest_exe)) {
    throw "Not a Blackwell OPS install (blackwell-ops.exe missing): $Dest"
}

# The portable app locks its exe; refuse instead of killing it (the user closes REL first).
$running = @(Get-Process -Name 'blackwell-ops' -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and $_.Path.StartsWith($Dest, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
    })
if ($running.Count -gt 0) {
    throw "Close the REL app first (pid $($running[0].Id)): $Dest"
}

$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($SkipBuild) {
    Write-Host "[local-rel] Skipping build (-SkipBuild), reusing src-tauri\target\release"
} else {
    Write-Host "[local-rel] Building REL $version -> $Dest"
    Push-Location $root
    try {
        npm run build:exe
        if ($LASTEXITCODE -ne 0) { throw "npm run build:exe failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

$built = Join-Path $root 'src-tauri\target\release\blackwell-ops.exe'
if (-not (Test-Path -LiteralPath $built)) { throw "Release exe missing after build: $built" }
$file_version = (Get-Item -LiteralPath $built).VersionInfo.FileVersion
if ($file_version -and -not $file_version.StartsWith($version)) {
    throw "Release exe version '$file_version' does not match package.json '$version'"
}

$edge_src = Join-Path $root 'src-tauri\target\debug\foundry\artifacts\ggml-master\edge\Release'
if (-not (Test-Path -LiteralPath (Join-Path $edge_src 'llama-server.exe'))) {
    throw "No Foundry EDGE artifact: $edge_src (build ggml-master/edge in Foundry first)"
}
$edge_info_path = Join-Path $edge_src 'build-info.txt'
$edge_identity = if (Test-Path -LiteralPath $edge_info_path) {
    (Get-Content -LiteralPath $edge_info_path -First 1).Trim()
} else { 'unknown' }

$cfg_src = Join-Path $root 'src-tauri\runtime\ggml-master\config'
if (-not (Test-Path -LiteralPath (Join-Path $cfg_src 'ggml-master-default-config.json'))) {
    throw "Factory template missing: $cfg_src"
}

# 1. exe: copy beside the target, then replace (fails cleanly if the app locked it).
Write-Host "[local-rel] Copying exe $file_version"
$staged_exe = Join-Path $Dest 'blackwell-ops.exe.new'
Copy-Item -LiteralPath $built -Destination $staged_exe -Force
Move-Item -LiteralPath $staged_exe -Destination $dest_exe -Force

# 2. EDGE engine: distribution binaries + build-info; leave the installer CRT DLLs untouched.
Write-Host "[local-rel] Copying EDGE $edge_identity"
$edge_dst = Join-Path $Dest 'runtime\ggml-master\edge'
New-Item -ItemType Directory -Path $edge_dst -Force | Out-Null
$edge_files = @(Get-RuntimeDistributionFiles -Directory $edge_src)
if ($edge_files.Count -eq 0) { throw "No distribution binaries in $edge_src" }
foreach ($f in $edge_files) { Copy-Item -LiteralPath $f.FullName -Destination $edge_dst -Force }
if (Test-Path -LiteralPath $edge_info_path) {
    Copy-Item -LiteralPath $edge_info_path -Destination $edge_dst -Force
}

# 3. Factory template: the REL reads it from runtime\<provider>\config.
Write-Host '[local-rel] Copying factory template'
$cfg_dst = Join-Path $Dest 'runtime\ggml-master\config'
New-Item -ItemType Directory -Path $cfg_dst -Force | Out-Null
Copy-Item -Path (Join-Path $cfg_src '*') -Destination $cfg_dst -Recurse -Force

# 4. Learned cache: fit/VRAM/calibration/model metadata + the forecast log.
# Only these files are portable: they key on the shared model library path + GPU topology,
# never on the app root. Runtime state (download tasks/history) and big caches are skipped.
$cache_src = Join-Path $root 'src-tauri\target\debug\config\cache'
$cache_dst = Join-Path $Dest 'config\cache'
$utf8 = New-Object System.Text.UTF8Encoding $false

function Read-JsonMap([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @{} }
    try {
        $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
        if ($value -is [System.Collections.IDictionary]) { return $value }
    } catch {
        Write-Host "[local-rel] skipped unreadable JSON: $Path"
    }
    return @{}
}

function Write-JsonAtomic([string]$Path, $Value) {
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, (($Value | ConvertTo-Json -Depth 20) + "`n"), $utf8)
    [System.IO.File]::Move($tmp, $Path, $true)
}

if ($SkipCache) {
    Write-Host '[local-rel] Skipping learned cache (-SkipCache)'
} elseif (-not (Test-Path -LiteralPath $cache_src)) {
    Write-Host "[local-rel] No DEV cache at $cache_src - skipping"
} else {
    Write-Host "[local-rel] Copying learned cache from $cache_src"
    New-Item -ItemType Directory -Path $cache_dst -Force | Out-Null
    $backup = Join-Path $Dest ("config\cache-backup\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    # Keep the three newest pre-refresh snapshots; older ones are superseded.
    Get-ChildItem -LiteralPath (Join-Path $Dest 'config\cache-backup') -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 3 |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    $cache_files = @('fit_scan_full.json', 'learned-vram.json', 'model_cache.json', 'gpu-calibration.json', 'forecast-log.jsonl')
    foreach ($name in $cache_files) {
        $dst = Join-Path $cache_dst $name
        if (Test-Path -LiteralPath $dst) { Copy-Item -LiteralPath $dst -Destination $backup -Force }
    }

    # JSON maps are merged, source (DEV) wins on conflicts, so REL-only learned rows survive.
    $learned_src = Read-JsonMap (Join-Path $cache_src 'learned-vram.json')
    $learned_dst = Read-JsonMap (Join-Path $cache_dst 'learned-vram.json')
    $learned = @{}
    foreach ($map in @($learned_dst.entries, $learned_src.entries)) {
        if ($map -is [System.Collections.IDictionary]) {
            foreach ($k in $map.Keys) { $learned[$k] = $map[$k] }
        }
    }
    if ($learned.Count -gt 0) { Write-JsonAtomic (Join-Path $cache_dst 'learned-vram.json') @{ entries = $learned } }

    $models_src = Read-JsonMap (Join-Path $cache_src 'model_cache.json')
    $models_dst = Read-JsonMap (Join-Path $cache_dst 'model_cache.json')
    $models = @{}
    foreach ($map in @($models_dst, $models_src)) {
        foreach ($k in $map.Keys) { $models[$k] = $map[$k] }
    }
    if ($models.Count -gt 0) { Write-JsonAtomic (Join-Path $cache_dst 'model_cache.json') $models }

    foreach ($name in @('fit_scan_full.json', 'gpu-calibration.json')) {
        $src = Join-Path $cache_src $name
        if (-not (Test-Path -LiteralPath $src)) { continue }
        try {
            $null = Get-Content -LiteralPath $src -Raw -Encoding UTF8 | ConvertFrom-Json
            Copy-Item -LiteralPath $src -Destination (Join-Path $cache_dst $name) -Force
        } catch {
            Write-Host "[local-rel] skipped unreadable JSON: $src"
        }
    }

    # Forecast log is append-only: keep REL's lines, append the DEV lines it does not have.
    $forecast_src = Join-Path $cache_src 'forecast-log.jsonl'
    $forecast_dst = Join-Path $cache_dst 'forecast-log.jsonl'
    $added_lines = 0
    if (Test-Path -LiteralPath $forecast_src) {
        $have = New-Object 'System.Collections.Generic.HashSet[string]'
        if (Test-Path -LiteralPath $forecast_dst) {
            foreach ($line in Get-Content -LiteralPath $forecast_dst) { [void]$have.Add($line) }
        }
        $new_lines = @(Get-Content -LiteralPath $forecast_src | Where-Object { -not $have.Contains($_) })
        if ($new_lines.Count -gt 0) {
            [System.IO.File]::AppendAllText($forecast_dst, (($new_lines -join "`n") + "`n"), $utf8)
            $added_lines = $new_lines.Count
        }
    }

    Write-Host ("[local-rel] Cache: learned {0} | models {1} | forecast +{2} line(s) | backup {3}" -f $learned.Count, $models.Count, $added_lines, $backup)
}

$template_version = (Get-Content -LiteralPath (Join-Path $cfg_dst 'ggml-master-default-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).templateVersion
Write-Host ("[local-rel] OK: REL {0} | EDGE {1} | template v{2} -> {3}" -f $file_version, $edge_identity, $template_version, $Dest)

exit 0
