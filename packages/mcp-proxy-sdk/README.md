# MCP Proxy SDK

One SDK for hosting MCP proxies, embedding proxy endpoints in Node backends, and connecting remote MCP environments through an outbound daemon.

The package has no root export. Import an explicit subpath so runtime boundaries remain visible.

## Public entry points

- `@klex/mcp-proxy-sdk/core`: runtime-neutral environment IDs, exchange protocol, connections, and routing.
- `@klex/mcp-proxy-sdk/http`: Web-standard request/response relay with `fetch(Request): Promise<Response>`.
- `@klex/mcp-proxy-sdk/server`: Node HTTP handlers, WebSocket upgrades, and the batteries-included proxy server.
- `@klex/mcp-proxy-sdk/daemon/node`: Node environment daemon backed by `ws`.

`/core` and `/http` do not import Node built-ins. `/server` and `/daemon/node` are Node-only.

## Proxy

```ts
import { createEnvironmentId } from '@klex/mcp-proxy-sdk/core';
import { createProxyServer } from '@klex/mcp-proxy-sdk/server';

const server = createProxyServer({
  authenticateEnvironment: async ({ request }) =>
    authenticateEnvironment(request),
  parseEnvironmentId: (value) => createEnvironmentId(value),
  host: '127.0.0.1',
  port: 3000,
});

await server.start();
```

Agent traffic uses `/environments/:environmentId/mcp`. Daemons connect to `/environment` by default. The relay tunnels each HTTP request and streamed response as an independent exchange. It does not interpret MCP, own MCP session state, or authenticate agents.

The proxy authenticates environment connections only. Agent credentials, including `Authorization`, pass through unchanged to the environment handler. Each environment handler is responsible for authenticating and authorizing agents and may return `401` or `403`; the relay passes those responses back unchanged. `Proxy-Authorization` and other hop-by-hop transport headers are not forwarded.

For an existing Node server, use `createProxyNodeHandlers(options)` from `/server`. Frameworks using Web-standard requests can call `createProxyHttp(options).fetch(request)` from `/http`.

### Distributed request routing

Hosts with multiple proxy processes can provide `routeRequest`. The router receives the parsed environment ID, the original untouched `Request`, and a single-use `forwardLocal()` callback. It can choose the local in-memory connection or return a streamed `Response` obtained from the process that owns the connection. Without this option, all requests use the local proxy exactly as before.

```ts
const server = createProxyServer({
  authenticateEnvironment,
  parseEnvironmentId,
  routeRequest: async ({ environmentId, request, forwardLocal }) => {
    const owner = await ownership.find(environmentId);
    return owner.isLocal
      ? forwardLocal()
      : fetch(owner.url, request);
  },
});
```

`forwardLocal()` can be called once. Router failures are reported through `hooks.onError` and become `503` responses. The hosting application remains responsible for preserving cancellation and response streaming in its remote transport.

### Environment lifecycle

`onConnected` and `onDisconnected` are awaitable lifecycle hooks. Both receive the same environment ID and connection object, allowing a host to associate an external ownership generation with that exact socket. A rejected connection hook closes and unregisters the socket. Shutdown waits for disconnection hooks, so ownership records can be removed before the process exits.

## Environment daemon

The daemon accepts any Web-standard handler. MCP environments should pass the official stateless handler boundary rather than connecting an `McpServer` to a synthetic transport.

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createProxyDaemon } from '@klex/mcp-proxy-sdk/daemon/node';

const mcp = createMcpHandler(
  () => new McpServer({ name: 'computer', version: '1.0.0' }),
  { legacy: 'stateless' },
);

const daemon = createProxyDaemon({
  connection: () => ({
    url: 'wss://proxy.example.com/environment',
    headers: {
      authorization: `Bearer ${process.env.PROXY_TOKEN ?? ''}`,
    },
  }),
  handler: {
    fetch: mcp.fetch,
    close: () => mcp.close(),
  },
});

await daemon.start();
```

The daemon reconstructs requests, invokes `handler.fetch`, streams response bytes with bounded relay frames, propagates cancellation, and closes the handler exactly once. It calls `connection` before every initial connection and reconnect, so the host can provide fresh URLs or headers for each attempt.

For a hosted deployment, the provider can obtain a short-lived connection URL without coupling the SDK to a ticket format:

```ts
connection: async () => ({
  url: await platform.obtainEnvironmentConnectionUrl(),
})
```

The hosting platform owns ticket minting, expiry, replay prevention, and validation in `authenticateEnvironment`; the SDK only opens the returned WebSocket URL.

Long-lived MCP responses, including subscription streams and server notifications, remain ordinary response bodies. Concurrent exchanges are isolated and multiplexed over one environment WebSocket.

## Future browser daemon

Browser daemon support is intentionally not exported. A future `/daemon/browser` entry point requires a runtime-neutral socket boundary and browser-compatible authentication such as short-lived connection tickets or first-frame authentication.
