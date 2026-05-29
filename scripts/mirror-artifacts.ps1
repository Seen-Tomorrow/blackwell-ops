# Mirror foundry artifacts from DEV to runtime for REL bundling
# Usage: .\scripts\mirror-artifacts.ps1
# Run this BEFORE tauri build so fresh binaries are bundled.
#
# Flow:
#   1. Clear stale binaries in each profile dir (runtime/<provider>/<env>/)
#   2. Copy fresh binaries from foundry artifacts (foundry/artifacts/<provider>/<env>/Release/)
#   3. Config files at runtime/<provider>/config/ are NOT touched

$ErrorActionPreference = "Stop"

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir

$artifacts_root = Join-Path $root "src-tauri\target\debug\foundry\artifacts"
$runtime_root   = Join-Path $root "src-tauri\runtime"

if (-not (Test-Path $artifacts_root)) {
    Write-Host "[mirror-artifacts] No artifacts found - nothing to mirror." -ForegroundColor Yellow
    exit 0
}

$providers = Get-ChildItem -LiteralPath $artifacts_root -Directory

$copied = 0
foreach ($provider in $providers) {
    $provider_id = $provider.Name
    foreach ($env_dir in Get-ChildItem -LiteralPath $provider.FullName -Directory) {
        $env_name = $env_dir.Name

        # Skip .prev backup directories
        if ($env_name.EndsWith(".prev")) {
            continue
        }

        $release_dir = Join-Path $env_dir.FullName "Release"

        if (-not (Test-Path $release_dir)) {
            Write-Host "[mirror-artifacts] No Release dir for $provider_id/$env_name - skipping." -ForegroundColor DarkGray
            continue
        }

        $dest = Join-Path $runtime_root "$provider_id\$env_name"

        # Create destination if needed
        if (-not (Test-Path $dest)) {
            New-Item -ItemType Directory -LiteralPath $dest -Force | Out-Null
        }

        # Clear stale binaries from profile dir before copying
        Get-ChildItem -LiteralPath $dest -File | Remove-Item -Force

        # Copy fresh binaries using Path (not LiteralPath) so wildcard works
        Get-ChildItem -LiteralPath $release_dir | Copy-Item -Destination $dest -Force
        $copied++

        Write-Host "[mirror-artifacts] $provider_id/$env_name/Release -> runtime/$provider_id/$env_name" -ForegroundColor Green
    }
}

if ($copied -eq 0) {
    Write-Host "[mirror-artifacts] No profiles found to mirror." -ForegroundColor Yellow
} else {
    Write-Host "[mirror-artifacts] Mirrored $copied profile(s). Ready for tauri build." -ForegroundColor Cyan
}