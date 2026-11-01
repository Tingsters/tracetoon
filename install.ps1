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
  $binDir = Split-Path -Parent $stable
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -and (($userPath -split ';') -contains $binDir)) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath -split ';') | Where-Object { $_ -and $_ -ne $binDir }) -join ';', 'User')
  }
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
$staged = @()
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
  $manifest = Get-Content (Join-Path $skill 'build.json') -Raw | ConvertFrom-Json
  $binaryInfo = & (Join-Path $tmp $bin) build-info --json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $manifest.version -ne $ver -or $binaryInfo.version -ne $ver -or $manifest.buildId -ne $binaryInfo.buildId) {
    throw 'Downloaded skill and runtime are different builds; nothing was activated.'
  }
  # Stage every skill before replacing any installed component. All moves stay
  # beside their explicitly selected tracetoon directory.
  foreach ($t in $targets) {
    $targetPath = [IO.Path]::GetFullPath($t.Dir)
    if ((Split-Path -Leaf $targetPath) -ne 'tracetoon') { throw "Unexpected install target: $targetPath" }
    $stagePath = $targetPath + '.new-' + [guid]::NewGuid().ToString('N')
    $backupPath = $targetPath + '.old-' + [guid]::NewGuid().ToString('N')
    $parentPath = Split-Path -Parent $targetPath
    if ((Split-Path -Parent ([IO.Path]::GetFullPath($stagePath))) -ne $parentPath -or (Split-Path -Parent ([IO.Path]::GetFullPath($backupPath))) -ne $parentPath) { throw 'Install staging escaped its target parent.' }
    New-Item -ItemType Directory -Force -Path $parentPath | Out-Null
    Copy-Item -LiteralPath $skill -Destination $stagePath -Recurse
    $staged += [pscustomobject]@{ Name = $t.Name; Target = $targetPath; Stage = $stagePath; Backup = $backupPath }
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stable) | Out-Null
  & (Join-Path $tmp $bin) --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Downloaded binary does not run.' }
  Copy-Item -LiteralPath (Join-Path $tmp $bin) -Destination ($stable + '.new') -Force
  # Agent hooks start this binary all the time, and Windows refuses to overwrite
  # a file a process is loading. It does allow a rename, so set the old binary
  # aside, move the new one in, and delete the old one once nothing uses it.
  $binDir = Split-Path -Parent $stable
  # Earlier set-aside copies are only safe to delete while a binary is in place.
  if (Test-Path -LiteralPath $stable) {
    Get-ChildItem -LiteralPath $binDir -Filter 'tracetoon.exe.old-*' -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
  }
  $aside = $stable + '.old-' + [guid]::NewGuid().ToString('N')
  if (Test-Path -LiteralPath $stable) { Move-Item -LiteralPath $stable -Destination $aside }
  try { Move-Item -LiteralPath ($stable + '.new') -Destination $stable }
  catch {
    $moveError = $_
    # Put the old binary back; report the original failure either way.
    if (Test-Path -LiteralPath $aside) { Move-Item -LiteralPath $aside -Destination $stable -ErrorAction SilentlyContinue }
    throw $moveError
  }
  Remove-Item -LiteralPath $aside -Force -ErrorAction SilentlyContinue
  $exe = $stable
  # The binary finds its comic fonts and renderer at ..\assets, beside bin\,
  # so it can render comics when run directly (not only through a skill).
  # Same set-aside swap, so a failure never leaves assets half removed.
  $assets = Join-Path $homeRoot 'assets'
  # Keep the last set-aside copy if an earlier restore left no active assets.
  if (Test-Path -LiteralPath $assets) {
    Get-ChildItem -LiteralPath $homeRoot -Directory -Filter 'assets.old-*' -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
  $assetsNew = $assets + '.new-' + [guid]::NewGuid().ToString('N')
  $assetsOld = $assets + '.old-' + [guid]::NewGuid().ToString('N')
  Copy-Item -LiteralPath (Join-Path $skill 'assets') -Destination $assetsNew -Recurse
  if (Test-Path -LiteralPath $assets) { Move-Item -LiteralPath $assets -Destination $assetsOld }
  try { Move-Item -LiteralPath $assetsNew -Destination $assets }
  catch {
    $moveError = $_
    if (Test-Path -LiteralPath $assetsOld) { Move-Item -LiteralPath $assetsOld -Destination $assets -ErrorAction SilentlyContinue }
    throw $moveError
  }
  Remove-Item -LiteralPath $assetsOld -Recurse -Force -ErrorAction SilentlyContinue
  # Binaries cached by older versions are no longer needed.
  Remove-Item -Recurse -Force (Join-Path $homeRoot 'cache') -ErrorAction SilentlyContinue

  Write-Host 'Skill:'
  foreach ($t in $staged) {
    if (Test-Path -LiteralPath $t.Target) { Move-Item -LiteralPath $t.Target -Destination $t.Backup }
    try { Move-Item -LiteralPath $t.Stage -Destination $t.Target }
    catch {
      if (Test-Path -LiteralPath $t.Backup) { Move-Item -LiteralPath $t.Backup -Destination $t.Target }
      throw
    }
    if (Test-Path -LiteralPath $t.Backup) { Remove-Item -LiteralPath $t.Backup -Recurse -Force }
    Write-Host "  $($t.Name): $($t.Target)"
  }

  if ($env:TRACETOON_NO_HOOK -eq '1') {
    Write-Host 'PR hook: skipped (add it later with: tracetoon hook install)'
  } else {
    Write-Host 'PR hook (routes gh pr create through Tracetoon; turn off with: tracetoon off):'
    & $exe hook install
    if ($LASTEXITCODE -ne 0) { Write-Host '  could not add the PR hook; the skill still works' }
  }

  # A `tracetoon` command for your own terminal: the bin folder on the user PATH.
  $binDir = Split-Path -Parent $stable
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $binDir)) {
    [Environment]::SetEnvironmentVariable('Path', (@($userPath, $binDir) | Where-Object { $_ }) -join ';', 'User')
    Write-Host "Command: tracetoon (added $binDir to your PATH; new terminals will see it)"
  } else {
    Write-Host 'Command: tracetoon'
  }

  # Comics need an image route: say what's there and what to do next.
  & $exe images --brief
  Write-Host 'Done. Restart your agent, then ask it to open a PR.'
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  # After a failure, leave no half-installed copies beside the real ones.
  foreach ($s in $staged) {
    if (Test-Path -LiteralPath $s.Stage) { Remove-Item -LiteralPath $s.Stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath ($stable + '.new') -Force -ErrorAction SilentlyContinue
  if ($assetsNew -and (Test-Path -LiteralPath $assetsNew)) { Remove-Item -LiteralPath $assetsNew -Recurse -Force -ErrorAction SilentlyContinue }
}
