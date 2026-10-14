<#
.SYNOPSIS
  firefox-use kill switch. Run from any terminal.

.DESCRIPTION
  1. Revokes the session token (the server refuses all work and drops its connections).
  2. Kills every Firefox process tree started by firefox-use (claude-dev and throwaway test profiles).
  3. Marks the next cold start to restore the latest checkpoint, unless -NoRestore.
  Re-enable afterwards with:  setup.ps1 -TokenOnly
#>
param([switch]$NoRestore)
$ErrorActionPreference = 'Continue'
$Base = if ($env:FIREFOX_USE_HOME) { $env:FIREFOX_USE_HOME } else { Join-Path $env:LOCALAPPDATA 'firefox-use' }
$TokenFile = Join-Path $Base 'token'
$RunDir = Join-Path $Base 'run'
$cfg = $null
try { $cfg = Get-Content -Raw (Join-Path $Base 'config.json') | ConvertFrom-Json } catch {}
if ($cfg -and $cfg.runDir) { $RunDir = $cfg.runDir }

if (Test-Path $TokenFile) { Remove-Item -Force $TokenFile; Write-Host 'token revoked' } else { Write-Host 'token already revoked' }
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $RunDir 'killed.json'), (@{ at = (Get-Date).ToString('o'); restore = (-not $NoRestore); by = 'kill.ps1' } | ConvertTo-Json))

$pids = @()
$procs = Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'"
# 1. Firefoxes recorded in run state files (only if that pid still runs THAT profile: pids get reused)
foreach ($f in Get-ChildItem -Path $RunDir -Filter '*.json' -ErrorAction SilentlyContinue) {
  try { $s = Get-Content -Raw $f.FullName | ConvertFrom-Json } catch { continue }
  if ($s.personal) { continue } # personal mode: the user's own Firefox is never killed
  if ($s.pid -and $s.bidiPort) {
    foreach ($id in @($s.pid, $s.browserPid) | Where-Object { $_ }) {
      $p = $procs | Where-Object { $_.ProcessId -eq [int]$id }
      if ($p -and $p.CommandLine -and $s.profileDir -and $p.CommandLine.ToLower().Contains(([string]$s.profileDir).ToLower())) { $pids += [int]$id }
    }
    Remove-Item -Force $f.FullName
  }
}
# 2. any Firefox whose command line names a firefox-use profile (in case a run file is missing)
$profileDirs = @((Join-Path $Base 'profiles'), (Join-Path $Base 'throwaway'))
if ($cfg -and $cfg.profiles) { $cfg.profiles.PSObject.Properties | ForEach-Object { $profileDirs += $_.Value } }
foreach ($p in $procs) {
  foreach ($d in $profileDirs) { if ($p.CommandLine -and $p.CommandLine.Contains($d)) { $pids += [int]$p.ProcessId; break } }
}
$pids = $pids | Sort-Object -Unique
$killed = 0
foreach ($id in $pids) {
  $p = $procs | Where-Object { $_.ProcessId -eq $id }
  if (-not $p) { continue }
  if ($pids -contains [int]$p.ParentProcessId) { continue } # its parent's tree kill covers it
  & taskkill /PID $id /T /F | Out-Null
  Write-Host "killed Firefox tree $id"
  $killed++
}
if (-not $killed) { Write-Host 'no firefox-use Firefox processes running' }
