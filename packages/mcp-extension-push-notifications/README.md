# MCP Push Notifications Extension

Typed schemas and client/server facades for identity-scoped durable Push Notifications in the Model Context Protocol.

**Extension identifier:** `io.stagewise/push-notifications`

## Delivery model

- `io.stagewise/push-notifications/get` retrieves pending unacknowledged events for the authenticated consumer.
- `io.stagewise/push-notifications/ack` records durable client acceptance and removes events from the pending view.
- `io.stagewise/push-notifications/event` provides optional low-latency delivery.

Delivery is at least once. Servers persist before publishing. Clients accept and deduplicate by `eventId` before acknowledging. Live delivery is a latency optimization; pending retrieval is recovery. This extension is a durable queue, not a replayable historical event stream.

Every event carries ordered MCP `ContentBlock` values in `content` and may carry
producer-owned JSON in `data`. The runtime schema is the canonical
`ContentBlockSchema` from this package's pinned MCP SDK revision, so text, images,
audio, embedded resources, and resource links use standard MCP representations.
Transport support does not imply that every client or model can consume every
content type.

```ts
const event = {
  eventId: crypto.randomUUID(),
  sourceId: 'chat:local',
  type: 'chat.message.received',
  createdAt: new Date().toISOString(),
  content: [{ type: 'text', text: 'Hello' }],
  data: { messageId: '42' },
};
```

Small media may be carried inline as base64 MCP image/audio blocks. Larger or
long-lived media should use MCP resource links whose authorization and retention
match the event feed.

## Client

Register before connecting:

```ts
const events = registerPushNotificationsClient(mcpClient, {
  async onEvent({ params }) {
    const accepted = await inbox.commit([params.event]);
    if (accepted) await events.acknowledgeEvents({ eventIds: [params.event.eventId] });
  },
});
```

Subscribe first, then drain pending pages:

```ts
const subscription = await events.listen();

while (true) {
  const page = await events.getEvents({ limit: 100 });
  await inbox.commit(page.events);
  if (page.events.length > 0) {
    await events.acknowledgeEvents({
      eventIds: page.events.map((event) => event.eventId),
    });
  }
  if (!page.hasMore) break;
}

subscription.closed.catch(() => reconnect());
```

A lost acknowledgement can cause the same events to return again. `eventId` is the idempotency key. `listen()` resolves after subscription acknowledgement; `closed` settles when the long-lived request completes or fails.

Clients must treat content, MIME declarations, linked resources, and event data as untrusted input.

## Server facade

Storage and consumer resolution remain application concerns:

```ts
const events = registerPushNotificationsServer(mcpServer, {
  getEvents: ({ limit }, context) => store.pending(consumerFrom(context), limit),
  acknowledgeEvents: ({ eventIds }, context) =>
    store.acknowledge(consumerFrom(context), eventIds),
});

await store.append(consumerKey, event);
await events.sendEvent({ event }, { metadata: requestMeta });
```

Acknowledgement is idempotent. Acknowledged IDs disappear immediately from pending retrieval. Retention of payloads and acknowledgement tombstones is server policy.

## HTTP subscriptions

The HTTP manager requires a trusted consumer-key resolver and targeted publication:

```ts
const subscriptions = createPushNotificationsHttpSubscriptionManager(mcp.fetch, {
  resolveConsumerKey: (request) => authenticatedConsumerKey(request),
  onSubscriptionStateChanged: (consumerKey, active) => {
    updateConsumerActivity(consumerKey, active);
  },
});

app.all('/mcp', (context) => subscriptions.fetch(context.req.raw));

await store.append(consumerKey, event);
subscriptions.publish(consumerKey, { event });
```

Only one active live subscription is retained per consumer key; a new subscription replaces the previous stream. The key is derived from authentication context and never accepted from a Push Notifications payload. The optional lifecycle callback reports installation and removal of the active stream; observer failures are isolated from protocol handling.

## Capabilities and schemas

Every facade request declares the client capability. Server support is discovered lazily and cached. `src/spec.types.ts` is the source of truth; generated Zod schemas and `schema.json` must remain fresh.

```sh
pnpm generate:schemas
pnpm check:schema
pnpm typecheck
pnpm test
pnpm build
```

See `specification/draft/events.md` for the normative contract.