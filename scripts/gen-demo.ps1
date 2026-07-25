<#
.SYNOPSIS
  Generate optimized demo assets from a source MP4:
    - short.mp4     (loopable clip, ~3-5MB, for PH/Reddit/Twitter/Mastodon)
    - full.mp4      (compressed source, for detailed viewing)
    - thumb.gif     (first frame only, 480px wide, ~80KB, clickable thumbnail for GitHub README)

  Requires ffmpeg in PATH: winget install Gyan.FFmpeg

.DESCRIPTION
  Usage:
    .\scripts\gen-demo.ps1
    .\scripts\gen-demo.ps1 -InputFile docs/videos/demo.mp4 -Name "feature-x"
#>

param(
    [string]$InputFile = '',
    [string]$Name = '',
    [int]$ShortClipSeconds = 20
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $scriptDir
$videoDir = Join-Path $root 'docs\videos'
$gifDir = Join-Path $root 'docs\gifs'
$outDir = Join-Path $root 'docs\demos'

# Check ffmpeg
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
    Write-Error "ffmpeg not found. Install with: winget install Gyan.FFmpeg"
    exit 1
}

# Ensure output dirs exist
foreach ($d in @($outDir, $gifDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
}

# Find input video(s)
if ([string]::IsNullOrWhiteSpace($InputFile)) {
    $videos = Get-ChildItem -Path $videoDir -Filter '*.mp4' -ErrorAction SilentlyContinue
    if (-not $videos) {
        Write-Error "No MP4 files found in $videoDir"
        exit 1
    }
} else {
    $videos = @(Get-Item -LiteralPath (Join-Path $root $InputFile))
    if (-not $videos[0]) {
        Write-Error "Input file not found: $InputFile"
        exit 1
    }
}

# Get duration
function Get-Duration($file) {
    if (Get-Command ffprobe -ErrorAction SilentlyContinue) {
        $out = ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 $file 2>$null
        if ($out -and $out.Trim()) {
            return [double]::Parse($out.Trim(), [System.Globalization.CultureInfo]::InvariantCulture)
        }
    }
    return 80.0
}

foreach ($video in $videos) {
    $baseName = if ($Name) { $Name } else { [System.IO.Path]::GetFileNameWithoutExtension($video.Name) }
    $duration = Get-Duration $video.FullName
    $clipDur = [Math]::Min($ShortClipSeconds, $duration)

    Write-Host "Processing: $($video.Name) ($([math]::Round($duration,1))s total)" -ForegroundColor Green

    $shortOut = Join-Path $outDir "$baseName-short.mp4"
    $fullOut = Join-Path $outDir "$baseName-full.mp4"
    $thumbGif = Join-Path $gifDir "$baseName-thumb.gif"

    # Short clip: 20s, 1280p max, CRF 23
    Write-Host "  -> short.mp4 ($clipDur sec, 1280p)" -ForegroundColor Cyan
    ffmpeg -y -i $video.FullName -t $clipDur -vf scale=1280:-2 -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k -movflags +faststart $shortOut 2>&1 | Out-Null

    # Full compressed: source compressed
    Write-Host "  -> full.mp4 (1280p compressed)" -ForegroundColor Cyan
    ffmpeg -y -i $video.FullName -vf scale=1280:-2 -c:v libx264 -crf 25 -preset slow -c:a aac -b:a 128k -movflags +faststart $fullOut 2>&1 | Out-Null

    # Thumbnail GIF: single frame at 2s
    Write-Host "  -> thumb.gif (480px thumbnail)" -ForegroundColor Cyan
    $paletteFile = Join-Path $gifDir "$baseName-palette.png"
    ffmpeg -y -ss 2 -i $video.FullName -vf "scale=480:-1:flags=lanczos,palettegen" -update 1 $paletteFile 2>&1 | Out-Null
    ffmpeg -y -ss 2 -i $video.FullName -i $paletteFile -filter_complex "scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse" -vframes 1 $thumbGif 2>&1 | Out-Null
    Remove-Item -Force $paletteFile -ErrorAction SilentlyContinue
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host "  Short clips + full MP4s: $outDir" -ForegroundColor Cyan
Write-Host "  Thumbnail GIFs:          $gifDir" -ForegroundColor Cyan

# Report file sizes
Get-ChildItem $outDir, $gifDir -File | Where-Object { $_.Name -like "*$baseName*" } | ForEach-Object {
    $size = if ($_.Length -gt 1MB) { "$([math]::Round($_.Length/1MB,1)) MB" } elseif ($_.Length -gt 1KB) { "$([math]::Round($_.Length/1KB,0)) KB" } else { "$($_.Length) B" }
    Write-Host "    $($_.Name): $size" -ForegroundColor DarkGray
}
