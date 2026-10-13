# Reconstructed npm release baseline

This commit reconstructs the source for the already-published `@stagewise/mcp-extension-push-notifications@0.1.1`. It was created during release-history recovery in October 2026. It is not the original publication commit, and its timestamps must not be interpreted as the publication date.

npm published `0.1.1` at `2026-09-10T10:35:35.835Z` without recording a `gitHead`. Remote branches, tags, preserved GitHub pull-request heads, local reflogs and unreachable Git objects did not reveal the original release commit. Publishing from uncommitted changes is a supported inference, not proven provenance.

## Recovered source

The parent is `7ccf2dc378a5f6a0500b5fcb25520cbafd24d956`. Two orphaned Git blobs supply the missing published behavior:

- Server source: `abdc9ed92c961ad8c94aec9089ab7c075709197c`.
- Package README: `4b74a08691d2944a370227681274cfbddf2334e8`.

The server preserves the published `registerDiscoveryHandler: false` option. The manifest records the published version, `0.1.1`, and retains authored workspace dependencies.

## Artifact verification

Rebuilding from the parent with these files reproduces all 45 files in the published npm package. All 44 non-manifest files match byte-for-byte, including JavaScript, declarations, source maps, schema, specification, README and license. The manifest matches structurally after normal pnpm workspace dependency expansion. The downloaded npm tarball's SHA-512 integrity is verified.

The package build, typecheck and all 41 tests pass. A separate runtime check confirms default discovery registration and explicit discovery opt-out while retaining get and acknowledgement handlers.

The same historical parent reproduces `@stagewise/mcp-extension-client@0.1.0` and `@stagewise/mcp-extension-realtime-media@0.1.0` with ordinary packed-manifest normalization. Their baseline tags identify that verified historical snapshot, not a proven original publication commit.

## Integration

The Push Notifications `0.1.1` baseline tag identifies this explicitly reconstructed snapshot. Preserve this commit as ancestry when integrating it into main. Do not squash or rebase it after tagging. Merge the restoration without dropping newer protocol changes such as `resourceLink`.

This recovery does not republish any existing npm version or move an existing release tag.
