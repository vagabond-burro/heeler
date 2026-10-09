# Stages the Windows build: moves the installer dist.py built onto the
# shared builds folder, where the Mac's release script picks it up. The
# version is read from the workspace Cargo.toml, so nothing here changes
# from one release to the next.
#
#   .\scripts\windows-stage.ps1                  move it
#   .\scripts\windows-stage.ps1 -DryRun          say what would move, move nothing
#   .\scripts\windows-stage.ps1 -Builds DIR      stage on DIR instead
#   .\scripts\windows-stage.ps1 -Force           replace one already staged
#
# --dry-run and --force are taken too, as the Mac and Linux scripts spell
# them. HEELER_BUILDS names the shared folder when -Builds is not given.
# If Windows refuses to run scripts:
#   powershell -ExecutionPolicy Bypass -File scripts\windows-stage.ps1

[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$Builds = $(if ($env:HEELER_BUILDS) { $env:HEELER_BUILDS } else { 'F:\tmp\builds' }),
    [switch]$DryRun,
    [switch]$Force,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message, [int]$Code = 1) {
    [Console]::Error.WriteLine($Message)
    exit $Code
}

foreach ($word in $Rest) {
    if ($word -eq '--dry-run' -or $word -eq '--dryrun') { $DryRun = $true }
    elseif ($word -eq '--force') { $Force = $true }
    else { Fail "unknown option: $word (-DryRun, -Builds DIR, -Force)" 2 }
}

$repo = Split-Path -Parent $PSScriptRoot

# The one version, as release.py reads it: [workspace.package] in Cargo.toml.
$version = $null
$inSection = $false
foreach ($line in Get-Content -LiteralPath (Join-Path $repo 'Cargo.toml')) {
    if ($line -match '^\[workspace\.package\]') { $inSection = $true; continue }
    if ($line -match '^\[') { $inSection = $false }
    if ($inSection -and $line -match '^version\s*=\s*"([^"]+)"') { $version = $Matches[1]; break }
}
if (-not $version) { Fail 'Cargo.toml: no version under [workspace.package]' }

$name = "Heeler-$version-windows.exe"
$installer = Join-Path $repo (Join-Path 'target\release\bundle\nsis' $name)
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { Fail "No $installer. Build it first: python scripts\dist.py" }
if (-not (Test-Path -LiteralPath $Builds -PathType Container)) { Fail "No folder $Builds. Connect the shared drive, or name the folder with -Builds DIR." }

$dest = Join-Path $Builds $name
if ((Test-Path -LiteralPath $dest) -and -not $Force) { Fail "$dest is already there. -Force replaces it." }

Write-Output "Heeler $version"
Write-Output "  $installer -> $dest"
if ($DryRun) {
    Write-Output 'dry run: nothing moved'
    exit 0
}
Move-Item -LiteralPath $installer -Destination $dest -Force
Write-Output 'staged'
