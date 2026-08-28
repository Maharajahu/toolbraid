param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot 'deployment\vercel-stable-projects.json'
$outputRoot = Join-Path $projectRoot 'dist\vercel-stable-projects'
$vercelCommand = Get-Command vercel -ErrorAction Stop
$vercelScope = $env:TOOLBRAID_VERCEL_SCOPE
if ([string]::IsNullOrWhiteSpace($vercelScope)) {
    throw 'TOOLBRAID_VERCEL_SCOPE must name the exact Vercel user or team that owns the seven projects.'
}

if (-not $SkipBuild) {
    & node (Join-Path $PSScriptRoot 'build-vercel-stable-projects.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Stable Vercel build failed.' }
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$providerEntries = @($manifest.projects.PSObject.Properties | Where-Object Name -ne 'app')
$appEntry = @($manifest.projects.PSObject.Properties | Where-Object Name -eq 'app')
foreach ($entry in @($providerEntries + $appEntry)) {
    $originId = $entry.Name
    $project = $entry.Value.project
    $projectDirectory = Join-Path $outputRoot $originId

    & $vercelCommand.Source link --yes --project $project --scope $vercelScope --cwd $projectDirectory
    if ($LASTEXITCODE -ne 0) { throw "Vercel link failed for $project." }

    $linkPath = Join-Path $projectDirectory '.vercel\project.json'
    $link = Get-Content -Raw -LiteralPath $linkPath | ConvertFrom-Json
    if ($link.projectName -ne $project -or [string]::IsNullOrWhiteSpace($link.projectId) -or [string]::IsNullOrWhiteSpace($link.orgId)) {
        throw "Vercel link verification failed for $project under scope $vercelScope."
    }

    & $vercelCommand.Source deploy --prod --yes --scope $vercelScope --cwd $projectDirectory
    if ($LASTEXITCODE -ne 0) { throw "Vercel production deployment failed for $project." }
}

$previousNativeBaseUrl = $env:TOOLBRAID_NATIVE_BASE_URL
$previousNativeReadOnly = $env:TOOLBRAID_NATIVE_READ_ONLY
try {
    $env:TOOLBRAID_NATIVE_BASE_URL = $manifest.projects.app.origin
    $env:TOOLBRAID_NATIVE_READ_ONLY = '1'
    & python (Join-Path $PSScriptRoot 'e2e-native.py')
    if ($LASTEXITCODE -ne 0) { throw 'Public native read-only gate failed after deployment.' }
}
finally {
    $env:TOOLBRAID_NATIVE_BASE_URL = $previousNativeBaseUrl
    $env:TOOLBRAID_NATIVE_READ_ONLY = $previousNativeReadOnly
}
