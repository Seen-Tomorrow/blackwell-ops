<#
.SYNOPSIS
  Detect and repair NTFS DACL damage applied by agent-harness directory
  "access level" selectors (Read Only / Workspace Write / Full access).

.DESCRIPTION
  Such selectors can REPLACE a directory DACL instead of adding a restriction
  scoped to the harness identity. Two failure modes follow:

  1. A Deny ACE granting DELETE_CHILD to Everyone (WD), inherited by the whole
     tree. Everyone includes the user and every tool they run, so cargo cannot
     delete or rename inside target\ and builds fail.

  2. The standard inherited grants (BUILTIN\Users and
     NT AUTHORITY\Authenticated Users) are removed. Sandboxed child processes
     (Chromium / WebView2 GPU, renderer, utility) do not hold
     SeChangeNotifyPrivilege, so they cannot traverse into the tree. WebView2
     then fails at webview creation with ERROR_BUSY (0x800700AA) or
     E_UNEXPECTED (0x8000FFFF), typically surfacing as
     "Failed to setup app" from tauri app.rs.

  The harness identity usually shows up as a synthetic SID (S-1-4-...).

  Exit code is the number of FAIL findings, so this is usable in CI.

.PARAMETER Path
  Directories to inspect. Defaults to the current directory.

.PARAMETER Repair
  Remove Deny ACEs and restore the standard inherited grants on each target.

.PARAMETER RepairAncestors
  With -Repair, also restore traversal grants on parent directories.
  SECURITY: this widens access ABOVE the workspace. Review before using.

.PARAMETER Deep
  Also inspect subdirectories up to -Depth levels.

.EXAMPLE
  .\check-workspace-acl.ps1 -Path .\src-tauri -Deep
.EXAMPLE
  .\check-workspace-acl.ps1 -Path C:\dev\app -Repair
#>
[CmdletBinding()]
param(
  [string[]]$Path = @('.'),
  [switch]$Repair,
  [switch]$RepairAncestors,
  [switch]$Deep,
  [int]$Depth = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$UsersSid = 'S-1-5-32-545'   # BUILTIN\Users
$AuthSid  = 'S-1-5-11'       # NT AUTHORITY\Authenticated Users

function New-Finding {
  param([string]$Severity, [string]$Issue)
  [pscustomobject]@{ Severity = $Severity; Issue = $Issue }
}

function Get-AncestorChain {
  param([string]$Path)
  $chain = New-Object System.Collections.Generic.List[string]
  $item  = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  while ($null -ne $item) { $chain.Add($item.FullName); $item = $item.Parent }
  return ,$chain
}

function Repair-AncestorAcl {
  # Traverse-only grant on the directory object itself. Deliberately NO (OI)(CI):
  # inheriting BUILTIN\Users across a profile tree would expose every file in it.
  param([string]$Dir)
  $null = & icacls $Dir /grant "*${UsersSid}:(RX)"
  if ($LASTEXITCODE -ne 0) { throw "icacls failed on $Dir" }
}

function Test-DirAcl {
  param([string]$Dir)
  $found = New-Object System.Collections.Generic.List[object]
  $acl   = Get-Acl -LiteralPath $Dir

  foreach ($ace in $acl.Access) {
    $id = $ace.IdentityReference.Value
    if ($ace.AccessControlType -eq 'Deny') {
      $found.Add((New-Finding 'FAIL' ("Deny ACE: {0} -> {1} (inherited={2})" -f $id, $ace.FileSystemRights, $ace.IsInherited)))
    }
    elseif ($id -match '^S-1-4-') {
      $found.Add((New-Finding 'WARN' ("Non-standard principal: {0} -> {1}" -f $id, $ace.FileSystemRights)))
    }
  }

  $allow = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' } |
             ForEach-Object { $_.IdentityReference.Value })

  if ($allow -notcontains 'BUILTIN\Users') {
    $found.Add((New-Finding 'FAIL' 'No BUILTIN\Users grant - sandboxed child processes cannot read or traverse'))
  }
  if ($allow -notcontains 'NT AUTHORITY\Authenticated Users') {
    $found.Add((New-Finding 'WARN' 'No NT AUTHORITY\Authenticated Users grant'))
  }

  if (Test-Path -LiteralPath "$Dir`:Zone.Identifier" -ErrorAction SilentlyContinue) {
    $found.Add((New-Finding 'WARN' 'Zone.Identifier / Mark of the Web present'))
  }
  return $found
}

function Repair-DirAcl {
  param([string]$Dir)
  $acl = Get-Acl -LiteralPath $Dir
  foreach ($d in @($acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' -and -not $_.IsInherited })) {
    $null = $acl.RemoveAccessRule($d)
  }
  try   { Set-Acl -LiteralPath $Dir -AclObject $acl }
  catch { Write-Warning ("  could not rewrite DACL on {0}: {1}" -f $Dir, $_.Exception.Message) }

  $null = & icacls $Dir /grant "*${UsersSid}:(OI)(CI)(RX)" "*${AuthSid}:(OI)(CI)(M)"
  if ($LASTEXITCODE -ne 0) { throw "icacls failed on $Dir" }
}

$targets = New-Object System.Collections.Generic.List[string]
foreach ($p in $Path) {
  $full = (Resolve-Path -LiteralPath $p).Path
  $targets.Add($full)
  if ($Deep) {
    Get-ChildItem -LiteralPath $full -Directory -Force -Recurse -Depth ($Depth - 1) -ErrorAction SilentlyContinue |
      ForEach-Object { $targets.Add($_.FullName) }
  }
}

$failCount = 0
foreach ($t in $targets) {
  $found = @(Test-DirAcl -Dir $t)
  $bad   = @($found | Where-Object { $_.Severity -eq 'FAIL' })
  $failCount += $bad.Count

  if ($found.Count -eq 0) { Write-Host ("PASS  {0}" -f $t) -ForegroundColor Green; continue }

  $color = if ($bad.Count) { 'Red' } else { 'Yellow' }
  Write-Host ("{0}    {1}" -f $(if($bad.Count){'FAIL'}else{'WARN'}), $t) -ForegroundColor $color
  foreach ($f in $found) { Write-Host ("        [{0}] {1}" -f $f.Severity, $f.Issue) }

  if ($Repair) {
    Repair-DirAcl -Dir $t
    Write-Host "        repaired." -ForegroundColor Cyan
  }
}

# Traversal chain: sandboxed children need a grant on EVERY ancestor.
Write-Host ""
Write-Host "Ancestor traversal chain:" -ForegroundColor Cyan
foreach ($p in $Path) {
  $full = (Resolve-Path -LiteralPath $p).Path
  foreach ($anc in (Get-AncestorChain -Path $full)) {
    $allow = @(Get-Acl -LiteralPath $anc).Access |
             Where-Object { $_.AccessControlType -eq 'Allow' } |
             ForEach-Object { $_.IdentityReference.Value }
    $ok = ($allow -contains 'BUILTIN\Users') -or ($allow -contains 'Everyone') -or
          ($allow -contains 'NT AUTHORITY\Authenticated Users')
    if ($ok) { Write-Host ("  ok     {0}" -f $anc) }
    else {
      Write-Host ("  BLOCKED {0}  <- sandboxed processes cannot traverse here" -f $anc) -ForegroundColor Red
      if ($Repair -and $RepairAncestors) { Repair-AncestorAcl -Dir $anc; Write-Host "           traverse-only grant added (no inheritance)." -ForegroundColor Cyan }
    }
  }
}

Write-Host ""
Write-Host ("FAIL findings: {0}" -f $failCount) -ForegroundColor $(if($failCount){'Red'}else{'Green'})
exit $failCount

