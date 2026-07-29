[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$BundleDirectory = (Join-Path $PSScriptRoot "dist/windows-mcp")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
    throw "The frozen Windows-MCP smoke test must run on Windows."
}

$BundleDirectory = (Resolve-Path $BundleDirectory).Path
$ExecutablePath = Join-Path $BundleDirectory "windows-mcp.exe"
if (-not (Test-Path -PathType Leaf $ExecutablePath)) {
    throw "Frozen executable not found at $ExecutablePath."
}

& $ExecutablePath --help *> $null
if ($LASTEXITCODE -ne 0) {
    throw "windows-mcp.exe --help exited with code $LASTEXITCODE."
}

$portProbe = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
)
$portProbe.Start()
$Port = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()

$stdoutPath = [System.IO.Path]::GetTempFileName()
$stderrPath = [System.IO.Path]::GetTempFileName()
$serverProcess = $null

function Get-ServerDiagnostics {
    $stdout = if (Test-Path $stdoutPath) { Get-Content -Raw $stdoutPath } else { "" }
    $stderr = if (Test-Path $stderrPath) { Get-Content -Raw $stderrPath } else { "" }
    return "STDOUT:`n$stdout`nSTDERR:`n$stderr"
}

try {
    $serverProcess = Start-Process `
        -FilePath $ExecutablePath `
        -ArgumentList @(
            "serve",
            "--transport", "streamable-http",
            "--stateless-http",
            "--host", "127.0.0.1",
            "--port", "$Port"
        ) `
        -WorkingDirectory $BundleDirectory `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $ready = $false
    $httpClient = [System.Net.Http.HttpClient]::new()
    $httpClient.Timeout = [TimeSpan]::FromSeconds(2)
    try {
        while ([DateTime]::UtcNow -lt $deadline) {
            if ($serverProcess.HasExited) {
                throw "Windows-MCP exited before readiness with code $($serverProcess.ExitCode).`n$(Get-ServerDiagnostics)"
            }
            try {
                $response = $httpClient.GetAsync("http://127.0.0.1:$Port/mcp").GetAwaiter().GetResult()
                $response.Dispose()
                $ready = $true
                break
            } catch {
                Start-Sleep -Milliseconds 250
            }
        }
    } finally {
        $httpClient.Dispose()
    }

    if (-not $ready) {
        throw "Timed out waiting for the frozen Windows-MCP endpoint.`n$(Get-ServerDiagnostics)"
    }
} finally {
    if ($null -ne $serverProcess -and -not $serverProcess.HasExited) {
        & taskkill.exe /PID $serverProcess.Id /T /F *> $null
        $serverProcess.WaitForExit(10000) | Out-Null
    }
    Remove-Item -Force $stdoutPath, $stderrPath -ErrorAction SilentlyContinue
}

$rebindDeadline = [DateTime]::UtcNow.AddSeconds(10)
$rebound = $false
while ([DateTime]::UtcNow -lt $rebindDeadline) {
    $listener = [System.Net.Sockets.TcpListener]::new(
        [System.Net.IPAddress]::Loopback,
        $Port
    )
    try {
        $listener.Start()
        $rebound = $true
        break
    } catch {
        Start-Sleep -Milliseconds 250
    } finally {
        $listener.Stop()
    }
}
if (-not $rebound) {
    throw "Port $Port remained occupied after Windows-MCP shutdown."
}

Write-Host "Frozen Windows-MCP smoke test passed on port $Port."
