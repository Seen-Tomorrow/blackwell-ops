# Selective dev rebuild — full recompile of app + frontend without touching:
#   target/debug/foundry, target/debug/runtime, target/debug/config, toolchain/, src-tauri/runtime/

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

$Exe = Join-Path $Root "src-tauri\target\debug\blackwell-ops.exe"
if (Test-Path $Exe) {
    $locked = $false
    try {
        $fs = [System.IO.File]::Open($Exe, 'Open', 'ReadWrite', 'None')
        $fs.Close()
    } catch {
        $locked = $true
    }
    if ($locked) {
        Write-Host "ERROR: blackwell-ops.exe is running. Quit the app, then rerun." -ForegroundColor Red
        exit 1
    }
}

$DebugTarget = Join-Path $Root "src-tauri\target\debug"
Write-Host "==> [0/3] Selective Rust artifact purge (preserving foundry/runtime/config)..." -ForegroundColor Cyan
$patterns = @(
    "blackwell-ops*",
    "deps\blackwell_ops*",
    "deps\libblackwell_ops*",
    ".fingerprint\blackwell-ops*",
    "incremental\blackwell_ops*",
    "build\blackwell-ops*"
)
foreach ($pat in $patterns) {
    Get-ChildItem -Path $DebugTarget -Filter $pat -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "==> [1/3] Frontend..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "==> [2/3] Rust (debug, full crate rebuild)..." -ForegroundColor Cyan
Push-Location (Join-Path $Root "src-tauri")
cargo build
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { exit $code }

Write-Host ""
Write-Host "Dev selective rebuild complete." -ForegroundColor Green
Write-Host "  Preserved : foundry/, runtime/, config/, toolchain/" -ForegroundColor DarkGray
Write-Host "  Frontend  : dist/" -ForegroundColor DarkGray
Write-Host "  Binary    : src-tauri\target\debug\blackwell-ops.exe" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Launch: npm run dev" -ForegroundColor Yellow