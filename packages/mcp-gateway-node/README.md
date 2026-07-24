# MCP Gateway Node

Node.js gateway SDK that relays official MCP Streamable HTTP clients to remote environments connected through `@stagewise/mcp-gateway-daemon`.

The SDK does not host a local `McpServer` and does not implement MCP methods. Official MCP transports own request classification, session headers, JSON/SSE responses, and protocol-version validation. The gateway authenticates identities, authorizes routes through `mcp-gateway-core`, binds lifetimes, and relays JSON-RPC messages.

## Batteries-included server

```ts
import { createGatewayServer } from '@stagewise/mcp-gateway-node';
import {
  createEnvironmentId,
  createTenantId,
} from '@stagewise/mcp-gateway-core';

const tenantId = createTenantId('tenant');
const server = createGatewayServer({
  authorization: {
    authorize: async (agent, environment) =>
      agent.tenantId === environment.tenantId,
  },
  authenticateAgent: async ({ request }) => authenticateAgent(request),
  authenticateEnvironment: async ({ request }) =>
    authenticateEnvironment(request),
  parseEnvironmentId: (value) => createEnvironmentId(value),
  host: '127.0.0.1',
  port: 3000,
});

const address = await server.start();
console.log(address.mcpUrl('environment-1'));
console.log(address.environmentUrl);
```

Agent traffic uses `/environments/:environmentId/mcp`. Daemons connect to `/environment` by default. The environment ID in the URL is only the requested destination. Trusted agent and environment principals must come exclusively from successful authentication callbacks. `GatewayAuthorization` remains the final tenant and access-policy boundary.

TLS is intentionally outside the SDK. Terminate TLS at a reverse proxy and forward HTTP and WebSocket upgrades without placing credentials in URLs.

## Existing Node server

Use `createGatewayNodeHandlers` when the application owns its `node:http` server:

```ts
const handlers = createGatewayNodeHandlers(options);
const server = createServer((request, response) => {
  void handlers.handleHttp(request, response);
});
server.on('upgrade', (request, socket, head) => {
  void handlers.handleEnvironmentUpgrade(request, socket, head);
});
```

The HTTP adapter uses the official `@modelcontextprotocol/node` conversion layer, preserving streamed SSE responses, write backpressure, and request cancellation. Hono and Fastify integrations can call `createGatewayHttp(options).fetch(request)` directly and forward raw Node upgrade sockets through the environment upgrade handler.

## Web-standard relay

`createGatewayHttp` exposes:

- `fetch(Request): Promise<Response>`
- `sessionCount`
- idempotent `close()`

It supports legacy sessionful Streamable HTTP and modern per-request exchanges through official SDK transports. One core gateway session is opened per legacy MCP session or modern exchange. Related request IDs are relayed end to end so concurrent responses, progress, logging, and SSE notifications remain correlated.

## Lifecycle and observability

`start()` and `close()` are idempotent. Shutdown stops HTTP intake, closes active HTTP exchanges and environment registrations, then closes the core gateway. Reconnecting a daemon for the same environment replaces the stale core registration and invalidates its sessions.

Hooks report session opens, closes, accepted environment connections, and errors using typed IDs and causes. Hooks never receive credentials or raw authorization headers. The embedding application owns logging policy and must not log secrets.
