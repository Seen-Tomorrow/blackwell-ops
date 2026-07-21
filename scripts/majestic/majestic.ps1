# Majestic - private release automation for Blackwell Ops.
# Usage: .\scripts\majestic\majestic.ps1 -Mode check|pack|ship|bump|pack-provider|ship-provider [-DryRun]

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('check', 'pack', 'ship', 'bump', 'ship-toolchain', 'pack-provider', 'ship-provider')]
    [string]$Mode,

    [ValidateSet('app', 'full')]
    [string]$Variant = 'full',

    # pack-provider / ship-provider
    [string]$ProviderId = '',
    [string]$ProfileId = '',

    [switch]$DryRun,

    # Skip YES prompts (bump / ship) - used by DEV Distribution panel
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $script_dir)
$config_path = Join-Path $script_dir 'majestic.config.json'
$enabled_path = Join-Path $script_dir '.majestic-enabled'
$lock_path = Join-Path $script_dir 'majestic.lock'
$out_root = Join-Path $root '.majestic-out'

. (Join-Path (Split-Path -Parent $script_dir) 'runtime-distribution.ps1')

function Write-Majestic {
    param(
        [string]$Message,
        [ConsoleColor]$Color = 'White'
    )
    Write-Host "[majestic] $Message" -ForegroundColor $Color
}

function Read-MajesticConfig {
    if (-not (Test-Path -LiteralPath $config_path)) {
        throw "Missing majestic.config.json at $config_path"
    }
    $cfg = Get-Content -LiteralPath $config_path -Raw | ConvertFrom-Json
    # Provider maps always come from scripts/distribution-policy.json (DEV app + scripts).
    Import-RuntimeDistributionPolicy

    $nsis_obj = New-Object PSObject
    foreach ($kv in $script:NsisCoreProviders.GetEnumerator()) {
        $nsis_obj | Add-Member -NotePropertyName $kv.Key -NotePropertyValue @($kv.Value) -Force
    }
    # providers = optional PLUGIN packs only (not NSIS core). Core engines ship inside Full Setup.
    $packs_obj = New-Object PSObject
    foreach ($kv in $script:OptionalDownloadProviders.GetEnumerator()) {
        $packs_obj | Add-Member -NotePropertyName $kv.Key -NotePropertyValue @($kv.Value) -Force
    }
    $cfg | Add-Member -NotePropertyName nsisProviders -NotePropertyValue $nsis_obj -Force
    $cfg | Add-Member -NotePropertyName providers -NotePropertyValue $packs_obj -Force
    return $cfg
}

function Get-TauriConfPath {
    Join-Path $root 'src-tauri\tauri.conf.json'
}

function Get-TauriDevConfPath {
    Join-Path $root 'src-tauri\tauri.conf.dev.json'
}

function Get-PackageJsonPath {
    Join-Path $root 'package.json'
}

function Get-CargoTomlPath {
    Join-Path $root 'src-tauri\Cargo.toml'
}

function Read-AppVersion {
    $tauri_conf = Get-TauriConfPath
    if (-not (Test-Path -LiteralPath $tauri_conf)) {
        throw "Missing tauri.conf.json"
    }
    (Get-Content -LiteralPath $tauri_conf -Raw | ConvertFrom-Json).version
}

function Get-BumpedPatchVersion {
    param([string]$Current)
    $parts = $Current.Split('.')
    $major = 0
    $minor = 0
    $patch = 0
    if ($parts.Length -ge 1 -and $parts[0] -match '^\d+$') { [void][int]::TryParse($parts[0], [ref]$major) }
    if ($parts.Length -ge 2 -and $parts[1] -match '^\d+$') { [void][int]::TryParse($parts[1], [ref]$minor) }
    if ($parts.Length -ge 3 -and $parts[2] -match '^\d+$') { [void][int]::TryParse($parts[2], [ref]$patch) }
    "$major.$minor.$($patch + 1)"
}

function Set-JsonFileVersion {
    param(
        [string]$Path,
        [string]$NewVersion
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing file: $Path"
    }
    $content = Get-Content -LiteralPath $Path -Raw
    $pattern = '("version"\s*:\s*")[^"]+(")'
    $match = [regex]::Match($content, $pattern)
    if (-not $match.Success) {
        throw "version field not found in $Path"
    }
    $updated = $content.Substring(0, $match.Index) +
        $match.Groups[1].Value + $NewVersion + $match.Groups[2].Value +
        $content.Substring($match.Index + $match.Length)
    [System.IO.File]::WriteAllText($Path, $updated)
}

function Set-CargoTomlVersion {
    param(
        [string]$Path,
        [string]$NewVersion
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing file: $Path"
    }
    $content = Get-Content -LiteralPath $Path -Raw
    $pattern = '(?m)^(version\s*=\s*")[^"]+(")'
    $match = [regex]::Match($content, $pattern)
    if (-not $match.Success) {
        throw "version field not found in $Path"
    }
    $updated = $content.Substring(0, $match.Index) +
        $match.Groups[1].Value + $NewVersion + $match.Groups[2].Value +
        $content.Substring($match.Index + $match.Length)
    [System.IO.File]::WriteAllText($Path, $updated)
}

function Get-TagName {
    param([string]$Version, [string]$Prefix)
    "$Prefix$Version"
}

function Get-FoundryArtifactsRoot {
    Join-Path $root 'src-tauri\target\debug\foundry\artifacts'
}

function Get-InstallerCandidates {
    param([string]$Version)
    $bundle_dir = Join-Path $root 'src-tauri\target\release\bundle\nsis'
    if (-not (Test-Path -LiteralPath $bundle_dir)) {
        return @()
    }
    Get-ChildItem -LiteralPath $bundle_dir -Filter '*.exe' -File |
        Where-Object { $_.Name -match 'Setup' -and $_.Name -like "*$Version*" } |
        Sort-Object LastWriteTime -Descending
}

function Get-AppUpdateArchiveFileName {
    param([string]$Version)
    "CORE_Blackwell-Ops-App-v$Version.7z"
}

function Get-ProviderPackArchiveFileName {
    param(
        [string]$ProviderId,
        [string]$ProfileId
    )
    $kind = if (Test-RuntimeNsisProvider -ProviderId $ProviderId) { 'CORE' } else { 'PLUGIN' }
    "${kind}_${ProviderId}-${ProfileId}.7z"
}

function Resolve-ProviderPackArchivePath {
    param(
        [string]$OutRoot,
        [string]$ProviderId,
        [string]$ProfileId
    )
    $canonical = Join-Path $OutRoot (Get-ProviderPackArchiveFileName -ProviderId $ProviderId -ProfileId $ProfileId)
    if (Test-Path -LiteralPath $canonical) { return $canonical }
    # Legacy unprefixed name (pre CORE_/PLUGIN_)
    $legacy = Join-Path $OutRoot "$ProviderId-$ProfileId.7z"
    if (Test-Path -LiteralPath $legacy) { return $legacy }
    return $canonical
}

function Get-ReleaseExePath {
    Join-Path $root 'src-tauri\target\release\blackwell-ops.exe'
}

function Get-AssertReleaseExeScript {
    Join-Path $root 'scripts\assert-release-exe.ps1'
}

function Get-AssertAppArchiveScript {
    Join-Path $root 'scripts\assert-app-archive.ps1'
}

function Clear-ReleaseBuildEnvironment {
    # DEV app / tauri dev can leave config merge vars in the process tree when
    # DISTRIBUTION spawns Pack. Those must never influence `tauri build`.
    $kill = @(
        'TAURI_CONFIG',
        'TAURI_ANDROID_PACKAGE_NAME',
        'TAURI_ANDROID_PACKAGE_NAME_PREFIX',
        'TAURI_DEV_HOST'
    )
    foreach ($name in $kill) {
        if (Test-Path "Env:$name") {
            Remove-Item "Env:$name" -ErrorAction SilentlyContinue
            Write-Majestic "Cleared env $name (DEV pollution guard)" -Color DarkGray
        }
    }
    $env:NODE_ENV = 'production'
}

function Assert-ReleaseExe {
    param(
        [string]$ExePath,
        [string]$ExpectedVersion
    )
    $script = Get-AssertReleaseExeScript
    if (-not (Test-Path -LiteralPath $script)) {
        throw "Missing assert script: $script"
    }
    & $script -ExePath $ExePath -ExpectedVersion $ExpectedVersion -ExpectedProductName 'Blackwell Ops'
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "assert-release-exe failed (exit $LASTEXITCODE)"
    }
}

function Assert-AppArchive {
    param(
        [string]$ArchivePath,
        [string]$ExpectedVersion
    )
    $script = Get-AssertAppArchiveScript
    if (-not (Test-Path -LiteralPath $script)) {
        throw "Missing assert script: $script"
    }
    & $script -ArchivePath $ArchivePath -ExpectedVersion $ExpectedVersion -ExpectedProductName 'Blackwell Ops'
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "assert-app-archive failed (exit $LASTEXITCODE)"
    }
}

function Invoke-ForceReleasePackageClean {
    # VERSIONINFO / productName can stick across conf switches if only source is "unchanged".
    # Drop crate release artifacts so the next tauri build re-embeds identity from tauri.conf.json.
    $manifest = Join-Path $root 'src-tauri\Cargo.toml'
    Write-Majestic "Forcing clean release package rebuild (cargo clean -p blackwell-ops --release)..." -Color Cyan
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        cargo clean -p blackwell-ops --release --manifest-path $manifest 2>&1 | ForEach-Object {
            if ($_ -and "$_".Trim().Length -gt 0) { Write-Host $_ }
        }
    } finally {
        $ErrorActionPreference = $prev
    }
    $exe = Get-ReleaseExePath
    if (Test-Path -LiteralPath $exe) {
        Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
        Write-Majestic "Removed stale release exe before rebuild" -Color DarkGray
    }
}

function Get-PackKindLabel {
    param([string]$Kind)
    if ($Kind -eq 'app') { 'App update (7z)' } else { 'Full Bundle (NSIS + packs)' }
}

function Get-ReleaseNotesForVariant {
    param(
        $Config,
        [string]$Variant
    )
    if ($Variant -eq 'app') {
        if ($Config.ship.appOnlyReleaseNotes) {
            return [string]$Config.ship.appOnlyReleaseNotes
        }
    } elseif ($Variant -eq 'provider') {
        if ($Config.ship.providerReleaseNotes) {
            return [string]$Config.ship.providerReleaseNotes
        }
    } else {
        if ($Config.ship.fullBundleReleaseNotes) {
            return [string]$Config.ship.fullBundleReleaseNotes
        }
    }
    return [string]$Config.ship.releaseNotes
}

function Write-GhReleaseNotesFile {
    param([string]$Notes)
    if (-not (Test-Path -LiteralPath $out_root)) {
        New-Item -ItemType Directory -Path $out_root -Force | Out-Null
    }
    $path = Join-Path $out_root 'release-notes-body.md'
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($path, $Notes, $utf8NoBom)
    return $path
}

function Invoke-PrepareReleaseBundle {
    param([string]$Variant)
    $script_path = if ($Variant -eq 'app') {
        Join-Path $root 'scripts\prepare-release-app-only.ps1'
    } else {
        Join-Path $root 'scripts\prepare-release-runtime.ps1'
    }
    if (-not (Test-Path -LiteralPath $script_path)) {
        throw "Missing bundle script: $script_path"
    }
    Write-Majestic "Preparing runtime-bundle ($Variant)..." -Color Cyan
    & $script_path
    if ($LASTEXITCODE -ne 0) {
        throw "Bundle prep failed: $script_path"
    }
}

function Invoke-FrontendAndTauriBuild {
    param([string]$Variant)
    Push-Location $root
    try {
        Clear-ReleaseBuildEnvironment
        $version = Read-AppVersion
        Write-Majestic "Build target version $version | conf: tauri.conf.json only (never conf.dev)" -Color Cyan
        Invoke-ForceReleasePackageClean

        if ($Variant -eq 'app') {
            Write-Majestic "Building frontend + release exe (no NSIS, no engine mirror)..." -Color Cyan
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
            # Lean App pack: PE only - NSIS is Full Bundle path.
            # Do NOT pass -c/--config (would merge conf.dev and ship "Blackwell Ops DEV").
            npx tauri build --no-bundle
            if ($LASTEXITCODE -ne 0) { throw "tauri build --no-bundle failed with exit code $LASTEXITCODE" }
        } else {
            Write-Majestic "Running npm run release (mirror -> bundle -> NSIS)..." -Color Cyan
            npm run release
            if ($LASTEXITCODE -ne 0) { throw "npm run release failed with exit code $LASTEXITCODE" }
        }

        $exe = Get-ReleaseExePath
        if (-not (Test-Path -LiteralPath $exe)) {
            throw "Release exe missing after build: $exe"
        }
        Assert-ReleaseExe -ExePath $exe -ExpectedVersion $version
        Write-Majestic "Release PE identity verified (Blackwell Ops v$version)" -Color Green
    } finally {
        Pop-Location
    }
}

function Invoke-PackAppUpdateArchive {
    param(
        [string]$Version,
        [string]$OutRoot
    )
    $out_path = Join-Path $OutRoot (Get-AppUpdateArchiveFileName -Version $Version)
    $pack_script = Join-Path $root 'scripts\pack-app-update.ps1'
    $exe = Get-ReleaseExePath
    if (-not (Test-Path -LiteralPath $exe)) {
        throw "Release exe missing after build: $exe"
    }
    # Gate before 7z - never stage a DEV / wrong-version PE.
    Assert-ReleaseExe -ExePath $exe -ExpectedVersion $Version
    Write-Majestic "Packing lean App update .7z..." -Color Cyan
    # Swallow ALL nested streams. Native 7z + Write-Host can pollute the success stream;
    # assignment then feeds empty lines into Get-Item -LiteralPath and dies.
    $pack_log = & $pack_script -Version $Version -Output $out_path -ExePath $exe *>&1
    $pack_exit = $LASTEXITCODE
    foreach ($line in @($pack_log)) {
        if ($null -ne $line -and "$line".Length -gt 0) {
            Write-Host $line
        }
    }
    if ($pack_exit -ne 0) {
        throw "pack-app-update.ps1 failed (exit $pack_exit)"
    }
    if (-not (Test-Path -LiteralPath $out_path)) {
        throw "App update archive not created: $out_path"
    }
    # Gate after 7z - archive must embed the same REL PE (tag/name alone is not enough).
    Assert-AppArchive -ArchivePath $out_path -ExpectedVersion $Version
    $size_mb = [math]::Round((Get-Item -LiteralPath $out_path).Length / 1MB, 2)
    Write-Majestic "App update staged: $(Split-Path -Leaf $out_path) ($size_mb MB)" -Color Green
    # Single string only - never an Object[] of 7z chatter
    return [string]$out_path
}

function Invoke-PackProviderArchives {
    param([string]$OutRoot)
    $pack_script = Join-Path $root 'scripts\pack-provider-runtime.ps1'
    Write-Majestic "Packing provider runtime .7z archives..." -Color Cyan
    $pack_log = & $pack_script -OutDir $OutRoot *>&1
    $pack_exit = $LASTEXITCODE
    foreach ($line in @($pack_log)) {
        if ($null -ne $line -and "$line".Length -gt 0) {
            Write-Host $line
        }
    }
    if ($pack_exit -ne 0) {
        throw "pack-provider-runtime.ps1 failed (exit $pack_exit)"
    }
}

function Stage-InstallerForVariant {
    param(
        [string]$Version,
        [string]$Variant,
        [string]$OutRoot
    )
    if ($Variant -eq 'app') {
        throw "Stage-InstallerForVariant is for Full Bundle only - use Invoke-PackAppUpdateArchive"
    }
    $installers = Get-InstallerCandidates -Version $Version
    if ($installers.Count -eq 0) {
        throw "Installer not found after build. Expected under src-tauri/target/release/bundle/nsis/"
    }
    $installer = $installers[0]
    # CORE_ prefix so release assets are clearly full-install vs plugins.
    $core_name = if ($installer.Name -like 'CORE_*') { $installer.Name } else { "CORE_$($installer.Name)" }
    $dest_installer = Join-Path $OutRoot $core_name
    Copy-Item -LiteralPath $installer.FullName -Destination $dest_installer -Force
    Write-Majestic "Full installer staged: $core_name" -Color Green
    return $dest_installer
}

function Test-ProfileArtifact {
    param(
        [string]$ProviderId,
        [string]$ProfileId
    )
    $server = Join-Path (Get-FoundryArtifactsRoot) "$ProviderId\$ProfileId\Release\llama-server.exe"
    [PSCustomObject]@{
        Provider = $ProviderId
        Profile  = $ProfileId
        Path     = $server
        Ready    = Test-Path -LiteralPath $server
    }
}

function Get-ProviderProfileRows {
    param(
        $MapObject
    )
    $rows = @()
    if ($null -eq $MapObject) { return $rows }
    foreach ($prop in $MapObject.PSObject.Properties) {
        $provider_id = $prop.Name
        foreach ($profile_id in @($prop.Value)) {
            $rows += [PSCustomObject]@{
                Provider = $provider_id
                Profile  = $profile_id
            }
        }
    }
    $rows
}

# NSIS Full installer engines only (ggml-master by policy).
function Get-NsisRequiredProfiles {
    param($Config)
    if ($null -ne $Config.PSObject.Properties['nsisProviders'] -and $null -ne $Config.nsisProviders) {
        return Get-ProviderProfileRows -MapObject $Config.nsisProviders
    }
    # Legacy: fall back to full providers map
    return Get-ProviderProfileRows -MapObject $Config.providers
}

# Optional plugin packs + any provider listed for selective .7z shipping.
function Get-ProviderPackProfiles {
    param($Config)
    return Get-ProviderProfileRows -MapObject $Config.providers
}

function Invoke-MajesticCheck {
    param(
        $Config,
        [string]$Variant = 'full'
    )

    $version = Read-AppVersion
    $tag = Get-TagName -Version $version -Prefix $Config.tagPrefix
    $nsis_required = Get-NsisRequiredProfiles -Config $Config
    $pack_profiles = Get-ProviderPackProfiles -Config $Config
    $kind_label = Get-PackKindLabel -Kind $Variant

    Write-Majestic "Version $version  |  tag $tag  |  repo $($Config.repo)" -Color Cyan
    Write-Majestic "Mode: CHECK ($kind_label) (read-only)" -Color DarkGray

    $missing_artifacts = @()
    if ($Variant -eq 'full') {
        Write-Majestic "NSIS core engines (must be ready):" -Color Cyan
        $artifact_rows = foreach ($row in $nsis_required) {
            Test-ProfileArtifact -ProviderId $row.Provider -ProfileId $row.Profile
        }

        $missing_artifacts = @($artifact_rows | Where-Object { -not $_.Ready })
        if ($missing_artifacts.Count -eq 0) {
            Write-Majestic "Foundry artifacts (NSIS): all $($artifact_rows.Count) profile(s) ready." -Color Green
        } else {
            Write-Majestic "Foundry artifacts (NSIS): $($missing_artifacts.Count) missing - build in Foundry first." -Color Red
            foreach ($m in $missing_artifacts) {
                Write-Majestic "  - $($m.Provider)/$($m.Profile)" -Color Red
            }
        }

        $runtime_root = Join-Path $root 'src-tauri\runtime'
        foreach ($row in $nsis_required) {
            $runtime_server = Join-Path $runtime_root "$($row.Provider)\$($row.Profile)\llama-server.exe"
            $label = "NSIS $($row.Provider)/$($row.Profile) runtime mirror"
            if (Test-Path -LiteralPath $runtime_server) {
                Write-Majestic "$label : ok" -Color Green
            } else {
                Write-Majestic "$label : missing (pack will mirror)" -Color Yellow
            }
        }

        Write-Majestic "Optional plugin packs (warn only if missing):" -Color Cyan
        foreach ($row in $pack_profiles) {
            $is_nsis = $false
            foreach ($n in $nsis_required) {
                if ($n.Provider -eq $row.Provider -and $n.Profile -eq $row.Profile) { $is_nsis = $true; break }
            }
            if ($is_nsis) { continue }
            $art = Test-ProfileArtifact -ProviderId $row.Provider -ProfileId $row.Profile
            $label = "plugin $($row.Provider)/$($row.Profile)"
            if ($art.Ready) {
                Write-Majestic "$label : ready to pack" -Color Green
            } else {
                Write-Majestic "$label : missing (skip on pack unless Foundry-built)" -Color Yellow
            }
        }
    } else {
        Write-Majestic "App-Only: skipping Foundry artifact checks." -Color DarkGray
        $runtime_root = Join-Path $root 'src-tauri\runtime'
        $template_ok = $true
        # Core NSIS provider templates must exist; optional plugins only need factory JSON for catalog.
        $core_ids = @($nsis_required | ForEach-Object { $_.Provider } | Select-Object -Unique)
        foreach ($provider_id in $core_ids) {
            $template = Join-Path $runtime_root "$provider_id\config\$provider_id-default-config.json"
            if (Test-Path -LiteralPath $template) {
                Write-Majestic "Core template $provider_id : ok" -Color Green
            } else {
                Write-Majestic "Core template $provider_id : MISSING ($template)" -Color Red
                $template_ok = $false
            }
        }
        foreach ($prop in $Config.providers.PSObject.Properties) {
            $provider_id = $prop.Name
            if ($core_ids -contains $provider_id) { continue }
            $template = Join-Path $runtime_root "$provider_id\config\$provider_id-default-config.json"
            if (Test-Path -LiteralPath $template) {
                Write-Majestic "Plugin template $provider_id : ok (catalog)" -Color Green
            } else {
                Write-Majestic "Plugin template $provider_id : missing (catalog entry skipped until promoted)" -Color Yellow
            }
        }
        if (-not $template_ok) {
            $missing_artifacts = @([PSCustomObject]@{ Provider = 'templates'; Profile = 'config' })
        }
    }

    if ($Variant -eq 'app') {
        $exe = Get-ReleaseExePath
        if (Test-Path -LiteralPath $exe) {
            $age_min = [math]::Round(((Get-Date) - (Get-Item -LiteralPath $exe).LastWriteTime).TotalMinutes, 1)
            Write-Majestic "Release exe: $exe - $age_min minutes old" -Color Green
        } else {
            Write-Majestic "Release exe: not built yet (pack will build --no-bundle)" -Color Yellow
        }
    } else {
        $installers = Get-InstallerCandidates -Version $version
        if ($installers.Count -gt 0) {
            $latest = $installers[0]
            $age_min = [math]::Round(((Get-Date) - $latest.LastWriteTime).TotalMinutes, 1)
            Write-Majestic "Installer: $($latest.FullName) - $age_min minutes old" -Color Green
        } else {
            Write-Majestic "Installer: not built yet (pack will build)" -Color Yellow
        }
    }

    if (Get-Command gh -ErrorAction SilentlyContinue) {
        $gh_user = gh auth status 2>&1 | Select-String 'Logged in to github.com account' | ForEach-Object { $_.Line.Trim() }
        if ($gh_user) {
            Write-Majestic "GitHub CLI: $gh_user" -Color Green
        } else {
            Write-Majestic "GitHub CLI: installed but not logged in (run: gh auth login)" -Color Yellow
        }
    } else {
        Write-Majestic "GitHub CLI: gh not found - install for ship step" -Color Yellow
    }

    $tag_exists = $false
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Push-Location $root
        try {
            $tag_exists = [bool](git tag -l $tag 2>$null)
        } finally {
            Pop-Location
        }
        if ($tag_exists) {
            Write-Majestic "Git tag $tag already exists locally." -Color Yellow
        } else {
            Write-Majestic "Git tag $tag not created yet." -Color DarkGray
        }
    }

    if (Test-Path -LiteralPath $enabled_path) {
        Write-Majestic "Ship unlock: ON (.majestic-enabled present)" -Color Green
    } else {
        Write-Majestic "Ship unlock: OFF - create scripts/majestic/.majestic-enabled before ship" -Color Yellow
    }

    $ready = ($missing_artifacts.Count -eq 0)
    if ($ready) {
        Write-Majestic "READY TO PACK ($kind_label)." -Color Green
    } else {
        if ($Variant -eq 'app') {
            Write-Majestic "NOT READY - fix provider template JSONs under src-tauri/runtime/*/config/." -Color Red
        } else {
            Write-Majestic "NOT READY - finish Foundry builds first." -Color Red
        }
    }
    return $ready
}

function Test-InstallerFresh {
    param(
        $Config,
        [string]$Version
    )
    if (-not $Config.pack.skipBuildIfInstallerFresh) {
        return $false
    }
    $installers = Get-InstallerCandidates -Version $Version
    if ($installers.Count -eq 0) {
        return $false
    }
    $age = ((Get-Date) - $installers[0].LastWriteTime).TotalMinutes
    return $age -le [double]$Config.pack.installerMaxAgeMinutes
}

function Get-Sha256Hex {
    param([string]$Path)
    if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function New-ManifestEntry {
    param([System.IO.FileInfo]$File)
    $hash = Get-Sha256Hex -Path $File.FullName
    [PSCustomObject]@{
        name   = $File.Name
        path   = $File.FullName
        bytes  = $File.Length
        sha256 = $hash
    }
}

function Invoke-MajesticPack {
    param(
        $Config,
        [string]$Variant = 'full'
    )

    $kind_label = Get-PackKindLabel -Kind $Variant
    Write-Majestic "PACK ($kind_label)" -Color Cyan

    $ready = Invoke-MajesticCheck -Config $Config -Variant $Variant
    if (-not $ready) {
        throw "Check failed - fix prerequisites before pack ($kind_label)."
    }

    $version = Read-AppVersion
    $tag = Get-TagName -Version $version -Prefix $Config.tagPrefix

    if (Test-Path -LiteralPath $out_root) {
        Remove-Item -LiteralPath $out_root -Recurse -Force
    }
    New-Item -ItemType Directory -Path $out_root -Force | Out-Null

    $skip_build = ($Variant -eq 'full') -and (Test-InstallerFresh -Config $Config -Version $version)
    if ($skip_build) {
        Write-Majestic "Installer is fresh - skipping full release build (will still refresh App .7z)." -Color Yellow
        # Still require a correct REL PE for the App archive - never pack a stale/DEV binary.
        if (-not $DryRun) {
            $exe = Get-ReleaseExePath
            if (-not (Test-Path -LiteralPath $exe)) {
                Write-Majestic "Release exe missing during skip-build - forcing full rebuild." -Color Yellow
                $skip_build = $false
            } else {
                try {
                    Assert-ReleaseExe -ExePath $exe -ExpectedVersion $version
                } catch {
                    Write-Majestic "Skip-build PE failed identity check - forcing full rebuild. $_" -Color Yellow
                    $skip_build = $false
                }
            }
        }
    }
    if ($skip_build) {
        # already validated above
    } elseif ($DryRun) {
        if ($Variant -eq 'app') {
            Write-Majestic "[dry-run] would run: clean + prepare-release-app-only + npm run build + tauri build --no-bundle + PE assert + pack-app-update.ps1" -Color Cyan
        } else {
            Write-Majestic "[dry-run] would run: clean + npm run release + PE assert + pack-app-update" -Color Cyan
        }
    } else {
        if ($Variant -eq 'full') {
            Invoke-FrontendAndTauriBuild -Variant $Variant
        } else {
            Invoke-PrepareReleaseBundle -Variant $Variant
            Invoke-FrontendAndTauriBuild -Variant $Variant
        }
    }

    if (-not $DryRun) {
        if ($Variant -eq 'full') {
            $installers = Get-InstallerCandidates -Version $version
            if ($installers.Count -eq 0) {
                throw "Installer not found after build. Expected under src-tauri/target/release/bundle/nsis/"
            }
        } else {
            if (-not (Test-Path -LiteralPath (Get-ReleaseExePath))) {
                throw "Release exe not found after build: $(Get-ReleaseExePath)"
            }
        }
        # Final gate: release PE must match version files before any staging.
        Assert-ReleaseExe -ExePath (Get-ReleaseExePath) -ExpectedVersion $version
    }

    $bundle_root = Join-Path $root 'src-tauri\runtime-bundle'
    if (-not (Test-Path -LiteralPath $bundle_root)) {
        if ($DryRun) {
            Write-Majestic "[dry-run] runtime-bundle missing - bundle prep would run during pack" -Color Yellow
        } else {
            throw "runtime-bundle/ missing. Bundle prep step may have failed."
        }
    }

    $manifest_files = @()

    if ($DryRun) {
        Write-Majestic "[dry-run] would stage $(Get-AppUpdateArchiveFileName -Version $version)" -Color Cyan
        if ($Variant -eq 'full') {
            Write-Majestic "[dry-run] would stage CORE only: App .7z + Full NSIS (ggml-master inside). PLUGIN packs are manual (pack-provider)." -Color Cyan
        }
    } else {
        # Always stage lean App update for both daily app pack and weekly full pack
        if ($Variant -eq 'app') {
            # app pack already prepared templates-only bundle
        } elseif ($Variant -eq 'full') {
            # Full release used prepare-release-runtime (engines). Rebuild app-only bundle for App .7z
            # so the lean archive never embeds engine binaries.
            Invoke-PrepareReleaseBundle -Variant 'app'
        }

        $app_archive = Invoke-PackAppUpdateArchive -Version $version -OutRoot $out_root
        # Unwrap accidental multi-object capture; require a real path string
        if ($app_archive -is [array]) {
            $app_archive = @($app_archive | Where-Object { $_ -is [string] -and $_ } | Select-Object -Last 1)[0]
        }
        if ([string]::IsNullOrWhiteSpace([string]$app_archive)) {
            throw "App update pack returned empty path (internal PowerShell capture bug)."
        }
        $app_archive = [string]$app_archive
        if (-not (Test-Path -LiteralPath $app_archive)) {
            throw "App update archive missing after pack: $app_archive"
        }
        $manifest_files += New-ManifestEntry -File (Get-Item -LiteralPath $app_archive)

        if ($Variant -eq 'full') {
            # NSIS needs full runtime-bundle (app + ggml-master engines) for the installer build artifacts.
            Invoke-PrepareReleaseBundle -Variant 'full'
            $dest_installer = Stage-InstallerForVariant -Version $version -Variant 'full' -OutRoot $out_root
            $manifest_files += New-ManifestEntry -File (Get-Item -LiteralPath $dest_installer)

            # Full = CORE assets only (App .7z + Setup with Master). PLUGIN packs are manual
            # via DISTRIBUTION Pack+Ship per provider - not attached on weekly Full.
            Write-Majestic "PLUGIN packs: skipped on Full pack (use Pack+Ship per plugin when needed)" -Color DarkGray
        }
    }

    if (-not $DryRun) {
        $manifest = [PSCustomObject]@{
            version   = $version
            tag       = $tag
            packKind  = $Variant
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
            repo      = $Config.repo
            files     = $manifest_files
        }
        $manifest_path = Join-Path $out_root "manifest-$tag.json"
        $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest_path -Encoding UTF8
        Write-Majestic "Manifest: $manifest_path ($($manifest_files.Count) asset(s))" -Color Cyan
        Write-Majestic "PACK DONE - output in .majestic-out/" -Color Green
    } else {
        Write-Majestic "[dry-run] PACK complete (no files written)" -Color Cyan
    }
}

function Invoke-MajesticBump {
    $current = Read-AppVersion
    $newVersion = Get-BumpedPatchVersion -Current $current
    $tag = Get-TagName -Version $newVersion -Prefix (Read-MajesticConfig).tagPrefix

    Write-Majestic "Bump patch version: $current -> $newVersion (tag will be $tag)" -Color Cyan
    Write-Majestic "Updates: tauri.conf.json + tauri.conf.dev.json + package.json + Cargo.toml" -Color DarkGray

    if ($DryRun) {
        Write-Majestic "[dry-run] would bump version to $newVersion" -Color Yellow
        return
    }

    if (-not $Force) {
        $confirm = Read-Host "Type YES to bump to $newVersion"
        if ($confirm -ne 'YES') {
            Write-Majestic "Bump cancelled." -Color Yellow
            return
        }
    } else {
        Write-Majestic "Force: bumping to $newVersion without prompt" -Color DarkGray
    }

    Set-JsonFileVersion -Path (Get-TauriConfPath) -NewVersion $newVersion
    Set-JsonFileVersion -Path (Get-TauriDevConfPath) -NewVersion $newVersion
    Set-JsonFileVersion -Path (Get-PackageJsonPath) -NewVersion $newVersion
    Set-CargoTomlVersion -Path (Get-CargoTomlPath) -NewVersion $newVersion

    $old_tag = Get-TagName -Version $current -Prefix (Read-MajesticConfig).tagPrefix
    Push-Location $root
    try {
        $prev_eap = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        git tag -d $old_tag 2>$null | Out-Null
        $ErrorActionPreference = $prev_eap
        if ($LASTEXITCODE -eq 0) {
            Write-Majestic "Removed stale local tag $old_tag" -Color DarkGray
        }
    } finally {
        Pop-Location
    }

    Write-Majestic "Version bumped to $newVersion" -Color Green
    Write-Majestic "Next: pack (rebuild installer) then ship." -Color Cyan
}

function Assert-ShipUnlocked {
    if (-not (Test-Path -LiteralPath $enabled_path)) {
        throw @"
Ship is locked. Create the unlock file first:
  New-Item -ItemType File -Path scripts/majestic/.majestic-enabled -Force
"@
    }
}

function Get-GhReleaseView {
    param(
        [string]$Tag,
        [string]$Repo
    )

    # gh writes "release not found" to stderr - must not throw under $ErrorActionPreference Stop
    $prev_eap = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $json = gh release view $Tag --repo $Repo --json isImmutable,assets 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) {
            return $null
        }
        return ($json | ConvertFrom-Json)
    } finally {
        $ErrorActionPreference = $prev_eap
    }
}

function New-GhReleaseWithAssets {
    param(
        [string]$Tag,
        [string]$Repo,
        [string]$Notes,
        [string[]]$Assets
    )

    # Notes via UTF-8 file - avoids mojibake from --notes on Windows consoles
    $notes_file = Write-GhReleaseNotesFile -Notes $Notes
    $gh_args = @(
        'release', 'create', $Tag,
        '--repo', $Repo,
        '--title', $Tag,
        '--notes-file', $notes_file
    ) + $Assets

    $prev_eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & gh @gh_args 2>&1 | Out-String
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output   = $output.Trim()
        }
    } finally {
        $ErrorActionPreference = $prev_eap
    }
}

function Throw-GhReleaseCreateFailed {
    param(
        [string]$Tag,
        [string]$Repo,
        [string]$GhOutput
    )

    if ($GhOutput -match 'tag_name was used by an immutable release' -or
        $GhOutput -match 'Cannot create ref due to creations being restricted') {
        throw @"
Cannot ship $Tag - GitHub permanently reserved this tag name after a prior immutable release.
Deleting the release does not free the tag. Disabling immutability in settings does not help.

Fix:
  npm run majestic:bump          # e.g. 1.0.5 -> 1.0.6 (also drops the stale local tag)
  npm run majestic:pack
  npm run majestic:ship

GitHub output:
$GhOutput
"@
    }

    throw "gh release create failed:`n$GhOutput"
}

function Throw-ImmutableReleaseBlocked {
    param(
        [string]$Tag,
        [string]$Repo,
        [int]$AssetCount
    )

    $reason = if ($AssetCount -eq 0) {
        'was published with no assets'
    } else {
        'is locked and assets cannot be replaced'
    }

    throw @"
GitHub release $Tag $reason. Immutable releases stay locked even after you disable release immutability in repo settings.

Fix:
  1. Delete the broken release:  gh release delete $Tag --repo $Repo --cleanup-tag --yes
  2. GitHub does not allow reusing a tag from a deleted immutable release - bump patch:  npm run majestic:bump
  3. majestic:pack, then majestic:ship on the new version

Future ships use 'gh release create <tag> <assets...>' so assets attach before publish.
"@
}

function Invoke-MajesticShip {
    param($Config)

    Assert-ShipUnlocked

    if (Test-Path -LiteralPath $lock_path) {
        throw "Ship lock present ($lock_path). Another ship may be in progress - delete lock if stale."
    }

    $version = Read-AppVersion
    $tag = Get-TagName -Version $version -Prefix $Config.tagPrefix
    $manifest_path = Join-Path $out_root "manifest-$tag.json"

    if (-not (Test-Path -LiteralPath $manifest_path)) {
        throw "No manifest for $tag. Run: npm run majestic:pack"
    }

    $manifest = Get-Content -LiteralPath $manifest_path -Raw | ConvertFrom-Json
    $pack_kind = if ($manifest.PSObject.Properties.Name -contains 'packKind') {
        [string]$manifest.packKind
    } else {
        'full'
    }

    $assets = @()
    foreach ($entry in @($manifest.files)) {
        if (-not (Test-Path -LiteralPath $entry.path)) { continue }
        $leaf = Split-Path -Leaf $entry.path
        # Full pack/ship = CORE only (App + NSIS). Never re-upload PLUGIN leftover files.
        if ($pack_kind -eq 'full') {
            $is_core = ($leaf -like 'CORE_*') -or
                ($leaf -like '*Blackwell-Ops-App*') -or
                ($leaf -like '*Setup*.exe' -and $leaf -notlike '*App*')
            if (-not $is_core) {
                Write-Majestic "Ship full: skipping non-CORE asset $leaf (pack plugins separately)" -Color DarkGray
                continue
            }
        } elseif ($pack_kind -eq 'app') {
            $is_app = ($leaf -like 'CORE_*Blackwell-Ops-App*') -or
                ($leaf -like 'Blackwell-Ops-App*') -or
                ($leaf -like '*Blackwell-Ops-App*')
            if (-not $is_app) {
                Write-Majestic "Ship app: skipping non-App asset $leaf" -Color DarkGray
                continue
            }
        }
        $assets += $entry.path
    }
    if ($assets.Count -eq 0) {
        throw "No staged assets in .majestic-out/ for $tag (packKind=$pack_kind)"
    }

    # Never upload an App .7z whose embedded PE is DEV or wrong version (the historic off-by-one).
    Write-Majestic "Verifying staged App archive PE identity before upload..." -Color Cyan
    $app_assets = @($assets | Where-Object {
        $n = Split-Path -Leaf $_
        ($n -like '*Blackwell-Ops-App*.7z') -or ($n -like '*Blackwell-Ops-App*.zip')
    })
    if ($app_assets.Count -eq 0 -and ($pack_kind -eq 'app' -or $pack_kind -eq 'full')) {
        throw "Ship ${pack_kind}: no App .7z among staged assets - refuse upload (would publish incomplete release)."
    }
    foreach ($app_asset in $app_assets) {
        Assert-AppArchive -ArchivePath $app_asset -ExpectedVersion $version
    }
    if ($app_assets.Count -gt 0) {
        Write-Majestic ("App archive PE identity OK for v{0} ({1} file(s))" -f $version, $app_assets.Count) -Color Green
    }

    Write-Majestic "About to ship $tag to $($Config.repo) (packKind=$pack_kind)" -Color Cyan
    Write-Majestic "Assets:" -Color Cyan
    foreach ($asset in $assets) {
        Write-Majestic "  - $asset" -Color DarkGray
    }

    if ($DryRun) {
        Write-Majestic "[dry-run] would create GitHub release $tag and upload $($assets.Count) asset(s)" -Color Yellow
        return
    }

    if (-not $Force) {
        $confirm = Read-Host "Type YES to ship $tag"
        if ($confirm -ne 'YES') {
            Write-Majestic "Ship cancelled." -Color Yellow
            return
        }
    } else {
        Write-Majestic "Force: shipping $tag without prompt" -Color DarkGray
    }

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "GitHub CLI (gh) is required for ship. Install: https://cli.github.com/"
    }

    New-Item -ItemType File -Path $lock_path -Force | Out-Null
    try {
        Push-Location $root

        $tag_exists = [bool](git tag -l $tag 2>$null)
        if (-not $tag_exists) {
            Write-Majestic "Creating local git tag $tag on current commit..." -Color Cyan
            git tag -a $tag -m "Release $tag"
        } else {
            Write-Majestic "Local git tag $tag already exists - reusing." -Color DarkGray
        }

        if ($Config.ship.pushTag) {
            Write-Majestic "Pushing tag $tag to origin..." -Color Cyan
            git push origin $tag
        } else {
            Write-Majestic "pushTag=false - skipping git push (gh release still creates GitHub tag)." -Color DarkGray
        }

        $release_meta = Get-GhReleaseView -Tag $tag -Repo $Config.repo

        $pack_kind = if ($manifest.PSObject.Properties.Name -contains 'packKind') {
            [string]$manifest.packKind
        } else {
            'full'
        }
        $release_notes = Get-ReleaseNotesForVariant -Config $Config -Variant $pack_kind

        if ($null -eq $release_meta) {
            Write-Majestic "Creating GitHub release $tag ($pack_kind) with $($assets.Count) asset(s)..." -Color Cyan
            $create_result = New-GhReleaseWithAssets -Tag $tag -Repo $Config.repo -Notes $release_notes -Assets $assets
            if ($create_result.ExitCode -ne 0) {
                Throw-GhReleaseCreateFailed -Tag $tag -Repo $Config.repo -GhOutput $create_result.Output
            }
        } elseif ($release_meta.isImmutable) {
            $asset_count = @($release_meta.assets).Count
            Throw-ImmutableReleaseBlocked -Tag $tag -Repo $Config.repo -AssetCount $asset_count
        } else {
            Write-Majestic "Release $tag exists (mutable) - uploading $($assets.Count) asset(s)..." -Color Cyan
            gh release upload $tag --repo $Config.repo --clobber @assets
            if ($LASTEXITCODE -ne 0) {
                throw "gh release upload failed"
            }
            # Refresh body so a later full ship does not leave stale App-only notes (and vice versa)
            Write-Majestic "Updating release notes for packKind=$pack_kind..." -Color DarkGray
            $notes_file = Write-GhReleaseNotesFile -Notes $release_notes
            gh release edit $tag --repo $Config.repo --notes-file $notes_file
            if ($LASTEXITCODE -ne 0) {
                Write-Majestic "Warning: assets uploaded but release notes edit failed" -Color Yellow
            }
        }

        Write-Majestic "SHIPPED $tag - https://github.com/$($Config.repo)/releases/tag/$tag" -Color Green
    } finally {
        Pop-Location
        if (Test-Path -LiteralPath $lock_path) {
            Remove-Item -LiteralPath $lock_path -Force
        }
    }
}

$config = Read-MajesticConfig

function Invoke-MajesticShipToolchain {
    param($Config)

    Assert-ShipUnlocked

    $archive = Join-Path $root 'work\toolchain.7z'
    if (-not (Test-Path -LiteralPath $archive)) {
        throw "Missing work\toolchain.7z - run menu 11 TOOLCHAIN (or npm run majestic:toolchain) first."
    }

    $tag = 'toolchain'
    $size_mb = [math]::Round((Get-Item -LiteralPath $archive).Length / 1MB, 1)
    Write-Majestic "About to upload toolchain.7z ($size_mb MB) to tag '$tag' on $($Config.repo)" -Color Cyan

    if ($DryRun) {
        Write-Majestic "[dry-run] would upload $archive to release $tag" -Color Yellow
        return
    }

    if (-not $Force) {
        $confirm = Read-Host "Type YES to ship toolchain.7z"
        if ($confirm -ne 'YES') {
            Write-Majestic "Ship cancelled." -Color Yellow
            return
        }
    } else {
        Write-Majestic "Force: shipping toolchain.7z without prompt" -Color DarkGray
    }

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "GitHub CLI (gh) is required. Install: https://cli.github.com/"
    }

    $release_meta = Get-GhReleaseView -Tag $tag -Repo $Config.repo
    $notes = "Portable Foundry toolchain (CUDA + VS/SDK/CMake). Extract via in-app Config -> Foundry Toolchain."
    if ($null -eq $release_meta) {
        Write-Majestic "Creating GitHub release $tag with toolchain.7z..." -Color Cyan
        $create_result = New-GhReleaseWithAssets -Tag $tag -Repo $Config.repo -Notes $notes -Assets @($archive)
        if ($create_result.ExitCode -ne 0) {
            throw "gh release create failed:`n$($create_result.Output)"
        }
    } elseif ($release_meta.isImmutable) {
        throw "Release $tag is immutable - delete it on GitHub or use a new tag before re-uploading."
    } else {
        Write-Majestic "Release $tag exists - uploading toolchain.7z (clobber)..." -Color Cyan
        gh release upload $tag --repo $Config.repo --clobber $archive
        if ($LASTEXITCODE -ne 0) {
            throw "gh release upload failed"
        }
    }

    Write-Majestic "SHIPPED toolchain - https://github.com/$($Config.repo)/releases/tag/$tag" -Color Green
}

function Invoke-MajesticPackProvider {
    param(
        $Config,
        [string]$ProviderId,
        [string]$ProfileId
    )
    if ([string]::IsNullOrWhiteSpace($ProviderId) -or [string]::IsNullOrWhiteSpace($ProfileId)) {
        throw "pack-provider requires -ProviderId and -ProfileId (e.g. bee-llama frontier)"
    }
    $version = Read-AppVersion
    $tag = Get-TagName -Version $version -Prefix $Config.tagPrefix
    Write-Majestic "PACK PROVIDER $ProviderId/$ProfileId (tag $tag)" -Color Cyan

    if (-not (Test-Path -LiteralPath $out_root)) {
        New-Item -ItemType Directory -Path $out_root -Force | Out-Null
    }

    $pack_script = Join-Path $root 'scripts\pack-provider-runtime.ps1'
    $pack_name = Get-ProviderPackArchiveFileName -ProviderId $ProviderId -ProfileId $ProfileId
    if ($DryRun) {
        Write-Majestic "[dry-run] would pack $pack_name" -Color Yellow
        return
    }
    $pack_log = & $pack_script -OutDir $out_root -ProviderId $ProviderId -ProfileId $ProfileId *>&1
    $pack_exit = $LASTEXITCODE
    foreach ($line in @($pack_log)) {
        if ($null -ne $line -and "$line".Length -gt 0) { Write-Host $line }
    }
    if ($pack_exit -ne 0) {
        throw "pack-provider-runtime.ps1 failed for $ProviderId/$ProfileId"
    }

    $archive = Resolve-ProviderPackArchivePath -OutRoot $out_root -ProviderId $ProviderId -ProfileId $ProfileId
    if (-not (Test-Path -LiteralPath $archive)) {
        throw "Expected pack missing: $archive"
    }
    $manifest = [PSCustomObject]@{
        version   = $version
        tag       = $tag
        packKind  = 'provider'
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        repo      = $Config.repo
        files     = @(New-ManifestEntry -File (Get-Item -LiteralPath $archive))
    }
    $manifest_path = Join-Path $out_root "manifest-$tag-provider-$ProviderId-$ProfileId.json"
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest_path -Encoding UTF8
    Write-Majestic "PACK PROVIDER DONE: $archive" -Color Green
    Write-Majestic "Ship with: npm run majestic:ship:provider -- -ProviderId $ProviderId -ProfileId $ProfileId" -Color Cyan
    Write-Majestic "  or: gh release upload $tag --repo $($Config.repo) --clobber `"$archive`"" -Color DarkGray
}

function Invoke-MajesticShipProvider {
    param(
        $Config,
        [string]$ProviderId,
        [string]$ProfileId
    )
    Assert-ShipUnlocked
    if ([string]::IsNullOrWhiteSpace($ProviderId) -or [string]::IsNullOrWhiteSpace($ProfileId)) {
        throw "ship-provider requires -ProviderId and -ProfileId"
    }
    $version = Read-AppVersion
    $tag = Get-TagName -Version $version -Prefix $Config.tagPrefix
    $archive = Resolve-ProviderPackArchivePath -OutRoot $out_root -ProviderId $ProviderId -ProfileId $ProfileId
    if (-not (Test-Path -LiteralPath $archive)) {
        throw "No pack at $archive - run pack-provider first"
    }
    $pack_leaf = Split-Path -Leaf $archive

    Write-Majestic "About to upload $pack_leaf to $tag on $($Config.repo)" -Color Cyan
    if ($DryRun) {
        Write-Majestic "[dry-run] would upload $archive" -Color Yellow
        return
    }
    if (-not $Force) {
        $confirm = Read-Host "Type YES to ship $pack_leaf to $tag"
        if ($confirm -ne 'YES') {
            Write-Majestic "Ship cancelled." -Color Yellow
            return
        }
    } else {
        Write-Majestic "Force: shipping $pack_leaf without prompt" -Color DarkGray
    }

    $notes = [string]$Config.ship.providerReleaseNotes
    if ([string]::IsNullOrWhiteSpace($notes)) {
        $notes = "Engine pack $ProviderId-$ProfileId"
    }
    $notes = $notes -replace '\{provider\}', $ProviderId -replace '\{profile\}', $ProfileId

    $release_meta = Get-GhReleaseView -Tag $tag -Repo $Config.repo
    if ($null -eq $release_meta) {
        $create_result = New-GhReleaseWithAssets -Tag $tag -Repo $Config.repo -Notes $notes -Assets @($archive)
        if ($create_result.ExitCode -ne 0) {
            Throw-GhReleaseCreateFailed -Tag $tag -Repo $Config.repo -GhOutput $create_result.Output
        }
    } elseif ($release_meta.isImmutable) {
        Throw-ImmutableReleaseBlocked -Tag $tag -Repo $Config.repo -AssetCount @($release_meta.assets).Count
    } else {
        gh release upload $tag --repo $Config.repo --clobber $archive
        if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }
    }
    Write-Majestic "SHIPPED $ProviderId-$ProfileId.7z -> https://github.com/$($Config.repo)/releases/tag/$tag" -Color Green
}

switch ($Mode) {
    'check' {
        $ready = Invoke-MajesticCheck -Config $config -Variant $Variant
        if (-not $ready) { exit 1 }
    }
    'pack' { Invoke-MajesticPack -Config $config -Variant $Variant }
    'ship' { Invoke-MajesticShip -Config $config }
    'bump' { Invoke-MajesticBump }
    'ship-toolchain' { Invoke-MajesticShipToolchain -Config $config }
    'pack-provider' { Invoke-MajesticPackProvider -Config $config -ProviderId $ProviderId -ProfileId $ProfileId }
    'ship-provider' { Invoke-MajesticShipProvider -Config $config -ProviderId $ProviderId -ProfileId $ProfileId }
}