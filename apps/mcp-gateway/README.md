# MCP Gateway

Thin runnable composition of the batteries-included `@stagewise/mcp-gateway-sdk/server` API for local development and deployment smoke testing.

## Configuration

Copy `mcp-gateway.config.example.json` to `mcp-gateway.config.json` in this directory and replace every placeholder token. The local config file is ignored by Git.

The configuration supports multiple tenants, agents, and environments. Every agent and environment requires a unique bearer token. A token authenticates exactly one principal; clients must send the matching token in the `Authorization: Bearer <token>` header.

Agents can access only the environment IDs listed in their `environmentGrants`. Sharing a tenant does not grant access. Grants may reference only environments in the same tenant.

The app rejects malformed configuration, duplicate IDs or tokens, duplicate grants, and grants to unknown environments during startup.

## Endpoints

- Agents send MCP requests to `/environments/:environmentId/mcp`.
- Environment daemons connect by WebSocket to `/environment`.

Run the local gateway with:

```sh
pnpm --filter @stagewise/mcp-gateway dev
```

The config stores plaintext bearer credentials and is intended for local operation. Do not commit it. Put TLS and production identity infrastructure in front of this process for a hosted deployment.

The E2E client and daemon are separate processes and continue to receive their own credentials through their script-specific environment variables; those variables are not used to configure the gateway server.
