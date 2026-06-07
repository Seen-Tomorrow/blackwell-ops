# Full dev rebuild: frontend (dist/) + Rust debug binary.
# Quit the running app first - cargo cannot overwrite a locked exe.

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

Write-Host "==> [1/2] Frontend..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "==> [2/2] Rust (debug)..." -ForegroundColor Cyan
Push-Location (Join-Path $Root "src-tauri")
cargo build
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { exit $code }

Write-Host ""
Write-Host "Dev rebuild complete." -ForegroundColor Green
Write-Host "  Frontend : dist/" -ForegroundColor DarkGray
Write-Host "  Binary   : src-tauri\target\debug\blackwell-ops.exe" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Launch: npm run dev  (live Vite + Rust, recommended)" -ForegroundColor Yellow
Write-Host "    or: src-tauri\target\debug\blackwell-ops.exe" -ForegroundColor Yellow