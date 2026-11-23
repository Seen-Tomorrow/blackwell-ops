#requires -Version 7.0
<#
.SYNOPSIS
  Publish the newest OYM_link_b*.7z update asset to the prerelease `link` channel.
#>
param(
    [string] $Asset = "",
    [int] $Build = 0
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out_root = Join-Path $root ".majestic-out"
New-Item -ItemType Directory -Force -Path $out_root | Out-Null

. (Join-Path $PSScriptRoot "release-channels.ps1")
. (Join-Path $PSScriptRoot "runtime-distribution.ps1")

$cfg = Get-Content -LiteralPath (Join-Path $root "scripts\majestic\majestic.config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$repo = [string]$cfg.repo
$channel = Get-ReleaseChannel -Tag 'link'
$tag = [string]$channel.tag

if (-not $Asset) {
    $Asset = Get-ChildItem -LiteralPath $out_root -File -Filter "OYM_link_b*.7z" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Asset -or -not (Test-Path -LiteralPath $Asset)) {
    throw "No OYM_link_b*.7z asset found in .majestic-out/. Run npm run majestic:pack:link first."
}

$assetItem = Get-Item -LiteralPath $Asset
if ($Build -le 0) {
    if ($assetItem.Name -match '^OYM_link_b(\d+)\.7z$') {
        $Build = [int]$Matches[1]
    } else {
        $marker = Join-Path $root "tmp/link-installer-build.json"
        if (Test-Path -LiteralPath $marker) {
            $Build = [int]((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).build)
        }
    }
}
if ($Build -le 0) {
    throw "Could not determine OYM-Link build number for $($assetItem.Name)"
}

$version = (Get-Content -LiteralPath (Join-Path $root "link/app/src-tauri/tauri.conf.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$sha256 = Get-FileSha256Hex -Path $assetItem.FullName
$commit = (git -C $root rev-parse --short HEAD 2>$null | Out-String).Trim()

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'SilentlyContinue'
$relJson = gh release view $tag --repo $repo --json isImmutable,assets 2>$null
$relCode = $LASTEXITCODE
$ErrorActionPreference = $prevEap

$existing = if ($relCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($relJson)) { $relJson | ConvertFrom-Json } else { $null }
if ($null -eq $existing) {
    Write-Host "[ship-link] Creating prerelease channel '$tag'..." -ForegroundColor Cyan
    $rootCommit = (git -C $root rev-list --max-parents=0 HEAD 2>$null | Select-Object -First 1 | Out-String).Trim()
    $createArgs = @('release', 'create', $tag, '--repo', $repo, '--title', [string]$channel.title, '--notes', [string]$channel.blurb, '--prerelease', '--latest=false')
    if ($rootCommit) { $createArgs += @('--target', $rootCommit) }
    & gh @createArgs
    if ($LASTEXITCODE -ne 0) { throw "gh release create $tag failed" }
} elseif ($existing.isImmutable) {
    throw "Release '$tag' is immutable."
} else {
    $already = @($existing.assets | Where-Object { $_.name -eq $assetItem.Name }) | Select-Object -First 1
    $sameSize = ($null -ne $already) -and ([long]$already.size -eq [long]$assetItem.Length)
    $digestOk = $true
    if ($null -ne $already -and $already.digest) {
        $digestOk = (([string]$already.digest).ToLowerInvariant() -eq ("sha256:" + $sha256.ToLowerInvariant()))
    }
    if ($sameSize -and $digestOk) {
        Write-Host "[ship-link] $($assetItem.Name) already published, refreshing channel.json + body" -ForegroundColor DarkGray
        $skipUpload = $true
    }
}

if (-not $skipUpload) {
    Write-Host "[ship-link] Uploading $($assetItem.Name) to '$tag'..." -ForegroundColor Cyan
    gh release upload $tag --repo $repo --clobber $assetItem.FullName
    if ($LASTEXITCODE -ne 0) { throw "gh release upload $tag failed" }
}

$verifyEntry = [PSCustomObject]@{ name = $assetItem.Name; bytes = [long]$assetItem.Length; sha256 = $sha256 }
Invoke-ChannelAssetVerify -Tag $tag -Repo $repo -Files @($verifyEntry)

$prev = Read-PublishedChannelManifest -OutDir $out_root -Tag $tag -Repo $repo
$latest = [PSCustomObject][ordered]@{
    version     = [string]$version
    build       = $Build
    commit      = $commit
    asset       = $assetItem.Name
    sizeBytes   = [long]$assetItem.Length
    sha256      = $sha256
    publishedAt = Format-UtcIsoTimestamp (Get-Date)
    notes       = "OYM Link build $Build (internal alpha)"
}
$releases = Merge-ChannelReleases -Previous $prev -NewLatest $latest -Retention $channel.retention -VersionToken ([string]$channel.versionToken)
$manifestPath = Write-ChannelManifestFile -OutDir $out_root -Tag $tag -Product 'OYM-Link' -Latest $latest -Releases $releases

gh release upload $tag --repo $repo --clobber $manifestPath
if ($LASTEXITCODE -ne 0) { throw "gh release upload $tag (channel.json) failed" }
Invoke-ChannelManifestVerify -Tag $tag -Repo $repo -ExpectedAsset $latest.asset -ExpectedSha256 $latest.sha256

$keep = @((Get-ChannelManifestAssetName)) + @($releases | ForEach-Object { $_.asset })
$view = gh release view $tag --repo $repo --json assets | ConvertFrom-Json
foreach ($a in @($view.assets)) {
    if ($keep -notcontains $a.name) {
        Write-Host "[ship-link] prune $tag/$($a.name)" -ForegroundColor DarkGray
        gh release delete-asset $tag $a.name --repo $repo --yes | Out-Null
    }
}

$body = New-ChannelReleaseBody -Channel $channel -Latest $latest -Releases $releases -Engines $null -Repo $repo
$bodyPath = Join-Path $out_root "release-body-$tag.md"
[System.IO.File]::WriteAllText($bodyPath, $body, (New-Object System.Text.UTF8Encoding $false))
gh release edit $tag --repo $repo --title ([string]$channel.title) --notes-file $bodyPath --prerelease --latest=false | Out-Null

& (Join-Path $PSScriptRoot "prune-staging.ps1") -OutRoot $out_root -Root $root
Write-Host "UPLOADED=$($assetItem.FullName)" -ForegroundColor Green
