# Validate a packed toolchain archive against the manifest INSIDE it.
#
# The failure this exists for: toolchain.7z shipped 2026-07-09 with no CUDA 13.4 at
# all, while later app builds listed an EDGE profile. Nothing compared the artifact's
# manifest to its payload, so the app could offer a profile the pack cannot build.
#
# Usage:
#   .\scripts\toolchain-validate-archive.ps1 -Archive "C:\path\to\toolchain.7z"

param(
    [Parameter(Mandatory)]
    [string]$Archive
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$SevenZip = Join-Path $RepoRoot "src-tauri\bin\7z.exe"

if (-not (Test-Path -LiteralPath $SevenZip)) {
    throw "Bundled 7z.exe not found at $SevenZip"
}
if (-not (Test-Path -LiteralPath $Archive)) {
    throw "Archive not found: $Archive"
}

# -slt prints one "Path = ..." line per entry; the columnar listing is not parseable.
$listing = & $SevenZip l -slt $Archive
if ($LASTEXITCODE -ne 0) { throw "7z list failed on $Archive" }

$entries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($line in $listing) {
    if ($line -like 'Path = *') {
        $p = $line.Substring(7).Trim().Replace('/', '\')
        if ($p -like 'toolchain\*') { [void]$entries.Add($p) }
    }
}
if ($entries.Count -eq 0) {
    throw "Archive contains no toolchain\ entries - wrong layout (extract must land in app_root\toolchain)"
}

$manifestRaw = & $SevenZip e -so $Archive 'toolchain\manifest.json'
if ($LASTEXITCODE -ne 0 -or -not $manifestRaw) {
    throw "manifest.json not found inside $Archive (archive root must be toolchain\)"
}
$manifest = ($manifestRaw -join "`n") | ConvertFrom-Json

$missing = New-Object System.Collections.Generic.List[string]
function Test-Entry([string]$Label, [string]$RelativePath) {
    $want = 'toolchain\' + ($RelativePath -replace '/', '\')
    if (-not $entries.Contains($want)) { $script:missing.Add("$Label  ->  $want") }
}

foreach ($prop in $manifest.vs.PSObject.Properties) {
    $vsKey = $prop.Name
    $vsDef = $prop.Value
    Test-Entry "VS $vsKey devcmd" $vsDef.devcmd
    Test-Entry "VS $vsKey cl.exe" "vs/$vsKey/VC/Tools/MSVC/$($vsDef.msvc_version)/bin/Hostx64/x64/cl.exe"
}

foreach ($prof in $manifest.profiles) {
    Test-Entry "profile $($prof.id) nvcc (CUDA $($prof.cuda))" "cuda/v$($prof.cuda)/bin/nvcc.exe"
    $profVs = $manifest.vs.PSObject.Properties[$prof.vs]
    if ($null -eq $profVs) {
        $script:missing.Add("profile $($prof.id) names vs '$($prof.vs)', which the manifest does not define")
    }
}

Test-Entry "portable cmake" "cmake/bin/cmake.exe"
Test-Entry "Windows SDK" "Windows Kits/10/Include/$($manifest.windows_sdk_version)/um/windows.h"

if ($missing.Count -gt 0) {
    $ids = ($manifest.profiles | ForEach-Object { $_.id }) -join ', '
    throw @"
Toolchain archive does not match its own manifest.
  archive:   $Archive
  version:   $($manifest.version)
  profiles:  $ids

Missing from the archive:
  $($missing -join "`n  ")

Repack before shipping: scripts\pack-foundry-toolchain.ps1 trims the payload and
rewrites the manifest so the two cannot disagree.
"@
}

$sizeMb = [math]::Round((Get-Item -LiteralPath $Archive).Length / 1MB, 1)
$ids = ($manifest.profiles | ForEach-Object { "$($_.id) (CUDA $($_.cuda))" }) -join ', '
Write-Host "Archive OK: manifest v$($manifest.version), profiles $ids, $($entries.Count) entries, $sizeMb MB" -ForegroundColor Green
