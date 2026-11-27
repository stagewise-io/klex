# klex-machine

`klex-machine` is a local-first MCP server that exposes unrestricted filesystem and persistent shell access to the machine on which it runs. It is a single native executable written in Rust; the npm package installs the build for your platform.

## Security

This server has the same filesystem, process, and network permissions as its operating-system user. It does not sandbox shell commands or restrict paths. The default listener is `127.0.0.1`; binding another interface exposes unauthenticated full-machine access.

## Install and run

Requires Node.js 24 or newer for the npm launcher.

```sh
pnpm add -g @klex/machine   # or: npm install -g @klex/machine
klex-machine cloud enroll <code>

# Explicit unauthenticated local mode:
klex-machine serve --mode local --cwd /path/to/project --port 3123
```

Run `pnpm setup` once and restart your shell before your first global pnpm install.

Prebuilt executables exist for macOS (arm64, x64), Linux (arm64, x64; statically linked, so any distribution and libc) and Windows (arm64, x64). Your package manager installs the matching `@klex/machine-<os>-<cpu>` package through `optionalDependencies`, and the `klex-machine` command starts it, forwarding arguments, standard streams, signals and the exit status. Installing with `--no-optional` or `--omit=optional` leaves the executable out. `KLEX_MACHINE_BINARY_PATH` points the command at another executable.

`cloud enroll` enrolls the machine and then keeps serving in the same process. Keep it running; the machine is offline while the process is stopped. It does not install a background service, so it does not survive a terminal close or reboot. Pass `--no-serve` to enroll and exit, then start it later with `klex-machine`. Enrolled mode connects outbound to Cloud and has no local listener, so `--host`, `--port`, and `--log-level` only apply to local mode.

Running the same `cloud enroll` command again restarts the machine without contacting the enrollment endpoint. A new code re-enrolls this computer with its existing identity key. If Cloud reports that the machine is already enrolled, delete the old machine in Cloud first, then run the command with a new code. To start over with a fresh identity, delete `~/.klex-machine`.

With no command, the machine starts in enrolled mode using the identity in `~/.klex-machine`. Local mode serves the MCP endpoint at `http://127.0.0.1:3123/mcp` and the health endpoint at `http://127.0.0.1:3123/health`. Run `klex-machine --help` for every flag.

Configuration precedence is CLI flag, environment variable, then default:

| Flag | Environment | Default |
| --- | --- | --- |
| `--cwd` | `KLEX_MACHINE_CWD` | current directory |
| `--host` | `KLEX_MACHINE_HOST` | `127.0.0.1` |
| `--port` | `KLEX_MACHINE_PORT` | `3123` |
| `--log-level` | `KLEX_MACHINE_LOG_LEVEL` | `info` |
| `--mode` | `KLEX_MACHINE_MODE` | `enrolled` |
| `--data-dir` | `KLEX_MACHINE_DATA_DIR` | `~/.klex-machine`, identity and notification state |
| `--cloud-base-url` | `KLEX_MACHINE_CLOUD_BASE_URL` | `https://cloud.klex.bot` |
| `--enrollment-code-file` | `KLEX_MACHINE_ENROLLMENT_CODE_FILE` | none |
| `--omit-host-details` | `KLEX_MACHINE_OMIT_HOST_DETAILS` | `false` |

TLS trusts the bundled Mozilla roots plus any certificates in `NODE_EXTRA_CA_CERTS`, and adds the operating-system store when `NODE_USE_SYSTEM_CA=1` or `NODE_OPTIONS` contains `--use-system-ca`. `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` in `NODE_OPTIONS` sends Cloud HTTP requests through `HTTP_PROXY`/`HTTPS_PROXY`, honouring `NO_PROXY`. The Cloud WebSocket connects directly either way.

Clients must speak MCP protocol `2026-07-28`, for example `@modelcontextprotocol/client` 2.4.0 or newer. Older clients fall back to the legacy `initialize` handshake and get no Push Notifications.

## MCP icons

The MCP `initialize` response advertises light/dark SVG icons through standard `serverInfo.icons`. Images are self-contained base64 data URLs with scalable `sizes: ["any"]`, designed for 16px badges. Laptop, desktop, server and container shapes follow the same device-type detector as Cloud machine facts. Virtual machines use the server rack icon. Unknown devices use a generic monitor.

Detection is lazy, shared across principals and requests, and limited to one second per process. Failures use the generic icon without blocking subsequent requests or retrying probes. `--omit-host-details` skips icon device detection too and always advertises the generic icon.

## Machine facts reported to Cloud

Enrolled and managed modes report static facts on every authenticated Cloud connection attempt, including reconnect. Local mode and enrollment with `--no-serve` do not report. Collection uses operating-system APIs and fixed system-information commands, with a one-second probe budget. It never invokes MCP tools or interpolates user input into commands.

Reports include daemon version, OS platform/architecture, kernel release and OS name, CPU model, logical processors available to the process, and total RAM. Hostname, configured workspace path and total size of the filesystem containing that workspace are included by default. RAM is not verified provider entitlement; disk size is not free space or the sum of attached disks. Unavailable optional probes are omitted. Linux distribution names come from `PRETTY_NAME` in os-release, parsed as data.

The optional `host.deviceType` is `laptop`, `desktop`, `server`, `vm` or `container`. macOS uses System Information model names, Windows queries CIM model/chassis information, and Linux checks container/virtualization signals before DMI chassis data. Unknown types are omitted. Queries have bounded runtime and output, share the collection budget, and do not block authentication if unavailable. No serial numbers or raw system-information output are transmitted.

These are untrusted display-only values exposed through Cloud's organization-scoped machine API. Facts do not change authorization, quotas, health, idle timers or wake decisions. Cloud retains last-known facts during disconnect or idle.

To omit hostname, workspace path and disk size, use:

```sh
klex-machine --omit-host-details
KLEX_MACHINE_OMIT_HOST_DETAILS=1 klex-machine
```

The environment setting accepts `1`/`true` or `0`/`false`, case-insensitive. CLI flags take precedence; `--no-omit-host-details` overrides an enabled environment setting. Omission skips hostname, disk and device-type probes. A valid report replaces the entire stored document, so previously retained host details disappear only after Cloud accepts an omitted-host report. A disconnected machine or a dropped report does not immediately clear them.

The WebSocket upgrade header `x-klex-machine-facts` carries UTF-8 JSON as unpadded base64url, capped at 4096 bytes. The v1 contract has `v`, `machineVersion`, `os`, `cpu`, `memory` and optional `host`; strings are bounded and numeric values are positive safe integers. Collection and storage are best effort.

## Managed sandbox bootstrap

Managed E2B templates start the machine with a protected one-time code file:

```sh
klex-machine cloud bootstrap \
  --cloud-base-url https://pr-N.preview.cloud.klex.bot \
  --enrollment-code-file /run/klex/enrollment-code \
  --data-dir /var/lib/klex-machine
```

Use `--enrollment-code-file -` to read the code from standard input. In managed sandboxes, never put an enrollment code in a command argument or environment variable. Bootstrap removes a file input after reading it, enrolls atomically, validates that enrollment metadata matches the private key, and starts enrolled mode in the same process. On restart it reuses matching identity and enrollment state without contacting the enrollment endpoint. Missing private keys, missing or corrupt metadata, or a key-ID mismatch fail closed.

The template must provide Node.js 24 or newer to start the npm command (the executable itself needs no runtime), a writable owner-only data directory that survives E2B pause/resume, a writable working directory, outbound HTTPS to the paired Cloud deployment, and normal `SIGTERM` delivery. The process should run as an unprivileged user and be supervised with restart-on-failure. It must not expose the local unauthenticated HTTP listener publicly.

Relative filesystem paths and new shell sessions start from the configured working directory. Absolute paths remain unrestricted.

## Desktop

When the machine can see and drive a desktop, it advertises `desktop_*` tools: `desktop_screenshot`, `desktop_zoom`, `desktop_click`, `desktop_drag`, `desktop_move`, `desktop_scroll`, `desktop_type`, `desktop_key`, `desktop_list_windows`, `desktop_focus_window` and `desktop_launch`, plus the `desktop://screen` resource. The names and arguments are Klex-owned and provider-independent, so any vision model can drive them. Without a usable desktop the tools and resource are hidden; the daemon prints why to stderr and the MCP instructions repeat it so the agent can tell you. A partial or failed probe is retried after 10 seconds, a full one after a minute. Set `KLEX_MACHINE_DESKTOP=off` to never offer a desktop.

Screenshots fit a 1280×800 box and every coordinate uses screenshot pixels, so a larger screen is scaled transparently. Run the display at 1280×800 to avoid scaling. Screenshots are JPEG by default and come back as MCP image content plus `width`, `height` and the physical `screen` size. Action tools return a screenshot only when called with `screenshot: true`. Clients that cannot show images in tool results can read the `desktop://screen` resource instead.

Input is serialized per display and checked against the control lease when it runs, not when it is queued. While a person holds control, input tools return `{"error":{"code":"desktop_controlled_by_user",...}}`. Each principal with a desktop session also gets a `desktop.control_changed` push notification when control moves between the agent and a person. These notifications are kept in memory only. Screenshots, zoom and window lists are never gated.

The tools act with the daemon's OS user on that user's display. Anyone who can drive the desktop can read everything that user can, including the machine identity in the data directory.

### Linux

The server picks a desktop from the session it runs in:

- **Wayland** (`WAYLAND_DISPLAY` set or `XDG_SESSION_TYPE=wayland`): screenshots, input and the Cloud stream go through xdg-desktop-portal's RemoteDesktop and ScreenCast interfaces, with frames over PipeWire. The first start shows the desktop's screen sharing dialog. Once it is allowed, the portal's restore token is kept in `desktop-portal-token` in the data directory, so later starts do not ask again where the portal supports this (RemoteDesktop version 2). Until then, and after the dialog is declined or sharing is stopped from the desktop, the server instructions explain what to do. The stream shares clipboard text both ways through the portal's Clipboard interface (GNOME 45 or newer). Wayland does not let clients see other windows, so the window list, window focus and the accessibility tree are unavailable. GNOME 46 and KDE Plasma 6 provide both portals.
- **X11:** the display in `DISPLAY`, with XTEST for input and AT-SPI for the accessibility tree. The Cloud stream relays the VNC server at `KLEX_MACHINE_VNC_SOCKET` (default `/run/klex/vnc.sock`). Without a configured socket, if none answers, the server streams the display itself, sharing clipboard text through the CLIPBOARD selection.

Setting `KLEX_MACHINE_VNC_SOCKET` always selects X11, as in Klex Cloud sandboxes.

### macOS

Screenshots and the stream use ScreenCaptureKit, input uses Quartz events, the window list and focus use the window server and Accessibility API, and `desktop_launch` opens a `.app` bundle such as `Safari.app` through Launch Services; any other command is spawned as a process. Key combos follow the current keyboard layout, so `cmd+z` presses the key labelled Z; `ctrl` is Control and `cmd`, `super` or `meta` is Command. Only the main display is captured and driven. There is no accessibility tree yet.

Computer use needs a logged-in desktop session plus two privacy permissions for the app that starts klex-machine, usually your terminal: Screen Recording (Screen & System Audio Recording on macOS 15 and later) and Accessibility. The probe checks both without prompting. While either is missing, computer use stays off and the hint names the missing permission and the System Settings pane. Turn the app on in System Settings > Privacy & Security, quit and reopen it, then restart klex-machine. When klex-machine runs as a background service, grant the `klex-machine` executable instead.

### Windows

Capture, input and window management use GDI, `SendInput` and the window manager on the primary monitor, in physical pixels; nothing needs to be installed. There are no accessibility trees yet.

The desktop belongs to the session klex-machine runs in. In Session 0, where Windows services run, or on a non-interactive window station (an SSH session, or a scheduled task set to run whether or not the user is signed in), there is no desktop, so run klex-machine in the signed-in user's session, for example from a logon task. The lock screen and UAC prompts run on Winlogon's secure desktop, which no user process can capture or drive; while one is showing, computer use is off and the stream shows a placeholder until the user is back. While a window of an elevated app, such as Task Manager or an administrator terminal, has focus, Windows discards all input from klex-machine anywhere on the screen unless klex-machine itself runs elevated. Computer use then fails with an error naming the app.

### Accessibility trees

Where the provider reports `accessibility` (X11 while the AT-SPI registry answers), the machine adds `desktop_accessibility_tree` and lets `desktop_click` take a `ref` instead of `x` and `y`. The tree comes back as text, one element per line: a ref such as `r12`, the role, the quoted name, the value, bounds in screenshot pixels and states. `interactiveOnly` (default true), `maxDepth`, `maxNodes` and `ref` (read one subtree) bound its size. A click by ref re-reads the element first and fails when it is gone, changed role or is off screen, rather than clicking whatever is now at the old position. Password values are never read.

Apps must be started with accessibility on: GTK and Qt apps register once the bus runs (Qt may need `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`). Chrome and Electron also need `--force-renderer-accessibility` and `ACCESSIBILITY_ENABLED=1`. Canvas, video and games expose little, so screenshots stay the way to check visual results.

### Streaming to Cloud

In enrolled mode, while the provider reports `stream`, the daemon keeps a control WebSocket open at `{cloudBaseUrl}/api/machine-desktop/control`. It authenticates with its existing `machine:connect` token. Cloud uses that socket to set the control lease and to request viewer streams. For each stream, the daemon dials `/api/machine-desktop/streams/{id}` and relays RFB from the provider's stream source: the Xvnc Unix socket on X11 sandboxes, or an RFB server inside klex-machine elsewhere. It never opens a TCP VNC listener. Viewer key, pointer, clipboard and resize messages are dropped unless Cloud has given a person control. A human lease reverts to the agent when it expires, or 30 seconds after the control socket drops.

## Watchers and notifications

Clients that declare `io.stagewise/push-notifications` in per-request client capabilities can use `createWatcher`, `listWatchers`, and `cancelWatcher`. These tools and the `createShellSession.notifyOnExit` field are not advertised to other clients. The standard push extension remains discoverable by everyone.

`createWatcher` runs a one-shot shell command in the background. Supply `command`, `title`, and `timeoutMs`, plus optional `cwd` and `env`. The command should block until a condition holds and exit 0. Poll locally with a sleep between checks, or use native filesystem event tools available on the machine. Do not repeatedly poll the machine through MCP tool calls.

- Exit 0 produces `watcher.completed` with outcome `condition_met`.
- A nonzero exit or signal produces `watcher.completed` with outcome `failed`.
- Reaching the wall-clock deadline kills the process group and produces `watcher.completed` with outcome `timed_out`.
- `cancelWatcher` kills the process without notifying. `listWatchers` includes running watchers and completed watchers whose events have not been acknowledged.
- `createShellSession({ notifyOnExit: true })` produces `shell.exited` on natural exit. Explicit `closeShellSession` calls do not notify.

Notifications carry a readable summary and structured data, including the last 4 KiB of output. Delivery is at least once. Subscribe before draining pending events, persist before acknowledging, and deduplicate by `eventId`. Cloud queues are scoped to the authenticated principal. Local mode uses one shared `local` consumer.

The machine records running items and pending events in `<data-dir>/notifications/state.json`, with an owner-only directory, atomic writes, and a single-writer `lock` file. Restarts never rerun commands. Previously running watchers and tracked shells become `watcher.lost` and `shell.lost` notifications on startup. Pause/resume keeps the process state and checks deadlines against wall-clock time. Notification recovery requires the same data directory to survive the restart.

Graceful shutdown on `SIGINT` or `SIGTERM` terminates watcher process groups. The same signal again, half a second or more later, exits at once. Abrupt daemon death, including `SIGKILL`, can leave detached watcher processes running. Startup reports their records as lost but does not terminate those orphan processes, so the supervisor must terminate the entire workload on restart.

Limits are 32 running watchers per principal, a 1-second to 7-day lifetime, a 16 KiB command, and a 200-character title. Starting a watcher or tracked shell fails when the principal already has 256 pending events. Existing completions are retained even if they take the queue beyond that threshold. Unacknowledged events expire after 7 days, with a warning per discarded event.

A second local server sharing a live instance's data directory runs with a memory-only queue and logs a warning. Its notifications cannot survive restart. Give concurrent servers separate data directories when durable recovery is required. Stale lock reclamation is serialized by an exclusive `notifications/lock-recovery` directory. If a crash leaves an ambiguous lock or recovery directory, stop all servers using that data directory before manually removing the lock artifacts; until then, affected startups use memory-only notifications.

## Upgrading from the Node.js releases

Versions up to 1.10.1 were a Node.js server. This executable keeps their command, flags, environment variables, tools and data directory format, so an existing `~/.klex-machine` enrollment and notification state carry over. Known differences:

- Only the six platforms above are supported.
- The 405, 406 and 415 HTTP errors have plain-text bodies.
- Legacy `initialize` responses are JSON rather than a single-event SSE stream, and JSON-RPC batches are rejected.
- `server/discover` reports `serverInfo` in `_meta`, and the wording of the `-32020` error differs.
- A `tools/call` whose `arguments` is not an object fails JSON-RPC deserialization instead of tool validation.
- Windows shells run in ConPTY instead of winpty.
- Log records have no `path` field in `_logMeta`.

## Development

Install Rust with [rustup](https://rustup.rs). The toolchain version, components and targets come from `rust-toolchain.toml`, and rustup installs them on the first build.

- **macOS:** install the Xcode Command Line Tools with `xcode-select --install`.
- **Windows:** install the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload. On Windows on Arm, also select the ARM64 build tools.
- **Linux:** a C toolchain (`build-essential`) is enough for the host target. Release builds for musl targets are fully static and need `musl-tools`, with `CC_x86_64_unknown_linux_musl=musl-gcc` (or the `aarch64` equivalent) set, because cc-rs looks for a cross-compiler name that `musl-tools` does not install.

From the repository root:

```sh
pnpm --filter @klex/machine build    # release build in mcp-servers/klex-machine/dist
node mcp-servers/klex-machine/bin/klex-machine.js serve --mode local --cwd /path/to/project
cargo machine serve --mode local     # or build and run it through Cargo
cargo fmt-check                      # formatting
cargo lint                           # clippy with warnings denied
pnpm --filter @klex/machine test     # Rust tests and the npm release plugin tests
pnpm --filter @klex/machine verify   # pack, install and run the npm packages
cargo deny check                     # advisories, licenses and sources (needs cargo-deny)
```

`build.mjs` reads `KLEX_MACHINE_BUILD_PROFILE` (default `release`) and `KLEX_MACHINE_BUILD_TARGET` (for example `x86_64-unknown-linux-musl`). `KLEX_MACHINE_VERSION` at build time sets the version the executable reports; without it, it reports the crate version. The tool and server definitions the MCP server advertises live in `definitions/`.

OS-specific code lives only in `src/platform/`: `unix.rs` and `windows.rs` provide the same modules with the same signatures, `macos.rs` and `linux.rs` hold what differs between Unixes, and `pty.rs` defines the PTY traits. `tests/platform_boundary.rs` fails on OS `cfg`s, `libc`, `windows_sys`, `std::os` or `portable_pty` anywhere else in `src/` outside test modules. The PipeWire client is written in Rust in `src/platform/desktop/linux/pipewire/`, because the static musl executables cannot load `libpipewire`.

### Releases

`.github/workflows/release.yml` releases `@klex/machine` from conventional commits scoped `machine` (see [NPM-RELEASES.md](../../NPM-RELEASES.md)). It computes the next version with a semantic-release dry run (`npm/next-version.mjs`) and builds every platform executable with that version. `npm/release-plugin.mjs` then publishes the six `@klex/machine-<os>-<cpu>` packages before `@semantic-release/npm` publishes the launcher pinned to them. `npm/packages.mjs` lists the platforms.
