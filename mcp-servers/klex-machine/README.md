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

## Machine facts reported to Cloud

Enrolled and managed modes report static facts on every authenticated Cloud connection attempt, including reconnect. Local mode and enrollment with `--no-serve` do not report. Collection uses Node OS and filesystem APIs, has a one-second async probe budget, and never invokes MCP tools or a shell.

Reports include daemon version, OS platform/architecture, kernel release and OS name, CPU model, logical processors available to the process, and runtime-visible total RAM. Hostname, configured workspace path and total size of the filesystem containing that workspace are included by default. RAM is not verified provider entitlement; disk size is not free space or the sum of attached disks. Unavailable optional probes are omitted. Linux distribution names come from `PRETTY_NAME` in os-release, parsed as data.

These are untrusted display-only values exposed through Cloud's existing organization-scoped machine API. No UI changes are included. Facts do not change authorization, quotas, health, idle timers or wake decisions. Cloud retains last-known facts during disconnect or idle.

To omit hostname, workspace path and disk size, use:

```sh
klex-machine --omit-host-details
KLEX_MACHINE_OMIT_HOST_DETAILS=1 klex-machine
```

The environment setting accepts `1`/`true` or `0`/`false`, case-insensitive. CLI flags take precedence; `--no-omit-host-details` overrides an enabled environment setting. Omission skips hostname and disk probes. A valid report replaces the entire stored document, so previously retained host details disappear only after Cloud accepts an omitted-host report. A disconnected machine or a dropped report does not immediately clear them.

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
