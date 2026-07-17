# Build runtime/catalog/plugins.json from optional provider factory templates.
# Usage: .\scripts\generate-plugin-catalog.ps1 [-OutDir path]

param(
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

$script_dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $script_dir
. (Join-Path $script_dir 'runtime-distribution.ps1')

$runtime_root = Join-Path $root 'src-tauri\runtime'

if (-not $OutDir) {
    $OutDir = Join-Path $runtime_root 'catalog'
}
if (-not [System.IO.Path]::IsPathRooted($OutDir)) {
    $OutDir = Join-Path $root $OutDir
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$plugins = @()

foreach ($kv in $script:OptionalDownloadProviders.GetEnumerator()) {
    $provider_id = $kv.Key
    $profiles = @($kv.Value)
    $factory_path = Join-Path $runtime_root "$provider_id\config\$provider_id-default-config.json"
    if (-not (Test-Path -LiteralPath $factory_path)) {
        Write-Host "[plugin-catalog] skip $provider_id - missing $factory_path" -ForegroundColor Yellow
        continue
    }

    $factory = Get-Content -LiteralPath $factory_path -Raw | ConvertFrom-Json
    $display = if ($factory.PSObject.Properties['displayName']) { [string]$factory.displayName }
        elseif ($factory.PSObject.Properties['display_name']) { [string]$factory.display_name }
        else { $provider_id }
    $template_type = if ($factory.PSObject.Properties['templateType']) { [string]$factory.templateType }
        elseif ($factory.PSObject.Properties['template_type']) { [string]$factory.template_type }
        else { 'ggml-llama' }

    $plugins += [PSCustomObject]@{
        id              = $provider_id
        displayName     = $display
        description     = if ($factory.description) { [string]$factory.description } else { "Optional engine plugin ($provider_id)" }
        templateType    = $template_type
        templateVersion = if ($null -ne $factory.templateVersion) { [int]$factory.templateVersion } else { 1 }
        profiles        = $profiles
    }
}

$catalog = [PSCustomObject]@{
    catalogVersion = 1
    plugins        = $plugins
}

$out_path = Join-Path $OutDir 'plugins.json'
$json = $catalog | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($out_path, $json + "`n", $utf8NoBom)
Write-Host ("[plugin-catalog] Wrote {0} ({1} plugin(s))" -f $out_path, $plugins.Count) -ForegroundColor Cyan