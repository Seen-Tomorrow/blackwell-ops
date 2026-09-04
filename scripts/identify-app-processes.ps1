<#
.SYNOPSIS
  Classify every running blackwell-ops process as REL or DEV by executable path.

.DESCRIPTION
  Safety tool for the "never kill the running app" rule. The REL build is frequently
  the one actively serving the LLM engine that backs the current agent session, so a
  blanket `Stop-Process -Name blackwell-ops` can kill the session doing the work.

  REL  = path contains "Blackwell OPS portable"  -> serves the engine/session; NEVER kill.
  DEV  = path contains "target\debug"            -> dev build.

  Exit code 0 = no REL instance running (safe to build/restart).
  Exit code 2 = a REL instance is running        -> ask the user to close it; do NOT kill.

  Read-only: this script never kills, stops or signals anything.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/identify-app-processes.ps1
#>

$ErrorActionPreference = 'SilentlyContinue'

$relMarker = 'Blackwell OPS portable'
$devMarker = 'target\debug'

$rows = @(
  Get-Process -Name 'blackwell-ops' | ForEach-Object {
    $path = $_.Path
    $kind = 'UNKNOWN'
    if ($path -like "*$relMarker*") { $kind = 'REL' }
    elseif ($path -like "*$devMarker*") { $kind = 'DEV' }
    [pscustomobject]@{
      PID     = $_.Id
      Kind    = $kind
      StartMB = [math]::Round($_.WorkingSet64 / 1MB, 0)
      Exe     = $path
    }
  }
)

if ($rows.Count -eq 0) {
  Write-Host 'blackwell-ops: no processes running. Safe to build.'
  exit 0
}

$rows | Format-Table -AutoSize -Wrap

$rel = @($rows | Where-Object { $_.Kind -eq 'REL' })
$dev = @($rows | Where-Object { $_.Kind -eq 'DEV' })

Write-Host ("total={0}  REL={1}  DEV={2}  UNKNOWN={3}" -f `
  $rows.Count, $rel.Count, $dev.Count, (@($rows | Where-Object { $_.Kind -eq 'UNKNOWN' }).Count))

if ($rel.Count -gt 0) {
  Write-Host ''
  Write-Host ('REL instance(s) running: ' + (($rel | ForEach-Object { $_.PID }) -join ', ')) -ForegroundColor Yellow
  Write-Host 'This is likely the build serving the live engine/session.' -ForegroundColor Yellow
  Write-Host 'A locked blackwell-ops.exe during cargo build is EXPECTED here.' -ForegroundColor Yellow
  Write-Host 'ASK the user to close the app, or build to a separate target. Do NOT auto-kill.' -ForegroundColor Yellow
  exit 2
}

Write-Host 'No REL instance. Any lock is a DEV build only.'
exit 0
