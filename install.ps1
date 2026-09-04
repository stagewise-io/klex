<#
.SYNOPSIS
Klex Bot installer for Windows.

.DESCRIPTION
Manifest-driven installer: reads release-manifest.json from a GitHub release,
picks the artifact matching this machine, verifies its SHA-256 against the
manifest, and unpacks it into a versioned directory.

Klex is not a single binary. Each artifact is a directory holding a Node SEA
executable plus a sibling node_modules with native addons, so the install
layout is versioned directories behind a junction:

  $InstallDir\
    versions\0.1.1\               unpacked artifact
    current  ->  versions\0.1.1   directory junction, repointed on upgrade
    bin\klex.cmd                  shim forwarding to current\klex.exe
    install-receipt.json

A junction rather than a symlink because junctions need neither elevation nor
Developer Mode. A .cmd shim rather than a symlink for the same reason.

.EXAMPLE
irm https://raw.githubusercontent.com/stagewise-io/klex/main/install.ps1 | iex

.EXAMPLE
# With options, since a piped script cannot take parameters:
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/stagewise-io/klex/main/install.ps1))) -NoModifyPath
#>

[CmdletBinding()]
param(
	# Release channel. 'nightly' is intentionally undocumented in the README.
	#
	# Deliberately unvalidated by attribute. The documented one-liner is
	# `irm ... | iex`, which evaluates this text in the caller's scope instead of
	# invoking a script, so a param block becomes a set of plain variable
	# declarations. A [ValidateSet] would then be applied to a variable holding
	# the unbound [string] default '' and fail the whole install before any code
	# runs. Invoke-Install rejects unknown channels explicitly instead.
	[string] $Channel,

	# Exact version to install instead of the newest release of the channel.
	[string] $Version,

	# Install root. Default: $env:LOCALAPPDATA\Klex
	[string] $InstallDir,

	# Do not touch the user PATH.
	[switch] $NoModifyPath,

	# Remove the installation, keeping all agent data.
	[switch] $Uninstall,

	[switch] $Help
)

$ErrorActionPreference = 'Stop'
# 1.0 rather than 2.0: the manifest is read with ConvertFrom-Json, and 2.0 turns
# every absent optional property into an opaque runtime error instead of the
# explicit "manifest is incomplete" diagnostics below.
Set-StrictMode -Version 1.0

$script:Repository = 'stagewise-io/klex'
$script:DefaultChannel = 'stable'
$script:FetchAttempts = 4
# Written into bin\klex.cmd so a later run can tell its own shim apart from a
# file that happened to be there first.
$script:ShimMarker = 'klex installer shim; managed by install.ps1'

# PowerShell 5.1 defaults to TLS 1.0 on older Windows builds, which GitHub refuses.
try {
	[Net.ServicePointManager]::SecurityProtocol =
	[Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol
} catch {
	Write-Verbose 'could not raise the TLS version; continuing with the default'
}

# --------------------------------------------------------------- diagnostics

function Write-Info {
	param([Parameter(Mandatory = $true)][string] $Message)
	Write-Host "klex: $Message"
}

function Write-Warn {
	param([Parameter(Mandatory = $true)][string] $Message)
	Write-Warning "klex: $Message"
}

function Stop-WithError {
	param([Parameter(Mandatory = $true)][string] $Message)
	throw "klex: error: $Message"
}

function Show-Help {
	@'
Klex Bot installer

Usage:
  install.ps1 [options]

Options:
  -Version <x.y.z>     Install an exact version instead of the newest release
  -InstallDir <path>   Install root (default: $env:LOCALAPPDATA\Klex)
  -NoModifyPath        Do not touch the user PATH
  -Uninstall           Remove the installation, keeping all agent data
  -Help                Show this help

Environment:
  KLEX_VERSION         Same as -Version
  KLEX_INSTALL_DIR     Same as -InstallDir
  KLEX_HOME            Agent data root (default: %USERPROFILE%\.klex); never modified here

Agent data lives outside the install root and survives -Uninstall.
'@ | Write-Host
}

# ------------------------------------------------------------------ resolving

function Resolve-Channel {
	if ($Channel) { return $Channel }
	if ($env:KLEX_CHANNEL) { return $env:KLEX_CHANNEL }
	return $script:DefaultChannel
}

function Resolve-InstallDir {
	if ($InstallDir) { return $InstallDir }
	if ($env:KLEX_INSTALL_DIR) { return $env:KLEX_INSTALL_DIR }
	if ($env:LOCALAPPDATA) { return (Join-Path $env:LOCALAPPDATA 'Klex') }
	return (Join-Path $env:USERPROFILE 'AppData\Local\Klex')
}

function Resolve-Target {
	# Only windows-x64 is published. ARM64 runs the x64 build under emulation.
	$architecture = $env:PROCESSOR_ARCHITEW6432
	if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }

	switch ($architecture) {
		'AMD64' { return 'windows-x64' }
		'ARM64' {
			Write-Warn 'no native ARM64 build is published; installing the x64 build, which runs under emulation'
			return 'windows-x64'
		}
		'x86' {
			Stop-WithError 'this is a 32-bit Windows installation; only 64-bit builds are published'
		}
		default {
			Stop-WithError "unsupported architecture: $architecture"
		}
	}
}

function Resolve-ManifestUrl {
	param(
		[Parameter(Mandatory = $true)][string] $ResolvedChannel
	)

	if ($env:KLEX_MANIFEST_URL) {
		# Internal/testing escape hatch. Accepts file:// for local bundles.
		return $env:KLEX_MANIFEST_URL
	}

	$pinned = if ($Version) { $Version } elseif ($env:KLEX_VERSION) { $env:KLEX_VERSION } else { '' }
	if ($pinned) {
		return "https://github.com/$script:Repository/releases/download/v$pinned/release-manifest.json"
	}

	if ($ResolvedChannel -eq 'nightly') {
		return "https://github.com/$script:Repository/releases/download/channel-nightly/release-manifest.json"
	}

	return "https://github.com/$script:Repository/releases/latest/download/release-manifest.json"
}

# -------------------------------------------------------------------- network

function Invoke-Download {
	param(
		[Parameter(Mandatory = $true)][string] $Url,
		[Parameter(Mandatory = $true)][string] $Destination,
		[Parameter(Mandatory = $true)][string] $Description
	)

	# The nightly pointer release replaces its manifest asset in place, so the
	# fixed URL can 404 for a moment during a nightly run. A single failure is
	# therefore not evidence that the release is missing.
	$attempt = 1
	$delay = 2
	while ($true) {
		try {
			# -UseBasicParsing keeps this working on machines without IE engine
			# initialisation, and is a no-op on PowerShell 7+.
			Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
			return
		} catch {
			if ($attempt -ge $script:FetchAttempts) {
				Stop-WithError "failed to download $Description after $script:FetchAttempts attempts: $Url`n$($_.Exception.Message)"
			}
			Write-Warn "$Description download failed, retrying in ${delay}s ($Url)"
			Start-Sleep -Seconds $delay
			$delay = $delay * 2
			$attempt = $attempt + 1
		}
	}
}

# ------------------------------------------------------------------ installing

function Get-ArtifactForTarget {
	param(
		[Parameter(Mandatory = $true)] $Manifest,
		[Parameter(Mandatory = $true)][string] $Target
	)

	foreach ($artifact in $Manifest.artifacts) {
		if ($artifact.target -eq $Target) { return $artifact }
	}
	return $null
}

function Assert-Checksum {
	param(
		[Parameter(Mandatory = $true)][string] $Path,
		[Parameter(Mandatory = $true)][string] $ExpectedSha256,
		[Parameter(Mandatory = $true)][long] $ExpectedSize
	)

	$actualSize = (Get-Item -LiteralPath $Path).Length
	if ($actualSize -ne $ExpectedSize) {
		Stop-WithError "archive size mismatch: expected $ExpectedSize bytes, got $actualSize"
	}

	$actualSha = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($actualSha -ne $ExpectedSha256.ToLowerInvariant()) {
		Stop-WithError "archive checksum mismatch: expected $ExpectedSha256, got $actualSha"
	}
	Write-Info 'checksum verified'
}

function Get-ReparsePointItem {
	param([Parameter(Mandatory = $true)][string] $Path)

	# Not Test-Path: it resolves the target, so a junction whose target has been
	# deleted is reported as nonexistent even though the reparse point still
	# occupies the name and still blocks New-Item. Get-Item -Force sees the link
	# itself.
	return (Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
}

function Remove-DirectoryLink {
	param([Parameter(Mandatory = $true)][string] $Path)

	$item = Get-ReparsePointItem -Path $Path
	if (-not $item) { return }

	$isLink = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq [IO.FileAttributes]::ReparsePoint
	if (-not $isLink) {
		Stop-WithError "$Path exists and is not a junction; remove it and retry"
	}

	# Remove-Item -Recurse on a junction has deleted target contents on older
	# PowerShell versions. rmdir on the reparse point only removes the link.
	& cmd.exe /c "rmdir `"$Path`"" | Out-Null
	if (Get-ReparsePointItem -Path $Path) {
		Stop-WithError "could not remove the existing junction at $Path"
	}
}

function Get-DirectoryLinkTarget {
	param([Parameter(Mandatory = $true)][string] $Path)

	$item = Get-ReparsePointItem -Path $Path
	if (-not $item) { return $null }

	$target = $item.Target
	if (-not $target) { return $null }
	# PowerShell 5.1 exposes Target as a collection for reparse points.
	if ($target -is [Array]) {
		if ($target.Count -eq 0) { return $null }
		return [string] $target[0]
	}
	return [string] $target
}

function Get-ComparablePath {
	param([string] $Path)

	# Junction targets come back in whatever form the filesystem stored them, so
	# raw string equality against a path this script built is unreliable. Compare
	# normalized, separator-trimmed forms instead; a false 'different' verdict here
	# would delete a directory that is still published.
	if (-not $Path) { return $null }
	try {
		return ([IO.Path]::GetFullPath($Path)).TrimEnd('\', '/')
	} catch {
		return $Path.TrimEnd('\', '/')
	}
}

function Expand-Artifact {
	param(
		[Parameter(Mandatory = $true)][string] $ArchivePath,
		[Parameter(Mandatory = $true)][string] $VersionsDir,
		[Parameter(Mandatory = $true)][string] $ArtifactVersion
	)

	$final = Join-Path $VersionsDir $ArtifactVersion
	$staging = Join-Path $VersionsDir (".{0}.tmp.{1}" -f $ArtifactVersion, $PID)

	New-Item -ItemType Directory -Path $VersionsDir -Force | Out-Null
	if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
	New-Item -ItemType Directory -Path $staging -Force | Out-Null

	Expand-Archive -LiteralPath $ArchivePath -DestinationPath $staging -Force

	# Artifacts contain a single top-level klex-<version>-<target>\ directory.
	$roots = @(Get-ChildItem -LiteralPath $staging -Directory)
	if ($roots.Count -ne 1) {
		Remove-Item -LiteralPath $staging -Recurse -Force
		Stop-WithError "unexpected archive layout: found $($roots.Count) top-level directories"
	}
	$unpacked = $roots[0].FullName

	if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'klex.exe'))) {
		Remove-Item -LiteralPath $staging -Recurse -Force
		Stop-WithError 'unpacked archive does not contain klex.exe'
	}

	# Replacing an existing directory of the same version is a reinstall. The
	# running executable is never inside it during an upgrade, because upgrades
	# unpack a new version directory beside the old one.
	if (Test-Path -LiteralPath $final) {
		try {
			Remove-Item -LiteralPath $final -Recurse -Force
		} catch {
			Remove-Item -LiteralPath $staging -Recurse -Force
			Stop-WithError "cannot replace $final; close any running klex.exe from that version and retry"
		}
	}

	Move-Item -LiteralPath $unpacked -Destination $final
	Remove-Item -LiteralPath $staging -Recurse -Force
	return $final
}

function Set-CurrentLink {
	param(
		[Parameter(Mandatory = $true)][string] $Root,
		[Parameter(Mandatory = $true)][string] $VersionDir
	)

	$binDir = Join-Path $Root 'bin'
	$shimPath = Join-Path $binDir 'klex.cmd'

	# Checked before anything is published: a klex.cmd without the marker belongs to
	# someone else. That only happens when -InstallDir points at a directory another
	# tool manages, and silently replacing their launcher is worse than stopping.
	if ((Test-Path -LiteralPath $shimPath) -and
		([IO.File]::ReadAllText($shimPath) -notmatch [regex]::Escape($script:ShimMarker))) {
		Stop-WithError "$shimPath was not created by this installer; remove it and retry"
	}

	$current = Join-Path $Root 'current'
	Remove-DirectoryLink -Path $current
	New-Item -ItemType Junction -Path $current -Target $VersionDir | Out-Null

	New-Item -ItemType Directory -Path $binDir -Force | Out-Null

	# %~dp0 keeps the shim relocatable, and it resolves through the junction, so
	# the shim never has to be rewritten on upgrade.
	$shim = @"
@echo off
@rem $script:ShimMarker
"%~dp0..\current\klex.exe" %*
"@

	# ASCII, CRLF: cmd.exe mis-parses a UTF-8 BOM in a .cmd file.
	[IO.File]::WriteAllText(
		$shimPath,
		($shim -replace "`r?`n", "`r`n"),
		(New-Object Text.ASCIIEncoding))

	return $binDir
}

function Test-Installation {
	param(
		[Parameter(Mandatory = $true)][string] $Exe,
		[Parameter(Mandatory = $true)][string] $ExpectedVersion
	)

	# Returns $false instead of throwing so the caller can roll back a junction it
	# has already published.
	#
	# A SEA resolves its native addons relative to the realpath of the running
	# executable, so running it through the junction also proves that chain.
	if (-not (Test-Path -LiteralPath $Exe)) {
		Write-Warn "no executable at $Exe"
		return $false
	}

	$reported = (& $Exe --version 2>$null | Select-Object -First 1)
	if ($reported) { $reported = $reported.Trim() }
	if ($reported -ne $ExpectedVersion) {
		Write-Warn "klex reports version '$reported', expected '$ExpectedVersion'"
		return $false
	}

	# Existence checks cannot prove a native addon loads; --verify-native
	# force-loads every one of them inside the real SEA process.
	$output = (& $Exe --verify-native 2>&1)
	if ($LASTEXITCODE -ne 0) {
		$output | Out-String | Write-Host
		Write-Warn 'native dependency verification failed; this build cannot run on this machine'
		return $false
	}
	return $true
}

# --------------------------------------------------------------------- receipt

function Write-Receipt {
	param(
		[Parameter(Mandatory = $true)][string] $Root,
		[Parameter(Mandatory = $true)][string] $BinDir,
		[Parameter(Mandatory = $true)][string] $ArtifactVersion,
		[Parameter(Mandatory = $true)][string] $ResolvedChannel,
		[Parameter(Mandatory = $true)][string] $Target,
		[Parameter(Mandatory = $true)][string] $Sha256,
		[Parameter(Mandatory = $true)][string] $ManifestUrl,
		[Parameter(Mandatory = $true)][bool] $PathModified
	)

	# pathEntry is what makes uninstall exact instead of guesswork, and channel is
	# what lets a later self-update resolve the right manifest without re-asking.
	$receipt = [ordered]@{
		schemaVersion = 1
		version       = $ArtifactVersion
		channel       = $ResolvedChannel
		target        = $Target
		installDir    = $Root
		binDir        = $BinDir
		archiveSha256 = $Sha256
		manifestUrl   = $ManifestUrl
		pathEntry     = if ($PathModified) { $BinDir } else { $null }
		pathScope     = if ($PathModified) { 'User' } else { $null }
		installedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd\THH:mm:ss\Z')
	}

	$path = Join-Path $Root 'install-receipt.json'
	($receipt | ConvertTo-Json) | Set-Content -LiteralPath $path -Encoding UTF8
}

# ------------------------------------------------------------------------ path

function Get-UserPathEntries {
	$raw = [Environment]::GetEnvironmentVariable('Path', 'User')
	if (-not $raw) { return @() }
	return @($raw -split ';' | Where-Object { $_ -ne '' })
}

function Test-PathEntry {
	param(
		[Parameter(Mandatory = $true)][string] $Entry,
		[Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $Entries
	)

	foreach ($existing in $Entries) {
		if ($existing.TrimEnd('\') -eq $Entry.TrimEnd('\')) { return $true }
	}
	return $false
}

function Add-BinDirToPath {
	param([Parameter(Mandatory = $true)][string] $BinDir)

	$entries = Get-UserPathEntries

	if ($NoModifyPath) {
		# An entry left by an earlier run is still ours, and the receipt has to keep
		# claiming it even when this run may not write. Otherwise -Uninstall leaves it
		# behind pointing at a deleted directory.
		if (Test-PathEntry -Entry $BinDir -Entries $entries) {
			Write-Info "skipping PATH setup; $BinDir is already on the user PATH"
			return $true
		}
		Write-Info "skipping PATH setup; add $BinDir to PATH yourself"
		return $false
	}

	if (Test-PathEntry -Entry $BinDir -Entries $entries) {
		# Still reported as ours: the entry points inside the install root, so an
		# earlier run of this installer put it there. Returning $false would write a
		# receipt claiming no PATH entry exists, and -Uninstall would then leave it
		# behind pointing at a deleted directory.
		Write-Info "$BinDir is already on the user PATH"
		return $true
	}

	$updated = (@($BinDir) + $entries) -join ';'
	if ($updated.Length -gt 2047) {
		# Legacy tooling truncates a user PATH beyond 2047 characters, which would
		# silently break unrelated commands. Refuse rather than corrupt it.
		Write-Warn "the user PATH would exceed 2047 characters; not modifying it. Add $BinDir manually"
		return $false
	}

	[Environment]::SetEnvironmentVariable('Path', $updated, 'User')
	# Make klex usable in this session too, without waiting for a new shell.
	$env:Path = "$BinDir;$env:Path"
	Write-Info "added $BinDir to the user PATH"

	Write-Host ''
	Write-Host 'Open a new terminal to pick up the PATH change.'
	return $true
}

function Remove-BinDirFromPath {
	param([Parameter(Mandatory = $true)][string] $Entry)

	$entries = Get-UserPathEntries
	if (-not (Test-PathEntry -Entry $Entry -Entries $entries)) { return }

	$kept = @($entries | Where-Object { $_.TrimEnd('\') -ne $Entry.TrimEnd('\') })
	[Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
	Write-Info "removed $Entry from the user PATH"
}

# ------------------------------------------------------------------- uninstall

function Invoke-Uninstall {
	$root = Resolve-InstallDir
	$receiptPath = Join-Path $root 'install-receipt.json'

	if (-not (Test-Path -LiteralPath $receiptPath)) {
		# Refusing beats guessing: without a receipt there is no evidence that this
		# directory was created by the installer, and a recursive delete on a guess
		# is not safe.
		Stop-WithError "no install receipt at $receiptPath; nothing was removed. Pass -InstallDir if klex lives elsewhere"
	}

	$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json

	if ($receipt.PSObject.Properties['pathEntry'] -and $receipt.pathEntry) {
		Remove-BinDirFromPath -Entry $receipt.pathEntry
	}

	# Drop the junction before the recursive delete so no delete can ever walk
	# into the version directory through the reparse point.
	Remove-DirectoryLink -Path (Join-Path $root 'current')
	Remove-Item -LiteralPath $root -Recurse -Force

	$installedVersion = if ($receipt.PSObject.Properties['version']) { $receipt.version } else { 'installation' }
	Write-Info "removed klex $installedVersion from $root"

	$klexHome = if ($env:KLEX_HOME) { $env:KLEX_HOME } else { Join-Path $env:USERPROFILE '.klex' }
	Write-Host ''
	Write-Host 'Your agent data was left untouched:'
	Write-Host ''
	Write-Host "  $klexHome"
	Write-Host ''
	Write-Host 'It holds configuration, credentials, enrollment state, and history.'
	Write-Host 'Delete it yourself if you want it gone:'
	Write-Host ''
	Write-Host "  Remove-Item -Recurse -Force `"$klexHome`""
}

# --------------------------------------------------------------------- install

function Invoke-Install {
	$resolvedChannel = Resolve-Channel
	if ($resolvedChannel -ne 'stable' -and $resolvedChannel -ne 'nightly') {
		Stop-WithError "unknown channel: $resolvedChannel"
	}

	$target = Resolve-Target
	$root = Resolve-InstallDir
	$manifestUrl = Resolve-ManifestUrl -ResolvedChannel $resolvedChannel

	$staging = Join-Path ([IO.Path]::GetTempPath()) ("klex-install-{0}" -f [Guid]::NewGuid().ToString('N'))
	New-Item -ItemType Directory -Path $staging -Force | Out-Null

	try {
		Write-Info "target $target"
		Write-Info "fetching $manifestUrl"
		$manifestPath = Join-Path $staging 'release-manifest.json'
		Invoke-Download -Url $manifestUrl -Destination $manifestPath -Description 'release manifest'

		$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
		if ($manifest.schemaVersion -ne 1) {
			Stop-WithError "unsupported manifest schemaVersion '$($manifest.schemaVersion)'; upgrade the installer"
		}
		if (-not $manifest.version) {
			Stop-WithError 'manifest does not contain a version'
		}

		$pinned = if ($Version) { $Version } elseif ($env:KLEX_VERSION) { $env:KLEX_VERSION } else { '' }
		if ($pinned -and $manifest.version -ne $pinned) {
			Stop-WithError "requested version $pinned but the manifest describes $($manifest.version)"
		}

		$artifact = Get-ArtifactForTarget -Manifest $manifest -Target $target
		if (-not $artifact) {
			Stop-WithError "release $($manifest.version) has no artifact for $target"
		}
		if (-not $artifact.url -or -not $artifact.archiveSha256 -or -not $artifact.archiveSize) {
			Stop-WithError "manifest artifact for $target is incomplete"
		}

		Write-Info "installing klex $($manifest.version)"
		$archivePath = Join-Path $staging $artifact.archiveFileName
		Invoke-Download -Url $artifact.url -Destination $archivePath -Description 'release archive'
		Assert-Checksum -Path $archivePath -ExpectedSha256 $artifact.archiveSha256 -ExpectedSize ([long] $artifact.archiveSize)

		New-Item -ItemType Directory -Path $root -Force | Out-Null
		$versionDir = Expand-Artifact -ArchivePath $archivePath -VersionsDir (Join-Path $root 'versions') -ArtifactVersion $manifest.version

		$current = Join-Path $root 'current'
		$previousTarget = Get-DirectoryLinkTarget -Path $current

		# Verify before publishing. A release that cannot run must never become the
		# active one, and current still points at the previous version here.
		if (-not (Test-Installation -Exe (Join-Path $versionDir 'klex.exe') -ExpectedVersion $manifest.version)) {
			# Keep the directory if it is already the published one (same-version
			# reinstall): deleting it would break the installation this run failed to
			# replace.
			if ((Get-ComparablePath $previousTarget) -ine (Get-ComparablePath $versionDir)) {
				Remove-Item -LiteralPath $versionDir -Recurse -Force -ErrorAction SilentlyContinue
			}
			Stop-WithError 'the downloaded release does not run on this machine; the existing installation was left in place'
		}

		$binDir = Set-CurrentLink -Root $root -VersionDir $versionDir

		# Again through current\klex.exe: only this proves the junction resolves. A
		# failure here has to be rolled back.
		if (-not (Test-Installation -Exe (Join-Path $current 'klex.exe') -ExpectedVersion $manifest.version)) {
			if ($previousTarget) {
				Remove-DirectoryLink -Path $current
				New-Item -ItemType Junction -Path $current -Target $previousTarget | Out-Null
				Write-Warn "rolled back: current -> $previousTarget"
			} else {
				Remove-DirectoryLink -Path $current
			}
			Stop-WithError 'klex does not run through the installed junction; the previous version was restored'
		}
		Write-Info 'native dependencies verified'

		$pathModified = Add-BinDirToPath -BinDir $binDir

		$receiptChannel = if ($manifest.PSObject.Properties['channel'] -and $manifest.channel) { $manifest.channel } else { $resolvedChannel }
		Write-Receipt `
			-Root $root `
			-BinDir $binDir `
			-ArtifactVersion $manifest.version `
			-ResolvedChannel $receiptChannel `
			-Target $target `
			-Sha256 $artifact.archiveSha256 `
			-ManifestUrl $manifestUrl `
			-PathModified $pathModified

		Write-Info "klex $($manifest.version) installed to $root"
		Write-Host ''
		Write-Host 'Run klex --help to get started.'
	} finally {
		if (Test-Path -LiteralPath $staging) {
			Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
		}
	}
}

# ------------------------------------------------------------------------ main

if ($Help) {
	Show-Help
	return
}

if ($Uninstall) {
	Invoke-Uninstall
	return
}

Invoke-Install
