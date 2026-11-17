# klex-machine

`klex-machine` is a local-first MCP server that exposes unrestricted filesystem and persistent shell access to the machine on which it runs.

## Security

This server has the same filesystem, process, and network permissions as its operating-system user. It does not sandbox shell commands or restrict paths. The default listener is `127.0.0.1`; binding another interface exposes unauthenticated full-machine access.

## Install and run

Requires Node.js 24 or newer.

```sh
pnpm add -g @klex/machine   # or: npm install -g @klex/machine
klex-machine cloud enroll <code>

# Explicit unauthenticated local mode:
klex-machine serve --mode local --cwd /path/to/project --port 3123
```

Run `pnpm setup` once and restart your shell before your first global pnpm install.

`cloud enroll` enrolls the machine and then keeps serving in the same process. Keep it running; the machine is offline while the process is stopped. It does not install a background service, so it does not survive a terminal close or reboot. Pass `--no-serve` to enroll and exit, then start it later with `klex-machine`. Enrolled mode connects outbound to Cloud and has no local listener, so `--host`, `--port`, and `--log-level` only apply to local mode.

Running the same `cloud enroll` command again restarts the machine without contacting the enrollment endpoint. A new code re-enrolls this computer with its existing identity key. If Cloud reports that the machine is already enrolled, delete the old machine in Cloud first, then run the command with a new code. To start over with a fresh identity, delete `~/.klex-machine`.

With no command, the machine starts in enrolled mode using the identity in `~/.klex-machine`. Local mode serves the MCP endpoint at `http://127.0.0.1:3123/mcp` and the health endpoint at `http://127.0.0.1:3123/health`.

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

## MCP icons

The MCP `initialize` response advertises light/dark SVG icons through standard `serverInfo.icons`. Images are self-contained base64 data URLs with scalable `sizes: ["any"]`, designed for 16px badges. Laptop, desktop, server and container shapes follow the same device-type detector as Cloud machine facts. Virtual machines use the server rack icon. Unknown devices use a generic monitor.

Detection is lazy, shared across principals and requests, and limited to one second per process. Failures use the generic icon without blocking subsequent requests or retrying probes. `--omit-host-details` skips icon device detection too and always advertises the generic icon. No external image host or Cloud-specific URL matching is required. Existing machines need an updated daemon and an MCP reconnect before clients receive the icons.

## Machine facts reported to Cloud

Enrolled and managed modes report static facts on every authenticated Cloud connection attempt, including reconnect. Local mode and enrollment with `--no-serve` do not report. Collection uses Node OS/filesystem APIs and fixed system-information commands, with a one-second async probe budget. It never invokes MCP tools or interpolates user input into commands.

Reports include daemon version, OS platform/architecture, kernel release and OS name, CPU model, logical processors available to the process, and runtime-visible total RAM. Hostname, configured workspace path and total size of the filesystem containing that workspace are included by default. RAM is not verified provider entitlement; disk size is not free space or the sum of attached disks. Unavailable optional probes are omitted. Linux distribution names come from `PRETTY_NAME` in os-release, parsed as data.

The optional `host.deviceType` is `laptop`, `desktop`, `server`, `vm` or `container`. macOS uses System Information model names, Windows queries CIM model/chassis information, and Linux checks container/virtualization signals before DMI chassis data. Unknown types are omitted. Queries have bounded runtime/output, share the collection budget, and do not block authentication if unavailable. No serial numbers or raw system-information output are transmitted. Deploy Cloud's extended strict schema before releasing daemons with this field; older strict validators reject extended facts without rejecting the connection.

These are untrusted display-only values exposed through Cloud's existing organization-scoped machine API. Facts do not change authorization, quotas, health, idle timers or wake decisions. Cloud retains last-known facts during disconnect or idle.

To omit hostname, workspace path and disk size, use:

```sh
klex-machine --omit-host-details
KLEX_MACHINE_OMIT_HOST_DETAILS=1 klex-machine
```

The environment setting accepts `1`/`true` or `0`/`false`, case-insensitive. CLI flags take precedence; `--no-omit-host-details` overrides an enabled environment setting. Omission skips hostname, disk and device-type probes. A valid report replaces the entire stored document, so previously retained host details disappear only after Cloud accepts an omitted-host report. A disconnected machine or a dropped report does not immediately clear them.

The WebSocket upgrade header `x-klex-machine-facts` carries UTF-8 JSON as unpadded base64url, capped at 4096 bytes. The v1 contract has `v`, `machineVersion`, `os`, `cpu`, `memory` and optional `host`; strings are bounded and numeric values are positive safe integers. Collection and storage are best effort. Old Cloud deployments ignore the extra header; old daemons leave retained Cloud facts untouched. Ship Cloud's additive migration and proxy/API support before releasing this daemon and updating managed images. No SDK release is required.

## Managed sandbox bootstrap

Managed E2B templates start the machine with a protected one-time code file:

```sh
klex-machine cloud bootstrap \
  --cloud-base-url https://pr-N.preview.cloud.klex.bot \
  --enrollment-code-file /run/klex/enrollment-code \
  --data-dir /var/lib/klex-machine
```

Use `--enrollment-code-file -` to read the code from standard input. In managed sandboxes, never put an enrollment code in a command argument or environment variable. Bootstrap removes a file input after reading it, enrolls atomically, validates that enrollment metadata matches the private key, and starts enrolled mode in the same process. On restart it reuses matching identity and enrollment state without contacting the enrollment endpoint. Missing private keys, missing or corrupt metadata, or a key-ID mismatch fail closed.

The template must provide Node.js 24 or newer, a writable owner-only data directory that survives E2B pause/resume, a writable working directory, outbound HTTPS to the paired Cloud deployment, and normal `SIGTERM` delivery. The process should run as an unprivileged user and be supervised with restart-on-failure. It must not expose the local unauthenticated HTTP listener publicly.

Relative filesystem paths and new shell sessions start from the configured working directory. Absolute paths remain unrestricted.

## Desktop

Desktop support comes from one platform provider (`DesktopProvider` in `src/desktop/provider.ts`), chosen by platform in `src/desktop/platform/`. Its `probe()` returns `{ computerUse, stream, screen }`, plus `accessibility` while the accessibility registry answers, and that result alone decides what the machine offers. Linux uses X11, macOS a bundled helper (see [macOS](#macos)) and Windows a PowerShell helper (see [Windows](#windows)); on other platforms there is none, and klex-machine runs without any desktop tools, resource or Cloud desktop link. With X11, when `DISPLAY` points at a reachable X server and `xdotool` and ImageMagick `import` are installed, `computerUse` is true and the machine advertises `desktop_*` tools: `desktop_screenshot`, `desktop_zoom`, `desktop_click`, `desktop_drag`, `desktop_move`, `desktop_scroll`, `desktop_type`, `desktop_key`, `desktop_list_windows`, `desktop_focus_window` and `desktop_launch`. The names and arguments are Klex-owned and provider-independent, so any vision model can drive them and another provider can implement the same contract (`test/desktop-provider-contract.ts`). Set `KLEX_MACHINE_DESKTOP=off` to never offer a desktop. Without a display the tools and `desktop://screen` are hidden. A partial or failed probe is retried after 10 seconds, a full one after a minute. Native access (child processes, `DISPLAY`, socket paths, `process.platform`) stays inside `src/desktop/platform/`; `test/desktop-boundary.test.ts` and a Biome `noRestrictedImports` override keep it there.

Screenshots fit a 1280×800 box and every coordinate uses screenshot pixels, so a larger screen is scaled transparently. Run the display at 1280×800 to avoid scaling. Screenshots are JPEG by default and come back as MCP image content plus `width`, `height` and the physical `screen` size. Action tools return a screenshot only when called with `screenshot: true`. Clients that cannot show images in tool results can read the `desktop://screen` resource instead.

Input is serialized per display and checked against the control lease when it runs, not when it is queued. While a person holds control, input tools return `{"error":{"code":"desktop_controlled_by_user",...}}`. Each principal with a desktop session also gets a `desktop.control_changed` push notification when control moves between the agent and a person. These notifications are kept in memory only. Screenshots, zoom and window lists are never gated.

### Windows

On Windows the provider needs nothing installed. On first use it starts one hidden Windows PowerShell 5.1 process (`powershell.exe -NoProfile -NonInteractive -Command -`) and sends it, over stdin, a small C# helper that `Add-Type` compiles in memory: System.Drawing for screenshots, `SendInput` for mouse, keyboard and Unicode text, and `EnumWindows` for the window list. The process stays up and answers one line per request, so the compile cost (about 1–3 seconds) is paid once per daemon; after that a request costs a pipe round trip plus the work itself, and a timed-out or crashed helper is replaced on the next request. The helper makes its thread per-monitor DPI aware, so the provider works in physical pixels of the primary monitor whatever the display scaling; the tools still expose the scaled screenshot space described above. Other monitors are not captured, and window bounds are clipped to the primary monitor. If a helper is killed mid-request, its replacement releases any modifier keys and mouse buttons left down. Windows reports `computerUse` only; streaming and accessibility trees are not implemented yet.

The desktop belongs to the session klex-machine runs in. In Session 0, where Windows services run, or on a non-interactive window station (an SSH session, or a scheduled task set to run whether or not the user is signed in), the probe reports no desktop, so run klex-machine in the signed-in user's session, for example from a logon task. The lock screen, the sign-in screen and UAC prompts run on Winlogon's secure desktop, which no user process can capture or send input to; while one is showing the probe reports no desktop, and computer use returns once the user is back. Input also cannot reach windows of elevated apps unless klex-machine itself runs elevated, and a minimized or disconnected Remote Desktop session has no screen to capture. Constrained Language Mode and some application control policies block `Add-Type`; the probe then reports no desktop.

### Accessibility trees

A provider may also report `accessibility`. Only then does the machine add `desktop_accessibility_tree` and let `desktop_click` take a `ref` instead of `x` and `y`. The tree comes back as text, one element per line: a ref such as `r12`, the role, the quoted name, the value, bounds in screenshot pixels and states. `interactiveOnly` (default true), `maxDepth`, `maxNodes` and `ref` (read one subtree) bound its size. A ref keeps its number for the life of the daemon. A click by ref re-reads the element first and fails when it is gone, changed role or is off screen, rather than clicking whatever is now at the old position. Password values are never read.

Like `computerUse`, `accessibility` follows the probe alone. On X11 the provider reads AT-SPI2 over D-Bus with `dbus-next` (pure JavaScript; the native `usocket` addon is never installed). It finds the accessibility bus from `AT_SPI_BUS_ADDRESS`, the root window's `AT_SPI_BUS` property, or the session bus launcher, in that order, and reports `accessibility` only while the registry answers. `KLEX_MACHINE_DESKTOP=off` turns it off along with the rest of the desktop. Apps must be started with accessibility on: GTK and Qt apps register once the bus runs (Qt may need `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`). Chrome and Electron also need `--force-renderer-accessibility` and `ACCESSIBILITY_ENABLED=1`. Canvas, video and games expose little, so screenshots stay the way to check visual results.

### macOS

On macOS, screenshots come from the built-in `screencapture` (scaled and encoded with `sips`), and input, window listing, window focus and app launch from `dist/macos/klex-desktop-helper`, a small universal (arm64 and x86_64) Swift binary that ships inside this package and uses CGEvent, CGWindowList, the Accessibility API and NSWorkspace. `desktop_launch` opens a `.app` bundle such as `Safari.app` or `/Applications/Safari.app` through Launch Services; any other command is spawned as a process. Key combos follow the current keyboard layout, so `cmd+z` presses the key labelled Z; `ctrl` is Control and `cmd`, `super` or `meta` is Command. The macOS provider reports `stream: false` and no accessibility tree for now.

Computer use needs a logged-in desktop session plus two privacy permissions for the app that starts klex-machine, usually your terminal: Screen Recording (Screen & System Audio Recording on macOS 15 and later) and Accessibility. Without Screen Recording, macOS returns screenshots without window contents; without Accessibility, it drops synthetic input. The probe checks both without prompting. While either is missing, computer use stays off, the daemon prints a hint naming the missing permission and the System Settings pane to stderr, and the MCP instructions repeat it so the agent can tell you. Turn the app on in System Settings > Privacy & Security, quit and reopen it, then restart klex-machine. When klex-machine runs as a background service, grant `node` instead. Tools still take screenshot pixels, as on every platform. The service maps them to physical screen pixels, and the macOS provider converts those to the points macOS uses for input and window bounds with the backing scale factor (2 on Retina). Screenshots are captured at full pixel resolution before they are fitted to the screenshot box. Only the main display is captured and driven, and windows on other displays are not listed.

Building the package on macOS compiles the helper with Xcode or the Command Line Tools (`xcrun swiftc`). Other hosts copy a prebuilt helper from `KLEX_MACHINE_MACOS_HELPER_PREBUILT`; the release workflow builds it on a macOS runner and hands it to the Linux release job that publishes the package.

### Streaming to Cloud

In enrolled mode, while the provider reports `stream`, the daemon keeps a control WebSocket open at `{cloudBaseUrl}/api/machine-desktop/control`. It authenticates with its existing `machine:connect` token. Cloud uses that socket to set the control lease and to request viewer streams. For each stream, the daemon dials `/api/machine-desktop/streams/{id}` and relays raw RFB to the provider's stream source; for X11 that is the Xvnc Unix socket (`/run/klex/vnc.sock`, or `KLEX_MACHINE_VNC_SOCKET`). It never opens a TCP VNC listener. If the source cannot be opened, the daemon closes the control socket and stays off Cloud until a new probe reports `stream`. Viewer key, pointer, clipboard and resize messages are dropped unless Cloud has given a person control. A human lease reverts to the agent when it expires, or 30 seconds after the control socket drops. Commands run through `execFile` without a shell, and key names are validated before they reach `xdotool`.

The tools act with the daemon's OS user on that user's display. Anyone who can drive the desktop can read everything that user can, including the machine identity in the data directory.

`examples/desktop` contains a spike image: TigerVNC `Xvnc` on a Unix socket (no TCP listener), XFCE, Google Chrome, fonts, supervisord, and this package's build. `smoke.mjs` drives every tool against the local-mode daemon:

```sh
pnpm --filter @klex/machine build
docker build -f mcp-servers/klex-machine/examples/desktop/Dockerfile -t klex-desktop-spike mcp-servers/klex-machine
docker run -d --name klex-desktop --memory 8g --cpus 4 --shm-size 1g klex-desktop-spike
docker exec klex-desktop supervisorctl -c /etc/supervisor/desktop.conf start klex-machine-local
docker exec klex-desktop node /opt/klex-machine/examples/smoke.mjs
```

To enroll the container into Cloud, run `klex-machine cloud enroll <code> --no-serve --cloud-base-url <url>` inside it as `user`. To keep the code out of process listings, pipe it in: `docker exec -i -u user klex-desktop sh -c 'read -r code; exec klex-machine cloud enroll "$code" --no-serve --cloud-base-url <url>'`. Supervisord then starts enrolled mode. The image disables Chrome's sandbox because Docker's default seccomp profile blocks its namespaces; treat the container as the boundary.

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

Graceful shutdown terminates watcher process groups. Abrupt daemon death, including `SIGKILL`, can leave detached watcher processes running. Startup reports their records as lost but does not terminate those orphan processes. Until parent-death cleanup is implemented, the supervisor must terminate the entire workload on restart to enforce this lifecycle requirement.

Limits are 32 running watchers per principal, a 1-second to 7-day lifetime, a 16 KiB command, and a 200-character title. Starting a watcher or tracked shell fails when the principal already has 256 pending events. Existing completions are retained even if they take the queue beyond that threshold. Unacknowledged events expire after 7 days, with a warning per discarded event.

A second local server sharing a live instance's data directory runs with a memory-only queue and logs a warning. Its notifications cannot survive restart. Give concurrent servers separate data directories when durable recovery is required. Empty or malformed PID locks are not reclaimed because their ownership is uncertain. Stale PID-lock reclamation is serialized by an exclusive `notifications/lock-recovery` directory. If a crash leaves an ambiguous lock or recovery directory, stop all servers using that data directory before manually removing the lock artifacts; until then, affected startups use memory-only notifications.

## Development

From the Klex monorepo:

```sh
pnpm --filter @klex/machine build
pnpm --filter @klex/machine typecheck
pnpm --filter @klex/machine test
pnpm --filter @klex/machine verify
```
