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
  -> record as delivered but unacknowledged
  -> continue live delivery

session host, once the agent is quiescent
  -> acknowledgeDeliveredEvents()
```

- **Live notifications** are the low-latency path.
- **Pending retrieval** is the startup and reconnection recovery path.
- **Subscribe before drain** closes the connection-boundary race.
- **At-least-once delivery** — duplicates are normal; the inbox suppresses by `eventId`.
- **Handle before acknowledgement** — accepted events are not ACKed on receipt. MCP records them per namespace, and the session host calls `acknowledgeDeliveredEvents()` once the agent is quiescent (no running turn, child session, or held event). Delivering an event synchronously makes the default session non-idle, so a quiescent agent has finished every turn caused by the snapshotted events. A crash before that point leaves the events on the server, which redelivers them after restart.
- **Server-owned progress** — Klex stores no cursor. Acknowledged events disappear from the server's pending view.

Duplicates:

- An event still in flight (delivered, not ACKed) is skipped: not republished, not ACKed. The next flush ACKs it. In-flight IDs survive reconnects of the same namespace.
- An event the inbox already accepted and that is not in flight was ACKed before, and the ACK was lost. It is ACKed again immediately.

Paging: pages return the oldest unacknowledged events, so with deferred ACKs a page can contain only in-flight events. Recovery then stops (`recoveryBlocked`) instead of fetching the same page forever, and resumes after the next flush ACKs that namespace. Live notifications keep flowing meanwhile.

If retrieval returns `hasMore: true` with an empty page, the worker fails the attempt instead of spinning. Acknowledgements retry with exponential backoff. A subscription failure restarts the complete subscribe-then-drain sequence. A flush for a namespace without a live worker keeps its IDs for a later flush; IDs of a namespace removed from config no longer count as unacknowledged.

**Drain pause** — before an update restart, `pausePushDelivery()` stops accepting new events for the rest of the process. Recovery and live delivery become no-ops, and events whose inbox commit was still in flight are released instead of published, so the server keeps them for the next process and a steady message stream cannot keep the agent busy. Events delivered before the pause are still ACKed once the agent is quiescent.

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

## On-demand servers

A server configured with `lifecycle: { mode: 'on-demand', catalogUrl }` can be in standby. `catalogUrl` must be HTTP(S) and share the server URL's origin. The OAuth provider sends the server's token only to that origin. Klex lists the server's tools without holding a connection and connects only when they are used.

```
config -> read no-wake catalog (on-demand.ts, 15 s)
  ready   -> standby: register descriptors without a connection
  missing -> passive connection (no demand header) for discovery
tool call / resource read on a standby server
  -> one shared activation (concurrent callers join it)
  -> connect with x-klex-machine-demand: invocation on initialize only
  -> run the operation once on the live connection
quiet 5 min -> close the connection -> standby
```

- `registry.ts` keeps tool descriptors separate from live connections. A standby server keeps its descriptors in the registry and in `toolCount`.
- Standby re-reads the catalog every 5 minutes to detect replacement or unassignment. `unauthorized`, `forbidden`, `not_found` and `malformed` catalog results discard retained descriptors. `unavailable` keeps them and retries later.
- A changed generation or a changed tool schema invalidates the descriptors. The call fails instead of running against a different schema.
- The demand header is set only on the MCP `initialize` POST, so discovery and later traffic never count as activity.
- The demand connect timeout is 90 seconds, above the proxy's 65 second wake bound. The idle close is 5 minutes, below the 15 minute idle window of the server, so a session never outlives a pause.
- The end of a demand connection caused by the machine's standby is expected. It does not schedule a reconnect.
- Wake, capacity and authorization failures become tool errors with their upstream code. They never instruct the model to manage the machine.

`McpConnectionStatus` includes `standby`. The admin API reports it, and Cloud shows it as a functional state, not as an error.

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
