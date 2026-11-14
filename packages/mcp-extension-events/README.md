# @stagewise/mcp-extension-events

Client-side support for the MCP Events extension (`io.modelcontextprotocol/events`, SEP-3415).

**Status: draft, private.** The SEP is unmerged and its wire format may change. See `specification/draft/events-compat.md` for the pinned source (PR #3415 head `f77a5fe31b91c052dbfc2a37add98b9e84662b34`, checked 2026-11-12). Error codes `-32023..-32027` are provisional.

## Scope

- Types, generated Zod schemas, `schema.json`.
- `@stagewise/mcp-extension-events/client`:
  - `registerEventsClient`: capability, discovery, `events/list`, `events/poll`.
  - `runPollLoop`: poll delivery.
  - `runStreamLoop` with `createSdkStreamPort` and `createRequestIdTap`: push delivery over `events/stream`.
  - `selectDeliveryMode`: push, then poll.
- Not included: webhook delivery, server facade.

## Delivery semantics

The client owns progress. A batch is handed to `onBatch`; only after it resolves does the driver advance its cursor. A throwing `onBatch` makes the driver retry from the last handled cursor, so delivery is at-least-once. Callers must persist the cursor themselves and deduplicate by `(subscription, eventId)`, because `eventId` is scoped per subscription.

Push streams are demultiplexed by `_meta["io.modelcontextprotocol/subscriptionId"]`, which equals the JSON-RPC id of the `events/stream` request. The SDK does not expose that id, so create the tap from the transport before `client.connect(transport)`:

```ts
const tap = createRequestIdTap(transport);
await client.connect(transport);
const port = createSdkStreamPort(client, tap);
```

A stream with no message for three times the granted `heartbeatMs` is treated as dead and reopened from the last handled cursor.

This package does no storage. It is independent of `@stagewise/mcp-extension-push-notifications`.
