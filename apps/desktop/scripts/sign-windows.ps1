# Signs one file with Azure Artifact Signing. Tauri calls this through
# bundle.windows.signCommand (set by scripts/release/release-config.ts) for
# the app executable, the NSIS installer and its uninstaller. The release
# workflow's "Configure Azure Trusted Signing" step sets the variables.
param(
  [Parameter(Mandatory = $true)]
  [string] $Path
)

$ErrorActionPreference = 'Stop'

foreach ($name in 'SIGNTOOL_PATH', 'AZURE_CODE_SIGNING_DLIB', 'AZURE_METADATA_JSON') {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "$name is not set; Windows release builds must configure Azure Trusted Signing first"
  }
}

& $env:SIGNTOOL_PATH sign /v /fd sha256 /tr http://timestamp.acs.microsoft.com /td sha256 `
  /dlib $env:AZURE_CODE_SIGNING_DLIB /dmdf $env:AZURE_METADATA_JSON $Path
if ($LASTEXITCODE -ne 0) {
  throw "signtool sign failed with exit code $LASTEXITCODE for $Path"
}

& $env:SIGNTOOL_PATH verify /pa /all $Path
if ($LASTEXITCODE -ne 0) {
  throw "signtool verify failed with exit code $LASTEXITCODE for $Path"
}
