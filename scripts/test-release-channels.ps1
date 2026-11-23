$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-channels.ps1')
. (Join-Path $PSScriptRoot 'engine-identity.ps1')

function Assert-True([bool]$Cond, [string]$What) {
    if (-not $Cond) { throw "FAIL: $What" }
    Write-Host "ok  $What"
}

# 1. naming
Assert-True ((New-ChannelAssetName -Tag app -Version '1.1.13') -eq 'APP_UPDATE_Blackwell-Ops-v1.1.13.7z') 'app name'
Assert-True ((New-ChannelAssetName -Tag full -Version '1.1.13') -eq 'FULL_SETUP_Blackwell-Ops-v1.1.13.exe') 'full name'
Assert-True ((New-ChannelAssetName -Tag link -Version 'b2047') -eq 'OYM_link_b2047.7z') 'link name'

# 1b. channel table shape
foreach ($t in @('full', 'app', 'engines', 'toolchain', 'link')) {
    $ch = Get-ReleaseChannel -Tag $t
    Assert-True ($null -ne $ch) "channel $t exists"
}
Assert-True ((Get-ReleaseChannel -Tag full).latest -eq $true) 'full is Latest'
Assert-True ((Get-ReleaseChannel -Tag full).retention -eq 1) 'full retention is 1'
Assert-True ((Get-ReleaseChannel -Tag link).prerelease -eq $true) 'link is Pre-release'

# 1c. engine identity parsing (the shapes llama-server --version prints)
$id = ConvertFrom-EngineVersionOutput -Output 'version: 0.8.0-dev (build 12017, commit 5047748f0)'
Assert-True ($id.Build -eq 'b12017-5047748f' -and $id.Version -eq '0.8.0-dev') 'engine identity: full shape'
$id = ConvertFrom-EngineVersionOutput -Output 'version: 0.9.0-dev (build 12187)'
Assert-True ($id.Build -eq 'b12187' -and $id.Version -eq '0.9.0-dev') 'engine identity: no commit'
$id = ConvertFrom-EngineVersionOutput -Output 'version: 11869 (d327bf1f0)'
Assert-True ($id.Build -eq 'b11869-d327bf1f' -and $id.Version -eq '') 'engine identity: legacy build-only'

# 2. history merge, newest first, capped, strips notes from releases[]
$sha = 'a' * 64
$prev = [pscustomobject]@{ releases = @(
    [pscustomobject]@{ version = '1.1.11'; asset = 'APP_UPDATE_Blackwell-Ops-v1.1.11.7z'; sha256 = $sha; sizeBytes = 1048576; publishedAt = '2026-11-07T13:02:51.7102062Z'; notes = 'old' },
    [pscustomobject]@{ version = '1.1.12'; asset = 'APP_UPDATE_Blackwell-Ops-v1.1.12.7z'; sha256 = $sha; sizeBytes = 1048576; publishedAt = '2026-11-16T22:00:53Z' }
) }
$new = [pscustomobject]@{ version = '1.1.13'; asset = 'APP_UPDATE_Blackwell-Ops-v1.1.13.7z'; sha256 = $sha; sizeBytes = 7200000; publishedAt = '2026-11-23T12:26:11.2852973Z'; notes = 'n' }
$all = @(Merge-ChannelReleases -Previous $prev -NewLatest $new -Retention 10)
Assert-True ($all.Count -eq 3) 'keeps full history'
Assert-True ($all[0].version -eq '1.1.13') 'newest first'
Assert-True (-not ($all[1].PSObject.Properties.Name -contains 'notes')) 'releases[] strips notes'
$capped = @(Merge-ChannelReleases -Previous $prev -NewLatest $new -Retention 2)
Assert-True ($capped.Count -eq 2) 'retention cap'
Assert-True ($capped[1].version -eq '1.1.12') 'cap keeps previous newest'

# 2b. link build-based history merge
$prevLink = [pscustomobject]@{ releases = @(
    [pscustomobject]@{ version = '0.1.0'; build = 2070; asset = 'OYM_link_b2070.7z'; sha256 = $sha; sizeBytes = 50000000; publishedAt = '2026-11-13T21:22:04Z' }
) }
$newLink = [pscustomobject]@{ version = '0.1.0'; build = 2073; asset = 'OYM_link_b2073.7z'; sha256 = $sha; sizeBytes = 51605822; publishedAt = '2026-11-23T16:27:35Z' }
$linkAll = @(Merge-ChannelReleases -Previous $prevLink -NewLatest $newLink -Retention 5 -VersionToken 'build')
Assert-True ($linkAll.Count -eq 2 -and $linkAll[0].build -eq 2073 -and $linkAll[1].build -eq 2070) 'link build merge keeps newest first'

# 3. engine retention is per (provider, profile): edge cannot evict stable
$prevEng = [pscustomobject]@{ engines = @(
    [pscustomobject]@{ build = 'b11869-d327bf1f'; provider = 'ggml-master'; profile = 'edge'; asset = 'ENGINE_edge_11869.7z'; version = '0.7.0-dev'; sha256 = $sha; sizeBytes = 100000000; cuda = '13.4' },
    [pscustomobject]@{ build = 'b11869-d327bf1f'; provider = 'ggml-master'; profile = 'stable'; asset = 'ENGINE_stable_11869.7z'; version = '0.7.0-dev'; sha256 = $sha; sizeBytes = 100000000; cuda = '12.9' },
    [pscustomobject]@{ build = 'b11910-63b4b303'; provider = 'ggml-master'; profile = 'edge'; asset = 'ENGINE_edge_11910.7z'; version = '0.7.0-dev'; sha256 = $sha; sizeBytes = 100000000; cuda = '13.4' },
    [pscustomobject]@{ build = 'b11950-11111111'; provider = 'ggml-master'; profile = 'edge'; asset = 'ENGINE_edge_11950.7z'; version = '0.8.0-dev'; sha256 = $sha; sizeBytes = 100000000; cuda = '13.4' }
) }
$newEng = @(
    [pscustomobject]@{ build = 'b12017-5047748f'; provider = 'ggml-master'; profile = 'edge'; asset = 'ENGINE_edge_12017.7z'; version = '0.8.0-dev'; sha256 = $sha; sizeBytes = 100000000; cuda = '13.4' }
)
$kept = @(Merge-EngineChannelEntries -Previous $prevEng -NewEntries $newEng -Retention 3)
$keptEdge = @($kept | Where-Object { $_.profile -eq 'edge' })
$keptStable = @($kept | Where-Object { $_.profile -eq 'stable' })
Assert-True ($keptEdge.Count -eq 3) 'retains 3 newest edge builds'
Assert-True ($keptStable.Count -eq 1 -and $keptStable[0].build -eq 'b11869-d327bf1f') 'edge never evicts stable'

# 4. manifest files & date round-trip regression
$dir = Join-Path $env:TEMP ('bw-relch-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir -Force | Out-Null
try {
    $appPath = Write-ChannelManifestFile -OutDir $dir -Tag app -Product 'Blackwell-Ops' -Latest $new -Releases $capped
    # Round-trip through ConvertFrom-Json (which turns ISO strings into [DateTime] in PS7)
    $doc = Get-Content -LiteralPath $appPath -Raw | ConvertFrom-Json
    Assert-True ($doc.schemaVersion -eq 1 -and $doc.channel -eq 'app') 'app manifest header'
    Assert-True ($doc.latest.asset -eq $new.asset -and $doc.releases.Count -eq 2) 'app manifest latest + history'
    Assert-True ($doc.latest.sha256.Length -eq 64) 'digest present'

    $new14 = [pscustomobject]@{ version = '1.1.14'; asset = 'APP_UPDATE_Blackwell-Ops-v1.1.14.7z'; sha256 = $sha; sizeBytes = 7200000; publishedAt = (Get-Date).ToUniversalTime().ToString('o'); notes = 'n2' }
    $merged14 = @(Merge-ChannelReleases -Previous $doc -NewLatest $new14 -Retention 10)
    $body = New-ChannelReleaseBody -Channel (Get-ReleaseChannel -Tag app) -Latest $new14 -Releases $merged14 -Engines $null
    Assert-True ($body -match '## Retained' -and $body -match '1\.1\.14') 'release body'
    Assert-True (-not $body.TrimStart().StartsWith('#')) 'body does not repeat the release title'
    $dateRows = @($body -split "`n" | Where-Object { $_ -match '^\| 1\.1\.' })
    Assert-True ($dateRows.Count -eq 3) 'all 3 retained rows rendered'
    foreach ($row in $dateRows) {
        Assert-True ($row -match '^\|\s*[\d.]+\s*\|\s*[^|]+\|\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\s*\|$') "uniform UTC date in row: $row"
    }

    $fullNew = [pscustomobject]@{ version = '1.1.23'; commit = '39154a82c'; asset = 'FULL_SETUP_Blackwell-Ops-v1.1.23.exe'; sha256 = $sha; sizeBytes = 181388910; publishedAt = '2026-11-23T12:30:08Z'; notes = 'Full' }
    $fullBody = New-ChannelReleaseBody -Channel (Get-ReleaseChannel -Tag full) -Latest $fullNew -Releases @($fullNew) -Engines $null
    Assert-True ($fullBody -match 'releases/download/full/FULL_SETUP_Blackwell-Ops-v1\.1\.23\.exe') 'full body has direct download link'
    Assert-True (-not ($fullBody -match '## Retained')) 'full body omits redundant 1-row Retained table'

    $engPath = Write-ChannelManifestFile -OutDir $dir -Tag engines -Engines $kept
    $engDoc = Get-Content -LiteralPath $engPath -Raw | ConvertFrom-Json
    Assert-True ($engDoc.channel -eq 'engines' -and $engDoc.engines.Count -eq 4) 'engine manifest'

    $engBody = New-ChannelReleaseBody -Channel (Get-ReleaseChannel -Tag engines) -Latest $null -Releases $null -Engines $kept
    Assert-True ($engBody -match '0\.8\.0-dev' -and $engBody -match 'b12017-5047748f') 'engine table keeps the llama version'
} finally {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'ALL CHANNEL HELPER CHECKS PASSED'
