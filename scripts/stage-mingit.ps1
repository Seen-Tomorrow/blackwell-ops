# Download Git for Windows MinGit and stage under src-tauri/bin/git/ for bundling.
#
# Usage:
#   .\scripts\stage-mingit.ps1
#   .\scripts\stage-mingit.ps1 -Tag "v2.55.0.windows.2"

param(
    [string]$Tag = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DestRoot = Join-Path $RepoRoot "src-tauri\bin\git"
$WorkDir = Join-Path $RepoRoot "work\mingit-staging"

function Ensure-Dir([string]$Path) {
    if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

if (-not $Tag) {
    Write-Host "Resolving latest MinGit release from GitHub API..." -ForegroundColor Cyan
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" -UseBasicParsing
    $Tag = $release.tag_name
}

$asset = Invoke-RestMethod -Uri "https://api.github.com/repos/git-for-windows/git/releases/tags/$Tag" -UseBasicParsing |
    Select-Object -ExpandProperty assets |
    Where-Object { $_.name -eq "MinGit-*-64-bit.zip" -or $_.name -like "MinGit-*-64-bit.zip" } |
    Select-Object -First 1

if (-not $asset) {
    throw "No MinGit-64-bit.zip asset found on release tag $Tag"
}

$ZipName = $asset.name
$Url = $asset.browser_download_url
$ZipPath = Join-Path $WorkDir $ZipName

Ensure-Dir $WorkDir
if (-not (Test-Path $ZipPath)) {
    Write-Host "Downloading $Url ..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
}

if (Test-Path $DestRoot) {
    Write-Host "Removing existing $DestRoot"
    Remove-Item $DestRoot -Recurse -Force
}
Ensure-Dir $DestRoot

Write-Host "Extracting $ZipName -> $DestRoot" -ForegroundColor Cyan
Expand-Archive -Path $ZipPath -DestinationPath $DestRoot -Force

$GitExe = Join-Path $DestRoot "cmd\git.exe"
if (-not (Test-Path $GitExe)) {
    throw "Expected $GitExe after extract - MinGit layout may have changed."
}

$sizeMb = [math]::Round((Get-ChildItem $DestRoot -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "MinGit staged ($Tag): $sizeMb MB at $DestRoot" -ForegroundColor Green
& $GitExe --version