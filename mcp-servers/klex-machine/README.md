# klex-machine

`klex-machine` is a local-first MCP server that exposes unrestricted filesystem and persistent shell access to the machine on which it runs.

## Security

This server has the same filesystem, process, and network permissions as its operating-system user. It does not sandbox shell commands or restrict paths. The default listener is `127.0.0.1`; binding another interface exposes unauthenticated full-machine access.

## Install and run

```sh
pnpm add --global klex-machine
klex-machine serve
klex-machine serve --cwd /path/to/project --port 3123
```

The MCP endpoint is `http://127.0.0.1:3123/mcp` and health endpoint is `http://127.0.0.1:3123/health`.

Configuration precedence is CLI flag, environment variable, then default:

| Flag | Environment | Default |
| --- | --- | --- |
| `--cwd` | `KLEX_MACHINE_CWD` | current directory |
| `--host` | `KLEX_MACHINE_HOST` | `127.0.0.1` |
| `--port` | `KLEX_MACHINE_PORT` | `3123` |
| `--log-level` | `KLEX_MACHINE_LOG_LEVEL` | `info` |

Relative filesystem paths and new shell sessions start from the configured working directory. Absolute paths remain unrestricted.

## Development

From the Klex monorepo:

```sh
pnpm --filter klex-machine build
pnpm --filter klex-machine typecheck
pnpm --filter klex-machine test
pnpm --filter klex-machine verify
```
