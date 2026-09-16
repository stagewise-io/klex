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

Relative filesystem paths and new shell sessions start from the configured working directory. Absolute paths remain unrestricted.

## Development

From the Klex monorepo:

```sh
pnpm --filter @klex/machine build
pnpm --filter @klex/machine typecheck
pnpm --filter @klex/machine test
pnpm --filter @klex/machine verify
```
