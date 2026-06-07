# Moderate CUDA toolkit trim — obvious non-build components only.
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Destination
)

$ErrorActionPreference = "Stop"

function Copy-Tree([string]$Src, [string]$Dst) {
    if (-not (Test-Path $Src)) { return }
    if (-not (Test-Path $Dst)) { New-Item -ItemType Directory -Path $Dst -Force | Out-Null }
    robocopy $Src $Dst /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
}

Write-Host "CUDA: $Source -> $Destination"

if (Test-Path $Destination) {
    Remove-Item $Destination -Recurse -Force
}
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

# Copy full tree first, then delete obvious bloat
Copy-Tree $Source $Destination

$removeDirs = @(
    "doc", "docs", "samples", "src", "compute-sanitizer", "libnvvp", "extras"
)
foreach ($dir in $removeDirs) {
    $p = Join-Path $Destination $dir
    if (Test-Path $p) {
        Write-Host "  remove dir $dir/"
        Remove-Item $p -Recurse -Force
    }
}

# Obvious non-compiler binaries in bin/
$removeBinFiles = @("tileiras.exe")
foreach ($f in $removeBinFiles) {
    $p = Join-Path $Destination "bin\$f"
    if (Test-Path $p) {
        Write-Host "  remove bin/$f"
        Remove-Item $p -Force
    }
}

$sizeMb = [math]::Round((Get-ChildItem $Destination -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "  => $sizeMb MB"