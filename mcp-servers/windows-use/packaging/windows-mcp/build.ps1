[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ExpectedUvVersion = "0.11.33"
$WindowsMcpVersion = "0.8.2"
$ArtifactName = "windows-mcp-$WindowsMcpVersion-win-x64"
$ProjectDirectory = $PSScriptRoot

if (-not $IsWindows) {
    throw "Windows-MCP artifacts must be built on Windows."
}
$osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if (
    -not [Environment]::Is64BitOperatingSystem -or
    -not [Environment]::Is64BitProcess -or
    $osArchitecture -ne [System.Runtime.InteropServices.Architecture]::X64
) {
    throw "Windows-MCP artifacts require a 64-bit Windows process on x64 Windows."
}

$uvCommand = Get-Command uv -ErrorAction SilentlyContinue
if ($null -eq $uvCommand) {
    throw "uv $ExpectedUvVersion is required to build Windows-MCP."
}
$uvVersionOutput = (& uv --version).Trim()
if ($LASTEXITCODE -ne 0 -or $uvVersionOutput -notmatch "^uv ([0-9.]+)") {
    throw "Unable to determine the installed uv version."
}
if ($Matches[1] -ne $ExpectedUvVersion) {
    throw "uv $ExpectedUvVersion is required; found $($Matches[1])."
}

Push-Location $ProjectDirectory
try {
    foreach ($directory in @("build", "dist", "artifacts")) {
        Remove-Item -Recurse -Force $directory -ErrorAction SilentlyContinue
    }

    & uv sync --frozen --python 3.13
    if ($LASTEXITCODE -ne 0) {
        throw "uv sync failed."
    }

    & uv run --frozen pyinstaller --clean --noconfirm windows-mcp.spec
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed."
    }

    $bundleDirectory = Join-Path $ProjectDirectory "dist/windows-mcp"
    $executablePath = Join-Path $bundleDirectory "windows-mcp.exe"
    if (-not (Test-Path -PathType Leaf $executablePath)) {
        throw "PyInstaller did not produce $executablePath."
    }

    $signingScript = Join-Path $ProjectDirectory "../sign-windows-executable.ps1"
    & $signingScript -ExecutablePath $executablePath

    $artifactDirectory = Join-Path $ProjectDirectory "artifacts/$ArtifactName"
    New-Item -ItemType Directory -Force $artifactDirectory | Out-Null
    Copy-Item -Recurse -Force (Join-Path $bundleDirectory "*") $artifactDirectory
    Copy-Item -Force "WINDOWS-MCP-LICENSE.md" $artifactDirectory
    Copy-Item -Force "TESTING.md" $artifactDirectory

    $licenseOutput = & uv run --frozen pip-licenses `
        --format=plain-vertical `
        --with-license-file `
        --no-license-path
    if ($LASTEXITCODE -ne 0) {
        throw "Generating the third-party license report failed."
    }
    $licenseOutput | Set-Content -Encoding UTF8 `
        (Join-Path $artifactDirectory "THIRD-PARTY-LICENSES.txt")

    $pythonVersion = (& uv run --frozen python --version).Trim()
    $pyInstallerVersion = (& uv run --frozen pyinstaller --version).Trim()
    $commit = (& git rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) {
        $commit = "unknown"
    }
    $packagedExecutable = Join-Path $artifactDirectory "windows-mcp.exe"
    $manifest = [ordered]@{
        artifact = $ArtifactName
        windowsMcpVersion = $WindowsMcpVersion
        windowsMcpWheel = "windows_mcp-0.8.2-py3-none-any.whl"
        windowsMcpWheelSha256 = "4689f070795323a25dc4f324057315f4273021b1799c149f6ad8181a54611fd5"
        pythonVersion = $pythonVersion
        pyInstallerVersion = $pyInstallerVersion
        uvVersion = $ExpectedUvVersion
        target = "windows-x64"
        gitCommit = $commit.Trim()
        lockFileSha256 = (Get-FileHash "uv.lock" -Algorithm SHA256).Hash.ToLowerInvariant()
        executableSha256 = (Get-FileHash $packagedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $manifest | ConvertTo-Json | Set-Content -Encoding UTF8 `
        (Join-Path $artifactDirectory "BUILD-MANIFEST.json")

    $zipPath = Join-Path $ProjectDirectory "artifacts/$ArtifactName.zip"
    Compress-Archive -Path $artifactDirectory -DestinationPath $zipPath `
        -CompressionLevel Optimal
    $zipHash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()

    Write-Host "Built $zipPath"
    Write-Host "SHA-256 $zipHash"
} finally {
    Pop-Location
}
