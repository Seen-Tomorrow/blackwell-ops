#requires -Version 7.0
<#
.SYNOPSIS
  Build a one-file, one-click OYM Help installer with NSIS.

.DESCRIPTION
  The installer is silent: it extracts to %LOCALAPPDATA%\OYM\Help and starts
  OYM-Help.exe. No wizard, no console, no 7-Zip SFX heuristic. The invite file
  is embedded in the payload and deleted by the app after pairing.

.EXAMPLE
  pwsh scripts/make-oym-helper-nsis.ps1 `
    -Server https://help.oym.cz `
    -Invite oym_inv_... `
    -Owner Alex `
    -OutFile tmp/OYM-Help-Alex.exe
#>
param(
    [Parameter(Mandatory)] [string] $Server,
    [string] $Code = "",
    [string] $Invite = "",
    [string] $Owner = "your technician",
    [string] $OutFile = "tmp/OYM-Help.exe",
    [string] $StageDir = "tmp/oym-helper-nsis-stage",
    # bzip2: ~8 s / 48 MB; lzma: ~80 s / 35 MB; zlib: ~10 s / 54 MB.
    [ValidateSet("bzip2", "lzma", "zlib")] [string] $NsisCompression = "bzip2"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (($Code -eq "") -eq ($Invite -eq "")) {
    throw "Provide exactly one of -Code (short pairing code) or -Invite (gateway invite token)."
}

$app = Join-Path $root "link/app/src-tauri/target/release/oym-link-app.exe"
$cli = Join-Path $root "remote-client/target/release/oym-link.exe"
$pi = Join-Path $root "tmp/blackwell-link-package/pi"
$makensis = @(
    "$env:LOCALAPPDATA\tauri\NSIS\Bin\makensis.exe",
    "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe",
    "C:\Program Files (x86)\NSIS\makensis.exe",
    "C:\Program Files\NSIS\makensis.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makensis) {
    throw "makensis.exe not found (install NSIS or Tauri's NSIS tools)."
}

foreach ($required in @($app, $cli, (Join-Path $pi "pi.exe"), $makensis)) {
    if (-not (Test-Path $required)) { throw "Missing build input: $required" }
}

$stage = if ([IO.Path]::IsPathRooted($StageDir)) { $StageDir } else { Join-Path $root $StageDir }
$out = if ([IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $root $OutFile }
foreach ($path in @($stage, $out)) {
    if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside the repo: $path"
    }
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null

Copy-Item $app (Join-Path $stage "OYM-Help.exe")
Copy-Item $cli (Join-Path $stage "oym-link.exe")
Copy-Item $pi (Join-Path $stage "pi") -Recurse

$inviteData = [ordered]@{
    version = 1
    server  = $Server
    owner   = $Owner
    helper  = $true
}
if ($Invite -ne "") {
    $inviteData.invite = $Invite.Trim()
} else {
    $inviteData.code = $Code.Trim().ToUpperInvariant()
}
$inviteData | ConvertTo-Json | Set-Content (Join-Path $stage "oym-invite.json") -Encoding utf8NoBOM

$nsi = Join-Path $root "tmp/oym-helper.nsi"
$outEscaped = $out.Replace('"', '""')
$stageEscaped = $stage.Replace('"', '""')
$compressor = if ($NsisCompression -eq "lzma") {
    "SetCompressor /SOLID lzma`nSetCompressorDictSize 64"
} else {
    "SetCompressor /SOLID $NsisCompression"
}
$script = @"
Unicode true
Name "OYM Help"
Caption "OYM Help"
SilentInstall silent
AutoCloseWindow true
RequestExecutionLevel user
InstallDir "`$LOCALAPPDATA\OYM\Help"
OutFile "$outEscaped"
$compressor

Section "Install"
  SetOutPath "`$INSTDIR"
  File "$stageEscaped\OYM-Help.exe"
  File "$stageEscaped\oym-link.exe"
  File "$stageEscaped\oym-invite.json"
  SetOutPath "`$INSTDIR\pi"
  File /r "$stageEscaped\pi\*.*"
  SetOutPath "`$INSTDIR"
  Exec '"`$INSTDIR\OYM-Help.exe"'
SectionEnd
"@
Set-Content $nsi -Value $script -Encoding utf8NoBOM

Push-Location $stage
try {
    & $makensis /V2 $nsi | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "NSIS build failed with exit $LASTEXITCODE" }
}
finally {
    Pop-Location
}

$hash = (Get-FileHash $out -Algorithm SHA256).Hash
$size = [Math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host ""
Write-Host "Built:  $out"
Write-Host "Size:   $size MB"
Write-Host "SHA256: $hash"
Write-Host ""
Write-Host "The invite is single-use and expires. Send the file now; rebuild if it expires."
