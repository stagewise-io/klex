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

## OAuth authorization channels

OAuth-protected HTTP MCP servers are authorized through one of two
`OAuthAuthorizationSession` implementations. `connection.ts` knows neither: it
calls `sessionFactory.start({ serverName, serverUrl })` once per connection
attempt, uses `session.redirectUrl` as the OAuth redirect URI, and awaits the
promise returned by `session.authorize()`.

```text
connect attempt -> 401 -> sessionFactory.start(context)
  local channel:  loopback receiver on 127.0.0.1 + browser on the agent host
  cloud channel:  public cloud redirect URI + pending-authorization registry
  -> callback params resolve the parked promise
  -> transport.finishAuth() -> reconnect
```

Selection happens per `start()` call, not once at construction: the cloud
channel is used when cloud connectivity is enabled, the agent is enrolled, and
the tunnel state is `connected`. A tunnel drop therefore falls back to the local
browser flow on the next attempt.

The cloud channel is **pull-based**. The agent exposes no new cloud-facing
surface; Klex Cloud reaches the agent's admin API through the tunnel and drives
the `mcp-servers` resource:

| Call | Purpose |
|---|---|
| `GET /v1/mcp-servers`, `GET /v1/mcp-servers/{name}` | read status *and* the live authorization in one round-trip |
| `PUT /v1/mcp-servers/{name}/authorization` | start one, or get the live one back — idempotent |
| `DELETE /v1/mcp-servers/{name}/authorization` | cancel the parked attempt |
| `POST /v1/mcp-oauth/callback` | deliver callback parameters, keyed by `state` |

This keeps the agent free of any agent-to-cloud protocol and avoids needing to
know its own `agentId`.

Authorization state is part of the server row: `authorization` is non-null while
a cloud authorization awaits consent, carrying only `id`, `createdAt` and
`expiresAt`. `status: 'authorizing'` with `authorization: null` means the local
loopback flow is driving the attempt, so there is nothing for the cloud to relay.
`usesInteractiveOAuth` says up front whether a server can be authorized this way
at all.

The callback sits outside the resource on purpose: it is keyed by `state`, not by
a server name, and must be servable by a redirect handler that knows neither.

Trust model of the callback sink: `POST /v1/mcp-oauth/callback` is
unauthenticated by necessity — the cloud proxy strips `authorization` and
`cookie`, and the admin API has no auth middleware. Security rests on the OAuth
`state` (32 random bytes from the SDK provider), compared timing-safely, usable
exactly once, and expiring with the entry. PKCE verifiers, client secrets, and
tokens never leave the agent. `state` and the authorization URL are returned
only by the idempotent `PUT`, to the caller that asked; they appear in no
pollable response and in no log line, because `state` is the capability that
authorizes a callback and the authorization URL embeds it.

`CLOUD_OAUTH_CALLBACK_PATH` (`/v1/mcp-oauth/callback`) is a compatibility
contract with the cloud: it is baked into dynamic client registrations, so
changing it forces re-registration with every authorization server. The cloud
TTL (15 minutes) is deliberately wider than the local one (5 minutes) because
cloud consent is user-driven and asynchronous.

Pending authorizations are in-memory: each one is a live, blocked connection
attempt. A restart drops them, and the cloud simply starts a new authorization.

## Interface to Router

The router subscribes through `mcp.onPushNotification(listener)` and receives `McpPushNotification` objects containing `{ namespace, event }`. It converts them into session-inbox events.

The router never accesses the Push Notification inbox directly.

## Interface to Main

`createMcp({ logging, config, realtimeMediaEnabled })` composes the module and
its inbox. Main resolves `realtimeMediaEnabled` from the persisted startup mode
before MCP starts. No external inbox wiring is required.