# Shared filter + profile policy for release/runtime distribution binaries.
# Source of truth: scripts/distribution-policy.json (edited by DEV app + this file on load).

$script:RuntimeDistributionPolicyPath = Join-Path $PSScriptRoot 'distribution-policy.json'

# SHA-256 without Get-FileHash: some pack steps run in hosts where the Utility module is not
# autoloaded. .NET statics always work; certutil is the fallback for a constrained host.
function Get-FileSha256Hex([string]$Path) {
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $stream = [System.IO.File]::OpenRead($Path)
            try { $bytes = $sha.ComputeHash($stream) } finally { $stream.Dispose() }
        } finally { $sha.Dispose() }
        return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    } catch {
        $line = (& certutil.exe -hashfile $Path SHA256 | Select-Object -Skip 1 -First 1)
        return ($line.Trim() -replace ' ', '').ToLowerInvariant()
    }
}

function Import-RuntimeDistributionPolicy {
    if (-not (Test-Path -LiteralPath $script:RuntimeDistributionPolicyPath)) {
        throw "Missing distribution policy: $($script:RuntimeDistributionPolicyPath)"
    }
    $raw = Get-Content -LiteralPath $script:RuntimeDistributionPolicyPath -Raw -Encoding UTF8
    $policy = $raw | ConvertFrom-Json

    $script:NsisCoreProviders = @{}
    if ($policy.nsisCore) {
        foreach ($prop in $policy.nsisCore.PSObject.Properties) {
            $script:NsisCoreProviders[$prop.Name] = @($prop.Value)
        }
    }

    $script:OptionalDownloadProviders = @{}
    if ($policy.plugins) {
        foreach ($prop in $policy.plugins.PSObject.Properties) {
            $script:OptionalDownloadProviders[$prop.Name] = @($prop.Value)
        }
    }

    # enginePacks = every profile that ships as a downloadable engine pack. nsisCore = the
    # subset seeded inside the installer (docs/ENGINE-PACKS.md: EDGE only). Mirroring and
    # packing follow enginePacks; only prepare-release-runtime follows nsisCore.
    $script:EnginePackProviders = @{}
    $pack_source = if ($policy.enginePacks) { $policy.enginePacks } else { $policy.nsisCore }
    foreach ($prop in $pack_source.PSObject.Properties) {
        $script:EnginePackProviders[$prop.Name] = @($prop.Value)
    }

    $script:RecommendedEngine = $null
    if ($policy.recommendedEngine) {
        $script:RecommendedEngine = [PSCustomObject]@{
            provider = [string]$policy.recommendedEngine.provider
            profile  = [string]$policy.recommendedEngine.profile
        }
    }

    $script:RuntimeBundleProfiles = @{}
    foreach ($kv in $script:EnginePackProviders.GetEnumerator()) {
        $script:RuntimeBundleProfiles[$kv.Key] = $kv.Value
    }
    foreach ($kv in $script:OptionalDownloadProviders.GetEnumerator()) {
        if (-not $script:RuntimeBundleProfiles.ContainsKey($kv.Key)) {
            $script:RuntimeBundleProfiles[$kv.Key] = $kv.Value
        }
    }
}

Import-RuntimeDistributionPolicy

# Retired CUDA profiles - never sync to debug runtime or NSIS bundle.
$script:RetiredRuntimeProfiles = @('vanguard', 'fresh')

# Copy one provider's factory config tree into a release bundle. Both prepare-release scripts
# used to duplicate this block (copy + default-config check); keep it in one place.
function Copy-ProviderFactoryConfig {
    param(
        [string]$ProviderId,
        [string]$RuntimeRoot,
        [string]$DestRoot
    )
    $src = Join-Path $RuntimeRoot "$ProviderId\config"
    if (-not (Test-Path -LiteralPath $src)) {
        return $null
    }
    $dst = Join-Path $DestRoot "$ProviderId\config"
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    # Path (not LiteralPath) so wildcards expand - LiteralPath treats '*' as a literal name.
    Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
    return [pscustomobject]@{
        Dest       = $dst
        HasDefault = Test-Path -LiteralPath (Join-Path $dst "$ProviderId-default-config.json")
    }
}

function Test-RuntimeNsisProvider {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderId
    )
    return $script:NsisCoreProviders.ContainsKey($ProviderId)
}

function Test-RuntimeOptionalProvider {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderId
    )
    return $script:OptionalDownloadProviders.ContainsKey($ProviderId)
}

function Test-RuntimeBundleProvider {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderId
    )
    return $script:RuntimeBundleProfiles.ContainsKey($ProviderId)
}

function Get-RuntimeBundleProfiles {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderId
    )
    if ($script:RuntimeBundleProfiles.ContainsKey($ProviderId)) {
        return $script:RuntimeBundleProfiles[$ProviderId]
    }
    return @()
}

function Get-RuntimeNsisProfiles {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderId
    )
    if ($script:NsisCoreProviders.ContainsKey($ProviderId)) {
        return $script:NsisCoreProviders[$ProviderId]
    }
    return @()
}

function Test-RuntimeProfileRetired {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProfileId
    )
    return $script:RetiredRuntimeProfiles -contains $ProfileId
}

function Test-RuntimeBundleProfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderId,
        [Parameter(Mandatory = $true)]
        [string]$ProfileId
    )
    if (Test-RuntimeProfileRetired -ProfileId $ProfileId) {
        return $false
    }
    $allowed = Get-RuntimeBundleProfiles -ProviderId $ProviderId
    if ($allowed.Count -eq 0) {
        return $false
    }
    return $allowed -contains $ProfileId
}

function Test-RuntimeNsisProfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderId,
        [Parameter(Mandatory = $true)]
        [string]$ProfileId
    )
    if (Test-RuntimeProfileRetired -ProfileId $ProfileId) {
        return $false
    }
    $allowed = Get-RuntimeNsisProfiles -ProviderId $ProviderId
    if ($allowed.Count -eq 0) {
        return $false
    }
    return $allowed -contains $ProfileId
}

$script:RuntimeDistributionExecutables = @(
    'llama-server.exe'
    'llama.exe'          # build-identity stub: prints only "b<build>-<sha>"
    'llama-fit-params.exe'
    'llama-bench.exe'
)

function Test-RuntimeDistributionFile {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.FileInfo]$File
    )
    if ($script:RuntimeDistributionExecutables -contains $File.Name) {
        return $true
    }
    if ($File.Name -eq 'build-info.txt') {
        # Written by Foundry at build time: b<build>-<commit>, read for engine identity.
        return $true
    }
    if ($File.Extension -ine '.dll') {
        return $false
    }
    if ($File.Name -notmatch '-impl\.dll$') {
        return $true
    }
    return $File.Name -in @(
        'llama-server-impl.dll'
        'llama-fit-params-impl.dll'
        'llama-bench-impl.dll'
    )
}

# ── MSVC C runtime (CRT) staging ───────────────────────────────────────
# Every shipped engine binary imports vcruntime140.dll, vcruntime140_1.dll and
# msvcp140.dll; ggml-base.dll additionally imports vcomp140.dll (OpenMP). All four are
# staged from ONE complete runtime set, never mixed across redist versions. The build
# toolchain carries the canonical set at {toolchain}/msvc-runtime/x64; the packer falls
# back to one VC Redist x64 tree (CRT + OpenMP), then System32.
# On a machine that never had VC++ 2015-2022 x64, LoadLibrary fails before the engine
# writes a single log line, so the failure looks like an app bug, not a missing runtime.
# App-local copies win the OS DLL search order, touch no system state, need no admin and
# no reboot, and keep the offline/flash-disk install working — unlike the 17-25 MB
# vc_redist.exe (which can also refuse with 1638 when another app already put a different
# CRT version on the machine).
$script:MsvcCrtDlls = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')
$script:MsvcOpenMpDll = 'vcomp140.dll'
$script:MsvcRuntimeDlls = @($script:MsvcCrtDlls + $script:MsvcOpenMpDll)

function Get-MsvcRuntimeSetFromDir {
    param([string]$Directory)
    $files = @{}
    if (-not $Directory) { return $files }
    foreach ($dll in $script:MsvcRuntimeDlls) {
        $path = Join-Path $Directory $dll
        if (Test-Path -LiteralPath $path -PathType Leaf) { $files[$dll] = $path }
    }
    return $files
}

function Test-MsvcRuntimeSet {
    param([hashtable]$Files)
    if (-not $Files) { return $false }
    foreach ($dll in $script:MsvcRuntimeDlls) {
        if (-not $Files.ContainsKey($dll)) { return $false }
        if (-not (Test-Path -LiteralPath $Files[$dll] -PathType Leaf)) { return $false }
    }
    return $true
}

function Get-MsvcRuntimeSetFromRedist {
    param([string]$X64Directory)
    $files = @{}
    if (-not (Test-Path -LiteralPath $X64Directory)) { return $files }
    $crt = Get-ChildItem -LiteralPath $X64Directory -Directory -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($crt) {
        foreach ($dll in $script:MsvcCrtDlls) {
            $path = Join-Path $crt.FullName $dll
            if (Test-Path -LiteralPath $path -PathType Leaf) { $files[$dll] = $path }
        }
    }
    $omp = Get-ChildItem -LiteralPath $X64Directory -Directory -Filter 'Microsoft.VC*.OpenMP' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($omp) {
        $path = Join-Path $omp.FullName $script:MsvcOpenMpDll
        if (Test-Path -LiteralPath $path -PathType Leaf) { $files[$script:MsvcOpenMpDll] = $path }
    }
    return $files
}

function Get-MsvcRedistX64Dirs {
    param([string]$ToolchainRoot = '')
    $dirs = @()
    if ($ToolchainRoot) {
        $vs_root = Join-Path $ToolchainRoot 'vs'
        if (Test-Path -LiteralPath $vs_root) {
            foreach ($year in Get-ChildItem -LiteralPath $vs_root -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending) {
                $redist = Join-Path $year.FullName 'VC\Redist\MSVC'
                if (-not (Test-Path -LiteralPath $redist)) { continue }
                foreach ($ver in Get-ChildItem -LiteralPath $redist -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending) {
                    $x64 = Join-Path $ver.FullName 'x64'
                    if (Test-Path -LiteralPath $x64) { $dirs += $x64 }
                }
            }
        }
    }
    foreach ($probe in @(
        'C:\BuildTools\VC\Redist\MSVC',
        'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Redist\MSVC',
        'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Redist\MSVC',
        'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Redist\MSVC'
    )) {
        if (-not (Test-Path -LiteralPath $probe)) { continue }
        foreach ($ver in Get-ChildItem -LiteralPath $probe -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending) {
            $x64 = Join-Path $ver.FullName 'x64'
            if (Test-Path -LiteralPath $x64) { $dirs += $x64 }
        }
    }
    return $dirs
}

function Get-MsvcRuntimeSetVersion {
    param([hashtable]$Files)
    if (-not $Files) { return [version]'0.0.0.0' }
    $candidate = $Files[$script:MsvcRuntimeDlls[0]]
    if (-not $candidate) { return [version]'0.0.0.0' }
    try {
        $raw = (Get-Item -LiteralPath $candidate).VersionInfo.FileVersion
        if ($raw) { return [version]$raw }
    } catch {}
    return [version]'0.0.0.0'
}

function Find-MsvcRuntimeSet {
    <#
    .SYNOPSIS
        Returns the newest complete four-DLL runtime set from ONE source, or $null.
        Candidates: toolchain/msvc-runtime/x64, one VC Redist tree (CRT + OpenMP),
        and the installed redist in System32. Never mixes a CRT from one version with
        vcomp140 from another; the highest vcruntime140 version wins.
    #>
    param([string]$ToolchainRoot = '')
    $sets = [System.Collections.Generic.List[hashtable]]::new()
    if ($ToolchainRoot) {
        $files = Get-MsvcRuntimeSetFromDir (Join-Path $ToolchainRoot 'msvc-runtime\x64')
        if (Test-MsvcRuntimeSet $files) { $sets.Add($files) }
    }
    foreach ($x64 in Get-MsvcRedistX64Dirs -ToolchainRoot $ToolchainRoot) {
        $files = Get-MsvcRuntimeSetFromRedist $x64
        if (Test-MsvcRuntimeSet $files) { $sets.Add($files) }
    }
    if ($env:SystemRoot) {
        $files = Get-MsvcRuntimeSetFromDir (Join-Path $env:SystemRoot 'System32')
        if (Test-MsvcRuntimeSet $files) { $sets.Add($files) }
    }
    if ($sets.Count -eq 0) { return $null }
    $best = $sets[0]
    $bestVersion = Get-MsvcRuntimeSetVersion $best
    foreach ($set in $sets) {
        $version = Get-MsvcRuntimeSetVersion $set
        if ($version -gt $bestVersion) {
            $best = $set
            $bestVersion = $version
        }
    }
    return $best
}

function Install-MsvcRuntimeSet {
    <#
    .SYNOPSIS
        Materialises toolchain/msvc-runtime/x64 from the newest complete source set.
        This is the canonical runtime shipped in the build pack and staged beside engines.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$ToolchainRoot
    )
    $files = Find-MsvcRuntimeSet -ToolchainRoot $ToolchainRoot
    if (-not $files) {
        throw "No complete x64 MSVC runtime set found ($($script:MsvcRuntimeDlls -join ', ')). Install the VC++ 2015-2022 x64 redistributable or expose one VC Redist x64 tree, then re-populate the toolchain."
    }
    $dest = Join-Path $ToolchainRoot 'msvc-runtime\x64'
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    foreach ($dll in $script:MsvcRuntimeDlls) {
        Copy-Item -LiteralPath $files[$dll] -Destination $dest -Force
    }
    $sources = ($script:MsvcRuntimeDlls | ForEach-Object { Split-Path -Parent $files[$_] } | Select-Object -Unique) -join ' + '
    Write-Host ("[crt] toolchain runtime set <- {0} ({1} DLLs)" -f $sources, $script:MsvcRuntimeDlls.Count) -ForegroundColor DarkGray
    return $dest
}

function Install-MsvcCrtIntoDirs {
    <#
    .SYNOPSIS
        Copies the four x64 MSVC runtime DLLs from ONE set into every directory that
        holds a llama-server.exe. Idempotent; overwrites so a toolset bump refreshes
        them. Returns files written.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$ToolchainRoot = '',
        [switch]$Quiet
    )
    if (-not (Test-Path -LiteralPath $Root)) { return 0 }
    $files = Find-MsvcRuntimeSet -ToolchainRoot $ToolchainRoot
    if (-not $files) {
        throw "No complete x64 MSVC runtime set found ($($script:MsvcRuntimeDlls -join ', ')). Engines will not start on a machine without VC++ 2015-2022 x64. Install the toolchain or the VC++ redistributable, then re-pack."
    }
    $written = 0
    # Do NOT use -Recurse here: it follows junctions/symlinks (the hazard
    # sync-dev-runtime.ps1 documents) and can walk into an unrelated tree. Walk two known
    # levels instead — runtime/{provider}/{profile}/ is the only layout that holds engines.
    $server_dirs = @()
    Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            if (Test-Path -LiteralPath (Join-Path $_.FullName 'llama-server.exe') -PathType Leaf) {
                $server_dirs += $_.FullName
            }
        }
    }
    foreach ($dir in $server_dirs) {
        foreach ($dll in $script:MsvcRuntimeDlls) {
            Copy-Item -LiteralPath $files[$dll] -Destination $dir -Force
            $written++
        }
    }
    if (-not $Quiet) {
        $sources = ($script:MsvcRuntimeDlls | ForEach-Object { Split-Path -Parent $files[$_] } | Select-Object -Unique) -join ' + '
        Write-Host ("[crt] staged {0} DLL(s) into {1} engine dir(s) from {2}" -f $written, @($server_dirs).Count, $sources) -ForegroundColor DarkGray
    }
    return $written
}

function Get-RuntimeDistributionFiles {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory
    )
    if (-not (Test-Path -LiteralPath $Directory)) {
        return @()
    }
    Get-ChildItem -LiteralPath $Directory -File | Where-Object {
        Test-RuntimeDistributionFile -File $_
    }
}

function Remove-RetiredRuntimeProfileDirs {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )
    if (-not (Test-Path -LiteralPath $Root)) {
        return 0
    }
    $removed = 0
    foreach ($provider in Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue) {
        foreach ($profile_id in $script:RetiredRuntimeProfiles) {
            $profile_dir = Join-Path $provider.FullName $profile_id
            if (Test-Path -LiteralPath $profile_dir) {
                Remove-Item -LiteralPath $profile_dir -Recurse -Force
                $removed++
            }
        }
    }
    return $removed
}
