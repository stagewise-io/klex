# Releasing Klex

GitHub Release assets are the distribution source of truth. Public installer
scripts and hosted stable/nightly channel pointers are not implemented yet.

## Supported targets

| Target | Runner | Archive | Release policy |
| --- | --- | --- | --- |
| `darwin-arm64` | `macos-26` | `.tar.gz` | Developer ID signed and notarized |
| `darwin-x64` | `macos-26-intel` | `.tar.gz` | Developer ID signed and notarized |
| `linux-arm64-gnu` | `ubuntu-24.04-arm` | `.tar.gz` | Unsigned; glibc 2.28 maximum |
| `linux-x64-gnu` | `ubuntu-22.04` | `.tar.gz` | Unsigned; glibc 2.28 maximum |
| `windows-x64` | `windows-2022` | `.zip` | Azure Trusted Signing verified |

The workflow checks the runner architecture before building. Linux artifacts
are scanned after extraction and rejected if any payload requires a GLIBC
symbol newer than `GLIBC_2.28`.

## GitHub environment and secrets

Create or update the protected GitHub environment named `Release`. Configure
its approval rules and these repository or environment secrets:

### macOS

- `MACOS_CERT_P12_BASE64`: base64-encoded Developer ID Application P12
- `MACOS_CERT_P12_PASSWORD`: P12 password
- `APPLE_SIGNING_IDENTITY`: full Developer ID Application identity
- `APPLE_ID`: notarization Apple ID
- `APPLE_PASSWORD`: app-specific password
- `APPLE_TEAM_ID`: Apple developer team ID

### Windows

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_ACCOUNT_NAME`
- `AZURE_ACCOUNT_ENDPOINT_URI`
- `AZURE_CERTIFICATE_PROFILE_NAME`

The workflow derives `SIGNTOOL_PATH`, `AZURE_CODE_SIGNING_DLIB`, and
`AZURE_METADATA_JSON`. Do not configure those as secrets. Missing or partial
credentials fail before artifact upload.

Confirm that the repository account can use `macos-26`, `macos-26-intel`, and
`ubuntu-24.04-arm`. Runner access is account-level and cannot be validated from
repository code.

## Stable releases

1. Set `apps/klex/package.json` to a strict stable version such as `1.2.3`.
2. Merge the release commit.
3. Push the matching tag: `git tag v1.2.3 && git push origin v1.2.3`.
4. Approve the protected `Release` environment when requested.
5. Inspect all 13 assets and the signing status in `release-manifest.json`.

The stable preflight rejects prerelease tags and package/tag mismatches. A
complete existing stable release is left unchanged on rerun. An existing
stable release with an incomplete asset set fails rather than being mutated.

## Nightly releases

`nightly-klex.yml` runs daily and supports manual dispatch from `main`. Manual
`date` and `counter` inputs exist only for testing version generation. Scheduled
runs skip a commit already represented by the newest reachable nightly tag.
Nightly versions use `X.Y.Z-nightlyYYYYMMDDcNNN` and publish prereleases.

A nightly rerun may replace the prerelease for the same nightly tag. Concurrency
is scoped to the tag, so two publications for one version cannot overlap.

## Published assets

A complete release contains exactly:

- five canonical archives;
- one `.sha256` sidecar for each archive;
- `release-manifest.json` and `release-manifest.json.sha256`;
- `checksums.txt`, covering every archive and the manifest.

Per-target build metadata is retained as a workflow artifact for diagnostics,
but is not published. Publication depends on every matrix build and the
complete-matrix validator, so a partial target set cannot become a release.

## Verification

Verify downloads before extraction:

```bash
sha256sum --check checksums.txt
```

On macOS, verify every Mach-O payload after extraction:

```bash
find klex-* -type f -exec sh -c \
  'file "$1" | grep -q "Mach-O" && codesign --verify --strict --verbose=2 "$1" || true' \
  sh {} \;
```

On Windows, inspect the Authenticode status in PowerShell:

```powershell
Get-ChildItem .\klex-* -Recurse -File |
  Where-Object { $_.Extension -in '.exe', '.dll', '.node' } |
  ForEach-Object { Get-AuthenticodeSignature $_.FullName } |
  Format-Table Status, Path
```

Linux intentionally has no code-signing provider in this release phase. Use
the SHA-256 checksums and manifest integrity metadata.

## Failure recovery

- **Runner label unavailable:** do not substitute architectures. Enable the
  documented runner or remove/defer that target in the release contract and
  workflow together.
- **Signing/notarization failure:** correct the protected secret or provider
  configuration, then rerun. Never use an unsigned or skip-notarization flag.
- **One matrix job fails:** rerun failed jobs. Publication cannot start until
  all five jobs succeed.
- **Incomplete stable release exists:** inspect its assets and workflow logs.
  Delete the incomplete release manually only after confirming no users rely
  on it, then rerun. Never replace a complete stable release.
- **Nightly publication fails:** rerun the workflow. The nightly prerelease for
  that version is replaceable.
- **Checksum/manifest validation fails:** treat the artifact as corrupt. Rebuild
  it; never edit generated hashes or metadata by hand.
