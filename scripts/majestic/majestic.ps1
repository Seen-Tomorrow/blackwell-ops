#requires -Version 7.0
# Majestic - private release automation for Blackwell Ops.
# Usage: .\scripts\majestic\majestic.ps1 -Mode check|pack|ship|bump|ship-toolchain|pack-provider [-DryRun]
#   pack-provider = rebuild engine packs (all enginePacks, or one with -ProviderId/-ProfileId)
#   ships from the pack manifest; there is no per-plugin ship mode any more

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('check', 'pack', 'ship', 'pack-link', 'ship-link', 'bump', 'bump-pi', 'ship-toolchain', 'pack-provider', 'ship-provider', 'ship-engines')]
    [string]$Mode,

    [ValidateSet('app', 'full')]
    [string]$Variant = 'full',

    # pack-provider / ship-provider
    [string]$ProviderId = '',
    [string]$ProfileId = '',

    # ship: restrict to these channels (comma separated). Empty = everything in the manifest.
    [string]$Channels = '',

    [switch]$DryRun,

    # Skip YES prompts (bump / ship) - used by DEV Distribution panel
    [switch]$Force,

    # Ship: skip the test gate (a plan runs it once, not per channel)
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $script_dir)
$config_path = Join-Path $script_dir 'majestic.config.json'
$enabled_path = Join-Path $script_dir '.majestic-enabled'
$lock_path = Join-Path $script_dir 'majestic.lock'
$out_root = Join-Path $root '.majestic-out'

. (Join-Path (Split-Path -Parent $script_dir) 'runtime-distribution.ps1')
. (Join-Path (Split-Path -Parent $script_dir) 'release-channels.ps1')

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
    # -Encoding UTF8: release notes / descriptions hold non-ASCII (em-dash).
    # Windows PowerShell 5.1 defaults to ANSI and mangles UTF-8 into mojibake.
    $cfg = Get-Content -LiteralPath $config_path -Raw -Encoding UTF8 | ConvertFrom-Json
    # Provider maps always come from scripts/distribution-policy.json (DEV app + scripts).
    Import-RuntimeDistributionPolicy
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
    # -Encoding UTF8 is mandatory: Windows PowerShell 5.1 decodes as ANSI, so a UTF-8
    # em-dash in the file arrives as three characters and is re-written as mojibake.
    $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $pattern = '("version"\s*:\s*")[^"]+(")'
    $match = [regex]::Match($content, $pattern)
    if (-not $match.Success) {
        throw "version field not found in $Path"
    }
    $updated = $content.Substring(0, $match.Index) +
        $match.Groups[1].Value + $NewVersion + $match.Groups[2].Value +
        $content.Substring($match.Index + $match.Length)
    # Explicit UTF-8 without BOM — same bytes File.WriteAllText emits by default,
    # stated so the round-trip cannot silently depend on a default.
    [System.IO.File]::WriteAllText($Path, $updated, (New-Object System.Text.UTF8Encoding $false))
}

function Set-CargoTomlVersion {
    param(
        [string]$Path,
        [string]$NewVersion
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing file: $Path"
    }
    # -Encoding UTF8 is mandatory (see Set-JsonFileVersion): ANSI decode mangles non-ASCII.
    $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $pattern = '(?m)^(version\s*=\s*")[^"]+(")'
    $match = [regex]::Match($content, $pattern)
    if (-not $match.Success) {
        throw "version field not found in $Path"
    }
    $updated = $content.Substring(0, $match.Index) +
        $match.Groups[1].Value + $NewVersion + $match.Groups[2].Value +
        $content.Substring($match.Index + $match.Length)
    [System.IO.File]::WriteAllText($Path, $updated, (New-Object System.Text.UTF8Encoding $false))
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
    New-ChannelAssetName -Tag 'app' -Version $Version
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

function Assert-CargoLockPinned {
    # `tauri build` runs cargo itself and forwards no flags, so the shipping
    # compile cannot take --locked. A lockfile that already satisfies every
    # manifest requirement cannot be re-resolved by that nested build either, so
    # resolving under --locked here is what puts the pinned crate graph onto the
    # binary that ships — and it fails in ~1s instead of after a 499-crate build.
    $manifest = Join-Path $root 'src-tauri\Cargo.toml'
    Write-Majestic "Asserting Cargo.lock satisfies the manifests (cargo metadata --locked)..." -Color Cyan
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = cargo metadata --locked --format-version 1 --manifest-path $manifest 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($code -ne 0) {
        $out | ForEach-Object { if ($_) { Write-Host $_ } }
        throw "SHIP BLOCKED: src-tauri/Cargo.lock does not match the manifests. Refresh it deliberately (cargo update --workspace --offline, or -p <crate> for a real dependency change) and commit the lockfile before packing."
    }
    Write-Majestic "Crate graph pinned to the committed Cargo.lock." -Color Green
}

function Get-PackKindLabel {
    param([string]$Kind)
    if ($Kind -eq 'app') { 'App update (7z)' } else { 'Full Bundle (App .7z + NSIS with EDGE seed + engine packs)' }
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
    # `$?` not `$LASTEXITCODE`: a script ending without `exit` leaves LASTEXITCODE null.
    if (-not $?) {
        throw "Bundle prep failed: $script_path"
    }
}

function Invoke-FrontendAndTauriBuild {
    param(
        [string]$Variant,
        [string]$OutRoot = ''
    )
    Push-Location $root
    try {
        Clear-ReleaseBuildEnvironment
        $version = Read-AppVersion
        Write-Majestic "Build target version $version | conf: tauri.conf.json only (never conf.dev)" -Color Cyan
        Invoke-ForceReleasePackageClean
        Assert-CargoLockPinned

        if ($Variant -eq 'app') {
            Write-Majestic "Building frontend + release exe (no NSIS, no engine packs)..." -Color Cyan
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
            # Lean App pack: PE only - NSIS is Full Bundle path.
            # Do NOT pass -c/--config (would merge conf.dev and ship "Blackwell Ops DEV").
            npx tauri build --no-bundle
            if ($LASTEXITCODE -ne 0) { throw "tauri build --no-bundle failed with exit code $LASTEXITCODE" }
        } else {
            # Engine packs must be staged BEFORE the app is compiled: `engines.json` is embedded
            # in the PE, and the client refuses any pack whose name/digest its build does not
            # pin. `npm run release` would compile first and pack afterwards, so the engine
            # packs, the NSIS seed bundle and the app build are sequenced explicitly here.
            if (-not $OutRoot) { throw "Full build needs -OutRoot (engine packs land there)" }
            Write-Majestic "Staging NSIS runtime bundle..." -Color Cyan
            npm run prerelease
            if ($LASTEXITCODE -ne 0) { throw "npm run prerelease failed with exit code $LASTEXITCODE" }
            Write-Majestic "Packing engine bundles (digests pinned into engines.json)..." -Color Cyan
            $engine_pack_script = Join-Path $root 'scripts\pack-provider-runtime.ps1'
            $engine_log = & $engine_pack_script -OutDir $OutRoot *>&1
            $engine_ok = $?
            foreach ($line in @($engine_log)) {
                if ($null -ne $line -and "$line".Length -gt 0) { Write-Majestic "$line" -Color DarkGray }
            }
            if (-not $engine_ok) { throw "pack-provider-runtime.ps1 failed" }

            Write-Majestic "Building frontend + release exe + NSIS (engines.json embedded)..." -Color Cyan
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE" }
            npx tauri build
            if ($LASTEXITCODE -ne 0) { throw "tauri build failed with exit code $LASTEXITCODE" }
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

function Invoke-PackLinkUpdate {
    param([string]$OutRoot)
    $installer = Join-Path $root 'tmp/OYM-Link-Setup.exe'
    if (-not (Test-Path -LiteralPath $installer)) {
        throw "Link installer not staged: $installer. Run BUILD LINK INSTALLER before pack."
    }
    $pack_script = Join-Path $root 'scripts\pack-link-update.ps1'
    $log = & $pack_script *>&1
    $exit_code = $LASTEXITCODE
    foreach ($line in @($log)) {
        if ($null -ne $line -and "$line".Length -gt 0) { Write-Host $line }
    }
    if ($exit_code -ne 0) { throw "pack-link-update.ps1 failed (exit $exit_code)" }
    $asset = Get-ChildItem -LiteralPath $OutRoot -File -Filter 'LINK_OYM-Link-*.7z' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $asset) { throw "Link update asset missing after pack" }
    Write-Majestic "Link update staged: $($asset.Name) ($([math]::Round($asset.Length / 1MB, 1)) MB)" -Color Green
    return [string]$asset.FullName
}

function Invoke-MajesticLinkPack {
    $builder = Join-Path $root 'scripts/build-link.ps1'
    $packer = Join-Path $root 'scripts/pack-link-update.ps1'
    Write-Majestic "Building OYM Link installer..." -Color Cyan
    & $builder -Profile installer
    if (-not $?) { throw "build-link.ps1 failed" }
    Write-Majestic "Packing LINK_OYM-Link update asset..." -Color Cyan
    & $packer
    if (-not $?) { throw "pack-link-update.ps1 failed" }
}

function Invoke-MajesticLinkShip {
    $shipper = Join-Path $root 'scripts/ship-link.ps1'
    & $shipper
    if (-not $?) { throw "ship-link.ps1 failed" }
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
    # `$?` not `$LASTEXITCODE`: a script that ends without `exit` leaves LASTEXITCODE null.
    $pack_ok = $?
    foreach ($line in @($pack_log)) {
        if ($null -ne $line -and "$line".Length -gt 0) {
            Write-Host $line
        }
    }
    if (-not $pack_ok) {
        throw "pack-app-update.ps1 failed"
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


# The installer carries the EDGE seed only (docs/ENGINE-PACKS.md). This asserts against the
# STAGING tree, not the built exe: with NSIS compression enabled the payload is no longer
# listable as plain paths, and a stale runtime-bundle/ is exactly how engines leak back in.
function Assert-InstallerSeed {
    param(
        [Parameter(Mandatory = $true)][string]$InstallerPath,
        [Parameter(Mandatory = $true)][string]$BundleRoot
    )
    $staged = @()
    Get-ChildItem -LiteralPath $BundleRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $provider = $_
        Get-ChildItem -LiteralPath $provider.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            if (Test-Path -LiteralPath (Join-Path $_.FullName 'llama-server.exe')) {
                $staged += ('{0}/{1}' -f $provider.Name, $_.Name)
            }
        }
    }
    if ($staged.Count -eq 0) {
        throw 'runtime-bundle has no engine profile. Run scripts\prepare-release-runtime.ps1 first.'
    }

    $policy_path = Join-Path $root 'scripts\distribution-policy.json'
    $policy = Get-Content -LiteralPath $policy_path -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $policy.nsisCore) {
        throw 'distribution-policy.json has no nsisCore map - cannot tell what belongs in the installer.'
    }
    $expected = @()
    foreach ($prop in $policy.nsisCore.PSObject.Properties) {
        foreach ($prof in @($prop.Value)) { $expected += ('{0}/{1}' -f $prop.Name, $prof) }
    }
    $unexpected = @($staged | Where-Object { $expected -notcontains $_ })
    if ($unexpected.Count -gt 0) {
        throw ("runtime-bundle has engine profile(s) the policy does not install: {0}. Policy: {1}. Delete runtime-bundle\ and re-run the prepare script." -f ($unexpected -join ', '), ($expected -join ', '))
    }
    $missing = @($expected | Where-Object { $staged -notcontains $_ })
    if ($missing.Count -gt 0) {
        throw ("runtime-bundle is missing installer profile(s) the policy requires: {0}" -f ($missing -join ', '))
    }

    $mb = [math]::Round((Get-Item -LiteralPath $InstallerPath).Length / 1MB, 1)
    if ($mb -lt 100) {
        throw "Installer is $mb MB - below the 100 MB floor; the engine seed or bin/ is missing."
    }
    if ($mb -gt 1100) {
        throw "Installer is $mb MB - engine payload leaked in? Expected shell + bin/ + seed (docs/ENGINE-PACKS.md)."
    }
    if ($mb -gt 700) {
        Write-Majestic "WARN: installer is $mb MB (> 700 MB). Revisit the EDGE seed once 3-arch engines land (docs/ENGINE-PACKS.md section 3)." -Color Yellow
    }
    Write-Majestic ("Installer assertion passed: {0} seed(s), {1} MB" -f $staged.Count, $mb) -Color Green
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
    # Channel naming: `FULL_SETUP_Blackwell-Ops-vX.Y.Z.exe` (docs/RELEASE-CHANNELS.md §3).
    $full_name = New-ChannelAssetName -Tag 'full' -Version $Version
    $dest_installer = Join-Path $OutRoot $full_name
    Copy-Item -LiteralPath $installer.FullName -Destination $dest_installer -Force
    Assert-InstallerSeed -InstallerPath $dest_installer -BundleRoot (Join-Path $root 'src-tauri\runtime-bundle')
    Write-Majestic "Full installer staged: $full_name" -Color Green
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


# Profile rows come from the distribution policy, never from a list in majestic.config.json:
#   nsisCore    = profiles seeded inside the installer
#   enginePacks = profiles published as downloadable engine packs
# Adding an engine later means editing the policy + packing it, not editing this script.
function Get-PolicyProfileRows {
    param($Map)
    $rows = @()
    if (-not $Map) { return $rows }
    foreach ($kv in $Map.GetEnumerator()) {
        foreach ($prof in @($kv.Value)) {
            $rows += [PSCustomObject]@{ Provider = $kv.Key; Profile = $prof }
        }
    }
    return $rows
}

# Engines the installer must carry (EDGE today).
function Get-NsisRequiredProfiles {
    param($Config)
    return Get-PolicyProfileRows -Map $script:NsisCoreProviders
}

# Engines published as downloadable packs (EDGE + STABLE today).
function Get-ProviderPackProfiles {
    param($Config)
    return Get-PolicyProfileRows -Map $script:EnginePackProviders
}

function Invoke-MajesticCheck {
    param(
        $Config,
        [string]$Variant = 'full'
    )

    # Channel table self-check (no network): a naming/retention typo must fail before a build.
    try {
        & (Join-Path $root 'scripts\test-release-channels.ps1') *>&1 | Out-Null
    } catch {
        throw "Release channel self-check failed: $($_.Exception.Message)"
    }
    Write-Majestic "Release channel self-check: OK" -Color DarkGray

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
        $artifact_rows = @(foreach ($row in $nsis_required) {
            Test-ProfileArtifact -ProviderId $row.Provider -ProfileId $row.Profile
        })

        $missing_artifacts = @($artifact_rows | Where-Object { -not $_.Ready })
        if ($missing_artifacts.Count -eq 0) {
            Write-Majestic "Foundry artifacts (NSIS): all $($artifact_rows.Count) profile(s) ready." -Color Green
        } else {
            Write-Majestic "Foundry artifacts (NSIS): $($missing_artifacts.Count) missing - build in Foundry first." -Color Red
            foreach ($m in $missing_artifacts) {
                Write-Majestic "  - $($m.Provider)/$($m.Profile)" -Color Red
            }
        }

        Write-Majestic "Engine packs (published with the release):" -Color Cyan
        foreach ($row in $pack_profiles) {
            $art = Test-ProfileArtifact -ProviderId $row.Provider -ProfileId $row.Profile
            $label = "engine pack $($row.Provider)/$($row.Profile)"
            if ($art.Ready) {
                Write-Majestic "$label : ready to pack" -Color Green
            } else {
                Write-Majestic "$label : missing Foundry artifact (rebuild before pack)" -Color Red
                $missing_artifacts += $art
            }
        }
    } else {
        Write-Majestic "App-Only: skipping Foundry artifact checks." -Color DarkGray
        $runtime_root = Join-Path $root 'src-tauri\runtime'
        $template_ok = $true
        # Templates are required for every provider the installer seeds. The provider list comes
        # from the policy, not a hardcoded map in majestic.config.json.
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
        if (-not $template_ok) {
            $missing_artifacts = @([PSCustomObject]@{ Provider = 'templates'; Profile = 'config' })
        }
    }

    # pi harness pin. The release binary embeds src-tauri/pi-pinned-version.txt via
    # pi_code::PINNED_VERSION (include_str!), and pi_code_install falls back to it when
    # no version is given - so a stale pin makes a fresh REL install download a pi that
    # was never tested. bump-pi is the only thing that writes this file and nothing else
    # validated it, so packing straight after a pi update shipped the old pi silently.
    # Hard gate, both variants. A missing DEV pi is NOT a failure: a clean checkout with
    # no pi installed cannot be pinned, and that must not block an unrelated pack.
    $pi_pin_stale = $false
    $pi_installed = $null
    try {
        $pi_installed = Get-DevPiInstalledVersion
    } catch {
        Write-Majestic "pi pin: no DEV pi installed - skipping pin check (Harness connect > UPDATE first)" -Color Yellow
    }
    if ($pi_installed) {
        $pi_pin = Read-PiPinnedVersion
        if (-not $pi_pin) {
            $pi_pin_stale = $true
            Write-Majestic "pi pin: pi-pinned-version.txt is EMPTY but DEV runs pi $pi_installed." -Color Red
            Write-Majestic '  Fix: press BUMP HARNESS (majestic -Mode bump-pi).' -Color Red
        } elseif ($pi_pin -ne $pi_installed) {
            $pi_pin_stale = $true
            Write-Majestic "pi pin: STALE - pin says $pi_pin, DEV-tested pi is $pi_installed." -Color Red
            Write-Majestic "  A REL install would download $pi_pin, not the pi you tested." -Color Red
            Write-Majestic '  Fix: press BUMP HARNESS (majestic -Mode bump-pi), then rebuild.' -Color Red
        } else {
            Write-Majestic "pi pin: $pi_pin matches DEV-installed pi." -Color Green
        }
    }

    # The bundled extension declares which @earendil-works/pi-ai it needs. A pin below that
    # floor ships a pair the extension cannot load - 0.80.0 against pi 0.84.3 died with
    # "(0, _piAi.toToolDeclaration) is not a function" and no subagent tool. Computed from
    # the repo files alone, because the pin and the bundle are what the installer ships.
    $pi_bundle_pkg = Join-Path $root 'src-tauri\pi-ext\pi-subagents\package.json'
    if (Test-Path -LiteralPath $pi_bundle_pkg) {
        try {
            $pi_bundle = Get-Content -LiteralPath $pi_bundle_pkg -Raw | ConvertFrom-Json
            $pi_ai_req = $null
            if ($pi_bundle.peerDependencies) {
                $pi_ai_req = $pi_bundle.peerDependencies.'@earendil-works/pi-ai'
            }
            $pi_floor_text = if ($pi_ai_req) { ($pi_ai_req -replace '^>=', '').Trim() } else { '' }
            $pi_pin_now = Read-PiPinnedVersion
            if ($pi_floor_text -and $pi_floor_text -ne '*' -and $pi_pin_now) {
                $pi_floor = [version]$pi_floor_text
                $pi_host = [version]$pi_pin_now
                if ($pi_host -lt $pi_floor) {
                    $pi_pin_stale = $true
                    Write-Majestic ("pi bundle: pi-subagents {0} needs pi-ai >= {1} but the pin is {2} - the extension would not load." -f $pi_bundle.version, $pi_floor_text, $pi_pin_now) -Color Red
                    Write-Majestic '  Fix: Distribution > UPDATE HARNESS (updates pi + bundle, then pins both).' -Color Red
                } else {
                    Write-Majestic ("pi bundle: pi-subagents {0} needs pi-ai >= {1} - pin {2} satisfies it." -f $pi_bundle.version, $pi_floor_text, $pi_pin_now) -Color Green
                }
            }
            # The bundle must ALSO be the pinned version. 0.70+ satisfies the peer range,
            # loads, and then crashes the host on the first workflow/parallel run
            # (Bun "cannot resolve DirInfo for non-absolute path"), so semver alone is not
            # the gate - the pin is.
            $pi_bundle_pin_file = Join-Path $root 'src-tauri\pi-subagents-pinned-version.txt'
            if (Test-Path -LiteralPath $pi_bundle_pin_file) {
                $pi_bundle_pin = (Get-Content -LiteralPath $pi_bundle_pin_file -Raw).Trim()
                if ($pi_bundle_pin -and "$($pi_bundle.version)" -ne $pi_bundle_pin) {
                    $pi_pin_stale = $true
                    Write-Majestic ("pi bundle: bundled pi-subagents {0} is NOT the pinned {1} - 0.70+ crashes every parallel run." -f $pi_bundle.version, $pi_bundle_pin) -Color Red
                    Write-Majestic '  Fix: Distribution > UPDATE HARNESS (installs the pinned bundle).' -Color Red
                } elseif ($pi_bundle_pin) {
                    Write-Majestic ("pi bundle: pi-subagents {0} matches the pin." -f $pi_bundle.version) -Color Green
                }
            }
        } catch {
            Write-Majestic "pi bundle: could not compare bundle/pi pin ($($_.Exception.Message))" -Color Yellow
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

    $ready = ($missing_artifacts.Count -eq 0) -and (-not $pi_pin_stale)
    if ($ready) {
        Write-Majestic "READY TO PACK ($kind_label)." -Color Green
    } else {
        if ($pi_pin_stale) {
            Write-Majestic "NOT READY - pi pin/bundle mismatch (see above). Distribution > UPDATE HARNESS, then rebuild." -Color Red
        } elseif ($Variant -eq 'app') {
            Write-Majestic "NOT READY - fix provider template JSONs under src-tauri/runtime/*/config/." -Color Red
        } else {
            Write-Majestic "NOT READY - finish Foundry builds first." -Color Red
        }
    }
    return $ready
}

function New-ManifestEntry {
    param(
        [Parameter(Mandatory = $true)][string]$Channel,
        [System.IO.FileInfo]$File
    )
    $hash = Get-FileSha256Hex -Path $File.FullName
    [PSCustomObject]@{
        channel = $Channel
        name    = $File.Name
        path    = $File.FullName
        bytes   = $File.Length
        sha256  = $hash
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

    if ($DryRun) {
        if ($Variant -eq 'app') {
            Write-Majestic "[dry-run] would run: clean + prepare-release-app-only + npm run build + tauri build --no-bundle + PE assert + pack-app-update.ps1" -Color Cyan
        } else {
            Write-Majestic "[dry-run] would run: clean + npm run prerelease + pack engines + npm run build + tauri build (NSIS) + PE assert + App .7z + FULL setup" -Color Cyan
        }
    } else {
        if ($Variant -eq 'full') {
            # Engine packs are built inside the full build, before the app compiles, so the PE
            # embeds the manifest that names them.
            Invoke-FrontendAndTauriBuild -Variant $Variant -OutRoot $out_root
        } else {
            Invoke-PrepareReleaseBundle -Variant $Variant
            Invoke-FrontendAndTauriBuild -Variant $Variant
        }

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
            Write-Majestic "[dry-run] would stage App .7z + FULL setup (EDGE seed) + both ENGINE_* packs (built and digest-verified during the build)." -Color Cyan
        }
    } else {
        # The App .7z is always the templates-only bundle, even inside a full pack.
        if ($Variant -eq 'full') {
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
        $manifest_files += New-ManifestEntry -Channel 'app' -File (Get-Item -LiteralPath $app_archive)

        if ($Variant -eq 'full') {
            $link_archive = Invoke-PackLinkUpdate -OutRoot $out_root
            if ($link_archive) {
                $manifest_files += New-ManifestEntry -Channel 'link' -File (Get-Item -LiteralPath $link_archive)
            }
            # NSIS needs the full runtime-bundle (app + seeded engines) for the installer.
            Invoke-PrepareReleaseBundle -Variant 'full'
            $dest_installer = Stage-InstallerForVariant -Version $version -Variant 'full' -OutRoot $out_root
            $manifest_files += New-ManifestEntry -Channel 'full' -File (Get-Item -LiteralPath $dest_installer)

            # Engine packs were built before the app compiled; verify the bytes against the
            # manifest the PE embedded, so a digest drift fails the pack, not the download.
            # They are NOT part of this manifest: the engines channel publishes them on its own
            # (docs/RELEASE-CHANNELS.md), so a stuck app ship never blocks an engine.
            $engine_manifest_path = Join-Path $root 'src-tauri\runtime-catalog\engines.json'
            $engine_manifest = Get-Content -LiteralPath $engine_manifest_path -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not $engine_manifest.enginePacks -or @($engine_manifest.enginePacks).Count -eq 0) {
                throw "engines.json has no enginePacks after packing - refuse to ship an installer with no engine bundle."
            }
            foreach ($p in $engine_manifest.enginePacks) {
                $asset_path = Join-Path $out_root $p.asset
                if (-not (Test-Path -LiteralPath $asset_path)) {
                    throw "Engine pack missing after pack: $($p.asset)"
                }
                $sha = Get-FileSha256Hex -Path $asset_path
                if ($sha -ne $p.sha256.ToLowerInvariant()) {
                    throw ("Engine pack digest mismatch for {0}: manifest {1}, file {2}. Re-commit engines.json." -f $p.asset, $p.sha256, $sha)
                }
                Write-Majestic ("  {0}  {1:N1} MB  ({2}/{3}) - ships via engines channel" -f $p.asset, ((Get-Item -LiteralPath $asset_path).Length / 1MB), $p.provider, $p.profile) -Color Green
            }
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

    # Cargo.lock mirrors [package] version, so rewriting the manifest alone leaves
    # the tree failing the --locked gate that Pack and the ship release gate now
    # enforce. Refresh only workspace-member entries — offline, and incapable of
    # moving a third-party pin — so bump can never smuggle in a dependency change.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        cargo update --workspace --offline --manifest-path (Get-CargoTomlPath) 2>&1 | ForEach-Object {
            if ($_ -and "$_".Trim().Length -gt 0) { Write-Majestic "  $_" -Color DarkGray }
        }
        if ($LASTEXITCODE -ne 0) {
            throw "cargo update --workspace failed (exit $LASTEXITCODE) - src-tauri/Cargo.lock is now out of sync with the bumped manifest."
        }
    } finally {
        $ErrorActionPreference = $prevEap
    }
    Write-Majestic "Refreshed src-tauri/Cargo.lock (workspace entry only)." -Color DarkGray

    $old_tag = Get-TagName -Version $current -Prefix (Read-MajesticConfig).tagPrefix
    Push-Location $root
    try {
        # Provenance check — deliberately NON-destructive.
        #
        # This used to run `git tag -d $old_tag` on every bump, deleting the local tag for
        # the version that had just shipped. A tag is the only record of which commit
        # produced a release, and once the working tree moves on it cannot be rebuilt.
        # That is how v1.0.66/v1.0.68 and v1.0.69/v1.0.70 came to resolve to the same
        # commits with nothing left to explain it. A bump now only *reports* on tags;
        # deleting one stays an explicit human decision.
        #
        # A missing tag must still NOT fail the chain: PowerShell keeps native
        # LASTEXITCODE, and run-release-plan.ps1 treats it as bump fail *after* version
        # files were already written (→ skipped pack + ghost bumps).
        $prev_eap = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'
        $old_tag_sha = (git rev-parse --verify --quiet "refs/tags/$old_tag" 2>$null | Select-Object -First 1)
        $ErrorActionPreference = $prev_eap
        if ($old_tag_sha) {
            Write-Majestic "Keeping tag $old_tag -> $old_tag_sha" -Color DarkGray
        } else {
            Write-Majestic "WARNING: no local tag $old_tag - release $current has no recorded commit." -Color Yellow
        }
        # Clear native exit so successful bump never reports fail to the chain.
        $global:LASTEXITCODE = 0
    } finally {
        Pop-Location
    }

    Write-Majestic "Version bumped to $newVersion" -Color Green
    Write-Majestic "Next: pack (rebuild installer) then ship." -Color Cyan
}

# ── pi harness pin ─────────────────────────────────────────────────────

function Get-PiPinnedVersionPath {
    Join-Path $root 'src-tauri\pi-pinned-version.txt'
}

function Read-PiPinnedVersion {
    $p = Get-PiPinnedVersionPath
    if (-not (Test-Path -LiteralPath $p)) { return '' }
    # Get-Content -Raw returns $null for a zero-byte file, so .Trim() threw
    # "cannot call a method on a null-valued expression" and aborted the whole script.
    $raw = Get-Content -LiteralPath $p -Raw -ErrorAction SilentlyContinue
    if ($null -eq $raw) { return '' }
    return ([string]$raw).Trim()
}

function Get-DevPiInstalledVersion {
    # The running DEV app's pi version stamp (same version the developer tested).
    $stamp = Join-Path $root 'src-tauri\target\debug\external-tools\pi\version.txt'
    if (Test-Path -LiteralPath $stamp) {
        $v = (Get-Content -LiteralPath $stamp -Raw).Trim().TrimStart('v')
        if ($v) { return $v }
    }
    # Fallback: probe the DEV pi binary directly.
    $exe = Join-Path $root 'src-tauri\target\debug\external-tools\pi\pi\pi.exe'
    if (Test-Path -LiteralPath $exe) {
        $line = (& $exe --version 2>&1 | Select-Object -First 1).ToString().Trim().TrimStart('v')
        if ($line) { return $line }
    }
    throw "Cannot determine DEV-installed pi version (no stamp at $stamp). Update pi first via Harness connect (UPDATE), then bump."
}

function Set-PiPinnedVersion {
    param([string]$NewVersion)
    $p = Get-PiPinnedVersionPath
    # No trailing newline: pi_code.rs reads it verbatim via include_str!.
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($p, $NewVersion, $utf8NoBom)
}

function Invoke-MajesticBumpPi {
    $installed = Get-DevPiInstalledVersion
    $current = Read-PiPinnedVersion
    Write-Majestic "Bump pi pin: '$current' -> '$installed' (DEV-installed, tested)" -Color Cyan
    Write-Majestic "Writes: src-tauri/pi-pinned-version.txt (baked into the next release binary)" -Color DarkGray

    if ($DryRun) {
        Write-Majestic "[dry-run] would set pi pin to $installed" -Color Yellow
        return
    }

    if (-not $Force) {
        $confirm = Read-Host "Type YES to pin pi to $installed"
        if ($confirm -ne 'YES') {
            Write-Majestic "Bump pi cancelled." -Color Yellow
            return
        }
    } else {
        Write-Majestic "Force: pinning pi to $installed without prompt" -Color DarkGray
    }

    Set-PiPinnedVersion -NewVersion $installed
    Write-Majestic "pi pinned to $installed (src-tauri/pi-pinned-version.txt)." -Color Green
    Write-Majestic "Next: pack Full/App - the release binary embeds this pin. (pi-subagents bundle should already be refreshed via Harness UPDATE.)" -Color Cyan
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

function Invoke-ReleaseTestGate {
    # Ship is the one-way door: whatever goes up here reaches every installed app
    # through the in-app updater. PACK is deliberately NOT gated - it is run over and
    # over while iterating and must stay fast. This runs only after the YES confirm,
    # before the lock, the git tag, and any upload, so a red suite leaves GitHub
    # completely untouched.
    # Both suites: the Rust suite guards engine / IPC / config-merge logic, the
    # frontend suite guards the IPC command contract. Neither is covered by the PE
    # identity asserts, which only prove the binary is a REL build of the right version.
    Push-Location $root
    try {
        Write-Majestic "Release gate: frontend suite (npm test)..." -Color Cyan
        npm test
        if ($LASTEXITCODE -ne 0) {
            throw "SHIP BLOCKED: frontend tests failed (exit $LASTEXITCODE). Nothing was tagged or uploaded."
        }

        Write-Majestic "Release gate: Rust suite (cargo test) - builds the test profile, expect a few minutes..." -Color Cyan
        cargo test --locked --manifest-path (Join-Path $root 'src-tauri\Cargo.toml')
        if ($LASTEXITCODE -ne 0) {
            throw "SHIP BLOCKED: Rust tests failed (exit $LASTEXITCODE). Nothing was tagged or uploaded."
        }
    } finally {
        Pop-Location
    }
    Write-Majestic "Release gate: both suites green." -Color Green
}

# ── Channel publishing (docs/RELEASE-CHANNELS.md §5) ─────────────────────

function Get-ChannelReleaseNotes {
    param($Config, [string]$ChannelTag)
    switch ($ChannelTag) {
        'app' { if ($Config.ship.appOnlyReleaseNotes) { return [string]$Config.ship.appOnlyReleaseNotes } }
        'full' { if ($Config.ship.fullBundleReleaseNotes) { return [string]$Config.ship.fullBundleReleaseNotes } }
    }
    return [string]$Config.ship.releaseNotes
}

# Upload assets -> verify -> manifest last -> prune -> body. Any failure before the manifest
# leaves the previous channel.json in place, so clients keep working and never see a
# half-published version.
function Publish-ChannelRelease {
    param(
        $Config,
        [string]$Tag,
        [object[]]$Files,
        [string]$Version,
        [string]$Commit,
        [string]$Notes
    )
    $channel = Get-ReleaseChannel -Tag $Tag
    $repo = $Config.repo

    $existing = Get-GhReleaseView -Tag $Tag -Repo $repo
    $latest = $null
    $releases = @()
    $kept = @()

    # Idempotent ship: an asset already on the channel with the same size and (when GitHub
    # reports it) the same digest is not re-uploaded — a body/manifest refresh stays cheap.
    $published = @{}
    if ($null -ne $existing) {
        foreach ($a in @($existing.assets)) { $published[[string]$a.name] = $a }
    }
    if ($null -eq $existing) {
        Write-Majestic "Creating channel release '$Tag'..." -Color Cyan
        $latestArgs = if ($channel.latest) { @('--latest') } else { @('--latest=false') }
        $createArgs = @('release', 'create', $Tag, '--repo', $repo, '--title', [string]$channel.title, '--notes', [string]$channel.blurb) + $latestArgs
        $createOut = & gh @createArgs 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Throw-GhReleaseCreateFailed -Tag $Tag -Repo $repo -GhOutput $createOut.Trim()
        }
    } elseif ($existing.isImmutable) {
        throw "Release '$Tag' is immutable. Rolling channels require mutable releases (docs/RELEASE-CHANNELS.md §13)."
    }

    $toUpload = @()
    foreach ($f in $Files) {
        $cur = $published[[string]$f.name]
        $sameSize = ($null -ne $cur) -and ([long]$cur.size -eq [long]$f.bytes)
        $digestOk = $true
        if ($null -ne $cur -and $cur.digest) {
            $digestOk = (([string]$cur.digest).ToLowerInvariant() -eq ('sha256:' + ([string]$f.sha256).ToLowerInvariant()))
        }
        if ($sameSize -and $digestOk) {
            Write-Majestic "  already published, skipping upload: $($f.name)" -Color DarkGray
            continue
        }
        $toUpload += $f.path
    }
    if ($toUpload.Count -gt 0) {
        Write-Majestic ("Uploading {0} asset(s) to '{1}'..." -f $toUpload.Count, $Tag) -Color Cyan
        gh release upload $Tag --repo $repo --clobber @toUpload
        if ($LASTEXITCODE -ne 0) { throw "gh release upload $Tag failed" }
    } else {
        Write-Majestic "Assets already published - refreshing channel.json + body only" -Color DarkGray
    }

    # Manifest is generated from the uploaded set (never from the staging dir alone).
    if ($Tag -eq 'engines') {
        $engineDoc = Get-Content -LiteralPath (Join-Path $root 'src-tauri\runtime-catalog\engines.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        # Only what this ship actually uploaded may be listed — a manifest entry whose asset is
        # missing from the release would 404 every client that pins it.
        $newEngines = @($engineDoc.enginePacks | Where-Object { $Files.name -contains $_.asset } | ForEach-Object {
            [PSCustomObject][ordered]@{
                provider  = [string]$_.provider
                profile   = [string]$_.profile
                build     = [string]$_.build
                version   = [string]$_.llamaVersion
                asset     = [string]$_.asset
                sizeBytes = [long]$_.sizeBytes
                sha256    = [string]$_.sha256
                cuda      = [string]$_.cuda
            }
        })
        $prev = Read-PublishedChannelManifest -OutDir $out_root -Tag $Tag -Repo $repo
        $kept = Merge-EngineChannelEntries -Previous $prev -NewEntries $newEngines -Retention $channel.retention
        if (@($kept).Count -eq 0) {
            throw "engines channel: no manifest entries for the uploaded assets - refusing to publish an empty engine manifest"
        }
        $manifestPath = Write-ChannelManifestFile -OutDir $out_root -Tag $Tag -Engines $kept
    } else {
        $latest = [PSCustomObject][ordered]@{
            version     = $Version
            commit      = $Commit
            asset       = [string]$Files[0].name
            sizeBytes   = [long]$Files[0].bytes
            sha256      = [string]$Files[0].sha256
            publishedAt = (Get-Date).ToUniversalTime().ToString('o')
            notes       = $Notes
        }
        $prev = Read-PublishedChannelManifest -OutDir $out_root -Tag $Tag -Repo $repo
        $releases = Merge-ChannelReleases -Previous $prev -NewLatest $latest -Retention $channel.retention
        $manifestPath = Write-ChannelManifestFile -OutDir $out_root -Tag $Tag -Product $channel.product -Latest $latest -Releases $releases
    }

    gh release upload $Tag --repo $repo --clobber $manifestPath
    if ($LASTEXITCODE -ne 0) { throw "gh release upload $Tag (channel.json) failed" }
    Write-Majestic "Published $Tag/channel.json" -Color Green

    # Prune: keep exactly what the manifest references, plus the manifest itself.
    $keep = @((Get-ChannelManifestAssetName))
    if ($Tag -eq 'engines') {
        $keep += @($kept | ForEach-Object { $_.asset })
    } else {
        $keep += @($releases | ForEach-Object { $_.asset })
    }
    $keep = @($keep | Select-Object -Unique)
    $view = gh release view $Tag --repo $repo --json assets | ConvertFrom-Json
    foreach ($asset in @($view.assets)) {
        if ($keep -notcontains $asset.name) {
            Write-Majestic "  prune $Tag/$($asset.name)" -Color DarkGray
            gh release delete-asset $Tag $asset.name --repo $repo --yes | Out-Null
            if ($LASTEXITCODE -ne 0) { Write-Majestic "  WARN: could not delete $($asset.name)" -Color Yellow }
        }
    }

    $body = New-ChannelReleaseBody -Channel $channel -Latest $latest -Releases $releases -Engines $kept
    $bodyPath = Join-Path $out_root "release-body-$Tag.md"
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($bodyPath, $body, $utf8NoBom)
    gh release edit $Tag --repo $repo --notes-file $bodyPath | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Majestic "  WARN: release body update failed for $Tag" -Color Yellow }
}

# Publish one or more staged engine packs to the `engines` channel — no app build involved.
# Engines are independent of app builds; the channel manifest is what clients offer.
function Invoke-MajesticShipEngines {
    param(
        $Config,
        [string]$ProviderId = '',
        [string]$ProfileId = ''
    )

    Assert-ShipUnlocked
    if (Test-Path -LiteralPath $lock_path) {
        throw "Ship lock present ($lock_path). Another ship may be in progress - delete lock if stale."
    }

    $engine_manifest_path = Join-Path $root 'src-tauri\runtime-catalog\engines.json'
    if (-not (Test-Path -LiteralPath $engine_manifest_path)) {
        throw "Missing engines.json - run pack-provider-runtime.ps1 first."
    }
    $doc = Get-Content -LiteralPath $engine_manifest_path -Raw -Encoding UTF8 | ConvertFrom-Json
    $rows = @($doc.enginePacks)
    if ($ProviderId) {
        $rows = @($rows | Where-Object { $_.provider -eq $ProviderId -and (-not $ProfileId -or $_.profile -eq $ProfileId) })
        if ($rows.Count -eq 0) {
            throw "engines.json has no entry for $ProviderId/$ProfileId - pack it first."
        }
    }

    $files = @()
    $skipped = @()
    foreach ($row in $rows) {
        $path = Join-Path $out_root $row.asset
        if (-not (Test-Path -LiteralPath $path)) {
            $skipped += [string]$row.asset
            continue
        }
        $entry = New-ManifestEntry -Channel 'engines' -File (Get-Item -LiteralPath $path)
        if ($entry.sha256 -ne $row.sha256.ToLowerInvariant()) {
            throw ("Engine pack digest mismatch for {0}: manifest {1}, file {2}. Re-commit engines.json." -f $row.asset, $row.sha256, $entry.sha256)
        }
        $files += $entry
    }
    if ($files.Count -eq 0) {
        throw "No staged engine packs in .majestic-out/ - run Pack All Engines or Pack <profile> first."
    }
    if ($ProviderId -and $skipped.Count -gt 0) {
        throw "Requested engine pack not staged: $($skipped -join ', ')"
    }
    if ($skipped.Count -gt 0) {
        Write-Majestic "Skipping not-staged engine pack(s): $($skipped -join ', ')" -Color DarkGray
    }

    Write-Majestic "About to publish $($files.Count) engine pack(s) to '$($Config.repo)' channel 'engines'" -Color Cyan
    foreach ($f in $files) {
        Write-Majestic ("  {0}  {1:N1} MB" -f $f.name, ($f.bytes / 1MB)) -Color DarkGray
    }

    if ($DryRun) {
        Write-Majestic "[dry-run] would upload $($files.Count) engine pack(s) + channel.json" -Color Yellow
        return
    }

    if (-not $Force) {
        $confirm = Read-Host "Type YES to publish $($files.Count) engine pack(s)"
        if ($confirm -ne 'YES') {
            Write-Majestic "Ship cancelled." -Color Yellow
            return
        }
    } else {
        Write-Majestic "Force: publishing engine packs without prompt" -Color DarkGray
    }

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "GitHub CLI (gh) is required for ship. Install: https://cli.github.com/"
    }

    New-Item -ItemType File -Path $lock_path -Force | Out-Null
    try {
        Push-Location $root
        try {
            $commit = (git rev-parse --short HEAD).Trim()
            $version = Read-AppVersion
            Publish-ChannelRelease -Config $Config -Tag 'engines' -Files $files -Version $version -Commit $commit -Notes ''
        } finally {
            Pop-Location
        }
    } finally {
        if (Test-Path -LiteralPath $lock_path) {
            Remove-Item -LiteralPath $lock_path -Force
        }
    }
    Write-Majestic "SHIPPED engines channel - https://github.com/$($Config.repo)/releases/tag/engines" -Color Green
    & (Join-Path $root 'scripts\prune-staging.ps1') -OutRoot $out_root -Root $root
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
    $link_assets = @()
    # Optional channel filter (plan steps ship one channel at a time, e.g. app now, full later).
    $channel_filter = @()
    if ($Channels) {
        $channel_filter = @($Channels.Split(',') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
    }
    foreach ($entry in @($manifest.files)) {
        if (-not (Test-Path -LiteralPath $entry.path)) { continue }
        $leaf = Split-Path -Leaf $entry.path
        if ($leaf -like 'LINK_OYM-Link-*.7z') {
            $link_assets += $entry.path
            continue
        }
        $channel = if ($entry.PSObject.Properties.Name -contains 'channel') { [string]$entry.channel } else { '' }
        if (-not $channel) {
            throw "Manifest entry '$leaf' has no channel - re-run pack (docs/RELEASE-CHANNELS.md)."
        }
        if ($channel_filter.Count -gt 0 -and $channel_filter -notcontains $channel) {
            Write-Majestic "Ship: skipping channel '$channel' asset $leaf (filter: $Channels)" -Color DarkGray
            continue
        }
        # App packs publish the app channel only; full packs carry app + full.
        if ($pack_kind -eq 'app' -and $channel -ne 'app') {
            Write-Majestic "Ship app: skipping non-App channel '$channel' asset $leaf" -Color DarkGray
            continue
        }
        $assets += $entry
    }
    if ($assets.Count -eq 0) {
        throw "No staged assets in .majestic-out/ for $tag (packKind=$pack_kind, channels='$Channels')"
    }

    $require_app = ($channel_filter.Count -eq 0 -or $channel_filter -contains 'app')
    if ($require_app) {
        # Never upload an App .7z whose embedded PE is DEV or wrong version (the historic off-by-one).
        Write-Majestic "Verifying staged App archive PE identity before upload..." -Color Cyan
        $app_assets = @($assets | Where-Object { $_.channel -eq 'app' })
        if ($app_assets.Count -eq 0) {
            throw "Ship ${pack_kind}: no app-channel asset among staged files - refuse upload (would publish incomplete release)."
        }
        foreach ($app_asset in $app_assets) {
            Assert-AppArchive -ArchivePath $app_asset.path -ExpectedVersion $version
        }
        Write-Majestic ("App archive PE identity OK for v{0} ({1} file(s))" -f $version, $app_assets.Count) -Color Green
    }

    $groups = @($assets | Group-Object channel)
    Write-Majestic "About to ship $tag to $($Config.repo) (packKind=$pack_kind)" -Color Cyan
    foreach ($g in $groups) {
        Write-Majestic ("  channel '{0}': {1}" -f $g.Name, (@($g.Group | ForEach-Object { $_.name }) -join ', ')) -Color DarkGray
    }

    if ($DryRun) {
        Write-Majestic "[dry-run] would publish $($groups.Count) channel(s) for $tag" -Color Yellow
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

    if (-not $SkipTests) {
        Invoke-ReleaseTestGate
    } else {
        Write-Majestic "Release gate: skipped (already ran for this plan)" -Color DarkGray
    }

    New-Item -ItemType File -Path $lock_path -Force | Out-Null
    try {
        Push-Location $root
        try {
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
                Write-Majestic "pushTag=false - skipping git push (channels are labels, the git tag carries provenance)." -Color DarkGray
            }

            $commit = (git rev-parse --short HEAD).Trim()
            foreach ($g in $groups) {
                $channelTag = [string]$g.Name
                $notes = Get-ChannelReleaseNotes -Config $Config -ChannelTag $channelTag
                Publish-ChannelRelease -Config $Config -Tag $channelTag -Files @($g.Group) -Version $version -Commit $commit -Notes $notes
            }

            if ($link_assets.Count -gt 0) {
                Write-Majestic "Shipping LINK asset to its own tag..." -Color Cyan
                & (Join-Path $root 'scripts/ship-link.ps1') -Asset $link_assets[0]
                if (-not $?) { throw "ship-link.ps1 failed" }
            }

            Write-Majestic "SHIPPED $tag - https://github.com/$($Config.repo)/releases/tag/$tag" -Color Green
        } finally {
            Pop-Location
        }
        & (Join-Path $root 'scripts\prune-staging.ps1') -OutRoot $out_root -Root $root
    } finally {
        if (Test-Path -LiteralPath $lock_path) {
            Remove-Item -LiteralPath $lock_path -Force
        }
    }
}

$config = Read-MajesticConfig

function Invoke-MajesticShipToolchain {
    param($Config)

    Assert-ShipUnlocked

    # Ship every pack the embedded manifest can ask for. The app resolves assets by name from
    # its own compiled-in manifest, so an asset missing here is a user-visible 404 during
    # onboarding - and a digest mismatch means the app refuses the download. Fail closed.
    $manifest_path = Join-Path $root 'toolchain\manifest.json'
    $manifest = Get-Content -LiteralPath $manifest_path -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $manifest.packs -or @($manifest.packs).Count -eq 0) {
        throw "toolchain\manifest.json has no packs[] - run scripts\pack-toolchain-packs.ps1 first."
    }

    $assets = @()
    foreach ($p in $manifest.packs) {
        $candidates = @(
            (Join-Path $root (Join-Path 'work' $p.asset)),
            (Join-Path $root (Join-Path '.majestic-out' $p.asset))
        )
        $found = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if (-not $found) {
            throw ("Missing pack asset '{0}' for '{1}'. Build it with scripts\pack-toolchain-packs.ps1." -f $p.asset, $p.id)
        }
        $sha = Get-FileSha256Hex -Path $found
        if ($p.sha256 -and $sha -ne $p.sha256.ToLowerInvariant()) {
            throw ("Pack '{0}' digest mismatch: manifest says {1}, file is {2}. Re-run pack-toolchain-packs.ps1 and commit the manifest." -f $p.id, $p.sha256, $sha)
        }
        $assets += (Get-Item -LiteralPath $found)
    }

    # Content check applies to the full pack: it is the one that must contain both CUDA trees.
    $full_asset = $assets | Where-Object { $_.Name -eq 'toolchain.7z' } | Select-Object -First 1
    if ($full_asset) {
        & (Join-Path $root 'scripts\toolchain-validate-archive.ps1') -Archive $full_asset.FullName
    }

    $tag = 'toolchain'
    $total_mb = [math]::Round((($assets | Measure-Object Length -Sum).Sum) / 1MB, 1)
    Write-Majestic ("About to upload {0} toolchain asset(s), {1} MB total, to tag '{2}' on {3}" -f $assets.Count, $total_mb, $tag, $Config.repo) -Color Cyan
    foreach ($a in $assets) {
        Write-Majestic ("  {0}  {1:N1} MB" -f $a.Name, ($a.Length / 1MB)) -Color DarkGray
    }

    if ($DryRun) {
        Write-Majestic "[dry-run] would upload $($assets.Count) asset(s) to release $tag" -Color Yellow
        return
    }

    if (-not $Force) {
        $confirm = Read-Host "Type YES to ship $($assets.Count) toolchain archive(s)"
        if ($confirm -ne 'YES') {
            Write-Majestic "Ship cancelled." -Color Yellow
            return
        }
    } else {
        Write-Majestic "Force: shipping toolchain assets without prompt" -Color DarkGray
    }

    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "GitHub CLI (gh) is required. Install: https://cli.github.com/"
    }

    $release_meta = Get-GhReleaseView -Tag $tag -Repo $Config.repo
    $notes = "Portable toolchain packs (CUDA runtime per version, Foundry build tools, full). The app resolves them by name from its embedded manifest; extract via in-app setup / Foundry."
    $asset_paths = @($assets | ForEach-Object { $_.FullName })
    if ($null -eq $release_meta) {
        Write-Majestic "Creating GitHub release $tag with $($assets.Count) asset(s)..." -Color Cyan
        $create_result = New-GhReleaseWithAssets -Tag $tag -Repo $Config.repo -Notes $notes -Assets $asset_paths
        if ($create_result.ExitCode -ne 0) {
            throw "gh release create failed:`n$($create_result.Output)"
        }
    } elseif ($release_meta.isImmutable) {
        throw "Release $tag is immutable - delete it on GitHub or use a new tag before re-uploading."
    } else {
        Write-Majestic "Release $tag exists - uploading $($assets.Count) asset(s) (clobber)..." -Color Cyan
        gh release upload $tag --repo $Config.repo --clobber @asset_paths
        if ($LASTEXITCODE -ne 0) {
            throw "gh release upload failed"
        }
    }

    Write-Majestic "SHIPPED toolchain - https://github.com/$($Config.repo)/releases/tag/$tag" -Color Green
    & (Join-Path $root 'scripts\prune-staging.ps1') -OutRoot $out_root -Root $root
}


switch ($Mode) {
    'check' {
        $ready = Invoke-MajesticCheck -Config $config -Variant $Variant
        if (-not $ready) { exit 1 }
    }
    'pack' { Invoke-MajesticPack -Config $config -Variant $Variant }
    'ship' { Invoke-MajesticShip -Config $config }
    'pack-link' { Invoke-MajesticLinkPack }
    'ship-link' { Invoke-MajesticLinkShip }
    'bump' { Invoke-MajesticBump }
    'bump-pi' { Invoke-MajesticBumpPi }
    'ship-toolchain' { Invoke-MajesticShipToolchain -Config $config }
    'pack-provider' {
        # Engine packs are built from the policy (enginePacks), not from a provider list.
        $pack_args = @{ OutDir = $out_root }
        if ($ProviderId) { $pack_args.ProviderId = $ProviderId }
        if ($ProfileId) { $pack_args.ProfileId = $ProfileId }
        & (Join-Path $root 'scripts\pack-provider-runtime.ps1') @pack_args
        if ($LASTEXITCODE -ne 0) { throw "pack-provider-runtime.ps1 failed (exit $LASTEXITCODE)" }
    }
    'ship-engines' {
        Invoke-MajesticShipEngines -Config $config -ProviderId $ProviderId -ProfileId $ProfileId
    }
    'ship-provider' {
        # Kept as an alias: publishing engine packs no longer needs an app build.
        Invoke-MajesticShipEngines -Config $config -ProviderId $ProviderId -ProfileId $ProfileId
    }
}
# Native tools (git/gh/7z) can leave LASTEXITCODE non-zero after a successful
# mode. Detached chain treats that as failure — force clean success exit.
exit 0