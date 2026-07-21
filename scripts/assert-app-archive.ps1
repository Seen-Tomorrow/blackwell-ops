# Extract blackwell-ops.exe from a CORE_Blackwell-Ops-App-*.7z and assert REL identity.
#
# Usage:
#   .\scripts\assert-app-archive.ps1 -ArchivePath .majestic-out\CORE_Blackwell-Ops-App-v1.0.30.7z -ExpectedVersion 1.0.30

param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedVersion,

    [string]$SevenZip = '',
    [string]$ExpectedProductName = 'Blackwell Ops'
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir

if (-not $SevenZip) {
    $SevenZip = Join-Path $root 'src-tauri\bin\7z.exe'
}
if (-not (Test-Path -LiteralPath $SevenZip)) {
    throw "Bundled 7z not found: $SevenZip"
}
if (-not (Test-Path -LiteralPath $ArchivePath)) {
    throw "App archive missing: $ArchivePath"
}

$work = Join-Path $env:TEMP ("bw-assert-app-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
    $seven_out = & $SevenZip x $ArchivePath "-o$work" -y 2>&1
    $seven_exit = $LASTEXITCODE
    if ($seven_exit -ne 0) {
        foreach ($line in @($seven_out)) { Write-Host $line }
        throw "7z extract failed (exit $seven_exit) for $ArchivePath"
    }

    $exe = Get-ChildItem -LiteralPath $work -Recurse -Filter 'blackwell-ops.exe' -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $exe) {
        throw "App archive has no blackwell-ops.exe: $ArchivePath"
    }

    $assert = Join-Path $script_dir 'assert-release-exe.ps1'
    & $assert -ExePath $exe.FullName -ExpectedVersion $ExpectedVersion -ExpectedProductName $ExpectedProductName
    Write-Host ("[assert-app-archive] OK: {0} embeds REL v{1}" -f (Split-Path -Leaf $ArchivePath), $ExpectedVersion) -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
