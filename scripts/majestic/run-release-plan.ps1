#requires -Version 7.0
# Plan-driven release runner (docs/DISTRIBUTION-PANEL.md §7).
#
# DISTRIBUTION writes `.majestic-out/release-plan.json` and spawns this windowless with
# -PlanFile. Progress is job-log.txt (+ @@STEP markers) and job-status.json (state + steps);
# each run also leaves `.majestic-out/jobs/<id>.json` for the panel's history.
#
# Engines are independent of app builds: steps only ever call one mode/script, never a chain.

param(
    [Parameter(Mandatory = $true)]
    [string]$PlanFile
)

$ErrorActionPreference = 'Stop'
$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $script_dir)
$out = Join-Path $root '.majestic-out'
New-Item -ItemType Directory -Path $out -Force | Out-Null

$log_path = Join-Path $out 'job-log.txt'
$status_path = Join-Path $out 'job-status.json'
$jobs_dir = Join-Path $out 'jobs'
$majestic = Join-Path $script_dir 'majestic.ps1'
$engine_packer = Join-Path $root 'scripts\pack-provider-runtime.ps1'
$toolchain_builder = Join-Path $root 'scripts\build-foundry-toolchain.ps1'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

# Strip DEV/tauri pollution inherited from the running app: pack must use tauri.conf.json only.
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
        chain      = 'plan'
        message    = $Message
        updatedAt  = (Get-Date).ToUniversalTime().ToString('o')
        providerId = ''
        profileId  = ''
        pid        = $PID
        planId     = $script:plan_id
        steps      = $script:step_state
    }
    $json = ($obj | ConvertTo-Json -Compress -Depth 6)
    # Atomic replace: a poll must never read a half-written status (it would parse as "idle").
    $tmp = "$status_path.tmp"
    try {
        [System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)
        [System.IO.File]::Move($tmp, $status_path, $true)
    } catch {
        [System.IO.File]::WriteAllText($status_path, $json, $utf8NoBom)
    }
}

function Set-StepState {
    param([int]$Index, [string]$State)
    if ($Index -ge 0 -and $Index -lt $script:step_state.Count) {
        $script:step_state[$Index].state = $State
    }
}

function Write-JobHistory {
    param([string]$Result)
    try {
        New-Item -ItemType Directory -Path $jobs_dir -Force | Out-Null
        $doc = [ordered]@{
            id        = $script:plan_id
            summary   = $script:plan_summary
            startedAt = $script:started_at
            endedAt   = (Get-Date).ToUniversalTime().ToString('o')
            result    = $Result
            steps     = $script:step_state
        }
        $path = Join-Path $jobs_dir ("{0}.json" -f $script:plan_id)
        [System.IO.File]::WriteAllText($path, ($doc | ConvertTo-Json -Depth 6), $utf8NoBom)
        # Keep the panel's history bounded; one small JSON per job adds up over months.
        Get-ChildItem -LiteralPath $jobs_dir -Filter '*.json' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -Skip 50 |
            Remove-Item -Force -ErrorAction SilentlyContinue
    } catch {
        # history is best-effort; never fail the job for it
    }
}

function Invoke-Majestic {
    # Hashtable splat is required: array splat is positional-only and would make -Mode a value.
    param([hashtable]$Params)
    $label = ($Params.GetEnumerator() | ForEach-Object { "-$($_.Key) $($_.Value)" }) -join ' '
    Write-JobLog "RUN majestic.ps1 $label"

    $call = @{} + $Params
    $call['Force'] = $true

    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $code = 0
    try {
        # Windowless: every stream (including native npm/cargo/gh output) must land in the log.
        & $majestic @call *>&1 | ForEach-Object {
            if ($null -ne $_ -and "$_".Length -gt 0) { Write-JobLog "$_" }
        }
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
    if ($code -ne 0) { throw "majestic exit $code" }
}

function Get-ShipParams {
    param([string]$Channel)
    $params = @{ Mode = 'ship'; Channels = $Channel }
    if ($script:gate_done) {
        $params.SkipTests = $true
    } else {
        $script:gate_done = $true
    }
    return $params
}

function Invoke-PlanStep {
    param($Step)
    $id = [string]$Step.id
    switch -Regex ($id) {
        '^bump$' {
            Invoke-Majestic -Params @{ Mode = 'bump' }
            return
        }
        '^pack:app$' {
            Invoke-Majestic -Params @{ Mode = 'pack'; Variant = 'app' }
            return
        }
        '^pack:full$' {
            Invoke-Majestic -Params @{ Mode = 'pack'; Variant = 'full' }
            return
        }
        '^pack:engine:([^:]+):(.+)$' {
            $provider = $Matches[1]
            $profile = $Matches[2]
            Write-JobLog "RUN pack-provider-runtime.ps1 $provider/$profile"
            $prev = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & $engine_packer -ProviderId $provider -ProfileId $profile *>&1 | ForEach-Object {
                    if ($null -ne $_ -and "$_".Length -gt 0) { Write-JobLog "$_" }
                }
                $code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
            } finally {
                $ErrorActionPreference = $prev
            }
            if ($code -ne 0) { throw "pack-provider-runtime.ps1 failed (exit $code)" }
            return
        }
        '^pack:link$' {
            Invoke-Majestic -Params @{ Mode = 'pack-link' }
            return
        }
        '^pack:toolchain$' {
            Write-JobLog "RUN build-foundry-toolchain.ps1"
            $prev = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & $toolchain_builder *>&1 | ForEach-Object {
                    if ($null -ne $_ -and "$_".Length -gt 0) { Write-JobLog "$_" }
                }
                $code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
            } finally {
                $ErrorActionPreference = $prev
            }
            if ($code -ne 0) { throw "build-foundry-toolchain.ps1 failed (exit $code)" }
            return
        }
        '^ship:app$' {
            Invoke-Majestic -Params (Get-ShipParams -Channel 'app')
            return
        }
        '^ship:full$' {
            Invoke-Majestic -Params (Get-ShipParams -Channel 'full')
            return
        }
        '^ship:engines$' {
            $profiles = @($Step.args.profiles)
            if ($profiles.Count -eq 0) {
                Invoke-Majestic -Params @{ Mode = 'ship-engines' }
            } elseif ($profiles.Count -eq 1) {
                Invoke-Majestic -Params @{
                    Mode       = 'ship-engines'
                    ProviderId = [string]$profiles[0].provider
                    ProfileId  = [string]$profiles[0].profile
                }
            } else {
                # One ship per profile: the engines manifest merges, so each step keeps the
                # others listed while only the requested pack is uploaded.
                foreach ($profile in $profiles) {
                    Invoke-Majestic -Params @{
                        Mode       = 'ship-engines'
                        ProviderId = [string]$profile.provider
                        ProfileId  = [string]$profile.profile
                    }
                }
            }
            return
        }
        '^ship:link$' {
            Invoke-Majestic -Params @{ Mode = 'ship-link' }
            return
        }
        '^ship:toolchain$' {
            Invoke-Majestic -Params @{ Mode = 'ship-toolchain' }
            return
        }
        '^refresh:local-rel$' {
            $refresh = Join-Path $root 'scripts\refresh-local-rel.ps1'
            $dest = [string]$Step.args.dest
            $params = @{}
            if ($dest) { $params.Dest = $dest }
            if ($Step.args.skipBuild) { $params.SkipBuild = $true }
            Write-JobLog "RUN refresh-local-rel.ps1 $dest"
            $prev = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & $refresh @params *>&1 | ForEach-Object {
                    if ($null -ne $_ -and "$_".Length -gt 0) { Write-JobLog "$_" }
                }
                $code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
            } finally {
                $ErrorActionPreference = $prev
            }
            if ($code -ne 0) { throw "refresh-local-rel.ps1 failed (exit $code)" }
            return
        }
        default {
            throw "Unknown plan step '$id'"
        }
    }
}

# ── boot ────────────────────────────────────────────────────────────────────

if (-not (Test-Path -LiteralPath $PlanFile)) { throw "Missing plan file: $PlanFile" }
$plan_doc = Get-Content -LiteralPath $PlanFile -Raw -Encoding UTF8 | ConvertFrom-Json
$script:plan_id = [string]$plan_doc.id
$script:plan_summary = [string]$plan_doc.summary
$script:started_at = (Get-Date).ToUniversalTime().ToString('o')
$steps = @($plan_doc.steps)
$script:step_state = @($steps | ForEach-Object {
        [ordered]@{ id = [string]$_.id; label = [string]$_.label; state = 'pending' }
    })
$script:gate_done = $false

try {
    [System.IO.File]::WriteAllText($log_path, "", $utf8NoBom)
    Set-JobStatus -State 'running' -Message "Starting $($script:plan_id) (pid $PID)"
} catch {
    # continue; best-effort
}

try {
    Write-JobLog "=== plan $($script:plan_id) (pid $PID) ==="
    Write-JobLog "Repo: $root"
    Write-JobLog "Summary: $($script:plan_summary)"
    Write-JobLog "Windowless job - progress goes to the DISTRIBUTION panel / job-log.txt."

    $index = 0
    foreach ($step in $steps) {
        Set-StepState -Index $index -State 'running'
        Set-JobStatus -State 'running' -Message ("Step {0}/{1}: {2}" -f ($index + 1), $steps.Count, $step.label)
        Write-JobLog "@@STEP $($step.id) running $($step.label)"
        Invoke-PlanStep -Step $step
        Set-StepState -Index $index -State 'ok'
        Write-JobLog "@@STEP $($step.id) ok"
        $index++
    }

    Write-JobLog "=== DONE: plan $($script:plan_id) ==="
    Set-JobStatus -State 'ok' -Message "Completed $($script:plan_summary)"
    Write-JobHistory -Result 'ok'
    exit 0
} catch {
    $msg = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($msg)) { $msg = "$_" }
    Set-StepState -Index $index -State 'failed'
    Write-JobLog "=== FAIL: $msg ==="
    try { Set-JobStatus -State 'failed' -Message $msg } catch { }
    Write-JobHistory -Result 'failed'
    Write-Host "=== FAIL: $msg ===" -ForegroundColor Red
    Write-Host "Log: $log_path" -ForegroundColor Yellow
    # Keep the process alive briefly so a manual (visible) run can be read.
    Start-Sleep -Seconds 20
    exit 1
}
