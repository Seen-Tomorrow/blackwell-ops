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

function Test-SemverGreater {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Current
    )
    return ([version]$Candidate -gt [version]$Current)
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

# ── UTC timestamp normalization ─────────────────────────────────────────
# PowerShell 7's ConvertFrom-Json auto-parses ISO-8601 strings into [DateTime]
# objects; formatting them directly with `-f` emits local Windows culture
# (`16/11/2026 22:00:53`) instead of UTC ISO. Always normalize explicitly.

function ConvertTo-UtcDateTimeOffset {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime() }
    if ($Value -is [DateTime]) {
        if ($Value.Kind -eq [DateTimeKind]::Unspecified) {
            return ([DateTimeOffset]::new($Value, [TimeSpan]::Zero)).ToUniversalTime()
        }
        return ([DateTimeOffset]$Value).ToUniversalTime()
    }
    $str = [string]$Value
    if ([string]::IsNullOrWhiteSpace($str)) { return $null }
    $parsed = [DateTimeOffset]::MinValue
    $styles = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    if ([DateTimeOffset]::TryParse($str, [System.Globalization.CultureInfo]::InvariantCulture, $styles, [ref]$parsed)) {
        return $parsed.ToUniversalTime()
    }
    return $null
}

function Format-UtcIsoTimestamp {
    param($Value)
    $dto = ConvertTo-UtcDateTimeOffset $Value
    if ($null -ne $dto) {
        return $dto.ToString('yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture)
    }
    return [string]$Value
}

function Format-UtcDisplayTimestamp {
    param($Value)
    $dto = ConvertTo-UtcDateTimeOffset $Value
    if ($null -ne $dto) {
        return $dto.ToString('yyyy-MM-dd HH:mm UTC', [System.Globalization.CultureInfo]::InvariantCulture)
    }
    return [string]$Value
}

function Format-AssetSizeLabel {
    param([long]$SizeBytes)
    if ($SizeBytes -ge 1MB) {
        return ('{0:N1} MB' -f ($SizeBytes / 1MB))
    }
    if ($SizeBytes -gt 0) {
        return ('{0:N0} KB' -f [math]::Max(1, [math]::Round($SizeBytes / 1KB)))
    }
    return '-'
}

# ── Manifest + history helpers (docs/RELEASE-CHANNELS.md §4-§6) ──────────

function Copy-HistoryReleaseEntry {
    param($Entry)
    $out = [ordered]@{
        version = [string]$Entry.version
    }
    if ($Entry.PSObject.Properties.Name -contains 'build' -and $null -ne $Entry.build) {
        $out.build = [int]$Entry.build
    }
    if ($Entry.PSObject.Properties.Name -contains 'commit' -and $Entry.commit) {
        $out.commit = [string]$Entry.commit
    }
    $out.asset = [string]$Entry.asset
    $out.sizeBytes = [long]$Entry.sizeBytes
    $out.sha256 = [string]$Entry.sha256
    $out.publishedAt = Format-UtcIsoTimestamp $Entry.publishedAt
    return [pscustomobject]$out
}

# Newest first, deduped by version (or build integer for `build` channels), capped at retention.
# The manifest's own retained list is what the prune step reads, so history and pruning cannot disagree.
function Merge-ChannelReleases {
    param(
        $Previous,
        $NewLatest,
        [int]$Retention,
        [string]$VersionToken = 'semver'
    )
    $all = @()
    if ($Previous -and $Previous.releases) {
        foreach ($r in @($Previous.releases)) {
            $all += Copy-HistoryReleaseEntry $r
        }
    }
    $newHist = Copy-HistoryReleaseEntry $NewLatest
    if ($VersionToken -eq 'build') {
        $newBuild = [int]$newHist.build
        $all = @($all | Where-Object { [int]$_.build -ne $newBuild })
        $all = @($newHist) + $all
        $sorted = $all | Sort-Object { [int]$_.build } -Descending
    } else {
        $all = @($all | Where-Object { $_.version -ne $newHist.version })
        $all = @($newHist) + $all
        $sorted = $all | Sort-Object { [version]($_.version) } -Descending
    }
    return @($sorted | Select-Object -First $Retention)
}

# Engines are retained per (provider, profile): shipping `edge` must never evict `stable`
# or another provider's builds.
function Merge-EngineChannelEntries {
    param($Previous, [object[]]$NewEntries, [int]$Retention)
    $all = @()
    if ($Previous -and $Previous.engines) { $all += @($Previous.engines) }
    $all = @($all | Where-Object { $NewEntries.asset -notcontains $_.asset })
    $all = @($NewEntries) + $all

    $kept = @()
    $byProfile = $all | Group-Object { '{0}/{1}' -f $_.provider.ToLowerInvariant(), $_.profile.ToLowerInvariant() }
    foreach ($grp in $byProfile) {
        $kept += @($grp.Group |
            Sort-Object { [int](($_.build -replace '^b(\d+).*$', '$1')) } -Descending |
            Select-Object -First $Retention)
    }

    return @($kept | Sort-Object `
        @{ Expression = { [int](($_.build -replace '^b(\d+).*$', '$1')) }; Descending = $true }, `
        @{ Expression = { $_.provider }; Descending = $false }, `
        @{ Expression = { $_.profile }; Descending = $false })
}

function New-ChannelReleaseBody {
    param(
        $Channel,
        $Latest,
        [object[]]$Releases,
        [object[]]$Engines,
        [string]$Repo = 'Seen-Tomorrow/blackwell-ops'
    )
    # No title heading: GitHub already renders the release title, so repeating it as an H1
    # shows the title twice. Body starts with the channel blurb.
    $lines = @([string]$Channel.blurb, "")
    if ($Latest) {
        $sizeLabel = Format-AssetSizeLabel ([long]$Latest.sizeBytes)
        $downloadUrl = "https://github.com/$Repo/releases/download/$($Channel.tag)/$($Latest.asset)"
        $pubDisplay = Format-UtcDisplayTimestamp $Latest.publishedAt

        if ($Channel.tag -eq 'full') {
            $lines += ("## Download latest — v{0}" -f $Latest.version)
            $lines += ""
            $lines += ("**[Download {0} ({1})]({2})**" -f $Latest.asset, $sizeLabel, $downloadUrl)
            $lines += ""
            $lines += ("- **Published:** {0}" -f $pubDisplay)
            if ($Latest.commit) { $lines += ("- **Commit:** ``{0}``" -f $Latest.commit) }
            if ($Latest.sha256) { $lines += ("- **SHA-256:** ``{0}``" -f $Latest.sha256) }
            $lines += ""
        } else {
            $lines += "## Latest"
            $lines += ""
            if ($Channel.versionToken -eq 'build' -and $Latest.PSObject.Properties.Name -contains 'build' -and $Latest.build) {
                $lines += ("**b{0}** (v{1}) — ``{2}`` ({3})" -f $Latest.build, $Latest.version, $Latest.asset, $sizeLabel)
            } else {
                $lines += ("**v{0}** — ``{1}`` ({2})" -f $Latest.version, $Latest.asset, $sizeLabel)
            }
            $lines += ""
        }
        if ($Latest.notes) { $lines += [string]$Latest.notes; $lines += "" }
    }
    if ($Releases -and @($Releases).Count -gt 1) {
        $lines += "## Retained"
        $lines += ""
        if ($Channel.versionToken -eq 'build') {
            $lines += "| Build | Version | Asset | Published |"
            $lines += "|---|---|---|---|"
            foreach ($r in $Releases) {
                $lines += ("| b{0} | {1} | {2} | {3} |" -f $r.build, $r.version, $r.asset, (Format-UtcDisplayTimestamp $r.publishedAt))
            }
        } else {
            $lines += "| Version | Asset | Published |"
            $lines += "|---|---|---|"
            foreach ($r in $Releases) {
                $lines += ("| {0} | {1} | {2} |" -f $r.version, $r.asset, (Format-UtcDisplayTimestamp $r.publishedAt))
            }
        }
        $lines += ""
    }
    if ($Engines) {
        $lines += "## Retained engine builds"
        $lines += ""
        $lines += "| Version | Build | Engine | Size | Asset |"
        $lines += "|---|---|---|---|---|"
        foreach ($e in $Engines) {
            $shown = if ($e.version) { [string]$e.version } else { "-" }
            $sizeLabel = Format-AssetSizeLabel ([long]$e.sizeBytes)
            $lines += ("| {0} | {1} | {2}/{3} | {4} | {5} |" -f $shown, $e.build, $e.provider, $e.profile, $sizeLabel, $e.asset)
        }
        $lines += ""
    }
    return ($lines -join "`n")
}

function New-ToolchainReleaseBody {
    param(
        $Channel,
        $Manifest
    )
    $lines = @([string]$Channel.blurb, "")
    if ($Manifest -and $Manifest.packs) {
        $lines += "## Packs (v$($Manifest.version))"
        $lines += ""
        $lines += "| Pack | Asset | Size | SHA-256 |"
        $lines += "|---|---|---|---|"
        foreach ($p in @($Manifest.packs)) {
            $sizeLabel = Format-AssetSizeLabel ([long]$p.sizeBytes)
            $lines += ("| {0} | ``{1}`` | {2} | ``{3}`` |" -f $p.id, $p.asset, $sizeLabel, $p.sha256)
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
        generatedAt   = Format-UtcIsoTimestamp (Get-Date)
    }
    if ($Engines) {
        $doc.engines = @($Engines)
    } else {
        $doc.product = $Product
        if ($Latest -and $Latest.PSObject.Properties.Name -contains 'publishedAt') {
            $Latest.publishedAt = Format-UtcIsoTimestamp $Latest.publishedAt
        }
        $doc.latest = $Latest
        $doc.releases = @($Releases)
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    $json = (($doc | ConvertTo-Json -Depth 8) -replace "`r`n", "`n")
    [System.IO.File]::WriteAllText($path, ($json + "`n"), $utf8NoBom)
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

# Step 4 of docs/RELEASE-CHANNELS.md §5: re-read the release from the API and assert every
# uploaded asset is present with the expected size (and digest when GitHub reports one).
function Invoke-ChannelAssetVerify {
    param(
        [Parameter(Mandatory = $true)][string]$Tag,
        [Parameter(Mandatory = $true)][string]$Repo,
        [Parameter(Mandatory = $true)][object[]]$Files
    )
    $json = gh release view $Tag --repo $Repo --json assets 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Verify failed for '$Tag': could not read release assets from GitHub."
    }
    $view = $json | ConvertFrom-Json
    $byName = @{}
    foreach ($a in @($view.assets)) {
        $byName[[string]$a.name] = $a
    }
    foreach ($f in $Files) {
        $name = [string]$f.name
        $remote = $byName[$name]
        if ($null -eq $remote) {
            throw "Verify failed for '$Tag': uploaded asset '$name' is missing from release."
        }
        if ([long]$remote.size -ne [long]$f.bytes) {
            throw ("Verify failed for '$Tag/$name': size mismatch (expected {0}, GitHub {1})." -f $f.bytes, $remote.size)
        }
        if ($remote.PSObject.Properties.Name -contains 'digest' -and $remote.digest -and $f.sha256) {
            $expectedDigest = 'sha256:' + ([string]$f.sha256).ToLowerInvariant()
            if (([string]$remote.digest).ToLowerInvariant() -ne $expectedDigest) {
                throw ("Verify failed for '$Tag/$name': digest mismatch (expected $expectedDigest, GitHub $($remote.digest)).")
            }
        }
    }
}

# Post-publish verification (docs/DISTRIBUTION-PANEL.md §7): re-download channel.json from
# GitHub and assert the manifest matches what we just published.
function Invoke-ChannelManifestVerify {
    param(
        [Parameter(Mandatory = $true)][string]$Tag,
        [Parameter(Mandatory = $true)][string]$Repo,
        [string]$ExpectedAsset = '',
        [string]$ExpectedSha256 = '',
        [object[]]$ExpectedEngines = @()
    )
    $tmp = Join-Path $env:TEMP ("bw-verify-$Tag-" + [guid]::NewGuid().ToString('N') + '.json')
    try {
        gh release download $Tag --repo $Repo --pattern (Get-ChannelManifestAssetName) --output $tmp --clobber 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tmp)) {
            throw "Post-ship verify failed for '$Tag': could not download channel.json."
        }
        $doc = Get-Content -LiteralPath $tmp -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([int]$doc.schemaVersion -ne 1 -or [string]$doc.channel -ne $Tag) {
            throw "Post-ship verify failed for '$Tag': invalid channel.json header."
        }
        if ($Tag -eq 'engines') {
            foreach ($exp in $ExpectedEngines) {
                $hit = @($doc.engines | Where-Object { $_.asset -eq $exp.asset }) | Select-Object -First 1
                if ($null -eq $hit) {
                    throw "Post-ship verify failed for 'engines': $($exp.asset) missing from channel.json."
                }
                if (([string]$hit.sha256).ToLowerInvariant() -ne ([string]$exp.sha256).ToLowerInvariant()) {
                    throw "Post-ship verify failed for 'engines': $($exp.asset) sha256 mismatch."
                }
            }
        } else {
            if ([string]$doc.latest.asset -ne $ExpectedAsset) {
                throw "Post-ship verify failed for '$Tag': latest.asset is '$($doc.latest.asset)' (expected '$ExpectedAsset')."
            }
            if (([string]$doc.latest.sha256).ToLowerInvariant() -ne $ExpectedSha256.ToLowerInvariant()) {
                throw "Post-ship verify failed for '$Tag': latest.sha256 mismatch."
            }
        }
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}
