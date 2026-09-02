# `@stagewise/app-packager`

Builds the current Node.js runtime and one pre-bundled entry file into a native
[Single Executable Application](https://nodejs.org/api/single-executable-applications.html).
The package owns SEA blob creation, runtime preparation, Postject injection,
platform signing, verification, optional macOS notarization, and artifact
metadata.

Phase one intentionally does not bundle application source, download Node.js,
cross-compile, package installer formats, or migrate existing application build
scripts. The entry file must already contain all application dependencies.

## Requirements

- Node.js 22 or newer
- The target platform and architecture must match the current Node.js process
- macOS: `codesign` and `strip`
- Linux: `strip`
- Windows signing: SignTool, the Azure Trusted Signing DLib, and its metadata
  file

## Programmatic API

```ts
import {
  defineAppPackagerConfig,
  packageApp,
} from '@stagewise/app-packager';

const config = defineAppPackagerConfig({
  name: 'example-app',
  entry: './dist/main.cjs',
  outputDirectory: './release',
  assets: {
    defaultConfig: './config/default.json',
  },
  signing: {
    mode: 'optional',
  },
  macos: {
    identity: process.env.APPLE_SIGNING_IDENTITY,
    entitlements: {
      allowJit: true,
      allowUnsignedExecutableMemory: true,
    },
  },
});

const artifact = await packageApp(config, {
  baseDirectory: import.meta.dirname,
});
console.log(artifact);
```

`packageApp()` returns the absolute output path, platform, architecture, Node
version, SHA-256 digest, embedded asset names, signing and verification status,
signing provider when present, and notarization status.

The root API also exports:

- `signExecutable(options)` for signing an existing executable
- `signExecutables(options)` for signing an ordered complete-payload inventory
- `verifyExecutable(options)` for platform-native signature verification
- `notarizeMacOSArchive(options)` for submitting an already assembled ZIP to
  Apple's notary service without repackaging or stapling it
- Config and result types for all public operations

## Configuration

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Output file name. `.exe` is added on Windows. |
| `entry` | Yes | Path to one pre-bundled CommonJS or supported SEA entry file. |
| `outputDirectory` | Yes | Directory for the packaged executable. |
| `assets` | No | Record of SEA asset names to file paths. |
| `useCodeCache` | No | Node SEA code-cache setting. Defaults to `true`. |
| `expectedNodeVersion` | No | Fails when the current Node version differs. |
| `expectedArchitecture` | No | Fails when the current architecture differs. |
| `signing.mode` | No | `optional` for development or `required` for release. |
| `macos.identity` | Release macOS | Developer ID Application identity. |
| `macos.entitlements` | No | Hardened-runtime JIT, executable-memory, and library-validation flags. |
| `macos.notarization` | No | Enables `notarytool` submission and optional stapling. |

All relative paths resolve from `baseDirectory`. The CLI uses the config file's
directory; the API defaults to the current working directory.

## CLI

Create `app-packager.config.mjs` with a default object export:

```js
export default {
  name: 'example-app',
  entry: './dist/main.cjs',
  outputDirectory: './release',
};
```

Then run:

```bash
app-packager package --config ./app-packager.config.mjs
app-packager sign --file ./release/example-app --mode optional
app-packager verify --file ./release/example-app
```

Commands return a non-zero status on failure. Success output is stable JSON
metadata after a short progress line. Sensitive command arguments are redacted
from surfaced failures.

## Signing policy

### Windows

The packaging order is fixed: copy Node, remove the inherited Authenticode
signature, inject the SEA blob, sign with Azure Trusted Signing, and verify with
SignTool.

The following environment values are an all-or-none group:

- `SIGNTOOL_PATH`
- `AZURE_CODE_SIGNING_DLIB`
- `AZURE_METADATA_JSON`

`required` mode fails if they are absent. `optional` mode leaves the executable
unsigned when all three are absent, but still rejects partial configuration.
Azure authentication is handled by the Trusted Signing DLib's normal credential
chain and is not represented in package configuration.

### macOS

Development mode applies an ad-hoc signature after SEA injection. Release mode
requires `macos.identity`, applies hardened-runtime signing and configured
entitlements, and verifies with `codesign`.

Applications that ship native files beside the SEA executable must sign those
nested files before archiving. Pass an inner-to-outer ordered inventory to
`signExecutables()`; for macOS, put the main executable last. Windows callers
must include every `.exe`, `.dll`, and `.node` payload. Linux does not support
code signing in this package.

Notarization uses:

- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

Credentials are passed as command arguments but redacted from errors. Stapling
is opt-in through `macos.notarization.staple`. Relocatable directory releases
should instead ZIP the complete signed directory temporarily and pass that ZIP
to `notarizeMacOSArchive()`; raw directory/tar releases cannot carry a stapled
ticket.

### Linux

Linux artifacts are stripped but are not signed or verified in phase one.
Metadata explicitly reports both values as `false`.

## Development

```bash
pnpm --filter @stagewise/app-packager typecheck
pnpm --filter @stagewise/app-packager test
pnpm --filter @stagewise/app-packager build
```

The Vitest suite includes a native smoke test on macOS and Linux. It builds a
real SEA with an embedded asset, applies the host signing policy, executes the
artifact, and validates its metadata.
