# Shared filter + profile policy for release/runtime distribution binaries.
# DEV sync (predev), mirror-artifacts, and NSIS prep all use this map.

# Profiles mirrored from foundry artifacts and bundled in the NSIS installer.
$script:RuntimeBundleProfiles = @{
    'ggml-master' = @('frontier', 'stable')
    'ggml-tom'    = @('frontier', 'stable')
}

# Retired CUDA profiles - never sync to debug runtime or NSIS bundle.
$script:RetiredRuntimeProfiles = @('vanguard', 'fresh')

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

$script:RuntimeDistributionExecutables = @(
    'llama-server.exe'
    'llama-fit-params.exe'
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

    # Shared backend DLLs (ggml*, llama.dll, llama-common.dll, mtmd.dll, ...)
    if ($File.Name -notmatch '-impl\.dll$') {
        return $true
    }

    # Stub loaders pair with these impl DLLs only.
    return $File.Name -in @(
        'llama-server-impl.dll'
        'llama-fit-params-impl.dll'
    )
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