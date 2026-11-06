$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 1.0

$repoRoot = Split-Path -Parent $PSScriptRoot
$lab = Join-Path ([IO.Path]::GetTempPath()) 'klex-install-lock-e2e'
$root = Join-Path $lab 'Klex'
$lockPath = "$root.install-lock"
Remove-Item -LiteralPath $lab -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $lab -Force | Out-Null

$owner = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'install.ps1') -InstallDir $root -Uninstall 2>&1
  if ($LASTEXITCODE -eq 0) { throw 'A concurrent uninstall unexpectedly succeeded' }
  if (($output | Out-String) -notmatch 'another install operation is already running') {
    throw "Contention diagnostic missing: $($output | Out-String)"
  }
} finally {
  $owner.Dispose()
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}

# Channel validation fails after lock acquisition. The outer finally must still
# close and remove the lock so another process can acquire it immediately.
$output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'install.ps1') -InstallDir $root -Channel bogus 2>&1
if ($LASTEXITCODE -eq 0) { throw 'The invalid-channel probe unexpectedly succeeded' }
if (($output | Out-String) -notmatch 'unknown channel: bogus') {
  throw "Channel validation diagnostic missing: $($output | Out-String)"
}
$probe = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$probe.Dispose()
Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
# Exercise post-install orchestration with a real executable and a stubbed
# installation step. Downloading and unpacking are intentionally outside this
# probe; the lock, parameter binding, foreground wait, and exit code are real.
$fixture = Join-Path $lab 'fixture.exe'
$fixtureSource = @'
using System;
using System.IO;
using System.Threading;
public static class InstallerLaunchFixture {
  public static int Main(string[] args) {
    string root = Environment.GetEnvironmentVariable("KLEX_TEST_ROOT");
    using (File.Open(root + ".install-lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {}
    File.WriteAllLines(Path.Combine(root, "args.txt"), args);
    while (File.Exists(Path.Combine(root, "keep-running"))) Thread.Sleep(50);
    return 23;
  }
}
'@
# Compile under Windows PowerShell so this is a .NET Framework executable,
# not a PowerShell 7/.NET assembly that needs a runtimeconfig and dotnet host.
$compiler = "Add-Type -TypeDefinition @'`n$fixtureSource`n'@ -OutputAssembly '$($fixture.Replace("'", "''"))' -OutputType ConsoleApplication"
$encodedCompiler = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($compiler))
& powershell.exe -NoProfile -NonInteractive -EncodedCommand $encodedCompiler
if ($LASTEXITCODE -ne 0) { throw 'Could not compile launch fixture' }

$installerPath = Join-Path $repoRoot 'install.ps1'
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installerPath, [ref] $null, [ref] $parseErrors)
if ($parseErrors) { throw 'Installer failed to parse' }
$installFunction = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Install' }, $false)
$source = [IO.File]::ReadAllText($installerPath)
$stub = @'
function Invoke-Install {
  $current = Join-Path (Resolve-InstallDir) 'current'
  New-Item -ItemType Directory -Path $current -Force | Out-Null
  Copy-Item -LiteralPath $env:KLEX_TEST_FIXTURE -Destination (Join-Path $current 'klex.exe') -Force
}
'@
$probeScript = Join-Path $lab 'launch-probe.ps1'
$source = $source.Remove($installFunction.Extent.StartOffset, $installFunction.Extent.EndOffset - $installFunction.Extent.StartOffset).Insert($installFunction.Extent.StartOffset, $stub)
[IO.File]::WriteAllText($probeScript, $source)
$env:KLEX_TEST_ROOT = $root
$env:KLEX_TEST_FIXTURE = $fixture
try {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probeScript -InstallDir $root -CloudBaseUrl 'https://example.test'
  if ($LASTEXITCODE -ne 0) { throw 'URL-only install failed' }
  if (Test-Path (Join-Path $root 'args.txt')) { throw 'URL alone launched the CLI' }

  $token = 'test token; $(literal)'
  $url = 'https://example.test/api?one=1&two=2'
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probeScript -InstallDir $root -CloudEnrollmentToken $token -CloudBaseUrl $url
  if ($LASTEXITCODE -ne 23) { throw 'CLI exit code was not propagated' }
  $actual = [IO.File]::ReadAllLines((Join-Path $root 'args.txt'))
  $expected = @('--create-bot', '--cloud-enroll-token', $token, '--cloud-base-url', $url)
  if (($actual -join "`n") -cne ($expected -join "`n")) { throw 'Token or URL arguments were not forwarded exactly' }

  # A waiting executable must keep the installer invocation alive until it stops.
  Remove-Item -LiteralPath (Join-Path $root 'args.txt')
  $keepRunning = Join-Path $root 'keep-running'
  [IO.File]::WriteAllText($keepRunning, '')
  $job = Start-Job -ScriptBlock {
    param($scriptPath, $installRoot)
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath -InstallDir $installRoot -CloudEnrollmentToken 'test-token'
    if ($LASTEXITCODE -ne 23) { throw 'Foreground CLI exit code was not propagated' }
  } -ArgumentList $probeScript, $root
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path (Join-Path $root 'args.txt')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (-not (Test-Path (Join-Path $root 'args.txt'))) { throw 'Foreground CLI did not start' }
    if ($job.State -ne 'Running') { throw 'Installer returned before CLI stopped' }
    $actual = [IO.File]::ReadAllLines((Join-Path $root 'args.txt'))
    if (($actual -join "`n") -cne (@('--create-bot', '--cloud-enroll-token', 'test-token') -join "`n")) { throw 'Missing URL did not leave CLI defaults intact' }
  } finally {
    Remove-Item -LiteralPath $keepRunning -Force
    $job | Wait-Job -Timeout 10 | Out-Null
    if ($job.State -ne 'Completed') { Stop-Job $job; throw 'Foreground installer did not finish cleanly' }
    Receive-Job $job -ErrorAction Stop
    Remove-Job $job
  }

  Remove-Item -LiteralPath (Join-Path $root 'args.txt')
  $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probeScript -InstallDir $root -Uninstall -CloudEnrollmentToken 'test-token' 2>&1
  if ($LASTEXITCODE -eq 0) { throw 'Uninstall with enrollment unexpectedly succeeded' }
  if (($output | Out-String) -notmatch 'cannot be combined') { throw 'Enrollment/uninstall diagnostic missing' }
  if (Test-Path (Join-Path $root 'args.txt')) { throw 'Rejected uninstall launched a bot' }
} finally {
  Remove-Item Env:KLEX_TEST_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:KLEX_TEST_FIXTURE -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $lab -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'ALL CHECKS PASSED'
exit 0
