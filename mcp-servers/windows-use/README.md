# Windows Use

Minimal Windows environment host that supervises Windows-MCP and exposes its Streamable HTTP endpoint through an outbound MCP gateway connection.

## Architecture

One Node.js process starts `uvx windows-mcp` as its only child process. The gateway daemon runs in-process and forwards tunneled HTTP exchanges to `http://127.0.0.1:8123/mcp`. The host waits for Windows-MCP readiness before connecting to the gateway.

This package is Windows-specific. The separate `mcp-servers/computer` package remains platform agnostic.

## Prerequisites

- Windows 7–11 in an interactive logged-in user session
- Node.js 22.12 or newer
- Python 3.13 or newer
- `uv` with `uvx` available on `PATH`
- An environment principal and bearer token configured in the MCP gateway

Do not run this as a traditional Windows Service. Windows UI automation must run in the interactive user's desktop session.

## Configuration

Copy `.env.example` outside version control or provide these variables through the process launcher:

- `GATEWAY_URL` — required `ws:` or `wss:` gateway environment endpoint, normally ending in `/environment`.
- `GATEWAY_TOKEN` — required bearer token for the configured environment principal.
- `WINDOWS_MCP_COMMAND` — optional executable path; defaults to `uvx`.
- `WINDOWS_MCP_PORT` — optional loopback port; defaults to `8123`.
- `LOG_LEVEL` — optional logger level; defaults to `INFO`.

The gateway configuration must contain a matching environment and grant it to the Fluid Agent, for example:

```json
{
  "tenantId": "local",
  "agents": [
    {
      "agentId": "fluid-agent",
      "token": "REPLACE_WITH_AGENT_TOKEN",
      "environmentGrants": ["windows-pc"]
    }
  ],
  "environments": [
    {
      "environmentId": "windows-pc",
      "token": "REPLACE_WITH_ENVIRONMENT_TOKEN"
    }
  ]
}
```

The Fluid Agent reaches this environment through the gateway URL `/environments/windows-pc/mcp` using its agent bearer token.

Never pass the environment token on a command line or commit it to the repository.

## Development

From the repository root:

```powershell
pnpm install
pnpm --filter @stagewise/windows-use dev
```

The development command reads variables from its inherited environment. PowerShell example:

```powershell
$env:GATEWAY_URL = "ws://gateway-host:3000/environment"
$env:GATEWAY_TOKEN = "environment-token"
pnpm --filter @stagewise/windows-use dev
```

Build and start:

```powershell
pnpm --filter @stagewise/windows-use build
pnpm --filter @stagewise/windows-use start
```

Validate:

```powershell
pnpm --filter @stagewise/windows-use typecheck
pnpm --filter @stagewise/windows-use test
```

## Lifecycle

Startup order:

1. Spawn Windows-MCP on loopback using native Streamable HTTP.
2. Wait for its `/mcp` endpoint to respond.
3. Connect the gateway daemon over outbound WebSocket.

Shutdown reverses that order. On Windows, the host terminates the complete Windows-MCP process tree so `uvx` cannot leave an orphaned server holding the loopback port. A Windows-MCP exit after startup is fatal and stops the host. Gateway connection loss is handled by the SDK's reconnect policy.

## Initial limitations

This first package intentionally has no:

- stdio-to-HTTP proxy
- installer or Scheduled Task integration
- Windows Service integration
- automatic Windows-MCP crash restart
- dynamic enrollment or credential refresh
- Fluid Events extension
- multiple computer-use provider abstraction
