# Start a Cloudflare quick tunnel for the Blackwell remote gateway.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/remote-tunnel.ps1
#
# The printed https://*.trycloudflare.com URL is written to
# {ConfigDir}/public_url.txt so the running Blackwell Ops instance can show it
# and the pairing command can use it. The URL changes on every restart.
param(
  [string]$Cloudflared = "",
  [string]$ConfigDir = "",
  [string]$LocalUrl = "http://127.0.0.1:7443",
  [ValidateSet("http2", "quic")]
  [string]$Protocol = "http2",
  [int]$EdgeIpVersion = 4
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
if (-not $ConfigDir) {
  $ConfigDir = Join-Path $repo "src-tauri\target\debug\config\remote"
}
if (-not $Cloudflared) {
  $candidates = @(
    (Join-Path $repo "tmp\cloudflared.exe"),
    (Join-Path $repo "bin\cloudflared.exe")
  )
  $Cloudflared = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $Cloudflared) {
    $Cloudflared = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source
  }
}
if (-not $Cloudflared -or -not (Test-Path $Cloudflared)) {
  throw "cloudflared.exe not found. Pass -Cloudflared <path> or put it in tmp\cloudflared.exe."
}

New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$urlFile = Join-Path $ConfigDir "public_url.txt"

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $Cloudflared
$startInfo.Arguments = "tunnel --url `"$LocalUrl`" --no-autoupdate --protocol $Protocol --edge-ip-version $EdgeIpVersion"
$startInfo.UseShellExecute = $false
$startInfo.RedirectStandardError = $true
$startInfo.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::Start($startInfo)
Write-Host "cloudflared started (pid $($process.Id)); waiting for the public URL..."
try {
  while (-not $process.HasExited) {
    $line = $process.StandardError.ReadLine()
    if ($null -eq $line) { break }
    Write-Host $line
    if ($line -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
      $publicUrl = $Matches[1]
      Set-Content -Path $urlFile -Value $publicUrl -NoNewline
      Write-Host ""
      Write-Host "PUBLIC URL: $publicUrl" -ForegroundColor Cyan
      Write-Host "Written to: $urlFile"
      Write-Host "Gateway health: $publicUrl/healthz"
      Write-Host "Pairing command: oym-link --server wss://$($publicUrl -replace '^https://','')/link --pair <code>"
      Write-Host ""
    }
  }
} finally {
  if (-not $process.HasExited) {
    $process.Kill()
  }
  Remove-Item $urlFile -ErrorAction SilentlyContinue
  Write-Host "cloudflared stopped; public URL removed."
}
