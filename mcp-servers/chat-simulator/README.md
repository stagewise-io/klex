# Chat Simulator

Local chat environment for testing an agent through MCP. User messages become
durable Push Notifications. Agent replies are sent with one MCP tool and appear in the
browser.

## Run

From the repository root:

```sh
pnpm install
pnpm --filter @stagewise/chat-simulator dev
```

The development and start scripts load the repository-root `.env`. For a real
local LiveKit realtime call, configure:

```dotenv
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
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
| `POST /api/realtime/sessions` | Create a contract-only incoming audio offer |
| `DELETE /api/realtime/sessions/:sessionId` | End an offered or accepted session remotely |
| `GET /api/stream` | Browser message stream |

Configure the agent's MCP client with:

```text
http://localhost:8787/mcp
```

The server supports both the `2026-07-28` modern protocol and the legacy MCP
handshake. MCP clients default to legacy negotiation, so clients that need
Realtime Media's `subscriptions/listen` stream must opt into negotiation with
`versionNegotiation: 'auto'`. The server advertises the Push
Notifications and Realtime Media extensions.

## Agent contract

A message entered in the browser produces this event:

```ts
{
  eventId: string,
  sourceId: 'chat-simulator:local',
  type: 'chat.message.received',
  createdAt: string,
  content: [{ type: 'text', text: string }],
  data: {
    messageId: string,
  },
}
```

Retrieve pending events and acknowledge them with
`@stagewise/mcp-extension-push-notifications/client`. Use `eventId` as the
deduplication key. Acknowledged events immediately disappear from pending
retrieval; repeated acknowledgements are safe.

The server exposes one tool:

```ts
await mcpClient.callTool({
  name: 'sendMessage',
  arguments: { message: 'Agent reply' },
});
```

`message` must contain between 1 and 4,000 characters after trimming.

## Realtime Media contract fixture

The simulator also implements the control-plane-only
`io.stagewise/realtime-media` contract. Open a realtime `subscriptions/listen`
stream, create an offer with `POST /api/realtime/sessions`, and use the MCP
`accept`, `reject`, or `end` requests to exercise lifecycle behavior.

Without LiveKit environment variables, acceptance intentionally returns
`wss://contract-only.livekit.invalid` with a non-connectable token so contract
tests remain deterministic. With all three LiveKit variables configured, the
simulator mints short-lived browser and Klex participant tokens for one room.
Use **Start realtime call** in the browser UI to publish the microphone and play
Klex's returned audio track. Use headphones to avoid acoustic feedback.

## E2E check

1. Start the simulator and the agent.
2. Open the browser UI.
3. Enter a user message.
4. Confirm that the agent receives a `chat.message.received` Push Notification.
5. Confirm that the agent persists and acknowledges the event.
6. Have the agent call `sendMessage`.
7. Confirm that the reply appears in the browser.
8. Restart the agent and verify that acknowledged events are not delivered again.

## Limitations

The simulator keeps messages, pending events, and acknowledgements in memory.
Restarting it clears all state. It uses one fixed local consumer identity, has no
authentication, and is intended only for trusted development environments.

See the [Push Notifications client guide](../../packages/mcp-extension-push-notifications/README.md#client)
for durable event handling and the [Realtime Media extension](../../packages/mcp-extension-realtime-media/README.md)
for the ephemeral audio-session control contract.
