# Realtime Media MCP Extension 0.1.0

## Scope

`io.stagewise/realtime-media` negotiates an ephemeral realtime audio session onto a dedicated media transport. It does not transport audio through JSON-RPC and does not provide durable events, replay, participants, tracks, transcripts, or model operations.

Normative terms **MUST**, **SHOULD**, and **MAY** are interpreted as in RFC 2119.

## Capability

Both peers advertise:

```json
{
  "extensions": {
    "io.stagewise/realtime-media": {
      "transports": ["livekit-room"],
      "media": ["audio"]
    }
  }
}
```

Every request MUST repeat this capability in `io.modelcontextprotocol/clientCapabilities` request metadata. A server MUST reject unsupported clients with JSON-RPC code `-32003` and the required capability in error data.

## Subscription

Before receiving offers, a client opens `subscriptions/listen` with `notifications["io.stagewise/realtime-media"]` set to `{}`. The server acknowledges it using `notifications/subscriptions/acknowledged`. For stateless HTTP this request remains an SSE response.

A server associates the stream with authenticated consumer identity, never an identity supplied in the body. One active subscription is retained per consumer. Replacement or loss of the stream terminates that consumer's pending and accepted sessions. Revision 0.1.0 has no resume or recovery operation.

## Messages

### `io.stagewise/realtime-media/session-offered`

Parameters are `{ sessionId, expiresAt }`. `sessionId` is non-empty and opaque within authenticated server scope. `expiresAt` is an ISO 8601 timestamp. The notification MUST NOT include transport credentials.

### `io.stagewise/realtime-media/accept`

Parameters are `{ sessionId }`. An unexpired pending offer transitions to accepted and returns:

```json
{
  "transport": {
    "profile": "livekit-room",
    "url": "wss://livekit.example.com",
    "token": "short-lived-participant-token"
  }
}
```

The token MUST be scoped to the accepted session and SHOULD be short lived. Servers and clients MUST NOT log it. Repeating accept returns the same logical descriptor while valid. Accepting an expired offer fails with `-32021`; an unknown session with `-32020`; a conflicting state with `-32022`.

### `io.stagewise/realtime-media/reject`

Parameters are `{ sessionId }`; result is empty. It transitions a pending offer to rejected. Repeating reject succeeds. Conflicting states fail with `-32022`.

### `io.stagewise/realtime-media/end`

Parameters are `{ sessionId }`; result is empty. It transitions an accepted session to ended. Repeating end succeeds. Pending, rejected, or expired sessions fail with `-32022`.

### `io.stagewise/realtime-media/session-ended`

Parameters are `{ sessionId, reason? }`. The server sends it when a pending or accepted session terminates remotely. It is terminal for that session ID. LiveKit remains authoritative for media-plane participant, track, and reconnection state.

## Security and trust boundaries

All protocol data is untrusted input. Applications validate URLs and token scope, authorize lifecycle operations against authenticated identity, redact tokens, bound offer retention, and terminate media access when the control subscription closes. The MCP proxy forwards opaque JSON-RPC and streaming responses and is not protocol-aware.
