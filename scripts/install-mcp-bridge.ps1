[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Convert-ToCSharpVerbatimLiteral([string] $Value) {
  return $Value.Replace('"', '""')
}

function Get-ExtensionId([string] $PublicKey) {
  $bytes = [Convert]::FromBase64String($PublicKey)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
  $alphabet = 'abcdefghijklmnop'
  $builder = [System.Text.StringBuilder]::new(32)
  foreach ($byte in $hash[0..15]) {
    [void]$builder.Append($alphabet[[int]($byte -shr 4)])
    [void]$builder.Append($alphabet[[int]($byte -band 15)])
  }
  return $builder.ToString()
}

function Remove-ToolBraidMcpBlock([string[]] $Lines) {
  $result = [System.Collections.Generic.List[string]]::new()
  $skipping = $false
  foreach ($line in $Lines) {
    if ($line -match '^\[mcp_servers\.toolbraid(?:\.[^\]]+)?\]\s*$') {
      $skipping = $true
      continue
    }
    if ($skipping -and $line -match '^\[') { $skipping = $false }
    if (-not $skipping) { $result.Add($line) }
  }
  return $result.ToArray()
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifestPath = Join-Path $projectRoot 'extension\manifest.json'
$hostScriptPath = Join-Path $projectRoot 'bridge\native-host.mjs'
$mcpServerPath = Join-Path $projectRoot 'bridge\mcp-server.mjs'
$launcherTemplatePath = Join-Path $projectRoot 'bridge\ToolBraidNativeHostLauncher.cs'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($manifest.key)) { throw 'The extension manifest requires a stable public key.' }
$extensionId = Get-ExtensionId $manifest.key
$allowedOrigin = "chrome-extension://$extensionId/"

$installRoot = Join-Path $projectRoot '.private\mcp-bridge'
$nativeHostRoot = Join-Path $projectRoot 'dist\toolbraid-native-host'
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
New-Item -ItemType Directory -Path $nativeHostRoot -Force | Out-Null
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& "$env:WINDIR\System32\icacls.exe" $installRoot '/inheritance:r' '/grant:r' ("*$currentSid`:(OI)(CI)F") '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the ToolBraid bridge directory ACL.' }

$configPath = Join-Path $installRoot 'bridge-config.json'
$token = $null
if (Test-Path -LiteralPath $configPath) {
  try {
    $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($existing.token -match '^[a-f0-9]{64}$') { $token = $existing.token }
  } catch { $token = $null }
}
if (-not $token) {
  $random = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
  $token = ([BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant()
}
$pipeName = "\\.\pipe\toolbraid-mcp-$($token.Substring(0, 32))"
$config = [ordered]@{
  version = 1
  token = $token
  pipe = $pipeName
  allowedOrigin = $allowedOrigin
}
[System.IO.File]::WriteAllText($configPath, (($config | ConvertTo-Json -Depth 4) + "`n"), [System.Text.UTF8Encoding]::new($false))

$launcherSourcePath = Join-Path $installRoot 'ToolBraidNativeHostLauncher.cs'
$launcherExePath = Join-Path $nativeHostRoot 'ToolBraidNativeHost.exe'
$launcherSource = Get-Content -LiteralPath $launcherTemplatePath -Raw
$launcherSource = $launcherSource.Replace('__TOOLBRAID_NODE_PATH__', (Convert-ToCSharpVerbatimLiteral $nodePath))
$launcherSource = $launcherSource.Replace('__TOOLBRAID_HOST_SCRIPT_PATH__', (Convert-ToCSharpVerbatimLiteral $hostScriptPath))
$launcherSource = $launcherSource.Replace('__TOOLBRAID_CONFIG_PATH__', (Convert-ToCSharpVerbatimLiteral $configPath))
[System.IO.File]::WriteAllText($launcherSourcePath, $launcherSource, [System.Text.UTF8Encoding]::new($false))
$cscPath = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $cscPath)) { $cscPath = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path -LiteralPath $cscPath)) { throw 'The Windows C# compiler required for the native host launcher was not found.' }
& $cscPath '/nologo' '/target:exe' "/out:$launcherExePath" $launcherSourcePath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExePath)) { throw 'The ToolBraid native host launcher could not be built.' }

$nativeManifestPath = Join-Path $nativeHostRoot 'com.toolbraid.mcp_bridge.json'
$nativeManifest = [ordered]@{
  name = 'com.toolbraid.mcp_bridge'
  description = 'Secure local ToolBraid Chrome to MCP bridge'
  path = $launcherExePath
  type = 'stdio'
  allowed_origins = @($allowedOrigin)
}
[System.IO.File]::WriteAllText($nativeManifestPath, (($nativeManifest | ConvertTo-Json -Depth 4) + "`n"), [System.Text.UTF8Encoding]::new($false))
$registryPath = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.toolbraid.mcp_bridge'
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $nativeManifestPath

$codexConfigPath = Join-Path $env:USERPROFILE '.codex\config.toml'
if (-not (Test-Path -LiteralPath $codexConfigPath)) { throw "Codex config was not found at $codexConfigPath" }
if ($nodePath.Contains("'") -or $mcpServerPath.Contains("'") -or $configPath.Contains("'")) { throw 'Bridge paths containing apostrophes are unsupported.' }
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $codexConfigPath -Destination "$codexConfigPath.toolbraid-$timestamp.bak" -Force
$existingLines = [System.IO.File]::ReadAllLines($codexConfigPath)
$keptLines = Remove-ToolBraidMcpBlock $existingLines
$block = @(
  '',
  '[mcp_servers.toolbraid]',
  "command = '$nodePath'",
  "args = ['$mcpServerPath', '--config', '$configPath']",
  'startup_timeout_sec = 10',
  'tool_timeout_sec = 60'
)
$updated = @($keptLines) + $block
[System.IO.File]::WriteAllLines($codexConfigPath, $updated, [System.Text.UTF8Encoding]::new($false))

& $nodePath (Join-Path $projectRoot 'scripts\build-universal-extension.mjs') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The ToolBraid extension build failed.' }

[ordered]@{
  installed = $true
  extensionId = $extensionId
  extensionDirectory = (Join-Path $projectRoot 'dist\toolbraid-universal-extension')
  nativeHostManifest = $nativeManifestPath
  codexConfig = $codexConfigPath
  requiresChromeExtensionReload = $true
  requiresCodexRestart = $true
} | ConvertTo-Json -Depth 4
