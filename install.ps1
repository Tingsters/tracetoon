# Tracetoon installer for Windows (PowerShell 5.1 or 7+).
#
#   irm https://raw.githubusercontent.com/Tingsters/tracetoon/main/install.ps1 | iex
#
# Installs the Tracetoon skill for every agent found on this machine (Claude Code,
# Codex, Antigravity, Gemini CLI), caches the prebuilt binary so nothing else
# (Bun, Node) is needed, and adds a small hook to each agent that routes
# `gh pr create` through Tracetoon. Re-run to update.
#
# Options (environment variables):
#   $env:TRACETOON_VERSION = 'v1.2.3'   install a specific release (default: newest)
#   $env:TRACETOON_NO_HOOK = '1'        skip the PR hook (add it later: tracetoon hook install)
#   $env:TRACETOON_UNINSTALL = '1'      remove the skill, the hooks and the cached binary
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

# The binary lives at a fixed path, so agent hooks keep working (and Codex keeps
# its trust) across updates. The launchers check it first.
$homeRoot = Join-Path $env:LOCALAPPDATA 'tracetoon'
$stable = Join-Path (Join-Path $homeRoot 'bin') 'tracetoon.exe'
$targets = @(Get-Targets)

if ($env:TRACETOON_UNINSTALL -eq '1') {
  # Hooks first, while the binary is still around to remove them.
  if (Test-Path $stable) { & $stable hook uninstall }
  foreach ($t in $targets) {
    if (Test-Path $t.Dir) { Remove-Item -Recurse -Force $t.Dir; Write-Host "removed from $($t.Name) ($($t.Dir))" }
  }
  if (Test-Path $homeRoot) { Remove-Item -Recurse -Force $homeRoot }
  Write-Host 'Tracetoon uninstalled.'
  return
}

if ($targets.Count -eq 0) { throw 'No supported agent found (Claude Code, Codex, Antigravity, Gemini CLI).' }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$bin = "tracetoon-windows-$arch.exe"
$headers = @{ 'User-Agent' = 'tracetoon-installer' }
$tag = $env:TRACETOON_VERSION
if (-not $tag) {
  # Newest release, including release candidates. The API sorts by tag name
  # (so rc.10 lands before rc.2), not by date: pick the latest published one.
  $releases = Invoke-RestMethod -Headers $headers "https://api.github.com/repos/$repo/releases?per_page=30"
  $tag = (@($releases) | Where-Object { -not $_.draft -and $_.published_at } |
    Sort-Object { [datetime]$_.published_at } -Descending | Select-Object -First 1).tag_name
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

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stable) | Out-Null
  & (Join-Path $tmp $bin) --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Downloaded binary does not run.' }
  Copy-Item -Force (Join-Path $tmp $bin) $stable
  $exe = $stable
  # Binaries cached by older versions are no longer needed.
  Remove-Item -Recurse -Force (Join-Path $homeRoot 'cache') -ErrorAction SilentlyContinue

  Write-Host 'Skill:'
  foreach ($t in $targets) {
    if (Test-Path $t.Dir) { Remove-Item -Recurse -Force $t.Dir }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $t.Dir) | Out-Null
    Copy-Item -Recurse $skill $t.Dir
    Write-Host "  $($t.Name): $($t.Dir)"
  }

  if ($env:TRACETOON_NO_HOOK -eq '1') {
    Write-Host 'PR hook: skipped (add it later with: tracetoon hook install)'
  } else {
    Write-Host 'PR hook (routes gh pr create through Tracetoon; turn off with: tracetoon off):'
    & $exe hook install
    if ($LASTEXITCODE -ne 0) { Write-Host '  could not add the PR hook; the skill still works' }
  }
  Write-Host 'Done. Restart your agent, then ask it to open a PR.'
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
