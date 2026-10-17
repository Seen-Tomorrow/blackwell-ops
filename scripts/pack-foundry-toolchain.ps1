# Pack slimmed portable toolchain into a single 7z (GitHub 2 GB asset limit).
#
# Usage:
#   .\scripts\pack-foundry-toolchain.ps1
#   .\scripts\pack-foundry-toolchain.ps1 -AppRoot "C:\path\to\install" -Output "C:\out\toolchain.7z"
#   .\scripts\pack-foundry-toolchain.ps1 -CompressionLevel 7

param(
    [string]$AppRoot = "",
    [string]$Output = "",
    [ValidateSet("full", "edge")]
    [string]$PackProfile = "full",
    [ValidateRange(1, 9)]
    [int]$CompressionLevel = 7
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Always use the bundled 7z from src-tauri/bin (independent of user's system).
$SevenZip = Join-Path $RepoRoot "src-tauri\bin\7z.exe"
if (-not (Test-Path $SevenZip)) {
    throw "Bundled 7z.exe not found at $SevenZip. Make sure it (and 7z.dll) are in src-tauri\bin."
}

if (-not $AppRoot) {
    $AppRoot = Join-Path $RepoRoot "src-tauri\target\debug"
}
$ToolchainRoot = Join-Path $AppRoot "toolchain"
if (-not $Output) {
    $Output = Join-Path $RepoRoot "work\toolchain.7z"
}

if (-not (Test-Path $ToolchainRoot)) {
    throw "Toolchain not found: $ToolchainRoot - run populate-foundry-toolchain.ps1 first"
}

# The contract manifest lives in the repo (`include_str!` into the app, so it IS the app's
# expectation). The copy under the tree can be stale — this DEV tree still carries a v2
# three-profile manifest. Stamp the repo version so the archive always ships the contract
# version, and so the check below tests the tree against the contract rather than against
# whatever the tree happens to claim about itself.
$repoManifest = Join-Path $RepoRoot "toolchain\manifest.json"
if (-not (Test-Path $repoManifest)) {
    throw "Missing contract manifest: $repoManifest"
}
Copy-Item -LiteralPath $repoManifest -Destination (Join-Path $ToolchainRoot "manifest.json") -Force
Write-Host "Stamped manifest from repo: $repoManifest" -ForegroundColor DarkGray

& (Join-Path $RepoRoot "scripts\toolchain-validate.ps1") -ToolchainRoot $ToolchainRoot

& (Join-Path $RepoRoot "scripts\toolchain-devcmd.ps1") -ToolchainRoot $ToolchainRoot
& (Join-Path $RepoRoot "scripts\slim-foundry-toolchain.ps1") -ToolchainRoot $ToolchainRoot -PackProfile $PackProfile

# Re-validate AFTER the trim: slim rewrites manifest.json to match the payload, so this
# proves the pair agrees before 4 GB of archive is produced.
& (Join-Path $RepoRoot "scripts\toolchain-validate.ps1") -ToolchainRoot $ToolchainRoot

$outDir = Split-Path $Output -Parent
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
if (Test-Path $Output) {
    $existingMb = [math]::Round((Get-Item $Output).Length / 1MB, 1)
    if ($existingMb -ge 100) {
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $backup = "$Output.bak-$stamp"
        Write-Host "Backing up existing archive ($existingMb MB) -> $backup" -ForegroundColor Yellow
        Move-Item $Output $backup -Force
    } else {
        Remove-Item $Output -Force
    }
}

$beforeGb = [math]::Round((Get-ChildItem $ToolchainRoot -Recurse -File | Measure-Object Length -Sum).Sum / 1GB, 2)
Write-Host "Packing $beforeGb GB from $ToolchainRoot -> $Output (mx=$CompressionLevel)" -ForegroundColor Cyan

# Archive paths must be under toolchain/ so 1-click extract lands in app_root/toolchain/
$toolchainParent = Split-Path $ToolchainRoot -Parent
Push-Location $toolchainParent
try {
    & $SevenZip a -t7z "-mx=$CompressionLevel" -mmt=on $Output "toolchain\*"
} finally {
    Pop-Location
}
if ($LASTEXITCODE -ne 0) { throw "7z failed with exit $LASTEXITCODE" }

$zipMb = [math]::Round((Get-Item $Output).Length / 1MB, 1)
$zipGb = [math]::Round((Get-Item $Output).Length / 1GB, 3)
Write-Host "Archive: $zipMb MB ($zipGb GB)" -ForegroundColor Green
if ($zipGb -ge 2.0) {
    Write-Warning "Over GitHub 2 GB single-file limit - trim more or split."
}