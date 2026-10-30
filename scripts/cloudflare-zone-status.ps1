#requires -Version 7.0
<#
.SYNOPSIS
  Poll the .cz registry/DNS until oym.cz is delegated to Cloudflare, then check
  the permanent support hostname.
#>
param(
    [string] $Domain = "oym.cz",
    [string] $Hostname = "help.oym.cz",
    [switch] $Watch,
    [int] $IntervalSeconds = 60
)

$ErrorActionPreference = "Continue"

function Get-Ns {
    try {
        Resolve-DnsName $Domain -Type NS -ErrorAction Stop |
            Where-Object { $_.NameHost } |
            Select-Object -ExpandProperty NameHost -Unique |
            Sort-Object
    } catch {
        @()
    }
}

function Show-Status {
    $ns = @(Get-Ns)
    Write-Host ("[{0:HH:mm:ss}] {1} NS: {2}" -f (Get-Date), $Domain, ($(if ($ns) { $ns -join ", " } else { "<not delegated yet>" })))
    $cloudflare = $ns | Where-Object { $_ -like "*.ns.cloudflare.com" }
    if (-not $cloudflare) {
        Write-Host "  waiting for the registrar/registry to publish the Cloudflare nameservers"
        return $false
    }
    Write-Host "  Cloudflare nameservers are live; checking the zone at Cloudflare..."

    try {
        $health = Invoke-WebRequest "https://$Hostname/healthz" -UseBasicParsing -TimeoutSec 8
        Write-Host "  https://$Hostname/healthz -> $($health.StatusCode) $($health.Content)"
        return $true
    } catch {
        Write-Host "  https://$Hostname/healthz not ready yet: $($_.Exception.Message)"
        return $false
    }
}

if (-not $Watch) {
    Show-Status | Out-Null
    return
}

while ($true) {
    if (Show-Status) { break }
    Start-Sleep -Seconds $IntervalSeconds
}
