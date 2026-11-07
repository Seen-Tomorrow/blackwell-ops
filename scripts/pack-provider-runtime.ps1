# Pack engine binaries for in-app download and pin their digests in src-tauri/runtime-catalog/engines.json.
#
#   ENGINE_{provider}-{profile}-{buildId}.7z   stage: runtime/{provider}/{profile} + config
#
# The installer seeds only the profiles listed under `nsisCore` in distribution-policy.json
# (EDGE). Everything else - STABLE, forks - is a pack, so an engine update stops re-shipping the
# whole installer. The digest lives in a committed file that the Rust side embeds, so a swapped
# pack is refused (docs/ENGINE-PACKS.md).
#
# Usage:
#   .\scripts\pack-provider-runtime.ps1                      # every enginePacks provider
#   .\scripts\pack-provider-runtime.ps1 -ProviderId ggml-master -ProfileId stable
#
# Source: Foundry artifacts (<app_root>/foundry/artifacts/<p>/<profile>/Release) + factory config
# (<repo>/src-tauri/runtime/<p>/config). Never runtime-bundle: that holds only the seeded profiles.

param(
    [string]$OutDir = '',
    [string]$ProviderId = '',
    [string]$ProfileId = ''
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')
. (Join-Path $script_dir 'engine-identity.ps1')

$SevenZip = Join-Path $root 'src-tauri\bin\7z.exe'
if (-not (Test-Path -LiteralPath $SevenZip)) { throw "Bundled 7z.exe not found at $SevenZip" }

if (-not $OutDir) { $OutDir = Join-Path $root '.majestic-out' }
$artifacts_root = Join-Path $root 'src-tauri\target\debug\foundry\artifacts'
# Factory configs live beside the provider (installed by the installer seed), not in Foundry.
$config_root = Join-Path $root 'src-tauri\runtime'
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$ManifestPath = Join-Path $root 'src-tauri\runtime-catalog\engines.json'
$toolchain = Get-Content -LiteralPath (Join-Path $root 'toolchain\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json

# `llama-server --version` prints "version: 0.8.0-dev (build 12017, commit 5047748f)".
# Returns the machine identity (`b<build>-<sha8>`) plus llama's human-readable version — the
# only readable part of an engine pack name, and what the release page / ENGINE page show.
# Run with the portable CUDA bin on PATH or the loader fails before the binary prints anything.
function Get-EngineIdentity {
    param([string]$Exe, [string]$CudaVersion)
    $dirs = @()
    foreach ($sub in @("cuda\v$CudaVersion\bin\x64", "cuda\v$CudaVersion\bin")) {
        $d = Join-Path (Join-Path $root 'src-tauri\target\debug\toolchain') $sub
        if (Test-Path -LiteralPath $d) { $dirs += $d }
    }
    if ($dirs.Count -eq 0) {
        throw "No portable CUDA $CudaVersion runtime found; cannot probe $Exe (run scripts\pack-toolchain-packs.ps1)."
    }
    $old = $env:PATH
    $prev_eap = $ErrorActionPreference
    try {
        # llama-server prints its version to stderr; with Stop as the script default PowerShell
        # turns that into a terminating NativeCommandError.
        $ErrorActionPreference = 'Continue'
        $env:PATH = ($dirs -join ';') + ';' + $old
        $out = (& $Exe --version 2>&1 | Out-String)
    } finally {
        $ErrorActionPreference = $prev_eap
        $env:PATH = $old
    }

    # Parsing lives in engine-identity.ps1 so it can be tested without an engine.
    return ConvertFrom-EngineVersionOutput -Output $out -Exe $Exe
}

function Get-ProfileCuda([string]$Profile) {
    $def = $toolchain.profiles | Where-Object { $_.id -eq $Profile } | Select-Object -First 1
    if (-not $def) { throw "Profile '$Profile' is not in toolchain\manifest.json" }
    return [string]$def.cuda
}

# Existing manifest entries survive this run: only the profiles we pack are replaced.
$doc = $null
if (Test-Path -LiteralPath $ManifestPath) {
    $doc = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
$entries = @{}
if ($doc -and $doc.enginePacks) {
    foreach ($e in $doc.enginePacks) { $entries[("{0}/{1}" -f $e.provider, $e.profile)] = $e }
}

$work_root = Join-Path $root 'work\provider-pack-staging'
if (Test-Path -LiteralPath $work_root) { Remove-Item -LiteralPath $work_root -Recurse -Force }
New-Item -ItemType Directory -Path $work_root -Force | Out-Null

function Pack-OneProfile {
    param([string]$Prov, [string]$Prof)
    if (Test-RuntimeProfileRetired -ProfileId $Prof) { return $null }
    if (-not (Test-RuntimeBundleProfile -ProviderId $Prov -ProfileId $Prof)) { return $null }

    $src = Join-Path $artifacts_root "$Prov\$Prof\Release"
    if (-not (Test-Path -LiteralPath (Join-Path $src 'llama-server.exe'))) {
        Write-Host "[engine-pack] skip $Prov/$Prof - no llama-server.exe in $src (build it in Foundry)" -ForegroundColor Yellow
        return $null
    }

    $cuda = Get-ProfileCuda -Profile $Prof
    $identity = Get-EngineIdentity -Exe (Join-Path $src 'llama-server.exe') -CudaVersion $cuda
    $build_id = [string]$identity.Build
    $llama_version = [string]$identity.Version

    $stage = Join-Path $work_root "$Prov-$Prof"
    $dst = Join-Path $stage "runtime\$Prov\$Prof"
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    $files = @(Get-RuntimeDistributionFiles -Directory $src)
    if ($files.Count -eq 0) { throw "No distribution binaries found in $src" }
    foreach ($f in $files) { Copy-Item -LiteralPath $f.FullName -Destination $dst -Force }

    # Every engine binary imports the x64 MSVC CRT (vcruntime140 / vcruntime140_1 / msvcp140).
    # App-local copies win the DLL search order; a pack without them dies at LoadLibrary on a
    # machine that never had VC++ 2015-2022 — the "raw Windows dialog, no engine log" failure.
    # Previously only prepare-release-runtime.ps1 staged these, i.e. only the installer seed.
    $crt_written = Install-MsvcCrtIntoDirs -Root (Join-Path $stage 'runtime') `
        -ToolchainRoot (Join-Path $root 'src-tauri\target\debug\toolchain') -Quiet
    if ($crt_written -lt 3) {
        throw ("MSVC CRT staging wrote {0} file(s) for {1}/{2}; expected 3. Fix the toolchain path before packing." -f $crt_written, $Prov, $Prof)
    }

    $config_src = Join-Path $config_root "$Prov\config"
    if (Test-Path -LiteralPath $config_src) {
        $config_dst = Join-Path $stage "runtime\$Prov\config"
        New-Item -ItemType Directory -Path $config_dst -Force | Out-Null
        Copy-Item -Path (Join-Path $config_src '*') -Destination $config_dst -Recurse -Force
    }

    # Human-readable version first, machine identity last: `ENGINE_<prov>-<profile>-[<ver>-]<build>.7z`.
    $asset = if ($llama_version) {
        "ENGINE_$Prov-$Prof-$llama_version-$build_id.7z"
    } else {
        "ENGINE_$Prov-$Prof-$build_id.7z"
    }
    $zip_path = Join-Path $OutDir $asset
    if (Test-Path -LiteralPath $zip_path) { Remove-Item -LiteralPath $zip_path -Force }

    Push-Location $stage
    try {
        $seven_out = & $SevenZip a -t7z -mx=7 -mmt=on $zip_path 'runtime' 2>&1
        if ($LASTEXITCODE -ne 0) {
            foreach ($line in @($seven_out)) { if ($line) { Write-Host $line } }
            throw "7z failed for $asset (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }

    $file = Get-Item -LiteralPath $zip_path
    $label = if ($Prof -eq 'edge') { 'EDGE' } elseif ($Prof -eq 'stable') { 'STABLE' } else { $Prof.ToUpper() }
    $recommended = $false
    if ($script:RecommendedEngine) {
        $recommended = ($script:RecommendedEngine.provider -eq $Prov) -and ($script:RecommendedEngine.profile -eq $Prof)
    }

    $entries["$Prov/$Prof"] = [pscustomobject][ordered]@{
        provider     = $Prov
        profile      = $Prof
        label        = $label
        asset        = $asset
        sha256       = Get-FileSha256Hex -Path $zip_path
        sizeBytes    = [long]$file.Length
        cuda         = $cuda
        build        = $build_id
        llamaVersion = $llama_version
        recommended  = [bool]$recommended
    }
    $human = if ($llama_version) { "$llama_version $build_id" } else { $build_id }
    Write-Host ("[engine-pack] {0}  {1:N1} MB  cuda {2}  {3}" -f $asset, ($file.Length / 1MB), $cuda, $human) -ForegroundColor Green
    return $zip_path
}

$packed = @()
if ($ProviderId -and $ProfileId) {
    $one = Pack-OneProfile -Prov $ProviderId -Prof $ProfileId
    if ($one) { $packed += $one }
} else {
    foreach ($kv in $script:EnginePackProviders.GetEnumerator()) {
        foreach ($prof in @($kv.Value)) {
            $one = Pack-OneProfile -Prov $kv.Key -Prof $prof
            if ($one) { $packed += $one }
        }
    }
}

if ($packed.Count -eq 0) {
    throw "No engine packs produced - check enginePacks in distribution-policy.json and Foundry artifacts under $artifacts_root"
}

$ordered = @($entries.Values | Sort-Object { $_.provider }, { $_.profile })
$out_doc = [pscustomobject][ordered]@{
    schemaVersion = 1
    enginePacks   = $ordered
}
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
# Committed artifact: normalise to LF (ConvertTo-Json emits CRLF on Windows hosts, which
# makes every later diff warn and re-normalise).
$manifest_json = (($out_doc | ConvertTo-Json -Depth 8) -replace "`r`n", "`n")
[System.IO.File]::WriteAllText($ManifestPath, ($manifest_json + "`n"), $utf8NoBom)

Write-Host ("[engine-pack] wrote {0} pack(s): {1}" -f $packed.Count, (($packed | ForEach-Object { Split-Path $_ -Leaf }) -join ', ')) -ForegroundColor Cyan
Write-Host ("[engine-pack] manifest: {0}" -f $ManifestPath) -ForegroundColor Cyan

exit 0
