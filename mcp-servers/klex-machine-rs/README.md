# klex-machine-rs

A Rust port of [`@klex/machine`](../klex-machine/README.md). It is a single executable with no Node.js runtime, and it serves the same MCP tools, Push Notifications and notification store as the TypeScript server. The shared conformance suite in [`packages/klex-machine-conformance`](../../packages/klex-machine-conformance) checks both implementations against the contract in [`../klex-machine/contract`](../klex-machine/contract).

This package is private and not released. Local, enrolled and managed (Klex Cloud) modes work; the desktop app link does not exist yet.

## Security

The same warning as `@klex/machine` applies. The server has the filesystem, process and network permissions of its operating-system user, and local mode is unauthenticated. Keep the default `127.0.0.1` listener.

## Build

Install Rust with [rustup](https://rustup.rs). The toolchain version, components and targets come from `rust-toolchain.toml`, and rustup installs them on the first build.

- **macOS:** install the Xcode Command Line Tools with `xcode-select --install`.
- **Windows:** install the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload. On Windows on Arm, also select the ARM64 build tools.
- **Linux:** a C toolchain (`build-essential`) is enough for the host target. Release builds for musl targets are fully static and need `musl-tools`, with `CC_x86_64_unknown_linux_musl=musl-gcc` (or the `aarch64` equivalent) set, because cc-rs looks for a cross-compiler name that `musl-tools` does not install.

From the repository root, either command produces a release build:

```sh
pnpm --filter @klex/machine-rs build   # copies the binary to mcp-servers/klex-machine-rs/dist
cargo build --release -p klex-machine  # leaves it in target/release
```

`build.mjs` reads `KLEX_MACHINE_RS_PROFILE` (default `release`) and `KLEX_MACHINE_RS_TARGET` (for example `x86_64-unknown-linux-musl`). CI also uploads a binary for every supported platform as a `klex-machine-rs-<platform>` workflow artifact.

## Run

```sh
# macOS and Linux
mcp-servers/klex-machine-rs/dist/klex-machine-rs serve --mode local --cwd /path/to/project
```

```powershell
# Windows
mcp-servers\klex-machine-rs\dist\klex-machine-rs.exe serve --mode local --cwd C:\path\to\project
```

Klex Cloud commands match `@klex/machine` (see [its README](../klex-machine/README.md#install-and-run)):

```sh
klex-machine-rs cloud enroll <code>   # enrolls, then keeps serving
klex-machine-rs                       # enrolled mode with the saved identity
```

Enrollment state lives under `identity/` in the data directory, in the same format as `@klex/machine`, so either server can serve an enrollment the other created. As in Node.js, TLS trusts the bundled Mozilla roots plus any certificates in `NODE_EXTRA_CA_CERTS`, and adds the operating-system store when `NODE_USE_SYSTEM_CA=1` or `NODE_OPTIONS` contains `--use-system-ca`. `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` sends Cloud HTTP requests through `HTTP_PROXY`/`HTTPS_PROXY`, honouring `NO_PROXY`, as Node.js `fetch` does. The Cloud WebSocket connects directly either way, matching `@klex/machine`.

In local mode, the MCP endpoint is `http://127.0.0.1:3123/mcp` and the health endpoint is `http://127.0.0.1:3123/health`. Run `klex-machine-rs --help` for every flag. Flags and `KLEX_MACHINE_*` environment variables match `@klex/machine`, except that the default data directory is `~/.klex-machine-rs`. Both servers can therefore run side by side without sharing notification state. Pointing `--data-dir` at an existing `~/.klex-machine` directory takes over its notification state.

Clients must speak MCP protocol `2026-07-28`, for example `@modelcontextprotocol/client` 2.4.0 or newer. Older clients fall back to the legacy `initialize` handshake and get no Push Notifications.

## Development

```sh
cargo fmt-check    # formatting
cargo lint         # clippy with warnings denied
cargo test -p klex-machine
cargo deny check   # advisories, licenses and sources (needs cargo-deny)
pnpm --filter @klex/machine-conformance test   # both implementations
KLEX_MACHINE_IMPL=rust pnpm --filter @klex/machine-conformance test
```

OS-specific code lives only in `src/platform/`: `unix.rs` and `windows.rs` provide the same modules with the same signatures, `macos.rs` and `linux.rs` hold what differs between Unixes, and `pty.rs` defines the PTY traits. `tests/platform_boundary.rs` fails on OS `cfg`s, `libc`, `windows_sys`, `std::os` or `portable_pty` anywhere else in `src/` outside test modules.

The conformance suite runs the built binaries. Build `@klex/machine` and `@klex/machine-rs` first, or let turbo do it with `pnpm turbo run test --filter @klex/machine-conformance`. Set `KLEX_MACHINE_BIN` together with `KLEX_MACHINE_IMPL` to test another binary.

## Known differences from @klex/machine

- The 405, 406 and 415 HTTP errors have plain-text bodies.
- Legacy `initialize` responses are JSON rather than a single-event SSE stream, and JSON-RPC batches are rejected.
- `server/discover` reports `serverInfo` in `_meta`, and the wording of the `-32020` error differs.
- A `tools/call` whose `arguments` is not an object fails JSON-RPC deserialization instead of tool validation.
- Windows shells run in ConPTY instead of winpty.
- Log records have no `path` field in `_logMeta`.
