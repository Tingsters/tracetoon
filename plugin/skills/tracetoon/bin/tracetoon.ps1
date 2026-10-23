# Tracetoon launcher for Windows. Same order as bin/tracetoon:
# $env:TRACETOON_BIN, shipped or cached binary, bun or node 22+ with the bundle,
# then (only with TRACETOON_ALLOW_DOWNLOAD=1) a checksum-verified gh download.
# Exits 3 when nothing works, so the skill can fall back to manual mode.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$skill = Split-Path -Parent $here
$ver = '0.0.0'
if (Test-Path (Join-Path $skill 'VERSION')) { $ver = (Get-Content (Join-Path $skill 'VERSION') -Raw).Trim() }

if ($env:TRACETOON_BIN) { & $env:TRACETOON_BIN @args; exit $LASTEXITCODE }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$name = "tracetoon-windows-$arch.exe"
$cacheRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME '.cache' }
$cache = Join-Path (Join-Path (Join-Path $cacheRoot 'tracetoon') 'cache') $ver

foreach ($c in @((Join-Path $here $name), (Join-Path $cache $name))) {
  if (Test-Path $c) { & $c @args; exit $LASTEXITCODE }
}

$bundle = Join-Path (Join-Path $skill 'dist') 'tracetoon.mjs'
if (Test-Path $bundle) {
  if (Get-Command bun -ErrorAction SilentlyContinue) { & bun $bundle @args; exit $LASTEXITCODE }
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $major = [int](& node -p 'process.versions.node.split(".")[0]')
    if ($major -ge 22) { & node $bundle @args; exit $LASTEXITCODE }
  }
}

if ($env:TRACETOON_ALLOW_DOWNLOAD -eq '1' -and (Get-Command gh -ErrorAction SilentlyContinue)) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("tracetoon-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  & gh release download "v$ver" -R Tingsters/tracetoon -p $name -D $tmp 2>$null | Out-Null
  $file = Join-Path $tmp $name
  if (Test-Path $file) {
    # Prefer a checksum pinned in the skill; otherwise use the release's own list.
    $line = Get-Content (Join-Path $skill 'checksums.txt') -ErrorAction SilentlyContinue | Where-Object { $_ -match " $([regex]::Escape($name))$" }
    if (-not $line) {
      & gh release download "v$ver" -R Tingsters/tracetoon -p checksums.txt -D $tmp 2>$null | Out-Null
      $line = Get-Content (Join-Path $tmp 'checksums.txt') -ErrorAction SilentlyContinue | Where-Object { $_ -match " $([regex]::Escape($name))$" }
    }
    $want = if ($line) { ($line -split ' ')[0] } else { '' }
    $got = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
    if ($want -and $want.ToLower() -eq $got) {
      New-Item -ItemType Directory -Force -Path $cache | Out-Null
      Move-Item -Force $file (Join-Path $cache $name)
      Remove-Item -Recurse -Force $tmp
      & (Join-Path $cache $name) @args
      exit $LASTEXITCODE
    }
    Write-Error 'tracetoon: downloaded binary failed its checksum; not running it.' -ErrorAction Continue
  }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

[Console]::Error.WriteLine('tracetoon: no way to run Tracetoon here (no bun, no node 22+, no cached binary).')
[Console]::Error.WriteLine('tracetoon: set TRACETOON_ALLOW_DOWNLOAD=1 to fetch the release binary with gh.')
exit 3
