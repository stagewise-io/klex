# MCP Fluid Events Extension

Typed schemas and client/server facades for the durable Fluid Events extension to
the Model Context Protocol.

**Extension identifier:** `io.stagewise.fluid/events`

## Protocol

- `io.stagewise.fluid/events/get` retrieves durable events after an opaque cursor.
- `io.stagewise.fluid/events/ack` records acceptance after durable client storage.
- `io.stagewise.fluid/notifications/event` provides optional low-latency delivery.

Delivery is at least once. Clients deduplicate by `eventId`. Notifications are a
latency optimization; cursor-based retrieval is the recovery mechanism. See the
[specification](./specification/draft/events.md) for the complete contract.

## Client

```ts
import { registerFluidEventsClient } from '@stagewise/mcp-extension-fluid-events/client';

async function persistEvent(_event: unknown) {
  // Application-owned durable storage implementation.
}

const events = registerFluidEventsClient(mcpClient, {
  async onEvent({ params }) {
    await persistEvent(params.event);
    await events.acknowledgeEvents({ eventIds: [params.event.eventId] });
  },
});

if (!(await events.serverSupportsFluidEvents())) return;

const cursor = await readEventCursor(); // From application-owned storage.
await events.listen({ afterCursor: cursor });
const page = await events.getEvents({ cursor }); // Recovery after missed pushes.
```

The SDK does not provide an inbox: applications persist events, cursors, and
acknowledgements. Every facade request declares the client capability in request
metadata. Server support is discovered lazily, cached, and checked by facade
operations; call `serverSupportsFluidEvents()` directly only to branch explicitly.

## Server

```ts
import { registerFluidEventsServer } from '@stagewise/mcp-extension-fluid-events/server';

const events = registerFluidEventsServer(mcpServer, {
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
