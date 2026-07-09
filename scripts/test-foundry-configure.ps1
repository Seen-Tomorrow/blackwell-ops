# Smoke-test: cmake configure (+ optional build) for one profile using portable toolchain.
# Verifies slimmed toolchain still satisfies Foundry cmake (NVCC, ml64, CUDAToolkit_ROOT).
param(
    [string]$Profile = "stable",
    [string]$AppRoot = "",
    [string]$ToolchainRoot = "",
    [string]$ProviderId = "ggml-master",
    [string]$CudaArch = "120a",
    [switch]$Build
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $AppRoot) { $AppRoot = Join-Path $RepoRoot "src-tauri\target\debug" }

function Ensure-Dir([string]$Path) {
    if (-not (Test-Path $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

$Toolchain = if ($ToolchainRoot) { $ToolchainRoot } else { Join-Path $AppRoot "toolchain" }
$Manifest = Get-Content (Join-Path $Toolchain "manifest.json") | ConvertFrom-Json
$prof = $Manifest.profiles | Where-Object { $_.id -eq $Profile } | Select-Object -First 1
if (-not $prof) { throw "Profile '$Profile' not in manifest" }

$vsKey = $prof.vs
$vsDef = $Manifest.vs.$vsKey
$Devcmd = Join-Path $Toolchain ($vsDef.devcmd -replace '/', '\')
$CudaRoot = Join-Path $Toolchain "cuda\v$($prof.cuda)"
$Nvcc = Join-Path $CudaRoot "bin\nvcc.exe"
$Ml64 = Join-Path $Toolchain "vs\$vsKey\VC\Tools\MSVC\$($vsDef.msvc_version)\bin\Hostx64\x64\ml64.exe"

foreach ($p in @($Devcmd, $Nvcc, $Ml64)) {
    if (-not (Test-Path $p)) { throw "Missing: $p" }
}

$SrcDir = Join-Path $AppRoot "foundry\engines\$ProviderId\llama.cpp"
if (-not (Test-Path $SrcDir)) {
    Write-Host "Cloning llama.cpp source for smoke test..."
    $engineRoot = Split-Path $SrcDir -Parent
    Ensure-Dir $engineRoot
    git clone --depth 1 https://github.com/ggml-org/llama.cpp.git $SrcDir
}

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
$AsmFlag = "-DCMAKE_ASM_COMPILER=`"$($Ml64.Replace('\','/'))`""
$Flags = "-DLLAMA_CURL=OFF -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=`"$CudaArch`" -DGGML_CUDA_PEER_TO_PEER=ON"
$Ml64Bin = Split-Path $Ml64 -Parent
$Cmake = Join-Path $Toolchain "cmake\bin\cmake.exe"
if (-not (Test-Path $Cmake)) { throw "Missing portable cmake: $Cmake (re-run populate-foundry-toolchain.ps1)" }

$bat = @"
@echo off
set "CUDA_PATH="
set "$CudaVar="
call "$Devcmd" -arch=amd64 -host_arch=amd64
set "PATH=$Ml64Bin;%PATH%"
set "CUDA_PATH=$CudaRoot"
set "$CudaVar=$CudaRoot"
set "PATH=$CudaRoot\bin;%PATH%"
"$Cmake" -B "$BuildDir" -S "$SrcDir" $Gen $Toolset $ForcedCuda $AsmFlag $Flags
if errorlevel 1 exit /b 1
"@
if ($Build) {
    $bat += "`n`"$Cmake`" --build `"$BuildDir`" --config Release --target llama-server -j %NUMBER_OF_PROCESSORS%"
}

$batPath = Join-Path $WorkRoot "_test_cfg.bat"
Set-Content $batPath $bat -Encoding ASCII
$phase = if ($Build) { "configure + build" } else { "configure" }
Write-Host "Running $phase for profile '$Profile' (CUDA $($prof.cuda), VS $vsKey)..."
Write-Host "Toolchain: $Toolchain"
cmd /c $batPath
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Warning "$phase exited $code"
    exit $code
} else {
    Write-Host "$phase succeeded." -ForegroundColor Green
}

# Grep CMakeCache for CUDA compiler path
$cache = Join-Path $BuildDir "CMakeCache.txt"
if (Test-Path $cache) {
    Select-String -Path $cache -Pattern 'CMAKE_CUDA_COMPILER:|CUDAToolkit_ROOT:' | ForEach-Object { Write-Host $_.Line }
}