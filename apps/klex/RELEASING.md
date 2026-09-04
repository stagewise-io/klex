# Releasing Klex

GitHub Release assets are the distribution source of truth. The public installers
resolve verified stable and nightly releases through dedicated channel manifests.

## Supported targets

| Target | Runner | Archive | Release policy |
| --- | --- | --- | --- |
| `darwin-arm64` | `macos-26` | `.tar.gz` | Developer ID signed and notarized |
| `darwin-x64` | `macos-26-intel` | `.tar.gz` | Developer ID signed and notarized |
| `linux-arm64-gnu` | `ubuntu-24.04-arm` | `.tar.gz` | Unsigned; glibc 2.28 maximum |
| `linux-x64-gnu` | `ubuntu-22.04` | `.tar.gz` | Unsigned; glibc 2.28 maximum |
| `windows-x64` | `windows-2022` | `.zip` | Azure Trusted Signing verified |

The workflow checks runner architecture before building. Linux payloads are
rejected if they require a GLIBC symbol newer than `GLIBC_2.28`.

## GitHub environment and secrets

The protected GitHub environment named `Release` owns artifact-publication
approval and signing credentials.

### Release preparation

`RELEASE_PAT` is a fine-grained repository secret with Contents read/write and
Pull requests read/write for this repository. It must not bypass branch
protection. The Prepare workflow needs it because pull requests created with the
default `GITHUB_TOKEN` do not trigger normal pull-request CI.

### macOS

- `MACOS_CERT_P12_BASE64`
- `MACOS_CERT_P12_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

### Windows

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_ACCOUNT_NAME`
- `AZURE_ACCOUNT_ENDPOINT_URI`
- `AZURE_CERTIFICATE_PROFILE_NAME`

The workflow derives `SIGNTOOL_PATH`, `AZURE_CODE_SIGNING_DLIB`, and
`AZURE_METADATA_JSON`. Do not configure those as secrets.

## Stable releases

1. Optionally add one-shot operator context to `.release-notes/klex.md`.
2. Dispatch **Prepare Klex Release** from `main`.
3. Review the generated `release/klex-vX.Y.Z` pull request and let normal CI pass.
4. Merge the release PR into `main`.
5. Approve the protected `Release` environment when requested.
6. Confirm the immutable release has eight public files and `channel-stable`
   points at its manifest.

The preparation tool reads conventional commits with scope `klex` since the
latest stable `vX.Y.Z` tag. On `0.x`, features and breaking changes bump the
minor version; other releasable commits bump the patch. Automation refuses to
produce `1.0.0` or newer. It updates `apps/klex/package.json`, prepends the
release to `apps/klex/CHANGELOG.md`, and consumes `.release-notes/klex.md`.
The committed changelog section becomes the exact GitHub Release body.

Merging the version change is the authorization event. `release-klex.yml`
detects the changed package version on a push to `main`, skips versions whose
tag already exists, and calls the reusable release workflow at that immutable
merge commit. The workflow publishes the immutable `vX.Y.Z` release, installs
and verifies that versioned manifest on all five target runners, then promotes
its manifest to the `channel-stable` pointer. Failed installation cannot change
the stable installer channel.

A manual dispatch of **Auto-release Klex** retries the current unreleased
`main` version. Rerunning a failed Actions run preserves the same commit and
version. A complete existing stable release remains immutable; an incomplete
one fails rather than being mutated.

## Nightly releases

`nightly-klex.yml` runs daily and supports manual dispatch from `main`. Nightly
versions use `X.Y.Z-nightlyYYYYMMDDcNNN`. The reusable workflow replaces the
matching versioned prerelease on a rerun and then updates `channel-nightly`.
Scheduled runs skip a commit already represented by the newest reachable
nightly tag.

Both channel releases are prerelease pointer containers with exactly one mutable
`release-manifest.json` asset. Binaries and checksums remain on immutable
versioned releases. The manifest pins every archive SHA-256; a second mutable
pointer checksum would not add trust and could not be replaced atomically.

## Published assets

A complete versioned release contains exactly eight public files:

- five canonical archives;
- `release-manifest.json`;
- `release-manifest.json.sha256`;
- `checksums.txt`, covering every archive and the manifest.

Per-target build metadata and stable release notes remain workflow artifacts for
diagnostics but are not public release assets. Publication depends on every
matrix build and complete-matrix validation.

## Verification

Installers verify each archive SHA-256 from the manifest before extraction and
run `klex --verify-native` before publishing an installation. Stable promotion
also runs the real installer against the immutable versioned manifest on all
five target runners, checks the exact version, and exercises receipt-driven
uninstall.

For manual download verification:

```bash
sha256sum --check checksums.txt
```

On macOS, verify Mach-O payloads after extraction with `codesign --verify
--strict`. On Windows, inspect executable, DLL, and Node-addon signatures with
`Get-AuthenticodeSignature`. Linux intentionally has no signing provider in
this phase; use the immutable release checksums and manifest metadata.

## Failure recovery

- **Runner unavailable:** do not substitute architectures. Restore the declared
  runner or change the release contract and workflow together.
- **Signing/notarization failure:** correct the protected credential/provider
  configuration and rerun. Never skip signing or notarization.
- **Matrix or stable-install verification fails:** rerun failed jobs. The stable
  pointer cannot update until every target passes.
- **Incomplete stable release exists:** inspect assets and logs. Delete it only
  after confirming no users rely on it, then rerun. Never replace a complete
  stable release.
- **Nightly publication fails:** rerun. The nightly prerelease is replaceable.
- **Checksum/manifest validation fails:** rebuild the artifact; never edit hashes
  or generated metadata by hand.
