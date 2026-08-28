# Shared filter + profile policy for release/runtime distribution binaries.
# Source of truth: scripts/distribution-policy.json (edited by DEV app + this file on load).

$script:RuntimeDistributionPolicyPath = Join-Path $PSScriptRoot 'distribution-policy.json'

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

    $script:RuntimeBundleProfiles = @{}
    foreach ($kv in $script:NsisCoreProviders.GetEnumerator()) {
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
# msvcp140.dll (verified with `dumpbin //DEPENDENTS` over all 40 .dll/.exe under
# runtime/ — that is the complete CRT surface; no concrt140, no vccorlib140).
# On a machine that never had VC++ 2015-2022 x64, LoadLibrary fails before the engine
# writes a single log line, so the failure looks like an app bug, not a missing runtime.
# App-local copies win the OS DLL search order, touch no system state, need no admin and
# no reboot, and keep the offline/flash-disk install working — unlike the 17-25 MB
# vc_redist.exe (which can also refuse with 1638 when another app already put a different
# CRT version on the machine).
$script:MsvcCrtDlls = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')

function Find-MsvcCrtSourceDir {
    <#
    .SYNOPSIS
        Locates a directory containing all three x64 CRT release DLLs.
        Prefers the portable toolchain (ships with the app, version-matched to the
        toolset that built the engines), then a local BuildTools install.
    #>
    param(
        [string]$ToolchainRoot = ''
    )
    # Layout is {toolchain}/vs/{vsYear}/VC/Tools/MSVC/{msvcVersion}/bin/Hostx64/x64 — note the
    # extra `vs` level and that vsYear is a key ('2022'/'2026'), not a version dir. Enumerate
    # it explicitly: globbing the toolchain root would probe cuda/ and Windows Kits/ instead.
    # Newest toolset first, so a multi-VS tree prefers the one that built the current engines.
    $candidates = @()
    $vs_root = if ($ToolchainRoot) { Join-Path $ToolchainRoot 'vs' } else { '' }
    if ($vs_root -and (Test-Path -LiteralPath $vs_root)) {
        $years = Get-ChildItem -LiteralPath $vs_root -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending
        foreach ($year in $years) {
            $msvc_root = Join-Path $year.FullName 'VC\Tools\MSVC'
            if (-not (Test-Path -LiteralPath $msvc_root)) { continue }
            $candidates += Get-ChildItem -LiteralPath $msvc_root -Directory -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending |
                ForEach-Object { Join-Path $_.FullName 'bin\Hostx64\x64' }
        }
    }
    foreach ($probe in @(
        'C:\BuildTools\VC\Tools\MSVC',
        'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC',
        'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC'
    )) {
        if (Test-Path -LiteralPath $probe) {
            $candidates += Get-ChildItem -LiteralPath $probe -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'bin\Hostx64\x64' }
        }
    }
    foreach ($dir in $candidates) {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        $ok = $true
        foreach ($dll in $script:MsvcCrtDlls) {
            if (-not (Test-Path -LiteralPath (Join-Path $dir $dll) -PathType Leaf)) { $ok = $false; break }
        }
        if ($ok) { return $dir }
    }
    return $null
}

function Install-MsvcCrtIntoDirs {
    <#
    .SYNOPSIS
        Copies the three x64 CRT DLLs into every directory that holds a llama-server.exe.
        Idempotent; overwrites so a toolset bump refreshes them. Returns files written.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$ToolchainRoot = '',
        [switch]$Quiet
    )
    if (-not (Test-Path -LiteralPath $Root)) { return 0 }
    $src = Find-MsvcCrtSourceDir -ToolchainRoot $ToolchainRoot
    if (-not $src) {
        throw "MSVC C runtime not found (looked for $($script:MsvcCrtDlls -join ', ') in the portable toolchain and local BuildTools installs). Engines will not start on a machine without VC++ 2015-2022 x64. Install the toolchain or the VC++ redistributable, then re-pack."
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
        foreach ($dll in $script:MsvcCrtDlls) {
            Copy-Item -LiteralPath (Join-Path $src $dll) -Destination $dir -Force
            $written++
        }
    }
    if (-not $Quiet) {
        Write-Host ("[crt] staged {0} DLL(s) into {1} engine dir(s) from {2}" -f $written, @($server_dirs).Count, $src) -ForegroundColor DarkGray
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
