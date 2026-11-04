param([Parameter(Mandatory=$true)][string]$SkillDir,[Parameter(Mandatory=$true)][string]$ReleaseDir)
$ErrorActionPreference = 'Stop'
$candidateSkill = (Resolve-Path -LiteralPath $SkillDir).Path
$candidateRelease = (Resolve-Path -LiteralPath $ReleaseDir).Path
$candidateManifest = Get-Content -LiteralPath (Join-Path $candidateSkill 'build.json') -Raw | ConvertFrom-Json
if (@(Get-ChildItem -LiteralPath (Join-Path $candidateSkill 'bin') -Filter 'tracetoon-*-*').Count -ne 0) { throw 'Base skill contains stale platform runtimes.' }
Compress-Archive -LiteralPath $candidateSkill -DestinationPath (Join-Path $candidateRelease 'tracetoon-skill.zip')
foreach ($candidateTarget in $candidateManifest.recipe.native.targets) {
  $candidateStage = Join-Path ([IO.Path]::GetTempPath()) ('tracetoon-candidate-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $candidateStage | Out-Null
  Copy-Item -LiteralPath $candidateSkill -Destination (Join-Path $candidateStage 'tracetoon') -Recurse
  $candidateSuffix = if ($candidateTarget.StartsWith('windows-')) { '.exe' } else { '' }
  $candidateBinary = 'tracetoon-' + $candidateTarget + $candidateSuffix
  foreach ($candidateFile in @($candidateBinary, ($candidateBinary + '.build.json'))) {
    Copy-Item -LiteralPath (Join-Path $candidateRelease $candidateFile) -Destination (Join-Path $candidateStage ('tracetoon/bin/' + $candidateFile))
  }
  Compress-Archive -LiteralPath (Join-Path $candidateStage 'tracetoon') -DestinationPath (Join-Path $candidateRelease ('tracetoon-skill-' + $candidateTarget + '.zip'))
}
