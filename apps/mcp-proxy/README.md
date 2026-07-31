# MCP Proxy

Thin runnable composition of the batteries-included `@stagewise/mcp-proxy-sdk/server` API for local development and deployment smoke testing.

## Configuration

Copy `mcp-proxy.config.example.json` to `mcp-proxy.config.json` in this directory and replace every placeholder token. The local config file is ignored by Git.

The configuration is a flat registry of globally unique environment IDs and bearer tokens. Environment daemons send their configured token in the `Authorization: Bearer <token>` header when connecting.

The proxy does not authenticate agents or store agent grants. It forwards agent credentials to the selected environment, which owns agent authentication and authorization. The app rejects malformed configuration and duplicate environment IDs or tokens during startup.

## Endpoints

- Agents send MCP requests, including their environment-recognized credentials, to `/environments/:environmentId/mcp`.
- Environment daemons connect by WebSocket to `/environment`.

Run the local proxy with:

```sh
pnpm --filter @stagewise/mcp-proxy dev
```

The config stores plaintext bearer credentials and is intended for local operation. Do not commit it. Put TLS and production identity infrastructure in front of this process for a hosted deployment.

The E2E client and daemon are separate processes and continue to receive their own credentials through their script-specific environment variables; those variables are not used to configure the proxy server.
