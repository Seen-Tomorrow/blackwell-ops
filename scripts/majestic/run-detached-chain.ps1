# Detached Majestic chain - survives tauri dev restarts.
# Visible console so long npm/cargo builds are not a black box.
# Args: -Chain pack_full | pack_ship_app | ...  [-ProviderId x] [-ProfileId y]

param(
    [Parameter(Mandatory = $true)]
    [string]$Chain,
    [string]$ProviderId = '',
    [string]$ProfileId = ''
)

$ErrorActionPreference = 'Stop'
$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $script_dir)
$out = Join-Path $root '.majestic-out'
New-Item -ItemType Directory -Path $out -Force | Out-Null

# Scrub DEV / tauri-dev pollution inherited when DISTRIBUTION spawns this console
# from a running `tauri dev` process. Pack must only use tauri.conf.json.
foreach ($name in @(
        'TAURI_CONFIG',
        'TAURI_ANDROID_PACKAGE_NAME',
        'TAURI_ANDROID_PACKAGE_NAME_PREFIX',
        'TAURI_DEV_HOST'
    )) {
    if (Test-Path "Env:$name") {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
}
$env:NODE_ENV = 'production'

$log_path = Join-Path $out 'job-log.txt'
$status_path = Join-Path $out 'job-status.json'
$majestic = Join-Path $script_dir 'majestic.ps1'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-JobLog {
    param([string]$Line)
    $ts = (Get-Date).ToUniversalTime().ToString('o')
    $text = "[$ts] $Line"
    try {
        [System.IO.File]::AppendAllText($log_path, $text + [Environment]::NewLine, $utf8NoBom)
    } catch {
        # best-effort
    }
    Write-Host $text
}

function Set-JobStatus {
    param(
        [string]$State,
        [string]$Message = ''
    )
    $obj = [ordered]@{
        state      = $State
        chain      = $Chain
        message    = $Message
        updatedAt  = (Get-Date).ToUniversalTime().ToString('o')
        providerId = $ProviderId
        profileId  = $ProfileId
        pid        = $PID
    }
    $json = ($obj | ConvertTo-Json -Compress)
    [System.IO.File]::WriteAllText($status_path, $json, $utf8NoBom)
}

function Invoke-Majestic {
    # Hashtable splat required: array splat is positional only, so '-Mode' became Mode's value.
    param([hashtable]$Params)
    $label = ($Params.GetEnumerator() | ForEach-Object { "-$($_.Key) $($_.Value)" }) -join ' '
    Write-JobLog ("RUN majestic.ps1 $label")
    Set-JobStatus -State 'running' -Message "majestic $label"

    $call = @{} + $Params
    $call['Force'] = $true

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $code = 0
    try {
        & $majestic @call
        if ($null -ne $LASTEXITCODE) {
            $code = [int]$LASTEXITCODE
        } elseif (-not $?) {
            $code = 1
        }
    } catch {
        Write-JobLog ("EXCEPTION: $($_.Exception.Message)")
        throw
    } finally {
        $ErrorActionPreference = $prev
    }

    if ($code -ne 0) {
        throw "majestic exit $code"
    }
}

# Bootstrap status ASAP so the app does not HEAL a stale pid=0 seed.
try {
    [System.IO.File]::WriteAllText($log_path, "", $utf8NoBom)
    Set-JobStatus -State 'running' -Message "Starting $Chain (pid $PID)"
} catch {
    # continue; best-effort
}

try {
    try {
        $host.ui.RawUI.WindowTitle = "Majestic $Chain | blackwell-ops DEV"
    } catch {
        # non-console host
    }

    Write-JobLog "=== detached chain: $Chain (pid $PID) ==="
    Write-JobLog "Repo: $root"
    Write-JobLog "Majestic: $majestic"
    Write-JobLog "Visible console - leave open until DONE/FAIL."
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  Majestic DEV pack job: $Chain" -ForegroundColor Cyan
    Write-Host "  Log file: $log_path" -ForegroundColor DarkGray
    Write-Host "  Full pack = mirror + npm run release (many minutes)" -ForegroundColor Yellow
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""

    if (-not (Test-Path -LiteralPath $majestic)) {
        throw "Missing majestic.ps1 at $majestic"
    }

    Set-Location -LiteralPath $root

    switch ($Chain) {
        'bump' {
            Invoke-Majestic -Params @{ Mode = 'bump' }
        }
        'pack_app' {
            Invoke-Majestic -Params @{ Mode = 'pack'; Variant = 'app' }
        }
        'pack_full' {
            Invoke-Majestic -Params @{ Mode = 'pack'; Variant = 'full' }
        }
        'ship_app' {
            Invoke-Majestic -Params @{ Mode = 'ship' }
        }
        'ship_full' {
            Invoke-Majestic -Params @{ Mode = 'ship' }
        }
        'check_app' {
            Invoke-Majestic -Params @{ Mode = 'check'; Variant = 'app' }
        }
        'check_full' {
            Invoke-Majestic -Params @{ Mode = 'check'; Variant = 'full' }
        }
        'pack_ship_app' {
            Write-JobLog '=== bump ==='
            Invoke-Majestic -Params @{ Mode = 'bump' }
            Write-JobLog '=== pack app ==='
            Invoke-Majestic -Params @{ Mode = 'pack'; Variant = 'app' }
            Write-JobLog '=== ship ==='
            Invoke-Majestic -Params @{ Mode = 'ship' }
        }
        'pack_ship_full' {
            Write-JobLog '=== bump ==='
            Invoke-Majestic -Params @{ Mode = 'bump' }
            Write-JobLog '=== pack full (NSIS + packs) - long running ==='
            Invoke-Majestic -Params @{ Mode = 'pack'; Variant = 'full' }
            Write-JobLog '=== ship ==='
            Invoke-Majestic -Params @{ Mode = 'ship' }
        }
        'pack_ship_provider' {
            if (-not $ProviderId -or -not $ProfileId) {
                throw 'pack_ship_provider needs ProviderId and ProfileId'
            }
            Write-JobLog "=== pack $ProviderId/$ProfileId ==="
            Invoke-Majestic -Params @{ Mode = 'pack-provider'; ProviderId = $ProviderId; ProfileId = $ProfileId }
            Write-JobLog "=== ship $ProviderId/$ProfileId ==="
            Invoke-Majestic -Params @{ Mode = 'ship-provider'; ProviderId = $ProviderId; ProfileId = $ProfileId }
        }
        'pack_provider' {
            if (-not $ProviderId -or -not $ProfileId) { throw 'pack_provider needs ids' }
            Invoke-Majestic -Params @{ Mode = 'pack-provider'; ProviderId = $ProviderId; ProfileId = $ProfileId }
        }
        'ship_provider' {
            if (-not $ProviderId -or -not $ProfileId) { throw 'ship_provider needs ids' }
            Invoke-Majestic -Params @{ Mode = 'ship-provider'; ProviderId = $ProviderId; ProfileId = $ProfileId }
        }
        default {
            throw "Unknown chain: $Chain"
        }
    }

    Write-JobLog "=== DONE: $Chain ==="
    Set-JobStatus -State 'ok' -Message "Completed $Chain"
    Write-Host ""
    Write-Host "=== DONE: $Chain ===" -ForegroundColor Green
    Write-Host "Window will close in 8s (or close manually)." -ForegroundColor DarkGray
    Start-Sleep -Seconds 8
    exit 0
} catch {
    $msg = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "$_" }
    Write-JobLog "=== FAIL: $msg ==="
    try { Set-JobStatus -State 'failed' -Message $msg } catch { }
    Write-Host ""
    Write-Host "=== FAIL: $msg ===" -ForegroundColor Red
    Write-Host "Log: $log_path" -ForegroundColor Yellow
    Write-Host "Window stays open 120s so you can read the error." -ForegroundColor Yellow
    Start-Sleep -Seconds 120
    exit 1
}
