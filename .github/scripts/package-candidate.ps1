param([Parameter(Mandatory=$true)][string]$SkillDir,[Parameter(Mandatory=$true)][string]$ReleaseDir)
$ErrorActionPreference = 'Stop'
$candidateSkill = (Resolve-Path -LiteralPath $SkillDir).Path
$candidateRelease = (Resolve-Path -LiteralPath $ReleaseDir).Path
python -B (Join-Path $PSScriptRoot 'package_candidate.py') --skill $candidateSkill --release $candidateRelease
if ($LASTEXITCODE -ne 0) { throw 'Portable candidate packaging failed.' }
