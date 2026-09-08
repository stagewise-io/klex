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

## Model providers

The provider contract is registry-driven. Clients do not need provider-specific
routes or hard-coded forms:

- `GET /v1/provider-types` returns each provider type's display metadata,
  capabilities, and declarative setup fields.
- `POST /v1/provider-types/{type}/can-add` checks candidate settings and local
  prerequisites without changing configuration.
- `/v1/providers` exposes instance CRUD. Every instance includes its stable ID
  and provider type; multiple instances may use the same type.
- `POST /v1/providers/{id}/test` returns the standardized connectivity result.
- `/v1/providers/{id}/models` exposes merged discovery and manual-model data and
  manages `knownModels` overrides.

Failures contain a stable `code`, a human-readable `error`, and optional
`remediation`. Branch on the code rather than parsing messages. Provider settings
returned by the API are redacted and must never contain resolved environment
secrets. Model selection uses separate `providerId` and opaque `modelId` fields;
clients must not split model IDs on colons.

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

## God session management

The Admin API contract includes the dedicated God Messages session:

- `POST /v1/god-messages` submits a trusted multipart directive.
- `GET /v1/god-messages/session` returns the current session state.
- `GET /v1/god-messages/messages` returns cursor-paginated session history.
- `POST /v1/god-messages/reset` replaces a resettable session.

Install `hono` and `@hono/zod-openapi` as peer dependencies.
