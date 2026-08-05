# MCP Realtime Media Extension

Typed schemas and client/server facades for negotiating ephemeral realtime media sessions over MCP.

**Extension identifier:** `io.stagewise/realtime-media`

This package is the control plane only. Audio flows through the accepted transport descriptor, initially a LiveKit room.

## Lifecycle

The extension's methods are directional:

| Method | Message type | Direction |
| --- | --- | --- |
| `session-offered` | Notification | Server → client |
| `accept` | Request | Client → server |
| `reject` | Request | Client → server |
| `end` | Request | Client → server |
| `session-ended` | Notification | Server → client |

1. Client and server advertise audio and their supported transport profiles; support requires at least one shared profile.
2. The client opens `subscriptions/listen` with the realtime-media filter.
3. The server emits `session-offered` with an opaque ID and expiration time.
4. The client calls `accept` or `reject`.
5. Acceptance returns one descriptor whose `profile` was advertised by both peers. Profile-specific fields are opaque to the extension and validated by the selected transport adapter; LiveKit returns its URL and short-lived participant token.
6. The client ends an accepted session with `end`. The server terminates a session locally and reports that termination with `session-ended`.

The subscription owns its sessions. Losing it ends pending and active sessions; this first revision has no recovery.

## Client

```ts
const realtime = registerRealtimeMediaClient(client, {
  onNotification(notification) {
    if (notification.method === REALTIME_MEDIA_SESSION_OFFERED_METHOD) {
      queueOffer(notification.params);
    }
  },
});

const subscription = await realtime.listen();
const accepted = await realtime.accept(sessionId);
subscription.closed.catch(reconnect);
```

Treat URLs, tokens, and all notification fields as untrusted. Never log the participant token.

## Server

```ts
registerRealtimeMediaServer(server, {
  accept: ({ sessionId }) => sessions.accept(sessionId),
  reject: ({ sessionId }) => sessions.reject(sessionId),
  end: ({ sessionId }) => sessions.end(sessionId),
});
```

For stateless HTTP, wrap the MCP fetch handler with `createRealtimeMediaHttpSubscriptionManager` and publish notifications by authenticated consumer key.

## Development

```sh
pnpm generate:schemas
pnpm check:schema
pnpm typecheck
pnpm test
pnpm build
```

See `specification/draft/realtime-media.md` for the normative contract.
