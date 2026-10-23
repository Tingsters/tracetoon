# Tracetoon installer for Windows (PowerShell 5.1 or 7+).
#
#   irm https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.ps1 | iex
#
# Installs the Tracetoon skill for every agent found on this machine (Claude Code,
# Codex, Antigravity, Gemini CLI) and caches the prebuilt binary, so nothing else
# (Bun, Node) is needed. Re-run to update.
#
# Options (environment variables):
#   $env:TRACETOON_VERSION = 'v1.2.3'   install a specific release (default: newest)
#   $env:TRACETOON_UNINSTALL = '1'      remove the skill from every agent and the cached binary
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = 'Tingsters/tracetoon'

function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Get-Targets {
  $t = @()
  $claude = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
  if ((Test-Path $claude) -or (Has 'claude')) { $t += [pscustomobject]@{ Name = 'Claude Code'; Dir = Join-Path $claude 'skills\tracetoon' } }
  $codex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
  if ((Test-Path $codex) -or (Has 'codex')) { $t += [pscustomobject]@{ Name = 'Codex'; Dir = Join-Path $HOME '.agents\skills\tracetoon' } }
  $gemini = if ($env:GEMINI_HOME) { $env:GEMINI_HOME } else { Join-Path $HOME '.gemini' }
  if ((Test-Path (Join-Path $gemini 'antigravity-cli')) -or (Test-Path (Join-Path $gemini 'antigravity-ide')) -or (Has 'agy')) {
    $t += [pscustomobject]@{ Name = 'Antigravity'; Dir = Join-Path $gemini 'config\skills\tracetoon' }
  }
  if (Has 'gemini') { $t += [pscustomobject]@{ Name = 'Gemini CLI'; Dir = Join-Path $gemini 'skills\tracetoon' } }
  return $t
}

$cacheRoot = Join-Path (Join-Path $env:LOCALAPPDATA 'tracetoon') 'cache'
$targets = @(Get-Targets)

if ($env:TRACETOON_UNINSTALL -eq '1') {
  foreach ($t in $targets) {
    if (Test-Path $t.Dir) { Remove-Item -Recurse -Force $t.Dir; Write-Host "removed from $($t.Name) ($($t.Dir))" }
  }
  if (Test-Path $cacheRoot) { Remove-Item -Recurse -Force $cacheRoot }
  Write-Host 'Tracetoon uninstalled.'
  return
}

if ($targets.Count -eq 0) { throw 'No supported agent found (Claude Code, Codex, Antigravity, Gemini CLI).' }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$bin = "tracetoon-windows-$arch.exe"
$headers = @{ 'User-Agent' = 'tracetoon-installer' }
$tag = $env:TRACETOON_VERSION
if (-not $tag) {
  # Newest release, including release candidates.
  $releases = Invoke-RestMethod -Headers $headers "https://api.github.com/repos/$repo/releases?per_page=1"
  $tag = @($releases)[0].tag_name
  if (-not $tag) { throw 'Could not find a Tracetoon release.' }
}
$ver = $tag.TrimStart('v')
$base = "https://github.com/$repo/releases/download/$tag"
Write-Host "Installing Tracetoon $tag (windows-$arch)"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("tracetoon-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Headers $headers "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt')
  $sums = Get-Content (Join-Path $tmp 'checksums.txt')
  foreach ($f in @('tracetoon-skill.zip', $bin)) {
    $path = Join-Path $tmp $f
    Invoke-WebRequest -UseBasicParsing -Headers $headers "$base/$f" -OutFile $path
    $line = $sums | Where-Object { $_ -match " $([regex]::Escape($f))$" }
    $want = if ($line) { ($line -split ' ')[0].ToLower() } else { '' }
    $got = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLower()
    if (-not $want -or $want -ne $got) { throw "Checksum mismatch for $f; not installing." }
  }

  $skillTmp = Join-Path $tmp 'skill'
  Expand-Archive -Path (Join-Path $tmp 'tracetoon-skill.zip') -DestinationPath $skillTmp
  $skill = Join-Path $skillTmp 'tracetoon'
  if (-not (Test-Path (Join-Path $skill 'SKILL.md'))) { throw 'Skill archive is missing SKILL.md.' }

  $cache = Join-Path $cacheRoot $ver
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  Copy-Item -Force (Join-Path $tmp $bin) (Join-Path $cache $bin)

  foreach ($t in $targets) {
    if (Test-Path $t.Dir) { Remove-Item -Recurse -Force $t.Dir }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $t.Dir) | Out-Null
    Copy-Item -Recurse $skill $t.Dir
    Write-Host "  $($t.Name): $($t.Dir)"
  }

  & (Join-Path $cache $bin) --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Installed binary does not run.' }
  Write-Host 'Done. Restart your agent, then ask it to "open a PR with Tracetoon".'
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
