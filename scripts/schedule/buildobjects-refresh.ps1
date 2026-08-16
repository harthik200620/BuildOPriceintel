# Build Objects Price Intelligence - daily refresh.
#
# Runs the collector, writes a dated snapshot, appends to price_history,
# replaces price_current inside a single transaction, and emits
# data/logs/diff-<date>.md listing every price that moved, every offer that
# appeared or vanished, and every source that failed.
#
# A failed run leaves the previous data intact. The app reads the last
# successful run from `collection_run` and marks freshness as degraded rather
# than blanking the page - degradation is always to an older price honestly
# labelled, never to a wrong price shown as right.
#
# NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 decodes a
# BOM-less UTF-8 script as ANSI, which corrupts any multi-byte character and
# breaks the parse - box-drawing rules in comments are enough to do it.
#
# Register (one line, from the repo root):
#   schtasks /Create /TN "Build Objects PriceIntel Daily Refresh" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%CD%\scripts\schedule\buildobjects-refresh.ps1\"" /SC DAILY /ST 06:30 /F
#
# macOS / Linux equivalent (crontab -e):
#   30 6 * * *  cd /path/to/BuildObjects-PriceIntel && /usr/bin/env npm run collect >> data/logs/cron.out 2>&1

$ErrorActionPreference = 'Continue'

# Resolve the project root from this script's own location, so the task works
# regardless of the working directory Task Scheduler hands it.
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$LogDir = Join-Path $Root 'data\logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

$Stamp   = Get-Date -Format 'yyyy-MM-dd'
$RunLog  = Join-Path $LogDir "refresh-$Stamp.log"
$Started = Get-Date

function Write-Log([string]$Message) {
    $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $Message
    # Write-Host, not Write-Output: this function is called from inside
    # Invoke-Step, and anything on the output pipeline there would be returned
    # alongside the exit code.
    Write-Host $line
    Add-Content -Path $RunLog -Value $line -Encoding utf8
}

Write-Log "Build Objects refresh starting in $Root"

$npxCmd = Get-Command npx.cmd -ErrorAction SilentlyContinue
if ($null -eq $npxCmd) { $npxCmd = Get-Command npx -ErrorAction SilentlyContinue }
if ($null -eq $npxCmd) {
    Write-Log "FATAL: npx not found on PATH. Previous data left intact."
    exit 2
}
$Npx = $npxCmd.Source

function Invoke-Step([string]$Label, [string[]]$Arguments) {
    Write-Log $Label
    $out = & $Npx @Arguments 2>&1
    foreach ($line in $out) { Add-Content -Path $RunLog -Value $line -Encoding utf8 }
    return $LASTEXITCODE
}

# 1. collect
$collectExit = Invoke-Step "collecting" @('tsx', 'collector/run.ts', '--mode=scheduled', '--passes=2')
if ($collectExit -ne 0) {
    Write-Log "collector exited $collectExit - previous price_current is untouched and will age honestly."
} else {
    Write-Log "collector ok"
}

# 2. reconcile the filter trees against the new data
Invoke-Step "reconciling filter counts" @('tsx', 'scripts/reconcile-filters.ts') | Out-Null

# 3. diff log
Invoke-Step "writing diff log" @('tsx', 'scripts/diff-log.ts') | Out-Null

$Elapsed = [int]((Get-Date) - $Started).TotalSeconds
Write-Log "done in ${Elapsed}s (collector exit $collectExit)"

# Exit non-zero on collector failure so Task Scheduler's Last Run Result shows
# the truth rather than a green tick over a failed refresh.
exit $collectExit
