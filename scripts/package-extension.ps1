$ErrorActionPreference = 'Stop'
$syncProjectRoot = Split-Path -Parent $PSScriptRoot
$syncExtensionRoot = Join-Path $syncProjectRoot 'extension'
Copy-Item -LiteralPath (Join-Path $syncProjectRoot 'web/sha256.js') -Destination (Join-Path $syncExtensionRoot 'sha256.js') -Force
Copy-Item -LiteralPath (Join-Path $syncProjectRoot 'web/links.js') -Destination (Join-Path $syncExtensionRoot 'links.js') -Force
$syncManifest = Get-Content -Raw -LiteralPath (Join-Path $syncExtensionRoot 'manifest.json') | ConvertFrom-Json
if ($syncManifest.manifest_version -ne 3) { throw 'Expected a Manifest V3 extension.' }
$syncPackageDirectory = Join-Path $syncProjectRoot 'dist'
New-Item -ItemType Directory -Force $syncPackageDirectory | Out-Null
$syncPackagePath = Join-Path $syncPackageDirectory 'sync-chrome-extension.zip'
Compress-Archive -Path (Join-Path $syncExtensionRoot '*') -DestinationPath $syncPackagePath -Force
Write-Output $syncPackagePath
