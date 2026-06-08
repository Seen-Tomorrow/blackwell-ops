# Shared filter + profile policy for release/runtime distribution binaries.
# DEV keeps the full foundry Release tree; NSIS ships only what Blackwell Ops runs.

# Profiles mirrored from foundry artifacts and bundled in the NSIS installer.
$script:RuntimeBundleProfiles = @{
    'ggml-master' = @('vanguard', 'frontier', 'fresh', 'stable')
    'ik'          = @('vanguard')
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

function Test-RuntimeBundleProfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProviderId,
        [Parameter(Mandatory = $true)]
        [string]$ProfileId
    )

    $allowed = Get-RuntimeBundleProfiles -ProviderId $ProviderId
    if ($allowed.Count -eq 0) {
        return $true
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