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
