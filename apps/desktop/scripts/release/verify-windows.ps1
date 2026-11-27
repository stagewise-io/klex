# Installs Klex Desktop silently with its NSIS installer, runs the installed
# daemon entry point, and uninstalls it again. With -Signed, the installer,
# the installed app and the uninstaller must carry valid Authenticode
# signatures. CI runs it unsigned on debug bundles built with the release GUI
# subsystem; the release workflow runs it with -Signed.
param(
  [Parameter(Mandatory)] [string] $Installer,
  [switch] $Signed
)

$ErrorActionPreference = 'Stop'

function Assert-Signed([string] $Path) {
  if (-not $Signed) { return }
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne 'Valid') {
    throw "$Path signature is $($signature.Status): $($signature.StatusMessage)"
  }
}

Assert-Signed $Installer
Start-Process -FilePath $Installer -ArgumentList '/S' -Wait
$root = Join-Path $env:LOCALAPPDATA 'Klex Desktop'
$app = Join-Path $root 'klex-desktop.exe'
if (-not (Test-Path -LiteralPath $app)) {
  throw "The installer did not create $app"
}
Assert-Signed $app

# Redirecting to a file gives the GUI-subsystem executable a real stdout.
$output = New-TemporaryFile
$daemon = Start-Process -FilePath $app -ArgumentList '--daemon', '--version' `
  -NoNewWindow -Wait -PassThru -RedirectStandardOutput $output
if ($daemon.ExitCode -ne 0) {
  throw "klex-desktop --daemon --version exited with $($daemon.ExitCode)"
}
$version = (Get-Content -Raw -LiteralPath $output).Trim()
if (-not $version) { throw 'klex-desktop --daemon --version printed nothing' }
Write-Host "Daemon version: $version"

# When PowerShell captures a GUI-subsystem executable, its end of the pipe
# can already be closed; the write must fail quietly instead of panicking.
$null = & $app --daemon --version
if ($LASTEXITCODE -ne 0) {
  throw "Captured klex-desktop --daemon --version exited with $LASTEXITCODE"
}

$uninstaller = Join-Path $root 'uninstall.exe'
Assert-Signed $uninstaller
Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait
$deadline = (Get-Date).AddMinutes(2)
while ((Test-Path -LiteralPath $app) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
}
if (Test-Path -LiteralPath $app) { throw "$app remains after uninstall" }
