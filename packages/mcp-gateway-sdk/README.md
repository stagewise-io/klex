# MCP Gateway SDK

One SDK for hosting MCP gateways, embedding gateway endpoints in Node backends, and connecting remote MCP environments through an outbound daemon.

The package has no root export. Import an explicit subpath so runtime boundaries remain visible.

## Public entry points

- `@stagewise/mcp-gateway-sdk/core`: runtime-neutral identities, authorization, exchange protocol, connections, and routing.
- `@stagewise/mcp-gateway-sdk/http`: Web-standard request/response relay with `fetch(Request): Promise<Response>`.
- `@stagewise/mcp-gateway-sdk/server`: Node HTTP handlers, WebSocket upgrades, and the batteries-included gateway server.
- `@stagewise/mcp-gateway-sdk/daemon/node`: Node environment daemon backed by `ws`.

`/core` and `/http` do not import Node built-ins. `/server` and `/daemon/node` are Node-only.

## Gateway

```ts
import { createEnvironmentId } from '@stagewise/mcp-gateway-sdk/core';
import { createGatewayServer } from '@stagewise/mcp-gateway-sdk/server';

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

await server.start();
```

Agent traffic uses `/environments/:environmentId/mcp`. Daemons connect to `/environment` by default. The relay tunnels each HTTP request and streamed response as an independent exchange. It does not interpret MCP or own MCP session state.

For an existing Node server, use `createGatewayNodeHandlers(options)` from `/server`. Frameworks using Web-standard requests can call `createGatewayHttp(options).fetch(request)` from `/http`.

## Environment daemon

The daemon accepts any Web-standard handler. MCP environments should pass the official stateless handler boundary rather than connecting an `McpServer` to a synthetic transport.

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createGatewayDaemon } from '@stagewise/mcp-gateway-sdk/daemon/node';

const mcp = createMcpHandler(
  () => new McpServer({ name: 'computer', version: '1.0.0' }),
  { legacy: 'stateless' },
);

const daemon = createGatewayDaemon({
  gatewayUrl: 'wss://gateway.example.com/environment',
  credential: { type: 'bearer', token: process.env.GATEWAY_TOKEN ?? '' },
  handler: {
    fetch: mcp.fetch,
    close: () => mcp.close(),
  },
});

await daemon.start();
```

The daemon reconstructs requests, invokes `handler.fetch`, streams response bytes with bounded relay frames, propagates cancellation, refreshes authentication on reconnect, and closes the handler exactly once.

Long-lived MCP responses, including subscription streams and server notifications, remain ordinary response bodies. Concurrent exchanges are isolated and multiplexed over one environment WebSocket.

## Future browser daemon

Browser daemon support is intentionally not exported. A future `/daemon/browser` entry point requires a runtime-neutral socket boundary and browser-compatible authentication such as short-lived connection tickets or first-frame authentication.
