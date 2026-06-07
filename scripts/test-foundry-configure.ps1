# Smoke-test: cmake configure for one profile using portable toolchain.
# Verifies CUDA toolkit + NVCC are picked up (configure may still fail on bleeding-edge CUDA).
param(
    [string]$Profile = "stable",
    [string]$AppRoot = "",
    [string]$ProviderId = "ggml-master"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $AppRoot) { $AppRoot = Join-Path $RepoRoot "src-tauri\target\debug" }

$Toolchain = Join-Path $AppRoot "toolchain"
$Manifest = Get-Content (Join-Path $Toolchain "manifest.json") | ConvertFrom-Json
$prof = $Manifest.profiles | Where-Object { $_.id -eq $Profile } | Select-Object -First 1
if (-not $prof) { throw "Profile '$Profile' not in manifest" }

$vsKey = $prof.vs
$vsDef = $Manifest.vs.$vsKey
$Devcmd = Join-Path $Toolchain ($vsDef.devcmd -replace '/', '\')
$CudaRoot = Join-Path $Toolchain "cuda\v$($prof.cuda)"
$Nvcc = Join-Path $CudaRoot "bin\nvcc.exe"

foreach ($p in @($Devcmd, $Nvcc)) {
    if (-not (Test-Path $p)) { throw "Missing: $p" }
}

$SrcDir = Join-Path $AppRoot "foundry\engines\$ProviderId\llama.cpp"
if (-not (Test-Path $SrcDir)) {
    Write-Host "Cloning llama.cpp source for smoke test..."
    $engineRoot = Split-Path $SrcDir -Parent
    Ensure-Dir $engineRoot
    git clone --depth 1 https://github.com/ggml-org/llama.cpp.git $SrcDir
}

function Ensure-Dir($p) { if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null } }

$WorkRoot = Join-Path $AppRoot "foundry\engines\$ProviderId\work\test-configure-$Profile"
if (Test-Path $WorkRoot) { Remove-Item $WorkRoot -Recurse -Force }
Ensure-Dir $WorkRoot

$BuildDir = Join-Path $WorkRoot "build"
$CudaVar = "CUDA_PATH_V$($prof.cuda.Replace('.','_'))"
$VsInstance = Join-Path $Toolchain "vs\$vsKey"
$CmakeVsVersion = $Manifest.vs.$vsKey.cmake_version
$Gen = "-G `"$($prof.generator)`" -A $($prof.arch) -DCMAKE_GENERATOR_INSTANCE=`"$VsInstance,version=$CmakeVsVersion`""
$Toolset = "-T `"cuda=$($prof.cuda)`""
$ForcedCuda = "-DCMAKE_CUDA_COMPILER=`"$($Nvcc.Replace('\','/'))`" -DCUDAToolkit_ROOT=`"$($CudaRoot.Replace('\','/'))`" -DCMAKE_VS_PLATFORM_TOOLSET_CUDA=`"$($prof.cuda)`""
$Flags = "-DLLAMA_CURL=OFF -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=`"120a`" -DGGML_CUDA_PEER_TO_PEER=ON"

$bat = @"
@echo off
set "CUDA_PATH="
set "$CudaVar="
call "$Devcmd" -arch=amd64 -host_arch=amd64
set "CUDA_PATH=$CudaRoot"
set "$CudaVar=$CudaRoot"
set "PATH=$CudaRoot\bin;%PATH%"
cmake -B "$BuildDir" -S "$SrcDir" $Gen $Toolset $ForcedCuda $Flags
"@

$batPath = Join-Path $WorkRoot "_test_cfg.bat"
Set-Content $batPath $bat -Encoding ASCII
Write-Host "Running configure for profile '$Profile' (CUDA $($prof.cuda), VS $vsKey)..."
cmd /c $batPath
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Warning "Configure exited $code - expected for experimental profiles without patches."
} else {
    Write-Host "Configure succeeded." -ForegroundColor Green
}

# Grep CMakeCache for CUDA compiler path
$cache = Join-Path $BuildDir "CMakeCache.txt"
if (Test-Path $cache) {
    Select-String -Path $cache -Pattern 'CMAKE_CUDA_COMPILER:|CUDAToolkit_ROOT:' | ForEach-Object { Write-Host $_.Line }
}