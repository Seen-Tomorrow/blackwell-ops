# Majestic - private release automation for Blackwell Ops.
# Usage: .\scripts\majestic\majestic.ps1 -Mode check|pack|ship|bump [-DryRun]

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('check', 'pack', 'ship', 'bump')]
    [string]$Mode,

    [switch]$DryRun
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
    Get-Content -LiteralPath $config_path -Raw | ConvertFrom-Json
}

function Get-TauriConfPath {
    Join-Path $root 'src-tauri\tauri.conf.json'
}

function Get-PackageJsonPath {
    Join-Path $root 'package.json'
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

function Get-RequiredProfiles {
    param($Config)
    $rows = @()
    foreach ($prop in $Config.providers.PSObject.Properties) {
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

function Invoke-MajesticCheck {
    param($Config)

    $version = Read-AppVersion
    $tag = Get-TagName -Version $version -Prefix $Config.tagPrefix
    $required = Get-RequiredProfiles -Config $Config

    Write-Majestic "Version $version  |  tag $tag  |  repo $($Config.repo)" -Color Cyan
    Write-Majestic "Mode: CHECK (read-only)" -Color DarkGray

    $artifact_rows = foreach ($row in $required) {
        Test-ProfileArtifact -ProviderId $row.Provider -ProfileId $row.Profile
    }

    $missing_artifacts = @($artifact_rows | Where-Object { -not $_.Ready })
    if ($missing_artifacts.Count -eq 0) {
        Write-Majestic "Foundry artifacts: all $($artifact_rows.Count) profile(s) ready." -Color Green
    } else {
        Write-Majestic "Foundry artifacts: $($missing_artifacts.Count) missing - build in Foundry first." -Color Red
        foreach ($m in $missing_artifacts) {
            Write-Majestic "  - $($m.Provider)/$($m.Profile)" -Color Red
        }
    }

    $runtime_root = Join-Path $root 'src-tauri\runtime'
    foreach ($row in $required) {
        $runtime_server = Join-Path $runtime_root "$($row.Provider)\$($row.Profile)\llama-server.exe"
        $label = "$($row.Provider)/$($row.Profile) runtime mirror"
        if (Test-Path -LiteralPath $runtime_server) {
            Write-Majestic "$label : ok" -Color Green
        } else {
            Write-Majestic "$label : missing (pack will mirror)" -Color Yellow
        }
    }

    $installers = Get-InstallerCandidates -Version $version
    if ($installers.Count -gt 0) {
        $latest = $installers[0]
        $age_min = [math]::Round(((Get-Date) - $latest.LastWriteTime).TotalMinutes, 1)
        Write-Majestic "Installer: $($latest.FullName) - $age_min minutes old" -Color Green
    } else {
        Write-Majestic "Installer: not built yet (pack will build)" -Color Yellow
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
        Write-Majestic "READY TO PACK." -Color Green
    } else {
        Write-Majestic "NOT READY - finish Foundry builds first." -Color Red
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

function New-ManifestEntry {
    param([System.IO.FileInfo]$File)
    $hash = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    [PSCustomObject]@{
        name   = $File.Name
        path   = $File.FullName
        bytes  = $File.Length
        sha256 = $hash
    }
}

function Invoke-MajesticPack {
    param($Config)

    $ready = Invoke-MajesticCheck -Config $Config
    if (-not $ready) {
        throw 'Check failed - fix Foundry artifacts before pack.'
    }

    $version = Read-AppVersion
    $tag = Get-TagName -Version $version -Prefix $Config.tagPrefix

    if (Test-Path -LiteralPath $out_root) {
        Remove-Item -LiteralPath $out_root -Recurse -Force
    }
    New-Item -ItemType Directory -Path $out_root -Force | Out-Null

    $skip_build = Test-InstallerFresh -Config $Config -Version $version
    if ($skip_build) {
        Write-Majestic "Installer is fresh - skipping npm run release." -Color Yellow
    } elseif ($DryRun) {
        Write-Majestic "[dry-run] would run: npm run release" -Color Cyan
    } else {
        Write-Majestic "Running npm run release (mirror -> bundle -> build)..." -Color Cyan
        Push-Location $root
        try {
            npm run release
            if ($LASTEXITCODE -ne 0) {
                throw "npm run release failed with exit code $LASTEXITCODE"
            }
        } finally {
            Pop-Location
        }
    }

    if (-not $skip_build -and -not $DryRun) {
        $installers = Get-InstallerCandidates -Version $version
        if ($installers.Count -eq 0) {
            throw "Installer not found after build. Expected under src-tauri/target/release/bundle/nsis/"
        }
    }

    $bundle_root = Join-Path $root 'src-tauri\runtime-bundle'
    if (-not (Test-Path -LiteralPath $bundle_root)) {
        if ($DryRun) {
            Write-Majestic "[dry-run] runtime-bundle missing - prepare-release-runtime would run via prerelease" -Color Yellow
        } else {
            throw "runtime-bundle/ missing. prerelease step may have failed."
        }
    }

    $manifest_files = @()
    $installers = Get-InstallerCandidates -Version $version
    if ($installers.Count -gt 0) {
        $installer = $installers[0]
        $dest_installer = Join-Path $out_root $installer.Name
        if ($DryRun) {
            Write-Majestic "[dry-run] copy installer -> $dest_installer" -Color Cyan
        } else {
            Copy-Item -LiteralPath $installer.FullName -Destination $dest_installer -Force
            $manifest_files += New-ManifestEntry -File (Get-Item -LiteralPath $dest_installer)
            Write-Majestic "Installer staged: $dest_installer" -Color Green
        }
    }

    if ($Config.upload.binaryZips) {
        foreach ($prop in $Config.providers.PSObject.Properties) {
            $provider_id = $prop.Name
            foreach ($profile_id in @($prop.Value)) {
                $src_dir = Join-Path $bundle_root "$provider_id\$profile_id"
                $zip_name = "$provider_id-$profile_id.zip"
                $zip_path = Join-Path $out_root $zip_name

                if (-not (Test-Path -LiteralPath $src_dir)) {
                    Write-Majestic "Zip skip (no bundle): $zip_name" -Color Yellow
                    continue
                }

                $dist_files = Get-RuntimeDistributionFiles -Directory $src_dir
                if ($dist_files.Count -eq 0) {
                    Write-Majestic "Zip skip (empty): $zip_name" -Color Yellow
                    continue
                }

                if ($DryRun) {
                    Write-Majestic "[dry-run] zip $($dist_files.Count) file(s) -> $zip_name" -Color Cyan
                    continue
                }

                $staging = Join-Path $out_root "_zip-staging\$provider_id-$profile_id"
                if (Test-Path -LiteralPath $staging) {
                    Remove-Item -LiteralPath $staging -Recurse -Force
                }
                New-Item -ItemType Directory -Path $staging -Force | Out-Null
                foreach ($file in $dist_files) {
                    Copy-Item -LiteralPath $file.FullName -Destination $staging -Force
                }
                if (Test-Path -LiteralPath $zip_path) {
                    Remove-Item -LiteralPath $zip_path -Force
                }
                Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip_path -CompressionLevel Optimal
                Remove-Item -LiteralPath (Split-Path -Parent $staging) -Recurse -Force

                $manifest_files += New-ManifestEntry -File (Get-Item -LiteralPath $zip_path)
                Write-Majestic "Zip staged: $zip_name ($($dist_files.Count) files)" -Color Green
            }
        }
    } else {
        Write-Majestic "Binary zips: skipped (upload.binaryZips = false)" -Color DarkGray
    }

    if (-not $DryRun) {
        $manifest = [PSCustomObject]@{
            version   = $version
            tag       = $tag
            createdAt = (Get-Date).ToUniversalTime().ToString('o')
            repo      = $Config.repo
            files     = $manifest_files
        }
        $manifest_path = Join-Path $out_root "manifest-$tag.json"
        $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifest_path -Encoding UTF8
        Write-Majestic "Manifest: $manifest_path" -Color Cyan
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
    Write-Majestic "Updates: src-tauri/tauri.conf.json + package.json" -Color DarkGray

    if ($DryRun) {
        Write-Majestic "[dry-run] would bump version to $newVersion" -Color Yellow
        return
    }

    $confirm = Read-Host "Type YES to bump to $newVersion"
    if ($confirm -ne 'YES') {
        Write-Majestic "Bump cancelled." -Color Yellow
        return
    }

    Set-JsonFileVersion -Path (Get-TauriConfPath) -NewVersion $newVersion
    Set-JsonFileVersion -Path (Get-PackageJsonPath) -NewVersion $newVersion
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
    $assets = @()
    foreach ($entry in @($manifest.files)) {
        if (Test-Path -LiteralPath $entry.path) {
            $assets += $entry.path
        }
    }
    if ($assets.Count -eq 0) {
        throw "No staged assets in .majestic-out/ for $tag"
    }

    Write-Majestic "About to ship $tag to $($Config.repo)" -Color Cyan
    Write-Majestic "Assets:" -Color Cyan
    foreach ($asset in $assets) {
        Write-Majestic "  - $asset" -Color DarkGray
    }

    if ($DryRun) {
        Write-Majestic "[dry-run] would create GitHub release $tag and upload $($assets.Count) asset(s)" -Color Yellow
        return
    }

    $confirm = Read-Host "Type YES to ship $tag"
    if ($confirm -ne 'YES') {
        Write-Majestic "Ship cancelled." -Color Yellow
        return
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

        $release_exists = $false
        try {
            gh release view $tag --repo $Config.repo 2>$null | Out-Null
            $release_exists = ($LASTEXITCODE -eq 0)
        } catch {
            $release_exists = $false
        }

        if (-not $release_exists) {
            Write-Majestic "Creating GitHub release $tag..." -Color Cyan
            gh release create $tag `
                --repo $Config.repo `
                --title $tag `
                --notes $Config.ship.releaseNotes
            if ($LASTEXITCODE -ne 0) {
                throw "gh release create failed"
            }
        } else {
            Write-Majestic "Release $tag already exists - uploading assets only." -Color Yellow
        }

        Write-Majestic "Uploading $($assets.Count) asset(s)..." -Color Cyan
        gh release upload $tag --repo $Config.repo --clobber @assets
        if ($LASTEXITCODE -ne 0) {
            throw "gh release upload failed"
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

switch ($Mode) {
    'check' {
        $ready = Invoke-MajesticCheck -Config $config
        if (-not $ready) { exit 1 }
    }
    'pack' { Invoke-MajesticPack -Config $config }
    'ship' { Invoke-MajesticShip -Config $config }
    'bump' { Invoke-MajesticBump }
}