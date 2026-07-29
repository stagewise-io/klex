# Windows Use

Minimal Windows environment host that supervises Windows-MCP and exposes its Streamable HTTP endpoint through an outbound MCP gateway connection.

## Architecture

One Node.js process starts Windows-MCP as its only child process. Development mode invokes `uvx windows-mcp`; the portable bundle invokes the adjacent frozen `windows-mcp.exe` directly. The gateway daemon runs in-process and forwards tunneled HTTP exchanges to `http://127.0.0.1:8123/mcp`. The host waits for Windows-MCP readiness before connecting to the gateway.

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
- `WINDOWS_MCP_LAUNCH_MODE` — optional `uvx` or `executable`; defaults to `uvx` for development.
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

## Portable Windows distribution

The reproducible PyInstaller project in `packaging/windows-mcp/` builds the frozen Windows-MCP child. The Windows Use SEA build embeds the Node.js host into `stagewise-windows-use.exe`, and `packaging/windows-use/assemble.ps1` combines both outputs into one portable ZIP.

The assembled bundle reads `windows-use.config.json` next to the host executable. Relative `windowsMcpCommand` paths are resolved from that configuration file, and environment variables override matching JSON values. Edit only the gateway URL and environment token for the normal portable test.

On a Windows x64 build machine, first build Windows-MCP and then assemble the complete distribution:

```powershell
pnpm install --frozen-lockfile
./mcp-servers/windows-use/packaging/windows-mcp/build.ps1
./mcp-servers/windows-use/packaging/windows-use/assemble.ps1
```

The output is `packaging/windows-use/artifacts/stagewise-windows-use-win-x64.zip`. The GitHub Actions workflow builds and uploads the same complete bundle after signing both primary executables, smoke-testing the frozen Windows-MCP child, and verifying the final staged Authenticode signatures.

Release workflow builds use Azure Trusted Signing for `stagewise-windows-use.exe` and `windows-mcp/windows-mcp.exe`. The workflow reads non-sensitive Azure configuration from variables in the protected `windows-use-release` GitHub Environment and reads only `AZURE_CLIENT_SECRET` from its environment secrets. Local builds remain unsigned when signing configuration is absent. Azure credentials and generated signing metadata must never be committed.

This milestone is a portable test distribution. It is not an installer, service, tray application, enrollment flow, or automatic updater.

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
