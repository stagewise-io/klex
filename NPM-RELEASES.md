# npm releases

The npm workflow publishes six packages independently on pushes to `main`. It does not publish the Klex executable. Calculator and the other private workspaces are excluded.

| Package | Commit scope | Release tag |
| --- | --- | --- |
| `@klex/mcp-proxy-sdk` | `mcp-proxy-sdk` | `@klex/mcp-proxy-sdk-v${version}` |
| `@klex/machine` | `machine` | `@klex/machine-v${version}` |
| `@klex/agent-admin-api` | `agent-admin-api` | `@klex/agent-admin-api-v${version}` |
| `@stagewise/mcp-extension-client` | `mcp-extension-client` | `@stagewise/mcp-extension-client-v${version}` |
| `@stagewise/mcp-extension-push-notifications` | `mcp-extension-push-notifications` | `@stagewise/mcp-extension-push-notifications-v${version}` |
| `@stagewise/mcp-extension-realtime-media` | `mcp-extension-realtime-media` | `@stagewise/mcp-extension-realtime-media-v${version}` |

## Commit scopes

A matching `feat` releases a minor version. A matching breaking change releases a major version. Other matching conventional commits release a patch. Unscoped or unrelated commits do not release that package. Tags, not committed manifest versions, track the published version.

```text
fix(mcp-extension-realtime-media): repair transport decoding
feat(mcp-extension-push-notifications,mcp-extension-realtime-media): add subscription metadata
```

Changes to the shared client require both consumer scopes, even if their source files did not change. The PR scope checker enforces this across the commit range.

```text
fix(mcp-extension-client,mcp-extension-push-notifications,mcp-extension-realtime-media): repair shared acknowledgement dispatch
```

The helper remains a runtime dependency. Bundling it separately into each extension would create separate WeakMaps and let the extensions overwrite each other's MCP acknowledgement handler.

## One-time setup before merging

For each new Stagewise package, configure npm trusted publishing for the GitHub repository `stagewise-io/klex` and workflow `release.yml`. Confirm the npm organization owns the package. The workflow uses npm OIDC and GitHub's workflow token. Do not add an npm token secret. Existing provenance settings remain unchanged.

The extension packages already existed on npm without scoped release tags. Artifact verification established these source baselines:

| Package | Published version found | Required baseline tag |
| --- | --- | --- |
| `@stagewise/mcp-extension-client` | `0.1.0` | `@stagewise/mcp-extension-client-v0.1.0` |
| `@stagewise/mcp-extension-push-notifications` | `0.1.1` | `@stagewise/mcp-extension-push-notifications-v0.1.1` |
| `@stagewise/mcp-extension-realtime-media` | `0.1.0` | `@stagewise/mcp-extension-realtime-media-v0.1.0` |

Before any npm publication, preflight checks that each package's latest reachable stable release tag agrees with npm's published version. Missing or mismatched tags stop the entire npm job. This prevents semantic-release from treating an established package as a first release and selecting `1.0.0`.

Client and Realtime Media reproduce their published artifacts from `7ccf2dc378a5f6a0500b5fcb25520cbafd24d956`, with 6 and 49 matching package files respectively. Their annotated tags identify a verified historical source snapshot, not proven original publication commits.

Push Notifications `0.1.1` had no npm `gitHead`, and the original release commit could not be recovered. The published `registerDiscoveryHandler: false` implementation and README survived as orphaned Git blobs. Commit `075b092` reconstructs that release on the same historical parent and reproduces all 45 published package files. Its annotated tag explicitly identifies a reconstruction created in October 2026, not the original publication commit. See [NPM-BASELINE-RECOVERY.md](./NPM-BASELINE-RECOVERY.md) for the evidence and manifest normalization.

PR #211 preserves the reconstructed commit as ancestry without removing newer `resourceLink` support. **Merge this PR with a merge commit, not a rebase or squash merge.** GitHub merge commits are temporarily enabled for this recovery; restore the previous rebase-only repository setting after the PR is merged. Rebasing would leave the tagged reconstruction outside main's ancestry and fail release preflight.

```sh
# Read-only verification from the PR branch before merging, or main afterward.
git fetch origin --tags
node scripts/mcp-extension-release-plugin.mjs --preflight
```

Never move an existing published tag or tag an unrelated implementation commit as an old release. Each baseline must be reachable from the PR head before merging and from `main` before publication. Do not rebase the tagged reconstruction.

## Workflow and publication preparation

The single release job installs with the frozen lockfile, builds, typechecks, tests, and verifies packed consumers before changing any release manifests. All extension baselines are checked before the first publication. Releases run sequentially: proxy SDK, shared client, push notifications, realtime media, machine, Admin API. The SDK remains before machine, and the shared client is released before its consumers and machine's packing step.

The npm plugin prepares each package version. The extension plugin then rewrites runtime `workspace:` dependencies to exact registry versions in the disposable checkout. It selects the latest reachable helper release tag and confirms that exact version exists on npm, with three bounded attempts for propagation. It never falls back to the helper's stale authored version or an unverified npm dist-tag. Missing, private, or unknown workspace runtime dependencies stop preparation.

Authored manifests keep `workspace:*`. There are no release commits, cross-package version synchronization, or lockfile rewrites. The release steps set `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` to disable pnpm 11's automatic dependency verification/reinstall after intentional manifest rewrites, including nested prepack builds. pnpm 11 does not read this setting from the former `npm_config_` prefix. Frozen installation and all workspace validation occur earlier with normal settings.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm --filter '@stagewise/mcp-extension-*' build
node scripts/verify-mcp-extension-packages.mjs
node --test packages/agent-admin-api/release-config.test.mjs scripts/scoped-release-integration.test.mjs scripts/mcp-extension-release-plugin.test.mjs scripts/check-package-release-scopes.test.mjs
```

The shared packing check stages copies without changing source manifests, uses the same runtime dependency conversion as publication, packs all three packages with npm, and installs the tarballs into a temporary consumer. It verifies contents, public JavaScript/declaration imports, and both registration orders for shared acknowledgement dispatch. The consumer has no workspace symlinks, receives no release credentials, and skips dependency lifecycle scripts. Its files are removed in `finally`. It fetches public peers and Node types from npm; it does not publish anything. Run builds first because staged packing deliberately skips prepack scripts.

## Partial-failure recovery

Stop and inspect both npm metadata and reachable tags before retrying. Successful earlier releases are immutable and need not be repeated.

- If preparation failed before tagging or publication, fix the cause and rerun the failed workflow job after confirming baselines still agree. Consumer preparation always resolves the already-published helper version.
- If npm publication succeeded but a later GitHub operation failed, preserve the version and tag. Complete the missing GitHub release separately if needed. A rerun may find no relevant commits for that package, which is expected.
- If semantic-release created a tag but npm publication failed, preflight intentionally blocks a blind rerun. A maintainer must recover that exact unpublished version from the tagged commit using an approved publishing identity. Rebuild and verify the artifact, resolve runtime dependencies to the confirmed published helper, and publish only after confirming the exact version is absent from npm. Then confirm npm and tags agree and retry the remaining job. Restoring publication may require a maintainer-controlled recovery workflow or authorized manual publication; the ordinary push workflow is not a recovery command.
- If helper publication succeeded but consumer preparation fails on registry propagation, wait for npm to expose the exact helper version, then retry. Do not replace its pin with a floating range.

Do not delete or move release tags, republish an existing version, disable preflight, or synthesize release commits merely to conceal partial failure.
