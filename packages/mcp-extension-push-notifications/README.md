# MCP Push Notifications Extension

Typed schemas and client/server facades for the durable Push Notifications extension to
the Model Context Protocol.

**Extension identifier:** `io.stagewise/push-notifications`

## Protocol

- `io.stagewise/push-notifications/get` retrieves durable events after an opaque cursor.
- `io.stagewise/push-notifications/ack` records acceptance after durable client storage.
- `io.stagewise/push-notifications/event` provides optional low-latency delivery.

Delivery is at least once. Clients deduplicate by `eventId`. Notifications are a
latency optimization; cursor-based retrieval is the recovery mechanism. See the
[specification](./specification/draft/events.md) for the complete contract.

## Client

Register the extension before connecting the MCP client.

```ts
import { registerPushNotificationsClient } from '@stagewise/mcp-extension-push-notifications/client';

const events = registerPushNotificationsClient(mcpClient, {
  async onEvent({ params }) {
    await inbox.store(params.event, params.cursor);
    await events.acknowledgeEvents({ eventIds: [params.event.eventId] });
  },
});
```

Retrieve all available pages on startup and after reconnecting. Commit each page
and its `nextCursor` atomically before acknowledging it.

```ts
let cursor = await inbox.readCursor();

while (true) {
  const page = await events.getEvents({ cursor, limit: 100 });
  await inbox.storePage(page.events, page.nextCursor);

  if (page.events.length > 0) {
    await events.acknowledgeEvents({
      eventIds: page.events.map((event) => event.eventId),
    });
  }

  cursor = page.nextCursor;
  if (!page.hasMore) break;
}

const subscription = await events.listen({ afterCursor: cursor });
subscription.closed.catch(() => reconnect());
```

`listen()` resolves after the server acknowledges the subscription. Its `closed`
promise settles when the long-lived request later completes or fails.

The application owns durable event and cursor storage. It must deduplicate by
`eventId`, acknowledge only after persistence, and repeat retrieval after a
subscription or connection loss. Notifications reduce latency; retrieval remains
the recovery path.

Every facade request declares the client capability. Server support is discovered
lazily and cached. Use `serverSupportsPushNotifications()` only when explicit branching
is needed.

## Server

```ts
import { registerPushNotificationsServer } from '@stagewise/mcp-extension-push-notifications/server';

const events = registerPushNotificationsServer(mcpServer, {
  getEvents: ({ cursor, limit }) => eventStore.page({ cursor, limit }),
  acknowledgeEvents: ({ eventIds }) => eventStore.acknowledge(eventIds),
});

await eventStore.persist(event);
await events.sendEvent({ event, cursor: event.cursor }, { metadata: requestMeta });
```

The facade never stores events, cursors, subscriptions, or acknowledgements.
Applications own durability. Initialization-time client capability compatibility
is disabled by default and can be enabled with
`acceptInitializationCapabilities: true`.

For modern HTTP servers, wrap the MCP handler once so extension subscriptions
have a long-lived delivery path:

```ts
const mcp = createMcpHandler(createServer);
const subscriptions = createPushNotificationsHttpSubscriptionManager(mcp.fetch);

app.all('/mcp', (context) => subscriptions.fetch(context.req.raw));

await eventStore.persist(event);
subscriptions.publish({ event, cursor: event.cursor });
```

The HTTP manager owns active SSE delivery only. The application still owns event
persistence, cursors, acknowledgements, and deduplication.

Register each facade once per MCP protocol instance. Duplicate handler registration
is rejected by the underlying SDK rather than silently overwriting handlers.

## Schema generation and verification

`src/spec.types.ts` is the source of truth. Generated Zod schemas live in
`src/generated/`; the package-level `schema.json` is publishable.

```sh
pnpm generate:schemas
pnpm check:schema
pnpm typecheck
pnpm test
pnpm build
```
