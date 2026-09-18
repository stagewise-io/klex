# MCP Module Architecture

## Role

The MCP module is the environment boundary between the agent core and external MCP servers. It owns:

- **Connection lifecycle** — connects, reconciles, retries, and disconnects configured MCP servers.
- **Tool registry** — builds and publishes a live tool registry from connected servers.
- **Push Notification worker** — subscribes, drains server-managed pending queues, deduplicates, and acknowledges.
- **Push Notification inbox** — process-local `eventId` deduplication scoped by MCP namespace.

The module exposes `onPushNotification()` to the MCP ingress extension installed in the default session. MCP access and MCP ingress are separate capabilities: providing an `Mcp` instance does not implicitly subscribe a session to push notifications.

## Realtime Media boundary

The MCP module exposes an independent `io.stagewise/realtime-media` control-plane facade: capability negotiation, an ephemeral notification stream, namespace-addressed accept/reject/end calls, and process-local availability events. Realtime notifications never enter the durable Push Notification inbox. Media transport, LiveKit connections, and realtime model sessions remain outside this module. Realtime capability registration is startup-gated; changing the mode requires a process restart.

## Push Notification flow

```
MCP server durable pending queue
  -> establish live subscription
  -> retrieve oldest pending notifications in bounded pages
  -> deduplication inbox (by namespace + eventId)
  -> publish to listeners (default session)
  -> acknowledge accepted event IDs
  -> continue live delivery
```

- **Live notifications** are the low-latency path.
- **Pending retrieval** is the startup and reconnection recovery path.
- **Subscribe before drain** closes the connection-boundary race.
- **At-least-once delivery** — duplicates are normal; the inbox suppresses by `eventId`.
- **Persist before acknowledgement** — the current inbox is in-memory, so it is suitable for development but not the final durable acceptance store.
- **Server-owned progress** — Klex stores no cursor. Acknowledged events disappear from the server's pending view.

If retrieval returns `hasMore: true` with an empty page, the worker fails the attempt instead of spinning. Acknowledgements retry with exponential backoff. A subscription failure restarts the complete subscribe-then-drain sequence.

## Connection lifecycle

```
config update
  -> reconcile configured servers
  -> removed/changed: close connection
  -> added/changed: create runtime and connect
  -> on connect: publish registry, start event worker
  -> event worker: subscribe -> drain pending -> process live events
  -> on disconnect: stop worker, schedule reconnect with backoff
```

Key invariants:

- Only one active connection per namespace.
- Only the current connection owns the namespace's event worker.
- Late connections from superseded attempts close immediately.

## OAuth authorization

OAuth-protected HTTP MCP servers are authorized through one of two `OAuthAuthorizationSession` implementations. `connection.ts` calls `sessionFactory.start()` once per connection attempt and awaits `session.authorize()`.

```
connect attempt -> 401 -> sessionFactory.start(context)
  local channel:  loopback receiver + browser on the agent host
  cloud channel:  public cloud redirect URI + pending-authorization registry
  -> callback parameters resolve the parked promise
  -> transport.finishAuth() -> reconnect
```

Selection happens per `start()` call: the cloud channel is used when cloud connectivity is enabled, the agent is enrolled, and the tunnel is `connected`. A tunnel drop falls back to the local browser flow on the next attempt.

The cloud channel is **pull-based** — Klex Cloud reaches the agent's admin API through the tunnel. The callback endpoint is unauthenticated by necessity; security rests on the OAuth `state` parameter (32 random bytes, timing-safe compared, single-use, expiring). PKCE verifiers, client secrets, and tokens never leave the agent.

Pending authorizations are in-memory: each is a live, blocked connection attempt. A restart drops them, and the cloud simply starts a new authorization.

## Interface to session

The MCP ingress extension installed in the default session subscribes through `mcp.onPushNotification(listener)` and receives `McpPushNotification` objects. It routes resource-linked notifications and converts events into session-inbox events. A session with MCP access does not subscribe automatically; its extension composition determines whether it handles ingress.

## Interface to main

`createMcp({ logging, config, realtimeMediaCapability })` composes the module. Main resolves `realtimeMediaCapability` from the realtime provider registry before MCP starts. No external inbox wiring is required.
