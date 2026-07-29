[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ExecutablePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SigningConfiguration = [ordered]@{
    SIGNTOOL_PATH = $env:SIGNTOOL_PATH
    AZURE_CODE_SIGNING_DLIB = $env:AZURE_CODE_SIGNING_DLIB
    AZURE_METADATA_JSON = $env:AZURE_METADATA_JSON
}
$ConfiguredValues = @(
    $SigningConfiguration.GetEnumerator() |
        Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.Value) }
)
$SigningRequired = $env:WINDOWS_SIGNING_REQUIRED -in @("1", "true", "TRUE", "yes", "YES")

if ($ConfiguredValues.Count -eq 0) {
    if ($SigningRequired) {
        throw "Windows signing is required, but signing configuration is absent."
    }

    Write-Host "Windows signing skipped because signing configuration is absent."
    return
}

if ($ConfiguredValues.Count -ne $SigningConfiguration.Count) {
    $MissingVariables = @(
        $SigningConfiguration.GetEnumerator() |
            Where-Object { [string]::IsNullOrWhiteSpace([string]$_.Value) } |
            ForEach-Object { $_.Key }
    )
    throw "Windows signing configuration is incomplete; missing: $($MissingVariables -join ', ')."
}

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "Executable to sign does not exist: $ExecutablePath"
}
foreach ($PathEntry in @(
    $SigningConfiguration.SIGNTOOL_PATH,
    $SigningConfiguration.AZURE_CODE_SIGNING_DLIB,
    $SigningConfiguration.AZURE_METADATA_JSON
)) {
    if (-not (Test-Path -LiteralPath $PathEntry -PathType Leaf)) {
        throw "Windows signing dependency does not exist: $PathEntry"
    }
}

$ResolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$SignTool = (Resolve-Path -LiteralPath $SigningConfiguration.SIGNTOOL_PATH).Path
$Dlib = (Resolve-Path -LiteralPath $SigningConfiguration.AZURE_CODE_SIGNING_DLIB).Path
$Metadata = (Resolve-Path -LiteralPath $SigningConfiguration.AZURE_METADATA_JSON).Path

Write-Host "Signing $ResolvedExecutable with Azure Trusted Signing."
& $SignTool sign `
    /fd sha256 `
    /tr http://timestamp.acs.microsoft.com `
    /td sha256 `
    /dlib $Dlib `
    /dmdf $Metadata `
    $ResolvedExecutable
if ($LASTEXITCODE -ne 0) {
    throw "SignTool failed to sign $ResolvedExecutable with exit code $LASTEXITCODE."
}

Write-Host "Verifying Authenticode signature for $ResolvedExecutable."
& $SignTool verify /pa /all /v $ResolvedExecutable
if ($LASTEXITCODE -ne 0) {
    throw "SignTool failed to verify $ResolvedExecutable with exit code $LASTEXITCODE."
}
