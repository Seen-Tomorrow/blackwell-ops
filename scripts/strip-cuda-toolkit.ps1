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
    "doc", "docs", "samples", "src", "compute-sanitizer", "libnvvp", "extras", "tools"
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

# Giant static libs — ggml CUDA links dynamically (cublas64_*.dll), not nvrtc/nvJitLink static.
$libX64 = Join-Path $Destination "lib\x64"
if (Test-Path $libX64) {
    foreach ($name in @(
        "nvrtc_static.lib", "nvJitLink_static.lib", "nvptxcompiler_static.lib"
    )) {
        $p = Join-Path $libX64 $name
        if (Test-Path $p) {
            Write-Host "  remove lib/x64/$name"
            Remove-Item $p -Force
        }
    }
    Get-ChildItem $libX64 -File -Filter "npp*.lib" -EA SilentlyContinue | ForEach-Object {
        Write-Host "  remove lib/x64/$($_.Name)"
        Remove-Item $_.FullName -Force
    }
    foreach ($pattern in @("cusolver*.lib", "cufft*.lib", "curand*.lib", "cusparse*.lib", "nvjpeg*.lib")) {
        Get-ChildItem $libX64 -File -Filter $pattern -EA SilentlyContinue | ForEach-Object {
            Write-Host "  remove lib/x64/$($_.Name)"
            Remove-Item $_.FullName -Force
        }
    }
}

# Runtime DLL bloat — ggml links cublas/Lt + cudart + nvJitLink/nvrtc dynamically only.
$binDirs = @(
    (Join-Path $Destination "bin"),
    (Join-Path $Destination "bin\x64")
)
foreach ($binDir in $binDirs) {
    if (-not (Test-Path $binDir)) { continue }
    foreach ($pattern in @(
        "cufft*.dll", "cufftw*.dll", "cusparse*.dll", "cusolver*.dll",
        "curand*.dll", "npp*.dll", "nvjpeg*.dll", "nvblas*.dll", "cuinj*.dll"
    )) {
        Get-ChildItem $binDir -File -Filter $pattern -EA SilentlyContinue | ForEach-Object {
            Write-Host "  remove $($_.FullName.Replace($Destination + '\',''))"
            Remove-Item $_.FullName -Force
        }
    }
    foreach ($pattern in @("nvprof.exe", "nvvp.exe", "nsys*.exe")) {
        Get-ChildItem $binDir -File -Filter $pattern -EA SilentlyContinue | ForEach-Object {
            Write-Host "  remove $($_.FullName.Replace($Destination + '\',''))"
            Remove-Item $_.FullName -Force
        }
    }
}

$sizeMb = [math]::Round((Get-ChildItem $Destination -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host "  => $sizeMb MB"