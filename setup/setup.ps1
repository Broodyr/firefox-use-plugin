<#
.SYNOPSIS
  One-time setup for firefox-use. Run by the user, not by Claude.

.DESCRIPTION
  1. Creates the claude-dev Firefox profile.
  2. Writes its user.js (remote debugging, devtools, no auto-updates, sandboxed downloads, quiet startup).
  3. Offers to copy the uBlock Origin, Violentmonkey and Stylus .xpi files from your main profile
     (installed into claude-dev at the first ff_launch, then kept in sync: at each launch, if your main
     profile has a newer version, that copy is installed), or tells you how to install them by hand.
  4. Generates the session token (%LOCALAPPDATA%\firefox-use\token, readable only by you).
  5. In a source checkout: builds the server if needed and adds the checkout to CLAUDE_CODE_PLUGIN_DIRS (your user
     environment), so Claude Code loads the plugin from it in place. A release install came from a marketplace, so
     there is nothing to register.

  Safe to re-run: existing profile and add-ons are kept; user.js, config and token are rewritten.

.PARAMETER TokenOnly
  Only issue a new session token (use this to re-enable after a kill switch).

.PARAMETER NoPlugin
  Skip registering the plugin with Claude Code.

.PARAMETER Yes
  Answer yes to the .xpi copy prompt.
#>
param(
  [switch]$TokenOnly,
  [switch]$NoPlugin,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Base = Join-Path $env:LOCALAPPDATA 'firefox-use'
$TokenFile = Join-Path $Base 'token'
$ConfigFile = Join-Path $Base 'config.json'
$AddonsDir = Join-Path $Base 'addons'
$SandboxDir = Join-Path $Base 'sandbox'
$RunDir = Join-Path $Base 'run'
$ProfileDir = Join-Path $Base 'profiles\claude-dev'
# a source checkout has the TypeScript sources; a release install (from a marketplace) has only the bundle
$SourceCheckout = Test-Path (Join-Path $Repo 'server\src')

$Addons = @(
  @{ Id = 'uBlock0@raymondhill.net'; Name = 'uBlock Origin'; Amo = 'https://addons.mozilla.org/firefox/addon/ublock-origin/' },
  @{ Id = '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}'; Name = 'Violentmonkey'; Amo = 'https://addons.mozilla.org/firefox/addon/violentmonkey/' },
  @{ Id = '{7a7a4a92-a2a0-41d1-9fd7-1e92480d612d}'; Name = 'Stylus'; Amo = 'https://addons.mozilla.org/firefox/addon/styl-us/' }
)

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Note($text) { Write-Host "    $text" -ForegroundColor Yellow }

function Write-Token {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  [System.IO.File]::WriteAllText($TokenFile, $token)
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $TokenFile /inheritance:r /grant:r "${user}:(F)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed to restrict $TokenFile" }
  Ok "token written to $TokenFile (access: $user only)"
}

New-Item -ItemType Directory -Force -Path $Base, $AddonsDir, $SandboxDir, $RunDir | Out-Null

if ($TokenOnly) {
  Step 1 'Issuing a new session token'
  Write-Token
  exit 0
}

# --- 0. prerequisites -------------------------------------------------------
Step 0 'Checking prerequisites'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22.13 or later is required (node not found on PATH).' }
# 22.13: node:sqlite without a flag (the server reads Violentmonkey's storage with it)
$nodeVersion = [version]((& node -p 'process.versions.node').Trim())
if ($nodeVersion -lt [version]'22.13.0') { throw "Node.js 22.13 or later is required (found $nodeVersion)." }
Ok "node $(& node -v)"
if ($SourceCheckout -and -not (Test-Path (Join-Path $Repo 'server\dist\index.js'))) {
  Note 'source checkout without a build: running npm ci and npm run build'
  Push-Location $Repo
  try {
    & npm ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    & npm run build; if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  } finally { Pop-Location }
  Ok 'server built'
}

$Firefox = $null
foreach ($key in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe',
                 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\firefox.exe') {
  try { $v = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'; if ($v -and (Test-Path $v)) { $Firefox = $v; break } } catch {}
}
if (-not $Firefox) {
  foreach ($p in "$env:ProgramFiles\Mozilla Firefox\firefox.exe", "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe") {
    if (Test-Path $p) { $Firefox = $p; break }
  }
}
if (-not $Firefox) { throw 'Firefox not found. Install Firefox, then re-run.' }
$ffVersion = (Get-Item $Firefox).VersionInfo.ProductVersion
Ok "Firefox $ffVersion at $Firefox"

# --- 1. profile --------------------------------------------------------------
Step 1 "Creating the claude-dev profile"
$iniPath = Join-Path $env:APPDATA 'Mozilla\Firefox\profiles.ini'
$registered = (Test-Path $iniPath) -and ((Get-Content $iniPath) -contains 'Name=claude-dev')
if ($registered -and (Test-Path $ProfileDir)) {
  Ok "already exists: $ProfileDir"
} else {
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
  $p = Start-Process -FilePath $Firefox -ArgumentList @('-no-remote', '-CreateProfile', "`"claude-dev $ProfileDir`"") -PassThru -Wait -WindowStyle Hidden
  Ok "created: $ProfileDir"
}

# --- 2. user.js --------------------------------------------------------------
Step 2 'Writing user.js'
$sandboxJs = $SandboxDir.Replace('\', '\\')
$userJs = (Get-Content -Raw (Join-Path $PSScriptRoot 'user.js')).Replace('%SANDBOX%', $sandboxJs)
[System.IO.File]::WriteAllText((Join-Path $ProfileDir 'user.js'), $userJs)
Ok "remote debugging + devtools enabled, add-on auto-update off, downloads -> $SandboxDir"

# --- 3. add-ons -----------------------------------------------------------------
Step 3 'uBlock Origin, Violentmonkey and Stylus'
$mainProfile = $null
$ini = Join-Path $env:APPDATA 'Mozilla\Firefox\profiles.ini'
if (Test-Path $ini) {
  $section = @{}; $sections = @()
  foreach ($line in Get-Content $ini) {
    if ($line -match '^\[(.+)\]$') { $section = @{ '__name' = $Matches[1] }; $sections += $section }
    elseif ($line -match '^([^=]+)=(.*)$') { $section[$Matches[1]] = $Matches[2] }
  }
  $install = $sections | Where-Object { $_['__name'] -like 'Install*' } | Select-Object -First 1
  $rel = if ($install) { $install['Default'] } else { ($sections | Where-Object { $_['Name'] -eq 'default-release' } | Select-Object -First 1)['Path'] }
  if ($rel) {
    $cand = if ([System.IO.Path]::IsPathRooted($rel)) { $rel } else { Join-Path (Join-Path $env:APPDATA 'Mozilla\Firefox') $rel.Replace('/', '\') }
    if ((Test-Path $cand) -and ((Resolve-Path $cand).Path -ne (Resolve-Path $ProfileDir).Path)) { $mainProfile = $cand }
  }
}

$syncAddons = $false
$found = @()
if ($mainProfile) {
  foreach ($a in $Addons) {
    $xpi = Join-Path $mainProfile "extensions\$($a.Id).xpi"
    if (Test-Path $xpi) { $found += @{ Addon = $a; Path = $xpi } }
  }
}
$missing = @($Addons | Where-Object { $id = $_.Id; -not ($found | Where-Object { $_.Addon.Id -eq $id }) })

if ($found.Count -gt 0) {
  Write-Host "    Found in your main profile ($mainProfile):"
  foreach ($f in $found) { Write-Host "      - $($f.Addon.Name)  $($f.Path)" }
  Write-Host '    Only these files (and extensions.json, for version checks at each launch) are ever read; your main profile is not changed.'
  $answer = if ($Yes) { 'y' } else { Read-Host '    Copy these AMO-signed .xpi files into claude-dev, and sync newer versions at each launch? [Y/n]' }
  if ($answer -eq '' -or $answer -match '^[yY]') {
    foreach ($f in $found) { Copy-Item -Force $f.Path (Join-Path $AddonsDir "$($f.Addon.Id).xpi") }
    Ok "copied to $AddonsDir (installed permanently at the first ff_launch; newer main-profile versions synced at launch)"
    $syncAddons = $true
  } else {
    $missing = $Addons
  }
}
if ($missing.Count -gt 0) {
  Note 'Install these into claude-dev by hand from AMO:'
  foreach ($a in $missing) { Note "  - $($a.Name): $($a.Amo)" }
  Note "Open claude-dev with:  & `"$Firefox`" -no-remote -profile `"$ProfileDir`""
}

# --- 4. token + config ---------------------------------------------------------
Step 4 'Session token and config'
Write-Token
$config = [ordered]@{
  firefoxPath = $Firefox
  profiles    = [ordered]@{ 'claude-dev' = $ProfileDir }
  addonsDir   = $AddonsDir
  sandboxDir  = $SandboxDir
  mainProfile = $mainProfile
  syncAddonsFromMainProfile = $syncAddons
  runDir      = $RunDir
  writtenAt   = (Get-Date).ToString('o')
}
[System.IO.File]::WriteAllText($ConfigFile, ($config | ConvertTo-Json -Depth 4))
Ok "config written to $ConfigFile"

# --- 5. plugin -----------------------------------------------------------------
Step 5 'Registering the plugin with Claude Code'
if ($NoPlugin) {
  Note 'skipped (-NoPlugin)'
} elseif (-not $SourceCheckout) {
  Ok 'already installed from a marketplace (this is a release install); nothing to register'
} else {
  # A source checkout loads in place through CLAUDE_CODE_PLUGIN_DIRS (the variable form of --plugin-dir), so rebuilds
  # reach running sessions and the version never matters. It takes precedence over an installed firefox-use.
  # (.claude-plugin/marketplace.json is the public marketplace: it installs the published release.)
  $dirs = @(([Environment]::GetEnvironmentVariable('CLAUDE_CODE_PLUGIN_DIRS', 'User') -split ';') | Where-Object { $_ })
  $isOtherCheckout = {
    param($d)
    $manifest = Join-Path $d '.claude-plugin\plugin.json'
    (Test-Path $manifest) -and ((Get-Content -Raw $manifest | ConvertFrom-Json).name -eq 'firefox-use')
  }
  # keep other plugins' folders; drop folders that are gone (a moved or renamed checkout) and other firefox-use checkouts
  $keep = @($dirs | Where-Object { (Test-Path $_) -and ($_ -ne $Repo) -and -not (& $isOtherCheckout $_) })
  $new = @($keep) + $Repo
  if (($new -join ';') -ne ($dirs -join ';')) {
    [Environment]::SetEnvironmentVariable('CLAUDE_CODE_PLUGIN_DIRS', ($new -join ';'), 'User')
    Ok "CLAUDE_CODE_PLUGIN_DIRS (your user environment) now loads the plugin from $Repo"
    Note 'Restart Claude Code (the desktop app too) so new sessions see it.'
  } else {
    Ok "CLAUDE_CODE_PLUGIN_DIRS already loads the plugin from $Repo"
  }
}

Write-Host "`nDone." -ForegroundColor Green
Write-Host 'Emergency stop at any time:  powershell -ExecutionPolicy Bypass -File' (Join-Path $PSScriptRoot 'kill.ps1')
