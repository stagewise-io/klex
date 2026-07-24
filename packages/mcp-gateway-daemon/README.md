# MCP Gateway Daemon

Node.js SDK for exposing one or more isolated MCP server sessions through an
outbound WebSocket connection to an MCP gateway. Environment authors define
MCP tools; this package owns gateway frames, transports, multiplexing,
authentication, cleanup, and reconnects.

## Usage

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import { createGatewayDaemon } from '@stagewise/mcp-gateway-daemon';

function createServer(): McpServer {
  const server = new McpServer({ name: 'computer', version: '1.0.0' });
  server.registerTool(
    'echo',
    { inputSchema: z.object({ text: z.string() }) },
    ({ text }) => ({ content: [{ type: 'text', text }] }),
  );
  return server;
}

const daemon = createGatewayDaemon({
  gatewayUrl: 'wss://gateway.example.com/environment',
  credential: { type: 'bearer', token: process.env.GATEWAY_TOKEN ?? '' },
  createServer: () => createServer(),
});

await daemon.start();
process.once('SIGTERM', () => void daemon.close());
```

`createServer` runs once for every client session. Never return a shared
`McpServer`. Its context provides the gateway session ID and an `AbortSignal`
that fires when that session ends.

Hosted platforms can refresh credentials before every connection attempt:

```ts
const daemon = createGatewayDaemon({
  gatewayUrl,
  credential: async () => `Bearer ${await acquireShortLivedToken()}`,
  createServer: ({ signal }) => createComputerServer({ signal }),
});
```

`start()` resolves when the initial WebSocket opens. It reports initial failures
to the caller. After a successful start, unexpected disconnects reconnect with
bounded exponential backoff by default and resolve authorization again. Use
`state` and `activeSessionCount` for health reporting. `close()` is idempotent
and cancels pending retries.

MCP sessions are live, not durable. A WebSocket disconnect closes every active
server and aborts its context. Reconnecting starts with zero sessions; clients
must establish new MCP sessions.

## Gateway compatibility contract

A compatible self-hosted or hosted gateway must:

1. accept an environment WebSocket upgrade;
2. verify the `Authorization` header and resolve it to a trusted
   `EnvironmentPrincipal`—query parameters are not identity;
3. register that principal and the connection with
   `@stagewise/mcp-gateway-core`;
4. exchange canonical gateway protocol text frames in order; and
5. preserve gateway-core connection replacement semantics.

Credential issuance, token verification, authorization policy, storage, and
revocation belong to the embedding gateway. This daemon is credential-format
agnostic beyond requiring a non-empty Bearer authorization value.
