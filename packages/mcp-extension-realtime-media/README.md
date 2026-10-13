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

## Optional session context

An offer can include `context: { text?: string, metadata?: Record<string, JSONValue> }`. Both fields can coexist. Metadata keys and nested values belong to the producer; the extension does not define caller, room, or participant fields.

```json
{
  "sessionId": "session-1",
  "expiresAt": "2026-08-01T19:00:00.000Z",
  "context": {
    "text": "This session concerns the scheduled demonstration.",
    "metadata": { "topic": "demonstration", "languages": ["en"] }
  }
}
```

The producer derives facts from authenticated application state and sends only information appropriate for the receiving client. Do not send secrets or transport credentials. Consumers treat context as external data, never as instructions or authorization, and must not fetch resources or follow URLs merely because context mentions them.

The SDK validates context before publishing or dispatching an offer. Its serialized JSON object must fit within 4,096 UTF-8 bytes, nesting depth 8, and 128 visited values. The root counts as depth 0 and one value; each property value and array element counts as another value. Only finite JSON values are accepted. Invalid or oversized context is rejected, not truncated. These aggregate limits supplement the structural JSON Schema.

Context is optional. Existing offers remain valid, and older SDK consumers ignore the additional field. Empty context has no effect. Klex snapshots the first offer's context and appends one user-role data envelope to that call's model bootstrap. It does not change system instructions, trigger a response, or store the raw envelope in canonical history. Reconnects within that call retain it; later context-free calls do not inherit it.

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
switch (accepted.transport.kind) {
  case 'livekit-room': {
    // Validated and typed as LiveKitRoomTransportDescriptor.
    const { url, token } = accepted.transport.descriptor;
    await connectToLiveKit(url, token);
    break;
  }
  case 'unknown':
    // Forward-compatible opaque descriptor for an unrecognized profile.
    handleUnknownTransport(accepted.transport.descriptor);
    break;
}
subscription.closed.catch(reconnect);
```

The client helper validates descriptors for profiles it knows. A known profile with malformed fields rejects `accept()`; unrecognized profiles retain all opaque fields under `kind: 'unknown'`. Adding another known-profile schema extends this discriminated result without changing the wire protocol.

Treat URLs, tokens, and all notification fields as untrusted. Transport adapters should validate again at their media-plane trust boundary. Never log the participant token.

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
