param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'deployment\vercel-stable-projects.json'
$outputRoot = Join-Path $projectRoot 'dist\vercel-stable-projects'
$vercelCommand = Get-Command vercel -ErrorAction Stop

if (-not $SkipBuild) {
    & node (Join-Path $PSScriptRoot 'build-vercel-stable-projects.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Stable Vercel build failed.' }
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
foreach ($entry in $manifest.projects.PSObject.Properties) {
    $originId = $entry.Name
    $project = $entry.Value.project
    $projectDirectory = Join-Path $outputRoot $originId

    & $vercelCommand.Source link --yes --project $project --cwd $projectDirectory
    if ($LASTEXITCODE -ne 0) { throw "Vercel link failed for $project." }

    & $vercelCommand.Source deploy --prod --yes --cwd $projectDirectory
    if ($LASTEXITCODE -ne 0) { throw "Vercel production deployment failed for $project." }
}
