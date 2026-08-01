# MCP Module Architecture

## Role

The MCP module is the environment boundary between the agent core and external MCP servers. It owns:

- **Connection lifecycle** — connects, reconciles, retries, and disconnects configured MCP servers.
- **Tool registry** — builds and publishes a live tool registry from connected servers.
- **Push Notification worker** — subscribes, drains server-managed pending queues, deduplicates, and acknowledges.
- **Push Notification inbox** — process-local `eventId` deduplication scoped by MCP namespace.

The module exposes `onPushNotification()` to the router. External code does not create or wire the inbox.

## Realtime Media boundary

The MCP module also exposes the independent `io.stagewise/realtime-media`
control-plane facade. It owns capability negotiation, an ephemeral notification
stream, namespace-addressed accept/reject/end calls, and process-local
availability events for the current realtime worker. Realtime notifications and
availability changes never enter the durable Push Notification inbox. Media
transport, LiveKit connections, and realtime model sessions remain outside this
module. Realtime capability registration is startup-gated: disabled mode does
not advertise the extension, open its listener, or permit local lifecycle
operations. Changing the mode requires a process restart because MCP
capabilities are negotiated when connections are established.

## Submodules

```text
McpModule
  ├─ push-notification-inbox/   (eventId deduplication, in-memory)
  ├─ connection.ts              (stdio and HTTP transports)
  └─ registry.ts                (tool registry builder)
```

## Realtime Media flow

```text
current MCP connection
  -> start ephemeral subscriptions/listen worker
  -> publish namespace available
  -> publish lifecycle notifications to realtime listeners
  -> accept/reject/end by namespace
  -> worker or connection stops
  -> publish namespace unavailable
  -> realtime coordinator terminates matching sessions
```

Availability is process-local and transition-based. Only the current connection
can make a namespace available. Disconnect, configuration replacement,
subscription failure, and shutdown make it unavailable. Stale callbacks and
repeated invalidation do not republish a transition. The realtime coordinator
borrows this facade; it does not own or close MCP connections.

## Push Notification flow

```text
MCP server durable pending queue
  -> establish live subscription and await acknowledgement
  -> retrieve oldest pending notifications in bounded pages
  -> push-notification-inbox.commit() (deduplicate by namespace + eventId)
  -> publishPushNotification() -> listeners (router)
  -> acknowledge all accepted or duplicate event IDs
  -> continue live delivery
```

- **Live notifications** are the low-latency path.
- **Pending retrieval** is the startup and reconnection recovery path.
- **Subscribe before drain** closes the connection-boundary race. Events created during recovery can arrive by both paths.
- **At-least-once delivery** means duplicates are normal. The inbox suppresses duplicate publication by `eventId`.
- **Persist before acknowledgement** remains the safety boundary. The current inbox is in-memory, so it is suitable for development but not the final durable acceptance store.
- **Server-owned progress** means Klex stores no cursor. Acknowledged events disappear from the server's pending view.

If retrieval returns `hasMore: true` with an empty page, the worker fails the attempt instead of spinning. Acknowledgements retry with exponential backoff. A subscription failure restarts the complete subscribe-then-drain sequence.

## Connection lifecycle

```text
config update
  -> reconcile configured servers
  -> removed or changed: invalidate runtime and close connection
  -> added or changed: create runtime and activateRuntime()
  -> connectRuntime: connect via transport and register callbacks
  -> on connect: publish registry and start event worker when supported
  -> event worker: subscribe -> drain pending -> process live events
  -> on disconnect: stop worker and schedule reconnect with exponential backoff
```

Key invariants:

- Only one active connection exists per namespace.
- Only the current connection can own the namespace's event worker.
- Late connections from superseded attempts close immediately.
- A server configuration change does not reset a client cursor because no cursor exists.

## Interface to Router

The router subscribes through `mcp.onPushNotification(listener)` and receives `McpPushNotification` objects containing `{ namespace, event }`. It converts them into session-inbox events.

The router never accesses the Push Notification inbox directly.

## Interface to Main

`createMcp({ logging, config, realtimeMediaEnabled })` composes the module and
its inbox. Main resolves `realtimeMediaEnabled` from the persisted startup mode
before MCP starts. No external inbox wiring is required.