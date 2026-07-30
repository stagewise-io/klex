# MCP Module Architecture

## Role

The MCP module is the environment boundary between the agent core and all external MCP servers. It owns:

- **Connection lifecycle** — connects, reconciles, retries, and disconnects MCP servers based on config.
- **Tool registry** — builds and publishes a live tool registry from connected servers.
- **Push-notification inbox** — cursor tracking and dedup for push notifications, as an internal submodule.

The module exposes `onPushNotification()` to the router. No external code creates or wires the inbox.

## Submodules

```
McpModule
  ├─ push-notification-inbox/   (cursor + dedup, in-memory)
  ├─ connection.ts              (transport: stdio + http)
  └─ registry.ts                (tool registry builder)
```

## Push Notification Flow

```
MCP server
  -> notification arrives (fast path) or cursor retrieval (recovery path)
  -> push-notification-inbox.commit() (dedup by eventId, advance cursor)
  -> publishPushNotification() -> listeners (router)
  -> ack events back to server
```

- **Notifications** — real-time push from the server via the push-notifications MCP extension. Fast path.
- **Cursor retrieval** — on (re)connect, the event worker replays missed events from the last cursor. Recovery path.
- **At-least-once delivery** — the inbox deduplicates by `eventId`. Ack happens after commit.
- **Per-namespace cursors** — each MCP server namespace has its own cursor and seen-eventId set.

## Connection Lifecycle

```
config update
  -> reconcile (diff old vs new server configs)
  -> for removed/changed: invalidate runtime, close connection, reset inbox
  -> for added/changed: create runtime, activateRuntime()
  -> activateRuntime: reset inbox (if pending) -> connectRuntime()
  -> connectRuntime: connect via transport, register callbacks
  -> on connect: publish registry, start event worker (if supported)
  -> on disconnect: stop worker, schedule reconnect with exponential backoff
```

Key invariants:
- Only one active connection per namespace at a time.
- Config changes reset the inbox for the affected namespace before reconnecting.
- Late connections (from a superseded attempt) are closed immediately.

## Interface to Router

The router subscribes via `mcp.onPushNotification(listener)` and receives `McpPushNotification` objects (`{ namespace, event }`). The router converts these into `SessionInboxEvent`s and feeds them to the session inbox.

The router never touches the push-notification inbox directly.

## Interface to Main

`createMcp({ logging, config })` — that's it. The module spawns its own inbox internally. No inbox parameter, no external wiring.
