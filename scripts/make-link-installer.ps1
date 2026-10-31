#requires -Version 7.0
<#
.SYNOPSIS
  Build a one-file NSIS installer for the normal OYM Link app.

.DESCRIPTION
  Consumes the REL package produced by build-link.ps1 -Profile rel:
    OYM Link.exe
    runtime/oym-link.exe
    runtime/pi/pi.exe

  The installer is silent, installs to %LOCALAPPDATA%\OYM\LinkApp, and starts
  OYM Link.exe. No console, no wizard.
#>
param(
    [string] $PackageDir = "tmp/link-rel-package",
    [string] $OutFile = "tmp/OYM-Link-Setup.exe",
    [ValidateSet("bzip2", "lzma", "zlib")] [string] $NsisCompression = "bzip2"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$package = if ([IO.Path]::IsPathRooted($PackageDir)) { $PackageDir } else { Join-Path $root $PackageDir }
$out = if ([IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $root $OutFile }

$app = Join-Path $package "OYM Link.exe"
$cli = Join-Path $package "runtime/oym-link.exe"
$pi = Join-Path $package "runtime/pi/pi.exe"
foreach ($required in @($app, $cli, $pi)) {
    if (-not (Test-Path $required)) {
        throw "Missing REL package input: $required (run BUILD LINK REL first)"
    }
}
if (-not $out.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write outside the repo: $out"
}

$makensis = @(
    "$env:LOCALAPPDATA\tauri\NSIS\Bin\makensis.exe",
    "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe",
    "C:\Program Files (x86)\NSIS\makensis.exe",
    "C:\Program Files\NSIS\makensis.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makensis) { throw "makensis.exe not found (install NSIS or Tauri's NSIS tools)." }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null
$nsi = Join-Path $root "tmp/oym-link-installer.nsi"
$outEscaped = $out.Replace('"', '""')
$pkgEscaped = $package.Replace('"', '""')
$compressor = if ($NsisCompression -eq "lzma") {
    "SetCompressor /SOLID lzma`nSetCompressorDictSize 64"
} else {
    "SetCompressor /SOLID $NsisCompression"
}
$script = @"
Unicode true
Name "OYM Link"
Caption "OYM Link"
SilentInstall silent
AutoCloseWindow true
RequestExecutionLevel user
InstallDir "`$LOCALAPPDATA\OYM\LinkApp"
OutFile "$outEscaped"
$compressor

Section "Install"
  SetOutPath "`$INSTDIR"
  File "$pkgEscaped\OYM Link.exe"
  File "$pkgEscaped\runtime\oym-link.exe"
  SetOutPath "`$INSTDIR\pi"
  File /r "$pkgEscaped\runtime\pi\*.*"
  SetOutPath "`$INSTDIR"
  Exec '"`$INSTDIR\OYM Link.exe"'
SectionEnd
"@
Set-Content $nsi -Value $script -Encoding utf8NoBOM

$t = Measure-Command { & $makensis /V2 $nsi | Out-Host }
if ($LASTEXITCODE -ne 0) { throw "NSIS build failed with exit $LASTEXITCODE" }

$hash = (Get-FileHash $out -Algorithm SHA256).Hash
Write-Host ""
Write-Host "Built:  $out"
Write-Host "Size:   $([Math]::Round((Get-Item $out).Length / 1MB, 1)) MB"
Write-Host "SHA256: $hash"
