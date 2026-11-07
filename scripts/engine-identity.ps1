# Parse `llama-server --version` output into the engine identity.
#
# Returns @{ Build = 'b<build>[-<sha8>]'; Version = '<llama version or empty>' }.
# `Version` is the only human-readable part of an engine pack name; it is empty for forks that
# print no semver. Kept separate from the probe so the shapes can be tested without an engine.

function ConvertFrom-EngineVersionOutput {
    param(
        [Parameter(Mandatory = $true)][string]$Output,
        [string]$Exe = 'llama-server'
    )

    # `version: 0.8.0-dev (build 12017, commit 5047748f)` — full identity.
    # Capture the groups immediately: any later `-match` resets $Matches.
    if ($Output -match 'version:\s*([^\s(]+)\s*\(build\s+(\d+)[,)]?\s*commit\s+([0-9a-f]{7,40})') {
        $raw_version = [string]$Matches[1]
        $build_no = [string]$Matches[2]
        $sha = [string]$Matches[3]
        $version = if ($raw_version -match '\d') {
            $raw_version -replace '[^0-9A-Za-z.\-]', '_'
        } else {
            ''
        }
        return [pscustomobject]@{ Build = "b$build_no-$($sha.Substring(0, 8))"; Version = $version }
    }

    # Same shape without a commit.
    if ($Output -match 'version:\s*([^\s(]+)\s*\(build\s+(\d+)') {
        $raw_version = [string]$Matches[1]
        $build_no = [string]$Matches[2]
        $version = if ($raw_version -match '\d') {
            $raw_version -replace '[^0-9A-Za-z.\-]', '_'
        } else {
            ''
        }
        return [pscustomobject]@{ Build = "b$build_no"; Version = $version }
    }

    # Older llama.cpp: `version: 11869 (d327bf1f0)` — the number IS the build, no semver.
    if ($Output -match 'version:\s*(\d+)\s*\(([0-9a-f]{7,40})\)') {
        $build_no = [string]$Matches[1]
        $sha = [string]$Matches[2]
        return [pscustomobject]@{ Build = "b$build_no-$($sha.Substring(0, 8))"; Version = '' }
    }

    # Last resort: a bare version token is still a readable identity.
    if ($Output -match 'version:\s*([^\s()]+)') {
        $version = [string]$Matches[1]
        return [pscustomobject]@{
            Build   = ('b' + ($version -replace '[^0-9A-Za-z.\-]', '_'))
            Version = ''
        }
    }

    throw ("Could not read an engine identity from {0}. Output: {1}" -f $Exe, $Output.Trim())
}
