<#
.SYNOPSIS
  One-time setup for personal mode: lets Claude browse in your own Firefox profile at
  page level (like Claude in Chrome). Run by the user, not by Claude.

.DESCRIPTION
  1. Finds your Firefox profile (profiles.ini; or pass -Profile <folder>).
  2. Adds a marked block to that profile's user.js:
       remote.prefs.recommended = false
     Without it, Firefox's remote agent switches off Safe Browsing, saved logins, session restore after a
     crash, extension scopes and more in your profile whenever remote control is on (they come back at a
     clean shutdown, but a crash keeps them). firefox-use refuses personal mode until this is set.
     Optionally (asked): dom.file.createInChild = true, which Firefox needs before automation can attach
     files to an <input type=file> (set_files). Answer no if Claude should never upload files there.
  3. Adds a "Firefox (Claude can browse)" shortcut (Desktop and Start menu) that starts Firefox with
     remote control on a local port (127.0.0.1 only; the port is written into the profile folder).

  Firefox cannot add remote control to a browser that is already running: close Firefox, then start it
  from the new shortcut (or let Claude start it with ff_launch profile "personal"). Session restore brings
  your tabs back. While remote control is on, Firefox shows a robot icon and a striped address bar, and
  any local program could drive the browser through that port, as with Chrome's remote debugging.

  Safe to re-run. Undo everything with -Remove.

.PARAMETER Profile
  Profile folder to use instead of your default one (recorded as personalProfile in config.json).

.PARAMETER Uploads
  Answer yes to the file-upload question.

.PARAMETER NoShortcut
  Do not add (or remove) the shortcuts.

.PARAMETER Remove
  Remove the user.js block and the shortcuts.
#>
param(
  [string]$Profile,
  [switch]$Uploads,
  [switch]$NoShortcut,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'

$Base = Join-Path $env:LOCALAPPDATA 'firefox-use'
$ConfigFile = Join-Path $Base 'config.json'
$Begin = '// >>> firefox-use personal mode (setup/personal-mode.ps1)'
$End = '// <<< firefox-use personal mode'
$ShortcutName = 'Firefox (Claude can browse).lnk'
$Shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) $ShortcutName),
  (Join-Path ([Environment]::GetFolderPath('Programs')) $ShortcutName)
)

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Note($text) { Write-Host "    $text" -ForegroundColor Yellow }

$cfg = [ordered]@{}
if (Test-Path $ConfigFile) {
  $json = Get-Content -Raw $ConfigFile | ConvertFrom-Json
  foreach ($p in $json.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
}

# ---------------------------------------------------------------- 1. profile
Step 1 'Your Firefox profile'
if (-not $Profile) { $Profile = $cfg['personalProfile'] }
if (-not $Profile) {
  $ini = Join-Path $env:APPDATA 'Mozilla\Firefox\profiles.ini'
  if (-not (Test-Path $ini)) { throw "no ${ini}: pass -Profile <folder>" }
  $sections = @(); $cur = $null
  foreach ($line in Get-Content $ini) {
    if ($line -match '^\[(.+)\]$') { $cur = @{ __name = $Matches[1] }; $sections += $cur }
    elseif ($cur -and $line -match '^([^=]+)=(.*)$') { $cur[$Matches[1]] = $Matches[2] }
  }
  $rel = ($sections | Where-Object { $_.__name -like 'Install*' } | Select-Object -First 1).Default
  if (-not $rel) { $rel = ($sections | Where-Object { $_.Name -eq 'default-release' } | Select-Object -First 1).Path }
  if (-not $rel) { throw 'could not find your default profile in profiles.ini: pass -Profile <folder>' }
  $Profile = if ([System.IO.Path]::IsPathRooted($rel)) { $rel } else { Join-Path (Split-Path $ini) $rel }
} else {
  $cfg['personalProfile'] = (Resolve-Path $Profile).Path
}
$Profile = (Resolve-Path $Profile).Path
if ($cfg['profiles'] -and $cfg['profiles'].'claude-dev' -and ((Resolve-Path $cfg['profiles'].'claude-dev').Path -eq $Profile)) { throw 'that is the claude-dev profile, not your own' }
Ok $Profile

# ---------------------------------------------------------------- 2. user.js
$userJs = Join-Path $Profile 'user.js'
$text = if (Test-Path $userJs) { [System.IO.File]::ReadAllText($userJs) } else { '' }
# the marked block a previous run wrote
foreach ($name in @('firefox-use')) {
  $pattern = '(?s)\r?\n?' + [regex]::Escape("// >>> $name personal mode (setup/personal-mode.ps1)") + '.*?' + [regex]::Escape("// <<< $name personal mode") + '\r?\n?'
  $text = [regex]::Replace($text, $pattern, "`n").TrimEnd()
}

if ($Remove) {
  Step 2 'Removing the user.js block'
  [System.IO.File]::WriteAllText($userJs, $(if ($text) { "$text`n" } else { '' }))
  Ok "removed from $userJs (Firefox drops the prefs at its next start; prefs.js may keep remote.prefs.recommended until you reset it in about:config, which is harmless)"
  Step 3 'Removing the shortcuts'
  if (-not $NoShortcut) { foreach ($s in $Shortcuts) { if (Test-Path $s) { Remove-Item -Force $s; Ok "removed $s" } } }
  if ($cfg.Contains('personalProfile')) { $cfg.Remove('personalProfile'); [System.IO.File]::WriteAllText($ConfigFile, ($cfg | ConvertTo-Json -Depth 5)) }
  exit 0
}

Step 2 "Prefs in $userJs"
$prefs = @('user_pref("remote.prefs.recommended", false);')
if (-not $Uploads) {
  $a = Read-Host '    Let Claude attach files to upload fields in your Firefox (set_files)? Sets dom.file.createInChild=true. [y/N]'
  $Uploads = $a -match '^(y|yes)$'
}
if ($Uploads) { $prefs += 'user_pref("dom.file.createInChild", true);' }
$block = @($Begin, '// remote control must not switch off Safe Browsing, saved logins, session restore, ...') + $prefs + @($End)
$new = $(if ($text) { "$text`n`n" } else { '' }) + ($block -join "`n") + "`n"
[System.IO.File]::WriteAllText($userJs, $new)
foreach ($p in $prefs) { Ok $p }
if (-not $Uploads) { Note 'file uploads stay off (re-run with -Uploads to allow them)' }

# ---------------------------------------------------------------- 3. shortcut
Step 3 'Shortcut "Firefox (Claude can browse)"'
$ff = $cfg['firefoxPath']
if (-not $ff -or -not (Test-Path $ff)) {
  foreach ($hive in 'HKLM', 'HKCU') {
    try { $ff = (Get-ItemProperty "${hive}:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe" -ErrorAction Stop).'(default)'; if ($ff -and (Test-Path $ff)) { break } } catch {}
  }
}
if (-not $ff -or -not (Test-Path $ff)) { $ff = Join-Path $env:ProgramFiles 'Mozilla Firefox\firefox.exe' }
$shell = New-Object -ComObject WScript.Shell
foreach ($s in $(if ($NoShortcut) { @() } else { $Shortcuts })) {
  $lnk = $shell.CreateShortcut($s)
  $lnk.TargetPath = $ff
  $lnk.Arguments = "-profile `"$Profile`" --remote-debugging-port 0"
  $lnk.WorkingDirectory = Split-Path $ff
  $lnk.IconLocation = "$ff,0"
  $lnk.Description = 'Firefox with remote control on a local port, so Claude can browse in your profile (firefox-use personal mode)'
  $lnk.Save()
  Ok $s
}

if ($cfg.Contains('personalProfile')) { New-Item -ItemType Directory -Force -Path $Base | Out-Null; [System.IO.File]::WriteAllText($ConfigFile, ($cfg | ConvertTo-Json -Depth 5)) }

Write-Host "`nDone." -ForegroundColor Green
Write-Host '  The prefs apply from Firefox''s next start. If Firefox is open now, close it, then start it from the new'
Write-Host '  shortcut, or let Claude start it (ff_launch with profile "personal"). Your tabs come back via session restore.'
Write-Host '  Claude only uses your Firefox when you ask it to; it works in a window of its own and never closes your browser.'
