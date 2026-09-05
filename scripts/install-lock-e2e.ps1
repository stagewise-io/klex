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
$probe = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$probe.Dispose()
Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $lab -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'ALL CHECKS PASSED'
exit 0
