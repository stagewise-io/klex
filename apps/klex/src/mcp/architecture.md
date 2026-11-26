# MCP Module Architecture

## Role

The MCP module is the environment boundary between the agent core and external MCP servers. It owns:

- **Connection lifecycle** — connects, reconciles, retries, and disconnects configured MCP servers.
- **Tool registry** — builds and publishes a live tool registry from connected servers.
- **Push Notification worker** — subscribes, drains server-managed pending queues, deduplicates, and acknowledges.
- **Push Notification inbox** — process-local `eventId` deduplication scoped by MCP namespace.

The module exposes `onPushNotification()` to the MCP ingress extension installed in the default session. MCP access and MCP ingress are separate capabilities: providing an `Mcp` instance does not implicitly subscribe a session to push notifications.

## Events extension (SEP-3415)

Klex can also consume `io.modelcontextprotocol/events`, pinned to draft SEP commit
`f77a5fe31b91c052dbfc2a37add98b9e84662b34`. Configure each server with optional
`events: [{ name, arguments, delivery }]`; delivery defaults to push then poll.
Webhook delivery and a server-side facade are not included.

The main-session ingress tools expose progressive discovery and durable watch intent:
`listMcpEvents({server, cursor?})` returns catalogue summaries; `{server, name}`
returns the complete descriptor. `watchMcpEvents({server, name, arguments?})`
validates the current descriptor and atomically creates or reuses an intent in the
server's existing `events` list. `unwatchMcpEvents({watchId})` removes that intent
idempotently, without calling any server-specific setup/cleanup tool. Watch IDs
are stable opaque hashes of server and canonical raw configuration, not wire
subscription IDs. Raw arguments and resolved environment values are excluded from
automatic watch summaries. Different argument scopes have different IDs.

Watches belong to the agent, not a chat. Watch-only config updates reconcile loops
in place and preserve unaffected cursors, receipts, resources and realtime
sessions. Removing a watch aborts its loop; queued inbox events are not retracted.
Rewatch starts a new run from now. Transport/credential changes still reconnect.
Model context receives an initial watched-state baseline and only changed rows
thereafter; checkpoints carry the cutoff baseline. Reading watch state does not
wake the model. No descriptor cache is used for model discovery or validation.

Admin API server create/update accepts optional `events` (maximum 32); update
replaces the list and `[]` clears it. HTTP updates merge atomically with current
config so unrelated concurrent watch/header changes survive. Invalid configured
watches remain visible with sanitized lifecycle reasons; model-created watches
are validated before persistence. Status `starting` means saved intent, not an
activated stream. Discovery and publication errors are not echoed from servers.

`connection.ts` registers the facade and captures stream JSON-RPC ids on the
transport. `events-source` runs one loop per canonical `(name, arguments)` and
registers with the same source registry as Push Notifications. Its event IDs
include namespace, origin, subscription hash and upstream ID. Push retains its
existing namespace-scoped inbox and ACK behavior. Both use the existing
`onPushNotification()` compatibility envelope and session ingress.

Events delivery registers a settleable receipt only after successful publication. The driver
waits for `acknowledgeDeliveredEvents()` before advancing its in-memory cursor.
Pause aborts the source and releases waiters. **Cursors are not persisted and a
new connection starts with null. Events during disconnection or process downtime
may be lost.** This does not weaken the durable Push Notification queue.

Configured arguments and payloads are validated against descriptor JSON Schemas
using Zod conversion; unsupported schema features fail closed. Limits are 32
subscriptions per connection (excess is rejected), 100 events per poll batch,
64 KiB per complete occurrence, depth 32, 8192 visited values,
4096 dedup entries and 128 queued stream messages. Slow consumers apply
quiescence backpressure. JSON content is explicitly untrusted; arguments and
upstream error details are excluded from source logs.

Server status exposes `supportsEvents` and subscription mode/lifecycle/gap state.
For servers also supporting Push Notifications, the shared listen request adds
`eventsListChanged`; a change re-lists, refreshes active payload validators,
and retries terminated subscriptions. Failed initial discovery retries with bounded
backoff. Streams require activation within 30 seconds; polling rate-limits
non-advancing cursors and yields after bounded backlog drains.
All Events sources also reconcile the catalogue every 60 seconds, including
Events-only servers without a shared listen subscription. Config
schema 10→11 adds the optional subscriptions without transforming existing data;
released schemas and fixtures remain frozen.

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

## Transient server failures

A managed Klex Cloud computer can refuse `initialize` or `tools/call` while it wakes or waits for host capacity. The proxy answers HTTP 503 with a JSON-RPC `-32000` error whose `data` carries `retryAfterSeconds` and a code such as `machine_starting` or `capacity_wait`. `transient-errors.ts` treats any 503, and any error whose data carries `retryAfterSeconds` or one of those codes, as transient. 401 and 403 are never transient, and other 4xx responses stay final.

- **Tool calls** retry a transient failure up to 4 attempts within 20 seconds. Each wait honors `retryAfterSeconds`, clamped to 1–10 seconds. Without a hint the wait backs off exponentially. When retries run out, the model gets `McpServerStartingError`: the computer is starting, the condition is temporary, and the call should be repeated. Upstream billing or authorization wording is not shown to the model.
- **Unexpected disconnects** keep the closed connection's tools published, so a reconnect does not make them disappear. A tool call during that gap waits for the new connection under the same retry budget and never calls the closed connection. Retained tools are dropped when a reconnect succeeds, fails for a non-transient reason, needs authorization, or keeps failing transiently for more than 5 minutes. A post-connect 401 never retains tools.
- **Transient connect failures** reconnect after the hinted delay, at most every 10 seconds, rather than the regular 1–30 second backoff. They report a neutral `lastError`.

## Server metadata

Each connection snapshots the SDK's server identity, capabilities, instructions,
selected protocol revision and era, and discovery-supported versions when present.
`McpServerMetadata` uses the public SDK `Implementation`, `ServerCapabilities`, and
`ProtocolEra` types. Metadata reads return detached copies, so admin consumers
cannot mutate connection state. `getServerStatuses()` includes only the active
connection's metadata; disconnects and configuration replacement discard it.
Reconnection captures fresh values. Metadata is process-local, not persisted.

The existing admin list and single-server routes forward these fields. They do
not perform additional discovery or external enrichment. Configured namespace
and URL stay separate from server-advertised name and website. Advertised
capabilities are not operational support guarantees. Text, instructions, links,
and icons remain untrusted server content for consumers to handle safely.

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

Removing a server through the admin API calls `mcp.removeServer()`. It removes the configuration, cancels pending authorization, closes the connection, and deletes that namespace's OAuth state, including credentials for previous URLs and legacy entries. Closed providers cannot write late token responses back into the store. A replacement with the same namespace waits for cleanup to finish. Normal reconnects and shutdown preserve credentials.

After local deletion, Klex discovers each saved token issuer's revocation endpoint and attempts RFC 7009 revocation of refresh and access tokens. Discovery and revocation share a five-second timeout. Missing endpoints, unsupported client authentication, and provider failures do not block local removal. Remote revocation is best effort; provider grants may still need to be removed in the provider's settings. Local storage errors fail the request and allow cleanup to be retried by namespace. The credential file's schema and compatibility versions are unchanged.

## Interface to session

The MCP ingress extension installed in the default session subscribes through `mcp.onPushNotification(listener)` and receives `McpPushNotification` objects. It routes resource-linked notifications and converts events into session-inbox events. A session with MCP access does not subscribe automatically; its extension composition determines whether it handles ingress.

## Interface to main

`createMcp({ logging, config, realtimeMediaCapability })` composes the module. Main resolves `realtimeMediaCapability` from the realtime provider registry before MCP starts. No external inbox wiring is required.
