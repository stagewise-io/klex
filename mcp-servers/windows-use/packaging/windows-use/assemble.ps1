param(
  [string]$WindowsMcpBundle = "../windows-mcp/artifacts/windows-mcp-0.8.2-win-x64",
  [string]$OutputDirectory = "./artifacts"
)

$ErrorActionPreference = "Stop"
$PackageRoot = Split-Path -Parent $PSScriptRoot
$WindowsUseRoot = Split-Path -Parent $PackageRoot
$RepositoryRoot = Resolve-Path (Join-Path $WindowsUseRoot "../..")
$ResolvedMcpBundle = Resolve-Path (Join-Path $PSScriptRoot $WindowsMcpBundle)
$ResolvedOutput = Join-Path $PSScriptRoot $OutputDirectory
$Stage = Join-Path $ResolvedOutput "stagewise-windows-use-win-x64"
$Zip = Join-Path $ResolvedOutput "stagewise-windows-use-win-x64.zip"

Push-Location $RepositoryRoot
try {
  pnpm --filter @stagewise/windows-use build:exe
  if ($LASTEXITCODE -ne 0) { throw "Windows Use executable build failed" }
} finally {
  Pop-Location
}

Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item $Stage -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $WindowsUseRoot "dist/stagewise-windows-use.exe") $Stage
Copy-Item (Join-Path $PSScriptRoot "windows-use.config.json") $Stage
Copy-Item (Join-Path $PSScriptRoot "README.txt") $Stage
Copy-Item $ResolvedMcpBundle (Join-Path $Stage "windows-mcp") -Recurse

Remove-Item $Zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $Zip -CompressionLevel Optimal
Write-Host "Portable Windows Use bundle: $Zip"
