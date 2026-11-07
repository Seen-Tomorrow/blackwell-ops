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

# 1b. engine identity parsing (the shapes llama-server --version prints)
$id = ConvertFrom-EngineVersionOutput -Output 'version: 0.8.0-dev (build 12017, commit 5047748f0)'
Assert-True ($id.Build -eq 'b12017-5047748f' -and $id.Version -eq '0.8.0-dev') 'engine identity: full shape'
$id = ConvertFrom-EngineVersionOutput -Output 'version: 0.9.0-dev (build 12187)'
Assert-True ($id.Build -eq 'b12187' -and $id.Version -eq '0.9.0-dev') 'engine identity: no commit'
$id = ConvertFrom-EngineVersionOutput -Output 'version: 11869 (d327bf1f0)'
Assert-True ($id.Build -eq 'b11869-d327bf1f' -and $id.Version -eq '') 'engine identity: legacy build-only'

# 2. history merge, newest first, capped
$sha = 'a' * 64
$prev = [pscustomobject]@{ releases = @(
    [pscustomobject]@{ version = '1.1.11'; asset = 'APP_UPDATE_Blackwell-Ops-v1.1.11.7z'; sha256 = $sha; sizeBytes = 1; publishedAt = 't1' },
    [pscustomobject]@{ version = '1.1.12'; asset = 'APP_UPDATE_Blackwell-Ops-v1.1.12.7z'; sha256 = $sha; sizeBytes = 1; publishedAt = 't2' }
) }
$new = [pscustomobject]@{ version = '1.1.13'; asset = 'APP_UPDATE_Blackwell-Ops-v1.1.13.7z'; sha256 = $sha; sizeBytes = 2; publishedAt = 't3'; notes = 'n' }
$all = @(Merge-ChannelReleases -Previous $prev -NewLatest $new -Retention 10)
Assert-True ($all.Count -eq 3) 'keeps full history'
Assert-True ($all[0].version -eq '1.1.13') 'newest first'
$capped = @(Merge-ChannelReleases -Previous $prev -NewLatest $new -Retention 2)
Assert-True ($capped.Count -eq 2) 'retention cap'
Assert-True ($capped[1].version -eq '1.1.12') 'cap keeps previous newest'

# 3. engine retention is per build (both profiles live or die together)
$prevEng = [pscustomobject]@{ engines = @(
    [pscustomobject]@{ build = 'b11869-d327bf1f'; provider = 'ggml-master'; profile = 'edge'; asset = 'ENGINE_edge_11869.7z'; version = '0.7.0-dev'; sha256 = $sha; sizeBytes = 1; cuda = '13.4' },
    [pscustomobject]@{ build = 'b11869-d327bf1f'; provider = 'ggml-master'; profile = 'stable'; asset = 'ENGINE_stable_11869.7z'; version = '0.7.0-dev'; sha256 = $sha; sizeBytes = 1; cuda = '12.9' },
    [pscustomobject]@{ build = 'b11910-63b4b303'; provider = 'ggml-master'; profile = 'edge'; asset = 'ENGINE_edge_11910.7z'; version = '0.7.0-dev'; sha256 = $sha; sizeBytes = 1; cuda = '13.4' }
) }
$newEng = @(
    [pscustomobject]@{ build = 'b12017-5047748f'; provider = 'ggml-master'; profile = 'edge'; asset = 'ENGINE_edge_12017.7z'; version = '0.8.0-dev'; sha256 = $sha; sizeBytes = 1; cuda = '13.4' },
    [pscustomobject]@{ build = 'b12017-5047748f'; provider = 'ggml-master'; profile = 'stable'; asset = 'ENGINE_stable_12017.7z'; version = '0.8.0-dev'; sha256 = $sha; sizeBytes = 1; cuda = '12.9' }
)
$kept = @(Merge-EngineChannelEntries -Previous $prevEng -NewEntries $newEng -Retention 2)
Assert-True ($kept.Count -eq 3) 'two builds retained (b12017 pair + b11910 edge)'
Assert-True (($kept | Where-Object { $_.build -like 'b11869*' }).Count -eq 0) 'oldest build pruned'
Assert-True (($kept | Where-Object { $_.build -like 'b12017*' }).Count -eq 2) 'new build keeps both profiles'

# 4. manifest files
$dir = Join-Path $env:TEMP ('bw-relch-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir -Force | Out-Null
try {
    $appPath = Write-ChannelManifestFile -OutDir $dir -Tag app -Product 'Blackwell-Ops' -Latest $new -Releases $capped
    $doc = Get-Content -LiteralPath $appPath -Raw | ConvertFrom-Json
    Assert-True ($doc.schemaVersion -eq 1 -and $doc.channel -eq 'app') 'app manifest header'
    Assert-True ($doc.latest.asset -eq $new.asset -and $doc.releases.Count -eq 2) 'app manifest latest + history'
    Assert-True ($doc.latest.sha256.Length -eq 64) 'digest present'

    $engPath = Write-ChannelManifestFile -OutDir $dir -Tag engines -Engines $kept
    $engDoc = Get-Content -LiteralPath $engPath -Raw | ConvertFrom-Json
    Assert-True ($engDoc.channel -eq 'engines' -and $engDoc.engines.Count -eq 3) 'engine manifest'

    $body = New-ChannelReleaseBody -Channel (Get-ReleaseChannel -Tag app) -Latest $new -Releases $capped -Engines $null
    Assert-True ($body -match '## Retained' -and $body -match '1\.1\.13') 'release body'
    Assert-True (-not $body.TrimStart().StartsWith('#')) 'body does not repeat the release title'

    $engBody = New-ChannelReleaseBody -Channel (Get-ReleaseChannel -Tag engines) -Latest $null -Releases $null -Engines $kept
    Assert-True ($engBody -match '0\.8\.0-dev' -and $engBody -match 'b12017-5047748f') 'engine table keeps the llama version'
} finally {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'ALL CHANNEL HELPER CHECKS PASSED'
