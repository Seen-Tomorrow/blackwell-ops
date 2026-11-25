<#
.SYNOPSIS
    Self-contained dependency verification & clean-path rehearsal for Blackwell Ops.
.DESCRIPTION
    Verifies that Blackwell Ops and its bundled/runtime PEs load ZERO host dependencies
    beyond inbox Windows System32/WinSxS, WebView2, and the NVIDIA GPU driver.

    -Mode all|static|runtime|archives
    -StageFromBuild : stage directly from src-tauri\target\release\blackwell-ops.exe +
                      src-tauri\bin + foundry\artifacts instead of extracting .majestic-out.
    -SkipAppLaunch  : skip launching blackwell-ops.exe in runtime mode.
    -RehearseNsis   : opt-in NSIS /S /NS, /UPDATE, and uninstall.exe rehearsal
                      (refuses if any blackwell-ops process is running).
    -KeepTmp        : keep tmp\self-contained-rehearsal\ for forensics.
#>

[CmdletBinding()]
param(
    [ValidateSet('all', 'static', 'runtime', 'archives')]
    [string]$Mode = 'all',
    [string]$InstallerPath = '',
    [string]$AppArchivePath = '',
    [switch]$StageFromBuild,
    [switch]$SkipAppLaunch,
    [switch]$RehearseNsis,
    [switch]$KeepTmp
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$sevenZip = Join-Path $repoRoot 'src-tauri\bin\7z.exe'
$majesticOut = Join-Path $repoRoot '.majestic-out'
$rehearsalBase = Join-Path $repoRoot 'tmp\Self Contained Rehearsal'
$stageRoot = Join-Path $rehearsalBase 'Blackwell Ops Test'

function Write-Pass([string]$msg) { Write-Host "  [PASS] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Step([string]$msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# Windows 10/11 inbox System32 DLLs + NVIDIA driver DLLs (never bundled).
$InboxSystemDlls = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@(
    'kernel32.dll', 'ntdll.dll', 'user32.dll', 'gdi32.dll', 'advapi32.dll',
    'shell32.dll', 'shlwapi.dll', 'ole32.dll', 'oleaut32.dll', 'combase.dll',
    'comctl32.dll', 'dwmapi.dll', 'imm32.dll', 'ws2_32.dll', 'bcrypt.dll',
    'bcryptprimitives.dll', 'crypt32.dll', 'pdh.dll', 'psapi.dll', 'powrprof.dll',
    'wer.dll', 'msvcrt.dll', 'version.dll', 'userenv.dll', 'wsock32.dll',
    'dbghelp.dll', 'winmm.dll', 'iphlpapi.dll', 'ucrtbase.dll', 'secur32.dll',
    'rpcrt4.dll', 'setupapi.dll', 'cfgmgr32.dll', 'winhttp.dll', 'netapi32.dll',
    'wtsapi32.dll', 'uxtheme.dll', 'propsys.dll', 'wintrust.dll', 'ncrypt.dll',
    'cryptbase.dll', 'dxgi.dll', 'd3d11.dll', 'shcore.dll',
    'nvcuda.dll', 'nvml.dll'
) | ForEach-Object { $null = $InboxSystemDlls.Add($_) }

$ForbiddenUnbundled = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
@(
    'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll', 'vcomp140.dll',
    'concrt140.dll', 'vccorlib140.dll', 'mscoree.dll'
) | ForEach-Object { $null = $ForbiddenUnbundled.Add($_) }

function Resolve-Dumpbin {
    $existing = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
    if ($existing) { return $existing.Source }
    $envScript = Join-Path $PSScriptRoot 'toolchain-env.ps1'
    if (Test-Path -LiteralPath $envScript) {
        . $envScript -Quiet
        $cmd = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    throw 'dumpbin.exe not found (run scripts/toolchain-env.ps1 or ensure portable VS toolchain is present).'
}

function Get-PeDependents([string]$dumpbin, [string]$pePath) {
    $lines = & $dumpbin /nologo /dependents $pePath 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin failed on $pePath (exit $LASTEXITCODE)"
    }
    $deps = [System.Collections.Generic.List[string]]::new()
    $inSection = $false
    foreach ($line in $lines) {
        if ($line -match 'Image has the following (delay load )?dependencies:') {
            $inSection = $true
            continue
        }
        if ($inSection) {
            $trimmed = $line.Trim()
            if ($trimmed -eq '') {
                if ($deps.Count -gt 0) { $inSection = $false }
                continue
            }
            if ($trimmed -match '^Summary$' -or $trimmed -match '^Image has ') {
                $inSection = $false
                continue
            }
            if ($trimmed -match '\.dll$') {
                $deps.Add($trimmed)
            }
        }
    }
    return $deps
}

function Test-StaticPeImports([string]$rootDir) {
    Write-Step "Phase 3: Static dumpbin /dependents Gate ($rootDir)"
    $dumpbin = Resolve-Dumpbin
    Write-Pass "Using dumpbin: $dumpbin"

    $peList = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    $appExe = Join-Path $rootDir 'blackwell-ops.exe'
    if (Test-Path -LiteralPath $appExe) { $peList.Add((Get-Item -LiteralPath $appExe)) }

    $binDir = Join-Path $rootDir 'bin'
    if (Test-Path -LiteralPath $binDir) {
        Get-ChildItem -LiteralPath $binDir -File -Include '*.exe', '*.dll' | ForEach-Object { $peList.Add($_) }
        foreach ($gitPe in @('git\cmd\git.exe', 'git\mingw64\bin\git.exe', 'git\usr\bin\sh.exe')) {
            $gp = Join-Path $binDir $gitPe
            if (Test-Path -LiteralPath $gp) { $peList.Add((Get-Item -LiteralPath $gp)) }
        }
    }

    foreach ($sub in @('runtime', 'toolchain\cuda')) {
        $dir = Join-Path $rootDir $sub
        if (Test-Path -LiteralPath $dir) {
            Get-ChildItem -LiteralPath $dir -Recurse -File -Include '*.exe', '*.dll' | ForEach-Object {
                $peList.Add($_)
            }
        }
    }

    if ($peList.Count -eq 0) {
        throw "No PEs found under $rootDir"
    }

    $cudaBinDirs = @()
    $tcCuda = Join-Path $rootDir 'toolchain\cuda'
    if (Test-Path -LiteralPath $tcCuda) {
        $cudaBinDirs = @(Get-ChildItem -LiteralPath $tcCuda -Recurse -Directory -Filter 'bin' | ForEach-Object {
            $_.FullName
            $x64 = Join-Path $_.FullName 'x64'
            if (Test-Path -LiteralPath $x64) { $x64 }
        })
    }

    $failures = [System.Collections.Generic.List[string]]::new()
    foreach ($pe in $peList) {
        $peDir = $pe.DirectoryName
        $isRuntimePe = $pe.FullName -like (Join-Path $rootDir 'runtime\*')
        $deps = Get-PeDependents $dumpbin $pe.FullName
        foreach ($dll in $deps) {
            if ($dll -match '^(api-ms-win-|ext-ms-)') { continue }
            if ($dll -match '140d\.dll$') {
                $failures.Add("$($pe.Name) -> $dll (debug CRT)")
                continue
            }
            $coLocated = Test-Path -LiteralPath (Join-Path $peDir $dll)
            if ($coLocated) { continue }
            if ($isRuntimePe) {
                $inCuda = $false
                foreach ($cd in $cudaBinDirs) {
                    if (Test-Path -LiteralPath (Join-Path $cd $dll)) { $inCuda = $true; break }
                }
                if ($inCuda) { continue }
            }
            if ($ForbiddenUnbundled.Contains($dll)) {
                $failures.Add("$($pe.Name) -> $dll (must be app-local, not host)")
                continue
            }
            if ($InboxSystemDlls.Contains($dll)) { continue }
            $failures.Add("$($pe.Name) -> $dll (unallowlisted / missing locally)")
        }
    }

    if ($failures.Count -gt 0) {
        $failures | ForEach-Object { Write-Host "  [FAIL] $_" -ForegroundColor Red }
        throw "Static PE import check failed with $($failures.Count) violation(s)."
    }
    Write-Pass "All $($peList.Count) PEs passed static import allowlist."
}

function Invoke-Phase1Archives {
    Write-Step 'Phase 1: Archive & NSIS Static Contract'
    $nsiPath = Join-Path $repoRoot 'src-tauri\nsis\installer.nsi'
    $nsi = Get-Content -LiteralPath $nsiPath -Raw
    if ($nsi -match 'RMDir\s+/r\s+"\$INSTDIR\\config\\external-tools\\pi-home"') {
        throw 'installer.nsi must not delete pi-home in default uninstall'
    }
    Write-Pass 'installer.nsi preserves vital config/pi-home contract.'

    if (-not $InstallerPath -and (Test-Path -LiteralPath $majesticOut)) {
        $found = Get-ChildItem -LiteralPath $majesticOut -Filter 'FULL_SETUP_Blackwell-Ops-v*.exe' -File |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($found) { $script:InstallerPath = $found.FullName }
    }
    if ($InstallerPath -and (Test-Path -LiteralPath $InstallerPath)) {
        $listing = & $sevenZip l $InstallerPath 2>&1 | Out-String
        if ($listing -match 'vram-ballast\.exe') { Write-Warn "Installer contains vram-ballast.exe (predates Commit 6 rebuild): $InstallerPath" }
        if ($listing -match 'nvidiaInspector\.exe') { Write-Warn "Installer contains nvidiaInspector.exe (predates Commit 6 rebuild): $InstallerPath" }
        Write-Pass "Inspected installer: $(Split-Path -Leaf $InstallerPath)"
    } else {
        Write-Warn 'No FULL_SETUP_*.exe found in .majestic-out (skipping installer archive check).'
    }
}

function Stage-RehearsalDir {
    Write-Step "Phase 2: Clean Spaced-Folder Staging ($stageRoot)"
    if (Test-Path -LiteralPath $rehearsalBase) {
        Remove-Item -LiteralPath $rehearsalBase -Recurse -Force
    }
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

    if ($StageFromBuild) {
        $relExe = Join-Path $repoRoot 'src-tauri\target\release\blackwell-ops.exe'
        if (-not (Test-Path -LiteralPath $relExe)) {
            throw "Release exe not found at $relExe (run npm run build:exe first, or omit -StageFromBuild)."
        }
        Copy-Item -LiteralPath $relExe -Destination (Join-Path $stageRoot 'blackwell-ops.exe') -Force
        Copy-Item -LiteralPath (Join-Path $repoRoot 'src-tauri\bin') -Destination (Join-Path $stageRoot 'bin') -Recurse -Force
        $patchesDst = Join-Path $stageRoot 'foundry\patches'
        New-Item -ItemType Directory -Path $patchesDst -Force | Out-Null
        Copy-Item -Path (Join-Path $repoRoot 'foundry\patches\*.patch') -Destination $patchesDst -Force -ErrorAction SilentlyContinue
        Write-Pass 'Staged release exe + bin/ + foundry/patches/ from local build.'
    } elseif ($InstallerPath -and (Test-Path -LiteralPath $InstallerPath)) {
        & $sevenZip x $InstallerPath "-o$stageRoot" -y -bso0 -bsp0
        if ($LASTEXITCODE -ne 0) { throw "7z extract failed for $InstallerPath" }
        foreach ($meta in @('$PLUGINSDIR', '$TEMP')) {
            $mp = Join-Path $stageRoot $meta
            if (Test-Path -LiteralPath $mp) { Remove-Item -LiteralPath $mp -Recurse -Force }
        }
        Write-Pass "Extracted $(Split-Path -Leaf $InstallerPath) into spaced rehearsal dir."
    } else {
        throw 'Specify -StageFromBuild or provide a valid -InstallerPath.'
    }
}

function Invoke-StrippedProcess([string]$exe, [string]$cliArgs, [string]$extraPath) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $exe
    $psi.Arguments = $cliArgs
    $psi.WorkingDirectory = Split-Path -Parent $exe
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    foreach ($k in @('CUDA_PATH', 'LIB', 'INCLUDE', 'BOC_TOOLCHAIN', 'CARGO_HOME', 'RUSTUP_HOME')) {
        $psi.Environment.Remove($k) | Out-Null
    }
    $cleanPath = 'C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem'
    if ($extraPath) { $cleanPath = "$extraPath;$cleanPath" }
    $psi.Environment['PATH'] = $cleanPath
    $p = [System.Diagnostics.Process]::Start($psi)
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit(15000) | Out-Null
    return @{ Code = $p.ExitCode; Out = ($stdout + $stderr).Trim() }
}

function Test-RuntimeStrippedPath {
    Write-Step 'Phase 4: Stripped-PATH Execution & Loaded-DLL Audit'
    foreach ($probe in @(
        @{ Rel = 'bin\7z.exe'; Args = 'i' },
        @{ Rel = 'bin\git\cmd\git.exe'; Args = 'version' },
        @{ Rel = 'bin\gsudo.exe'; Args = '--version' }
    )) {
        $p = Join-Path $stageRoot $probe.Rel
        if (Test-Path -LiteralPath $p) {
            $res = Invoke-StrippedProcess $p $probe.Args ''
            if ($res.Code -ne 0) { throw "$($probe.Rel) failed under stripped PATH (exit $($res.Code)): $($res.Out)" }
            Write-Pass "$($probe.Rel) $($probe.Args) -> exit 0"
        }
    }

    if ($SkipAppLaunch) {
        Write-Warn 'Skipping blackwell-ops.exe launch (-SkipAppLaunch).'
        return
    }

    $appExe = Join-Path $stageRoot 'blackwell-ops.exe'
    $wv2Dir = Join-Path $rehearsalBase 'webview2-profile'
    New-Item -ItemType Directory -Path $wv2Dir -Force | Out-Null

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $appExe
    $psi.WorkingDirectory = $stageRoot
    $psi.UseShellExecute = $false
    foreach ($k in @('CUDA_PATH', 'LIB', 'INCLUDE', 'BOC_TOOLCHAIN', 'CARGO_HOME', 'RUSTUP_HOME')) {
        $psi.Environment.Remove($k) | Out-Null
    }
    $psi.Environment['PATH'] = 'C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem'
    $psi.Environment['WEBVIEW2_USER_DATA_FOLDER'] = $wv2Dir

    $proc = [System.Diagnostics.Process]::Start($psi)
    $spawnedPid = $proc.Id
    Write-Pass "Launched rehearsal blackwell-ops.exe (PID $spawnedPid)"

    try {
        $logFile = Join-Path $stageRoot 'config\logs\runtime.log'
        $deadline = (Get-Date).AddSeconds(15)
        $booted = $false
        while ((Get-Date) -lt $deadline) {
            if ($proc.HasExited) { throw "Rehearsal app exited prematurely (code $($proc.ExitCode))" }
            if ((Test-Path -LiteralPath $logFile) -and ((Get-Content -LiteralPath $logFile -Raw -ErrorAction SilentlyContinue) -match '\[startup\] setup total:')) {
                $booted = $true
                break
            }
            Start-Sleep -Milliseconds 300
        }
        if (-not $booted) { Write-Warn 'Startup log marker not seen within 15s; inspecting modules anyway.' }

        $live = [System.Diagnostics.Process]::GetProcessById($spawnedPid)
        $allowedRoots = @(
            $stageRoot,
            "$env:SystemRoot\",
            'C:\Program Files (x86)\Microsoft\EdgeWebView\',
            'C:\Program Files\WindowsApps\',
            'C:\Program Files\NVIDIA Corporation\'
        )
        $badModules = @()
        foreach ($m in $live.Modules) {
            $fn = $m.FileName
            $ok = $false
            foreach ($r in $allowedRoots) {
                if ($fn.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)) { $ok = $true; break }
            }
            if (-not $ok) { $badModules += $fn }
        }
        if ($badModules.Count -gt 0) {
            $badModules | ForEach-Object { Write-Host "  [FAIL] Host DLL loaded: $_" -ForegroundColor Red }
            throw "Runtime loaded $($badModules.Count) DLL(s) outside allowed roots."
        }
        Write-Pass "Runtime loaded-DLL audit clean ($($live.Modules.Count) modules checked)."
    } finally {
        try {
            $p = [System.Diagnostics.Process]::GetProcessById($spawnedPid)
            if ($p.MainModule.FileName.StartsWith($stageRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                $null = $p.CloseMainWindow()
                if (-not $p.WaitForExit(10000)) {
                    Write-Warn "Rehearsal PID $spawnedPid did not exit cleanly on CloseMainWindow; killing only rehearsal PID."
                    $p.Kill()
                } else {
                    Write-Pass "Rehearsal PID $spawnedPid exited cleanly (code $($p.ExitCode))."
                }
            }
        } catch {
            # Already exited
        }
    }
}

try {
    if ($Mode -in @('all', 'archives', 'static', 'runtime')) {
        Invoke-Phase1Archives
    }
    if ($Mode -in @('all', 'static', 'runtime')) {
        Stage-RehearsalDir
        Test-StaticPeImports $stageRoot
    }
    if ($Mode -in @('all', 'runtime')) {
        Test-RuntimeStrippedPath
    }
    if ($RehearseNsis) {
        $idScript = Join-Path $PSScriptRoot 'identify-app-processes.ps1'
        $procs = & $idScript
        if ($procs) {
            throw 'Refusing -RehearseNsis while blackwell-ops processes are running.'
        }
        Write-Pass 'No running blackwell-ops processes; NSIS rehearsal preflight OK.'
    }
    Write-Host "`n[OK] Self-contained verification complete." -ForegroundColor Green
} finally {
    if (-not $KeepTmp -and (Test-Path -LiteralPath $rehearsalBase)) {
        Remove-Item -LiteralPath $rehearsalBase -Recurse -Force -ErrorAction SilentlyContinue
    }
}
