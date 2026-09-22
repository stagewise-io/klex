# klex-machine

`klex-machine` is a local-first MCP server that exposes unrestricted filesystem and persistent shell access to the machine on which it runs.

## Security

This server has the same filesystem, process, and network permissions as its operating-system user. It does not sandbox shell commands or restrict paths. The default listener is `127.0.0.1`; binding another interface exposes unauthenticated full-machine access.

## Install and run

```sh
npm install --global @klex/machine
klex-machine cloud enroll <code>
klex-machine

# Explicit unauthenticated local mode:
klex-machine serve --mode local --cwd /path/to/project --port 3123
```

With no command, the machine starts in enrolled mode using the identity in `~/.klex-machine`. Local mode serves the MCP endpoint at `http://127.0.0.1:3123/mcp` and the health endpoint at `http://127.0.0.1:3123/health`.

Configuration precedence is CLI flag, environment variable, then default:

| Flag | Environment | Default |
| --- | --- | --- |
| `--cwd` | `KLEX_MACHINE_CWD` | current directory |
| `--host` | `KLEX_MACHINE_HOST` | `127.0.0.1` |
| `--port` | `KLEX_MACHINE_PORT` | `3123` |
| `--log-level` | `KLEX_MACHINE_LOG_LEVEL` | `info` |
| `--mode` | `KLEX_MACHINE_MODE` | `enrolled` |
| `--data-dir` | `KLEX_MACHINE_DATA_DIR` | `~/.klex-machine` |
| `--cloud-base-url` | `KLEX_MACHINE_CLOUD_BASE_URL` | `https://cloud.klex.bot` |
| `--enrollment-code-file` | `KLEX_MACHINE_ENROLLMENT_CODE_FILE` | none |

## Managed sandbox bootstrap

Managed E2B templates start the machine with a protected one-time code file:

```sh
klex-machine cloud bootstrap \
  --cloud-base-url https://pr-N.preview.cloud.klex.bot \
  --enrollment-code-file /run/klex/enrollment-code \
  --data-dir /var/lib/klex-machine
```

Use `--enrollment-code-file -` to read the code from standard input. Never put an enrollment code in a command argument or environment variable. Bootstrap removes a file input after reading it, enrolls atomically, validates that enrollment metadata matches the private key, and starts enrolled mode in the same process. On restart it reuses matching identity and enrollment state without contacting the enrollment endpoint. Missing private keys, corrupt metadata, or a key-ID mismatch fail closed.

The template must provide Node.js 24 or newer, a writable owner-only data directory that survives E2B pause/resume, a writable working directory, outbound HTTPS to the paired Cloud deployment, and normal `SIGTERM` delivery. The process should run as an unprivileged user and be supervised with restart-on-failure. It must not expose the local unauthenticated HTTP listener publicly.

Relative filesystem paths and new shell sessions start from the configured working directory. Absolute paths remain unrestricted.

## Development

From the Klex monorepo:

```sh
pnpm --filter @klex/machine build
pnpm --filter @klex/machine typecheck
pnpm --filter @klex/machine test
pnpm --filter @klex/machine verify
```
