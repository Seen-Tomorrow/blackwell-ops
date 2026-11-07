# Release channel table - single source for tags, asset names, retention and release copy.
# Spec: docs/RELEASE-CHANNELS.md. The client embeds the same JSON; never duplicate names here.

$script:ReleaseChannelsPath = $null
foreach ($rel in @('..\src-tauri\release-channels.json', '..\..\src-tauri\release-channels.json')) {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $rel))
    if (Test-Path -LiteralPath $candidate) {
        $script:ReleaseChannelsPath = $candidate
        break
    }
}
if (-not $script:ReleaseChannelsPath) {
    throw "Missing src-tauri/release-channels.json (looked from $PSScriptRoot)"
}

function Read-ReleaseChannels {
    if (-not (Test-Path -LiteralPath $script:ReleaseChannelsPath)) {
        throw "Missing release channel table: $($script:ReleaseChannelsPath)"
    }
    $doc = Get-Content -LiteralPath $script:ReleaseChannelsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $doc.channels -or @($doc.channels).Count -eq 0) {
        throw "release-channels.json has no channels"
    }
    return @($doc.channels)
}

function Get-ReleaseChannel {
    param([Parameter(Mandatory = $true)][string]$Tag)
    $channel = Read-ReleaseChannels | Where-Object { $_.tag -eq $Tag } | Select-Object -First 1
    if (-not $channel) {
        throw "Unknown release channel '$Tag' (src-tauri/release-channels.json)"
    }
    return $channel
}

function Get-ChannelManifestAssetName {
    return 'channel.json'
}

# `<CLASS>_<Product>-<Version>.<ext>` per docs/RELEASE-CHANNELS.md §3.
function New-ChannelAssetName {
    param(
        [Parameter(Mandatory = $true)][string]$Tag,
        [Parameter(Mandatory = $true)][string]$Version
    )
    $channel = Get-ReleaseChannel -Tag $Tag
    if (-not $channel.assetClass) {
        throw "Channel '$Tag' has no asset naming (toolchain names come from toolchain/manifest.json)"
    }
    $ext = if ($channel.kind -eq 'installer') { 'exe' } else { '7z' }
    $token = if ($channel.versionToken -eq 'semver') { "v$Version" } else { $Version }
    # Channels whose class already names the product (OYM_link) leave `product` empty.
    $product = if ($channel.product) { "$($channel.product)-" } else { '' }
    return ('{0}_{1}{2}.{3}' -f $channel.assetClass, $product, $token, $ext)
}

# ── Manifest + history helpers (docs/RELEASE-CHANNELS.md §4-§6) ──────────

# Newest first, deduped by version, capped at the channel's retention. The manifest's own
# retained list is what the prune step reads, so history and pruning cannot disagree.
function Merge-ChannelReleases {
    param($Previous, $NewLatest, [int]$Retention)
    $all = @()
    if ($Previous -and $Previous.releases) { $all += @($Previous.releases) }
    $all = @($all | Where-Object { $_.version -ne $NewLatest.version })
    $all = @($NewLatest) + $all
    $sorted = $all | Sort-Object { [version]($_.version) } -Descending
    return @($sorted | Select-Object -First $Retention)
}

# Engines are retained per build id: both profiles of one build live or die together.
function Merge-EngineChannelEntries {
    param($Previous, [object[]]$NewEntries, [int]$Retention)
    $all = @()
    if ($Previous -and $Previous.engines) { $all += @($Previous.engines) }
    $all = @($all | Where-Object { $NewEntries.asset -notcontains $_.asset })
    $all = @($NewEntries) + $all
    $keptBuilds = $all |
        Group-Object build |
        Sort-Object { [int](($_.Name -replace '^b(\d+).*$', '$1')) } -Descending |
        Select-Object -First $Retention
    return @($keptBuilds | ForEach-Object { $_.Group })
}

function New-ChannelReleaseBody {
    param($Channel, $Latest, [object[]]$Releases, [object[]]$Engines)
    # No title heading: GitHub already renders the release title, so repeating it as an H1
    # shows "Blackwell Ops - ENGINE packs" twice. Body starts with the channel blurb.
    $lines = @([string]$Channel.blurb, "")
    if ($Latest) {
        $lines += "## Latest"
        $lines += ""
        $lines += ("**v{0}** - {1}" -f $Latest.version, $Latest.asset)
        $lines += ""
        if ($Latest.notes) { $lines += [string]$Latest.notes; $lines += "" }
    }
    if ($Releases) {
        $lines += "## Retained"
        $lines += ""
        $lines += "| Version | Asset | Published |"
        $lines += "|---|---|---|"
        foreach ($r in $Releases) { $lines += ("| {0} | {1} | {2} |" -f $r.version, $r.asset, $r.publishedAt) }
        $lines += ""
    }
    if ($Engines) {
        $lines += "## Retained engine builds"
        $lines += ""
        $lines += "| Version | Build | Engine | Asset |"
        $lines += "|---|---|---|---|"
        foreach ($e in $Engines) {
            $shown = if ($e.version) { [string]$e.version } else { "-" }
            $lines += ("| {0} | {1} | {2}/{3} | {4} |" -f $shown, $e.build, $e.provider, $e.profile, $e.asset)
        }
        $lines += ""
    }
    return ($lines -join "`n")
}

function Write-ChannelManifestFile {
    param(
        [Parameter(Mandatory = $true)][string]$OutDir,
        [Parameter(Mandatory = $true)][string]$Tag,
        [string]$Product,
        [object]$Latest,
        [object[]]$Releases,
        [object[]]$Engines
    )
    # Upload name is fixed: `channel.json` (docs/RELEASE-CHANNELS.md §4).
    $path = Join-Path $OutDir 'channel.json'
    $doc = [ordered]@{
        schemaVersion = 1
        channel       = $Tag
        generatedAt   = (Get-Date).ToUniversalTime().ToString('o')
    }
    if ($Engines) {
        $doc.engines = @($Engines)
    } else {
        $doc.product = $Product
        $doc.latest = $Latest
        $doc.releases = @($Releases)
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($path, (($doc | ConvertTo-Json -Depth 8) + "`n"), $utf8NoBom)
    return $path
}

# The previously published manifest drives history and pruning. A missing asset is normal
# (first publish of a channel), so a failed download returns $null instead of throwing.
function Read-PublishedChannelManifest {
    param(
        [Parameter(Mandatory = $true)][string]$OutDir,
        [Parameter(Mandatory = $true)][string]$Tag,
        [Parameter(Mandatory = $true)][string]$Repo
    )
    $tmp = Join-Path $OutDir "published-$Tag.json"
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    $prev_eap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    gh release download $Tag --repo $Repo --pattern (Get-ChannelManifestAssetName) --output $tmp --clobber 2>$null | Out-Null
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev_eap
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $tmp)) { return $null }
    try { return (Get-Content -LiteralPath $tmp -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}
