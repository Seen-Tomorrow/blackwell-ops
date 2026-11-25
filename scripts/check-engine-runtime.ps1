# Engine runtime diagnostic for an installed Blackwell Ops root.
#
# Answers the one question the app cannot: an engine that dies in the Windows loader exits with
# 0xC0000135 STATUS_DLL_NOT_FOUND and prints nothing, so "cannot boot any model" and "FIT binary
# crashed" look identical whatever the missing piece is. This checks the full static-import
# surface instead of guessing:
#   - the app-local engine binaries and the four MSVC runtime DLLs beside them
#   - the portable CUDA runtime for each profile (cublas / cublasLt / cudart)
#   - an actual `--version` / `--help` run of each engine with that PATH, reporting the exit code
#
# Usage (from any PowerShell, no repo needed):
#   powershell -ExecutionPolicy Bypass -File check-engine-runtime.ps1 -AppRoot "C:\AI-root\BlackwellOps"
#
# Exit 0 = every engine launched; 1 = at least one failure (details above the summary).
param(
    [Parameter(Mandatory = $true)][string]$AppRoot,
    # Optional: run a real FIT probe against this GGUF, exactly as the app does
    # (`--fit-print on` is the ggml-master adapter's flag). Without it only the loader is checked,
    # which cannot tell a working binary from a working probe.
    [string]$Model = '',
    [int]$FitCtx = 32768,
    # Fallback when toolchain/manifest.json is absent (a bare install before the build pack).
    [hashtable]$ProfileCuda = @{ edge = '13.4'; stable = '12.9' }
)

$ErrorActionPreference = 'Continue'
$script:failures = 0

$EngineBinaries = @(
    'llama-server.exe'
    'llama-server-impl.dll'
    'llama-fit-params.exe'
    'llama-fit-params-impl.dll'
    'llama-bench.exe'
    'llama-bench-impl.dll'
    'llama.dll'
    'llama-common.dll'
    'mtmd.dll'
    'ggml.dll'
    'ggml-base.dll'
    # No `ggml-cpu.dll`: every pack is built with GGML_CPU_ALL_VARIANTS, so the CPU
    # backend ships as one `ggml-cpu-<isa>.dll` per instruction set and the loader
    # picks. The variant presence check below catches a pack that lost them.
    'ggml-cuda.dll'
)
$CrtDlls = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'vcomp140.dll')

function Write-Fail($msg) { $script:failures++; Write-Host "  FAIL $msg" -ForegroundColor Red }
function Write-Ok($msg)   { Write-Host "  ok   $msg" -ForegroundColor Green }

if (-not (Test-Path -LiteralPath $AppRoot)) {
    Write-Host "AppRoot not found: $AppRoot" -ForegroundColor Red
    exit 1
}
$AppRoot = (Resolve-Path -LiteralPath $AppRoot).Path
Write-Host "app root: $AppRoot"

# Profile -> CUDA version comes from the installed manifest; the fallback covers a bare install.
$manifestPath = Join-Path $AppRoot 'toolchain\manifest.json'
if (Test-Path -LiteralPath $manifestPath) {
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        foreach ($p in $manifest.profiles) { $ProfileCuda[$p.id] = $p.cuda }
        Write-Ok "manifest: $manifestPath"
    } catch {
        Write-Fail "manifest unreadable ($manifestPath): $_"
    }
} else {
    Write-Host "  warn no toolchain manifest - using built-in CUDA map (edge 13.4, stable 12.9)" -ForegroundColor Yellow
}

function Get-CudaBinDirs([string]$cudaVersion) {
    $root = Join-Path $AppRoot "toolchain\cuda\v$cudaVersion"
    $dirs = @()
    foreach ($sub in @('bin\x64', 'bin')) {
        $d = Join-Path $root $sub
        if (Test-Path -LiteralPath $d) { $dirs += $d }
    }
    $dirs
}

# cublas/cublasLt/cudart must sit in the SAME dir: ggml-cuda.dll imports cublas64_<major>
# statically, so a partial set is indistinguishable from no runtime at all.
function Test-CudaRuntime([string]$cudaVersion) {
    foreach ($dir in (Get-CudaBinDirs $cudaVersion)) {
        $names = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | ForEach-Object { $_.Name.ToLower() })
        $hasCublas = @($names | Where-Object { $_ -like 'cublas64_*' }).Count -gt 0
        $hasLt = @($names | Where-Object { $_ -like 'cublaslt64_*' }).Count -gt 0
        $hasCudart = @($names | Where-Object { $_ -like 'cudart64_*' }).Count -gt 0
        if ($hasCublas -and $hasLt -and $hasCudart) { return $dir }
    }
    $null
}

function Invoke-EngineProbe([string]$exe, [string]$argList, [string]$pathPrefix) {
    if (-not (Test-Path -LiteralPath $exe)) { return }
    $dir = Split-Path -Parent $exe
    $env:PATH = "$pathPrefix;$dir;C:\Windows\system32;C:\Windows"
    $out = & $exe $argList 2>&1
    $code = $LASTEXITCODE
    $name = Split-Path -Leaf $exe
    switch ($code) {
        0 { Write-Ok ("{0} {1} -> 0 ({2})" -f $name, $argList, (($out | Select-Object -First 1) -join '')) }
        -1073741515 {
            Write-Fail ("{0} {1} -> 0xC0000135 STATUS_DLL_NOT_FOUND (loader death, no output)" -f $name, $argList)
        }
        -1073741511 {
            Write-Fail ("{0} {1} -> 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND (stale DLL wins the search order)" -f $name, $argList)
        }
        -1073741795 {
            Write-Fail ("{0} {1} -> 0xC000001D STATUS_ILLEGAL_INSTRUCTION (pack carries instructions this CPU lacks — a single-ISA build, check GGML_AVX512 / GGML_CPU_ALL_VARIANTS)" -f $name, $argList)
        }
        -1073741502 {
            Write-Fail ("{0} {1} -> 0xC0000142 STATUS_DLL_INIT_FAILED (driver/DLL init)" -f $name, $argList)
        }
        default {
            Write-Fail ("{0} {1} -> exit {2} (0x{2:X8})" -f $name, $argList, $code)
            ($out | Select-Object -First 5) | ForEach-Object { "       $_" }
        }
    }
}

$runtimeRoot = Join-Path $AppRoot 'runtime'
if (-not (Test-Path -LiteralPath $runtimeRoot)) {
    Write-Host "No runtime/ under app root - nothing installed to check." -ForegroundColor Yellow
    exit 1
}

foreach ($providerDir in (Get-ChildItem -LiteralPath $runtimeRoot -Directory | Where-Object { $_.Name -ne 'runtime-catalog' })) {
    foreach ($profileDir in (Get-ChildItem -LiteralPath $providerDir.FullName -Directory)) {
        $profile = $profileDir.Name
        $dir = $profileDir.FullName
        Write-Host ""
        Write-Host "== $($providerDir.Name)/$profile =="

        if (-not (Test-Path -LiteralPath (Join-Path $dir 'llama-server.exe'))) {
            Write-Host "  skip no llama-server.exe (config-only dir)" -ForegroundColor DarkGray
            continue
        }

        foreach ($f in $EngineBinaries) {
            if (-not (Test-Path -LiteralPath (Join-Path $dir $f))) { Write-Fail "engine file missing: $f" }
        }
        $cpuVariants = @(Get-ChildItem -LiteralPath $dir -Filter 'ggml-cpu-*.dll' -File -ErrorAction SilentlyContinue)
        if ($cpuVariants.Count -gt 0) {
            Write-Ok ("cpu variants: {0}" -f (($cpuVariants | ForEach-Object { $_.Name }) -join ' '))
        } elseif (Test-Path -LiteralPath (Join-Path $dir 'ggml-cpu.dll')) {
            # Legitimate for a build meant to run on this machine only (GGML_NATIVE=ON
            # auto-detects the host). It must never be shipped: the packer refuses it.
            Write-Host "  warn single-ISA ggml-cpu.dll (native build - correct here, must not be distributed)" -ForegroundColor Yellow
        } else {
            Write-Fail "no CPU backend beside the exe (expected ggml-cpu-*.dll, or ggml-cpu.dll for a native build)"
        }
        foreach ($f in $CrtDlls) {
            if (-not (Test-Path -LiteralPath (Join-Path $dir $f))) { Write-Fail "MSVC runtime missing beside the exe: $f" }
        }

        $cudaVersion = $ProfileCuda[$profile]
        $cudaDir = $null
        if (-not $cudaVersion) {
            Write-Fail "no CUDA version known for profile '$profile' (manifest profile missing)"
        } else {
            $cudaDir = Test-CudaRuntime $cudaVersion
            if (-not $cudaDir) {
                $expect = Join-Path $AppRoot "toolchain\cuda\v$cudaVersion\bin\x64"
                Write-Fail "portable CUDA $cudaVersion runtime incomplete - expected cublas64_* + cublasLt64_* + cudart64_* in $expect"
            } else {
                Write-Ok "portable CUDA $cudaVersion at $cudaDir"
            }
        }

        $pathPrefix = if ($cudaDir) { $cudaDir } else { '' }
        # Run even when the runtime is missing: the loader exit code is the proof.
        Invoke-EngineProbe (Join-Path $dir 'llama-server.exe') '--version' $pathPrefix
        Invoke-EngineProbe (Join-Path $dir 'llama-fit-params.exe') '--help' $pathPrefix

        if ($Model) {
            $fit = Join-Path $dir 'llama-fit-params.exe'
            if (-not (Test-Path -LiteralPath $fit)) { continue }
            if (-not (Test-Path -LiteralPath $Model)) {
                Write-Fail "model not found: $Model"
                continue
            }
            Write-Host "  ..   FIT probe: -m $Model --fit-print on --fit-ctx $FitCtx"
            $env:PATH = "$pathPrefix;$dir;C:\Windows\system32;C:\Windows"
            $fitOut = & $fit -m $Model --fit-print on --fit-ctx $FitCtx 2>&1
            $fitCode = $LASTEXITCODE
            if ($fitCode -eq 0) {
                Write-Ok ("FIT exit 0, {0} line(s) of output" -f @($fitOut).Count)
                $fitOut | Select-Object -First 12 | ForEach-Object { "       $_" }
                $fitOut | Select-Object -Last 6 | ForEach-Object { "       $_" }
            } else {
                Write-Fail ("FIT exit {0} (0x{0:X8}) - raw output below" -f $fitCode)
                $fitOut | Select-Object -First 20 | ForEach-Object { "       $_" }
            }
        }
    }
}

Write-Host ""
if ($script:failures -eq 0) {
    Write-Host "engine runtime check: PASS" -ForegroundColor Green
    exit 0
}
Write-Host "engine runtime check: $script:failures failure(s)" -ForegroundColor Red
Write-Host "A 0xC0000135 in the app console is this check: the engine never reached main()." -ForegroundColor Yellow
exit 1
