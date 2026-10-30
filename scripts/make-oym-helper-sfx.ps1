#requires -Version 7.0
<#
.SYNOPSIS
  Build a one-file OYM Help SFX for a one-time support invite.

.DESCRIPTION
  Packages the tray helper app, the remote link client and Pi into a 7-Zip
  self-extracting exe. On launch it extracts to %LOCALAPPDATA%\OYM\Help and
  starts OYM-Help.exe; the app reads oym-invite.json, pairs automatically and
  keeps a hidden link client connected for the owner.

  The code is the normal one-time gateway pairing code. Generate it in
  OYM -> REMOTE -> STATUS immediately before building the SFX.

.EXAMPLE
  pwsh scripts/make-oym-helper-sfx.ps1 `
    -Server https://link.example.com `
    -Invite oym_inv_... `
    -Owner Alex `
    -OutFile tmp/OYM-Help-Alex.exe
#>
param(
    [Parameter(Mandatory)] [string] $Server,
    [string] $Code = "",
    [string] $Invite = "",
    [string] $Owner = "your technician",
    [string] $OutFile = "tmp/OYM-Help.exe",
    [string] $StageDir = "tmp/oym-helper-stage",
    # 3 is ~4 s / ~39 MB; 9 is ~40 s / ~32 MB. Helper delivery values speed.
    [ValidateSet(1, 3, 5, 7, 9)] [int] $CompressionLevel = 3
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (($Code -eq "") -eq ($Invite -eq "")) {
    throw "Provide exactly one of -Code (short pairing code) or -Invite (gateway invite token)."
}

$app = Join-Path $root "link/app/src-tauri/target/release/oym-link-app.exe"
$cli = Join-Path $root "remote-client/target/release/oym-link.exe"
$launcher = Join-Path $root "link/helper-launcher/target/release/oym-helper-launcher.exe"
$pi = Join-Path $root "tmp/blackwell-link-package/pi"
$sevenZip = "C:\Program Files\7-Zip\7z.exe"

# 7zS.sfx is the silent installer module. Current 7-Zip installs only ship the
# GUI 7z.sfx, so use a local copy or fetch 7-Zip Extra 9.20 once into tmp/.
$sfxCandidates = @(
    "C:\Program Files\7-Zip\7zS.sfx",
    (Join-Path $root "tmp/7z920-extra/7zS.sfx"),
    (Join-Path $root "tools/7zS.sfx")
)
$sfxModule = $sfxCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sfxModule) {
    $extraArchive = Join-Path $root "tmp/7z920_extra.7z"
    $extraDir = Join-Path $root "tmp/7z920-extra"
    if (-not (Test-Path $extraArchive)) {
        Invoke-WebRequest "https://www.7-zip.org/a/7z920_extra.7z" -OutFile $extraArchive -UseBasicParsing
    }
    New-Item -ItemType Directory -Force -Path $extraDir | Out-Null
    & $sevenZip x $extraArchive "-o$extraDir" -y | Out-Null
    $sfxModule = Join-Path $extraDir "7zS.sfx"
    if (-not (Test-Path $sfxModule)) { throw "Could not obtain 7zS.sfx" }
}

foreach ($required in @($app, $cli, $launcher, $sevenZip, $sfxModule)) {
    if (-not (Test-Path $required)) {
        throw "Missing build input: $required"
    }
}
if (-not (Test-Path (Join-Path $pi "pi.exe"))) {
    throw "Missing Pi package at $pi (expected pi/pi.exe)"
}

$stage = if ([IO.Path]::IsPathRooted($StageDir)) { $StageDir } else { Join-Path $root $StageDir }
$out = if ([IO.Path]::IsPathRooted($OutFile)) { $OutFile } else { Join-Path $root $OutFile }
foreach ($path in @($stage, $out)) {
    if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside the repo: $path"
    }
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null

Copy-Item $app (Join-Path $stage "OYM-Help.exe")
Copy-Item $cli (Join-Path $stage "oym-link.exe")
Copy-Item $launcher (Join-Path $stage "OYM-Launcher.exe")
Copy-Item $pi (Join-Path $stage "pi") -Recurse

$inviteData = [ordered]@{
    version = 1
    server  = $Server
    owner   = $Owner
    helper  = $true
}
if ($Invite -ne "") {
    $inviteData.invite = $Invite.Trim()
} else {
    $inviteData.code = $Code.Trim().ToUpperInvariant()
}
$inviteData | ConvertTo-Json | Set-Content (Join-Path $stage "oym-invite.json") -Encoding utf8NoBOM

# 7zS extracts to a new %TEMP%\7zS*.tmp path on every run. OYM-Launcher.exe is a
# GUI-subsystem exe: it copies the payload to %LOCALAPPDATA%\OYM\Help (stable
# path for firewall rules) and starts the app there, with no console flash and
# no relative wscript/install.cmd handoff.
$config = @'
;!@Install@!UTF-8!
Title="OYM Help"
RunProgram="OYM-Launcher.exe"
GUIMode="2"
;!@InstallEnd@!
'@
$configPath = Join-Path $root "tmp/oym-helper-config.txt"
Set-Content $configPath -Value $config -Encoding utf8NoBOM

# 7zS.sfx is an installer stub: the layout is
#   [7zS.sfx][config.txt][payload.7z]
# concatenated into one exe. Keeping config.txt inside the archive makes the
# stub report "Cannot find setup".
$payload = Join-Path $root "tmp/oym-helper-payload.7z"
if (Test-Path $payload) { Remove-Item $payload -Force }
Push-Location $stage
try {
    & $sevenZip a "-mx=$CompressionLevel" "-mmt=on" $payload * | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "7-Zip payload build failed with exit $LASTEXITCODE" }
}
finally {
    Pop-Location
}

if (Test-Path $out) { Remove-Item $out -Force }
$stream = [IO.File]::Create($out)
try {
    foreach ($part in @($sfxModule, $configPath, $payload)) {
        $bytes = [IO.File]::ReadAllBytes($part)
        $stream.Write($bytes, 0, $bytes.Length)
    }
}
finally {
    $stream.Dispose()
}
Remove-Item $payload -Force

$hash = (Get-FileHash $out -Algorithm SHA256).Hash
$size = [Math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host ""
Write-Host "Built:  $out"
Write-Host "Size:   $size MB"
Write-Host "SHA256: $hash"
Write-Host ""
Write-Host "The invite is single-use and expires. Send the file now; rebuild if it expires."
