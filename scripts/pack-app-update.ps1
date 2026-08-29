# Pack lean App update archive: blackwell-ops.exe + factory templates + foundry
# vendor patches + bundled 7z + (hash-gated) pi-subagents extension.
# Target size ~5 MB. Layout (prefixed for safe extract):
#
#   app/
#     blackwell-ops.exe
#     runtime/<provider>/config/*.json
#     foundry/patches/*.patch   # vendor patches (same as NSIS resource)
#     bin/7z.exe, bin/7z.dll
#     pi-ext/pi-subagents/**    # only when the extension changed (see .majestic-out/pi-ext.hash)
#
# Usage:
#   .\scripts\pack-app-update.ps1
#   .\scripts\pack-app-update.ps1 -Version 1.0.12 -Output .majestic-out\CORE_Blackwell-Ops-App-v1.0.12.7z
#   .\scripts\pack-app-update.ps1 -ExePath src-tauri\target\release\blackwell-ops.exe
#   .\scripts\pack-app-update.ps1 -ForcePiExt    # ship pi-ext even if the hash matches

param(
    [string]$Version = '',
    [string]$Output = '',
    [string]$ExePath = '',
    [string]$BundleRoot = '',
    [switch]$ForcePiExt
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

$SevenZip = Join-Path $root 'src-tauri\bin\7z.exe'
$SevenZipDll = Join-Path $root 'src-tauri\bin\7z.dll'
if (-not (Test-Path -LiteralPath $SevenZip)) {
    throw "Bundled 7z.exe not found at $SevenZip"
}
if (-not (Test-Path -LiteralPath $SevenZipDll)) {
    throw "Bundled 7z.dll not found at $SevenZipDll"
}

if (-not $Version) {
    $tauri_conf = Join-Path $root 'src-tauri\tauri.conf.json'
    $Version = (Get-Content -LiteralPath $tauri_conf -Raw | ConvertFrom-Json).version
}

if (-not $ExePath) {
    $ExePath = Join-Path $root 'src-tauri\target\release\blackwell-ops.exe'
}
if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "Release exe not found: $ExePath - build first (tauri build --no-bundle or npm run build:exe)"
}

# Refuse to pack DEV-config / wrong-version PEs (DISTRIBUTION / majestic integrity).
$assert_exe = Join-Path $script_dir 'assert-release-exe.ps1'
if (Test-Path -LiteralPath $assert_exe) {
    & $assert_exe -ExePath $ExePath -ExpectedVersion $Version -ExpectedProductName 'Blackwell Ops'
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "assert-release-exe failed (exit $LASTEXITCODE)"
    }
}

if (-not $BundleRoot) {
    $BundleRoot = Join-Path $root 'src-tauri\runtime-bundle'
}
if (-not (Test-Path -LiteralPath $BundleRoot)) {
    throw "runtime-bundle missing at $BundleRoot - run prepare-release-app-only.ps1 first"
}

if (-not $Output) {
    $out_dir = Join-Path $root '.majestic-out'
    New-Item -ItemType Directory -Path $out_dir -Force | Out-Null
    $Output = Join-Path $out_dir "CORE_Blackwell-Ops-App-v$Version.7z"
}
# Absolute path required: we chdir into work/ for 7z packing
if (-not [System.IO.Path]::IsPathRooted($Output)) {
    $Output = Join-Path (Get-Location).Path $Output
}
$Output = [System.IO.Path]::GetFullPath($Output)

$work = Join-Path $root "work\app-update-pack-$Version"
if (Test-Path -LiteralPath $work) {
    Remove-Item -LiteralPath $work -Recurse -Force
}
$app_stage = Join-Path $work 'app'
New-Item -ItemType Directory -Path $app_stage -Force | Out-Null

# Main executable
Copy-Item -LiteralPath $ExePath -Destination (Join-Path $app_stage 'blackwell-ops.exe') -Force

# Factory templates only (never engines)
$providers = Get-ChildItem -LiteralPath $BundleRoot -Directory -ErrorAction SilentlyContinue
$template_count = 0
foreach ($provider in $providers) {
    $config_src = Join-Path $provider.FullName 'config'
    if (-not (Test-Path -LiteralPath $config_src)) { continue }
    $config_dst = Join-Path $app_stage "runtime\$($provider.Name)\config"
    New-Item -ItemType Directory -Path $config_dst -Force | Out-Null
    Copy-Item -Path (Join-Path $config_src '*') -Destination $config_dst -Recurse -Force
    $template_count++
}
# Prefer runtime-catalog/ layout; accept legacy bundle/catalog/
$catalog_src = Join-Path $BundleRoot 'runtime-catalog'
if (-not (Test-Path -LiteralPath $catalog_src)) {
    $catalog_src = Join-Path $BundleRoot 'catalog'
}
if (Test-Path -LiteralPath $catalog_src) {
    $catalog_dst = Join-Path $app_stage 'runtime-catalog'
    New-Item -ItemType Directory -Path $catalog_dst -Force | Out-Null
    Copy-Item -Path (Join-Path $catalog_src '*') -Destination $catalog_dst -Recurse -Force
    Write-Host "[pack-app-update] Included plugin catalog (runtime-catalog/)" -ForegroundColor DarkGray
}

if ($template_count -eq 0) {
    throw "No provider config trees under $BundleRoot"
}

# Always ship 7z so App update apply works even on bare/minimal installs
$bin_dst = Join-Path $app_stage 'bin'
New-Item -ItemType Directory -Path $bin_dst -Force | Out-Null
Copy-Item -LiteralPath $SevenZip -Destination (Join-Path $bin_dst '7z.exe') -Force
Copy-Item -LiteralPath $SevenZipDll -Destination (Join-Path $bin_dst '7z.dll') -Force

# pi-subagents extension (pi-ext) - hash-gated. Shipping it means App-only updates can
# move users onto a new extension version, not just a new exe. The whole point of the
# gate is that the 1171-file tree is staged ONLY when it actually changed: unchanged
# daily App updates stay a 3-second download/unzip, and the payload appears on the one
# release where Harness UPDATE bumped pi-ext (which happens with a core pi update).
# Identity is the upstream package version plus a manifest of every file we ship, so a
# same-version refresh that changed bundled deps still counts as a change.
$PiExtSrc = Join-Path $root 'src-tauri\pi-ext\pi-subagents'
$PiExtPkg = Join-Path $PiExtSrc 'package.json'
if (-not (Test-Path -LiteralPath $PiExtPkg)) {
    Write-Host '[pack-app-update] Missing src-tauri\pi-ext\pi-subagents (gitignored).' -ForegroundColor Yellow
    Write-Host '  App update will NOT carry the pi-subagents extension. Refresh it via Harness UPDATE.' -ForegroundColor Yellow
} else {
    # Read the version with PowerShell, not node: node -p with a Windows path needs
    # hand-quoted require(), and a stray stderr line trips $ErrorActionPreference.
    $piext_version = $null
    try {
        $piext_version = [string]((Get-Content -LiteralPath $PiExtPkg -Raw | ConvertFrom-Json).version)
    } catch {
        throw "pack-app-update: could not parse $PiExtPkg : $_"
    }
    if (-not $piext_version) {
        throw "pack-app-update: no version field in $PiExtPkg"
    }
    # Manifest: relative path + length for every shipped file, hashed in sorted order.
    # Path separator is normalised so the same tree hashes identically on any machine.
    $piext_files = @(Get-ChildItem -LiteralPath $PiExtSrc -File -Recurse -ErrorAction SilentlyContinue)
    if ($piext_files.Count -lt 100) {
        throw "pack-app-update: pi-ext tree looks incomplete ($($piext_files.Count) files) at $PiExtSrc"
    }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("pi-subagents/$piext_version`n")
    foreach ($f in ($piext_files | Sort-Object { $_.FullName.Substring($PiExtSrc.Length).Replace('\','/').ToLowerInvariant() })) {
        $rel = $f.FullName.Substring($PiExtSrc.Length).TrimStart('\','/').Replace('\','/').ToLowerInvariant()
        [void]$sb.Append("$rel|$($f.Length)`n")
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $piext_hash = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($sb.ToString())))).Replace('-','').Substring(0,16).ToLowerInvariant()

    # Skip staging when the previous pack recorded this exact hash.
    $hashFile = Join-Path $root '.majestic-out\pi-ext.hash'
    $prevHash = $null
    if (Test-Path -LiteralPath $hashFile) {
        try { $prevHash = (Get-Content -LiteralPath $hashFile -Raw -ErrorAction SilentlyContinue).Trim() } catch { }
    }

    if ($prevHash -eq $piext_hash -and -not $ForcePiExt) {
        Write-Host ("[pack-app-update] pi-subagents unchanged (v{0} sha {1}) - SKIPPING pi-ext, update stays small" -f $piext_version, $piext_hash) -ForegroundColor Green
    } else {
        $piext_dst = Join-Path $app_stage 'pi-ext\pi-subagents'
        New-Item -ItemType Directory -Path $piext_dst -Force | Out-Null
        Copy-Item -Path (Join-Path $PiExtSrc '*') -Destination $piext_dst -Recurse -Force
        # Never ship a link into pi's own core (see pi_code.rs strip_shadowed_pi_core_modules).
        Get-ChildItem -LiteralPath $piext_dst -Recurse -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint } |
            Remove-Item -Force -ErrorAction SilentlyContinue
        $stagedCount = @(Get-ChildItem -LiteralPath $piext_dst -File -Recurse -Force -ErrorAction SilentlyContinue).Count
        $stagedMB = [math]::Round(((Get-ChildItem -LiteralPath $piext_dst -File -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 2)
        Write-Host ("[pack-app-update] Staged pi-ext/pi-subagents v{0} sha {1} - {2} files, {3} MB raw" -f $piext_version, $piext_hash, $stagedCount, $stagedMB) -ForegroundColor Cyan
        # Record the hash only after staging succeeded.
        $hashDir = Split-Path -Parent $hashFile
        if (-not (Test-Path -LiteralPath $hashDir)) { New-Item -ItemType Directory -Path $hashDir -Force | Out-Null }
        Set-Content -LiteralPath $hashFile -Value $piext_hash -NoNewline -Encoding ascii
    }
}

# Foundry vendor patches - same product files NSIS gets via tauri.conf resources.
# Extract lands at {install}/foundry/patches (app_root); Foundry apply reads there.
$patches_src = Join-Path $root 'foundry\patches'
if (-not (Test-Path -LiteralPath $patches_src)) {
    throw "foundry/patches missing at $patches_src - required for App update (Foundry vendor patches)"
}
$patch_files = @(Get-ChildItem -LiteralPath $patches_src -File -Filter '*.patch' -ErrorAction SilentlyContinue)
if ($patch_files.Count -eq 0) {
    throw "No *.patch files under $patches_src - required for App update"
}
$patches_dst = Join-Path $app_stage 'foundry\patches'
New-Item -ItemType Directory -Path $patches_dst -Force | Out-Null
foreach ($pf in $patch_files) {
    Copy-Item -LiteralPath $pf.FullName -Destination (Join-Path $patches_dst $pf.Name) -Force
}
Write-Host ("[pack-app-update] Included {0} foundry patch file(s)" -f $patch_files.Count) -ForegroundColor DarkGray


$out_parent = Split-Path -Parent $Output
if ($out_parent -and -not (Test-Path -LiteralPath $out_parent)) {
    New-Item -ItemType Directory -Path $out_parent -Force | Out-Null
}
if (Test-Path -LiteralPath $Output) {
    Remove-Item -LiteralPath $Output -Force
}

Push-Location $work
try {
    # Prefix layout: app/blackwell-ops.exe, app/runtime/..., app/foundry/patches, app/bin/...
    # Discard native 7z stdout/stderr so this script never pollutes caller assignment.
    $seven_out = & $SevenZip a -t7z -mx=9 -mmt=on $Output 'app' 2>&1
    $seven_exit = $LASTEXITCODE
    if ($seven_exit -ne 0) {
        foreach ($line in @($seven_out)) { Write-Host $line }
        throw "7z pack failed with exit $seven_exit"
    }
} finally {
    Pop-Location
}

$size_mb = [math]::Round((Get-Item -LiteralPath $Output).Length / 1MB, 2)
Write-Host ("[pack-app-update] OK: {0} ({1} MB) - {2} provider template tree(s) + exe + 7z + {3} patch(es)" -f $Output, $size_mb, $template_count, $patch_files.Count) -ForegroundColor Cyan

# Cleanup staging (keep archive)
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
