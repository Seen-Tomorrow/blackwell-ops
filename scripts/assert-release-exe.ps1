# Assert a blackwell-ops.exe is a real REL binary at the expected version.
# Blocks shipping DEV-config / stale-version PEs under a newer tag.
#
# Usage:
#   .\scripts\assert-release-exe.ps1 -ExePath path\to\blackwell-ops.exe -ExpectedVersion 1.0.30
#   .\scripts\assert-release-exe.ps1 -ExePath ... -ExpectedVersion 1.0.30 -ExpectedProductName "Blackwell Ops"

param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,

    [string]$ExpectedProductName = 'Blackwell Ops'
)

$ErrorActionPreference = 'Stop'

function Normalize-Semver([string]$Raw) {
    if ($null -eq $Raw) { $Raw = '' }
    $v = $Raw.Trim().TrimStart('v', 'V').Trim()
    if ([string]::IsNullOrWhiteSpace($v)) { return '' }
    # FileVersion often "1.0.28.0" or "1.0.28"
    $parts = @($v.Split('.') | Where-Object { $_ -match '^\d+$' })
    if ($parts.Count -ge 3) {
        return "$($parts[0]).$($parts[1]).$($parts[2])"
    }
    if ($parts.Count -eq 2) {
        return "$($parts[0]).$($parts[1]).0"
    }
    return $v
}

if (-not (Test-Path -LiteralPath $ExePath)) {
    throw "Release exe missing: $ExePath"
}

$item = Get-Item -LiteralPath $ExePath
$vi = $item.VersionInfo
$product = if ($null -eq $vi.ProductName) { '' } else { $vi.ProductName.Trim() }
$fileVer = Normalize-Semver $(if ($null -eq $vi.FileVersion) { '' } else { $vi.FileVersion })
$prodVer = Normalize-Semver $(if ($null -eq $vi.ProductVersion) { '' } else { $vi.ProductVersion })
$expect = Normalize-Semver $ExpectedVersion

$errors = [System.Collections.Generic.List[string]]::new()

if ([string]::IsNullOrWhiteSpace($product)) {
    $errors.Add("ProductName is empty (expected '$ExpectedProductName')")
} elseif ($product -match '(?i)\bDEV\b') {
    $errors.Add("ProductName is '$product' - DEV conf leaked into release build (expected '$ExpectedProductName')")
} elseif ($product -ne $ExpectedProductName) {
    $errors.Add("ProductName is '$product' (expected '$ExpectedProductName')")
}

if ($fileVer -ne $expect) {
    $errors.Add("FileVersion is '$($vi.FileVersion)' -> normalized '$fileVer' (expected '$expect')")
}
if ($prodVer -and $prodVer -ne $expect) {
    $errors.Add("ProductVersion is '$($vi.ProductVersion)' -> normalized '$prodVer' (expected '$expect')")
}

# Binary fingerprints of tauri.conf.dev.json (must never ship in App update / Full REL)
$bytes = [System.IO.File]::ReadAllBytes($ExePath)
$ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
if ($ascii -match 'com\.blackwell-ops\.app\.dev') {
    $errors.Add("PE contains identifier 'com.blackwell-ops.app.dev' (DEV conf)")
}
if ($ascii -match '127\.0\.0\.1:1420') {
    $errors.Add("PE contains dev server CSP/host '127.0.0.1:1420' (DEV conf)")
}
if ($ascii -match 'Blackwell Ops DEV') {
    $errors.Add("PE contains string 'Blackwell Ops DEV'")
}

if ($errors.Count -gt 0) {
    $msg = @"
RELEASE EXE IDENTITY CHECK FAILED
  Path:     $ExePath
  Size:     $($item.Length) bytes
  Modified: $($item.LastWriteTime)

$($errors | ForEach-Object { "  - $_" } | Out-String)
This usually means Pack ran while DEV polluted the environment, cargo left a stale PE,
or tauri build used tauri.conf.dev.json. Fix: close DEV, re-run pack (clean rebuild is forced),
or run: npm run release:exe  then re-pack.

Refusing to continue - do not ship this binary.
"@
    throw $msg.TrimEnd()
}

Write-Host ("[assert-release-exe] OK: {0} | ProductName={1} FileVersion={2}" -f $ExePath, $product, $fileVer) -ForegroundColor Green
