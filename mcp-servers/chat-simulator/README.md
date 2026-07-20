# Chat Simulator

Local chat environment for testing an agent through MCP. User messages become
durable Fluid Events. Agent replies are sent with one MCP tool and appear in the
browser.

## Run

From the repository root:

```sh
pnpm install
pnpm --filter @stagewise/chat-simulator dev
```

Open [http://localhost:8787](http://localhost:8787). Set `PORT` to use another
port:

```sh
PORT=9000 pnpm --filter @stagewise/chat-simulator dev
```

For a built server:

```sh
pnpm --filter @stagewise/chat-simulator build
pnpm --filter @stagewise/chat-simulator start
```

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Chat UI |
| `GET /health` | Health check |
| `POST /mcp` | Streamable HTTP MCP endpoint |
| `GET /api/messages` | Current chat messages |
| `POST /api/messages` | Add a user message |
| `GET /api/stream` | Browser message stream |

Configure the agent's MCP client with:

```text
http://localhost:8787/mcp
```

The server supports the legacy MCP handshake and advertises the Fluid Events
extension through capability discovery.

## Agent contract

A message entered in the browser produces this event:

```ts
{
  eventId: string,
  sourceId: 'chat-simulator:local',
  type: 'chat.message.received',
  createdAt: string,
  payload: {
    messageId: string,
    message: string,
  },
}
```

Retrieve and acknowledge events with
`@stagewise/mcp-extension-fluid-events/client`. Use `eventId` as the
deduplication key and treat the cursor as opaque.

The server exposes one tool:

```ts
await mcpClient.callTool({
  name: 'sendMessage',
  arguments: { message: 'Agent reply' },
});
```

`message` must contain between 1 and 4,000 characters after trimming.

## E2E check

1. Start the simulator and the agent.
2. Open the browser UI.
3. Enter a user message.
4. Confirm that the agent receives a `chat.message.received` Fluid Event.
5. Confirm that the agent persists and acknowledges the event.
6. Have the agent call `sendMessage`.
7. Confirm that the reply appears in the browser.
8. Restart the agent and verify that already persisted events are deduplicated.

## Limitations

The simulator keeps messages, events, cursors, and acknowledgements in memory.
Restarting it clears all state. It has no authentication and is intended only for
trusted development environments.

See the [Fluid Events client guide](../../packages/mcp-extension-fluid-events/README.md#client)
for connection, recovery, acknowledgement, and subscription examples.
