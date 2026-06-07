# Rebuild the Vite/React frontend into dist/
# Use when launching the debug exe directly (not tauri dev) so UI changes take effect.

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
Set-Location $Root

Write-Host "==> Building frontend (tsc + vite build)..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Frontend rebuilt -> dist/" -ForegroundColor Green
Write-Host "Restart Blackwell-Ops to load the new bundle." -ForegroundColor Yellow
Write-Host "Tip: npm run dev starts Vite live - no dist rebuild needed during dev." -ForegroundColor DarkGray