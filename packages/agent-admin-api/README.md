# @klex/agent-admin-api

Shared types for the Klex Bot Admin API.

The package exports the routed Hono application type through `AdminApi` and
`AdminApiServer`, plus the `OpenAPIHono` type used to build RPC clients.

```ts
import { hc } from 'hono/client';
import type { AdminApi } from '@klex/agent-admin-api';

const client = hc<AdminApi>('https://agent.example');
const health = await client.v1.health.$get();
```

## MCP OAuth authorization

Version 0.2 adds the consolidated MCP authorization contract. Authorization is
managed through the MCP server resource:

- `PUT /v1/mcp-servers/:name/authorization` starts an interactive OAuth flow or
  returns the existing pending flow.
- `DELETE /v1/mcp-servers/:name/authorization` cancels a pending flow.
- `POST /v1/mcp-oauth/callback` delivers the provider result using its OAuth
  `state` value.
- `GET /v1/mcp-servers` and `GET /v1/mcp-servers/:name` expose authorization
  status, pending authorization metadata, connection errors, and retry timing.

The start response contains the provider authorization URL and its associated
state. Treat both as secrets: do not log them or expose them beyond the client
that opens the authorization flow. Callback state is single-use and expires at
the response's `expiresAt` timestamp.

Error responses include a machine-readable `code` alongside the human-readable
`error` message so clients can distinguish unsupported transports, manually
configured credentials, connected servers, unavailable Cloud authorization,
and authorization timeouts.

Install `hono` and `@hono/zod-openapi` as peer dependencies.
