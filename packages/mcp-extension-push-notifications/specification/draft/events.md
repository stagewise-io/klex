---
title: Push Notifications
---

# Push Notifications

Push Notifications defines an authenticated, identity-scoped durable notification queue between an MCP server and an MCP client. Pending retrieval is the recovery path. Live notifications are an optional low-latency delivery path.

The extension is not a replayable event log. Environments that require independent historical replay or multiple positions over one stream should use a separate extension.

## Extension identifier

```text
io.stagewise/push-notifications
```

Both peers advertise an empty capability object under this identifier. Every extension request includes the client capability in `io.modelcontextprotocol/clientCapabilities`. Servers reject extension requests from clients that did not declare support.

## Event envelope

```typescript
interface PushNotification {
  eventId: string;
  sourceId: string;
  type: string;
  createdAt: string;
  content: ContentBlock[];
  data?: Record<string, JSONValue>;
}
```

- `eventId` is stable and globally unique. It is the deduplication and acknowledgement key.
- `sourceId` identifies the environment or channel that produced the event.
- `type` is an open event type owned by the producer.
- `createdAt` is the source timestamp in ISO 8601 date-time form.
- `content` is an ordered array using the canonical MCP `ContentBlock` definition
  from the extension package's pinned MCP SDK revision. It MAY be empty.
- `data` is optional JSON whose fields and semantics are defined by `type`.

`content` supports the MCP text, image, audio, embedded-resource, and resource-link
representations. A producer SHOULD inline only bounded media; base64 increases
wire and storage size. Larger media SHOULD use a resource link. A linked resource
MUST use the same authorization boundary as its event and SHOULD remain available
for as long as the event can be recovered. Schema support for a content block does
not imply that every client or downstream model can consume it.

A server MUST durably add an event to the authenticated consumer's pending queue before pushing it. A client MUST durably accept and deduplicate an event before acknowledging it. Clients MUST tolerate receiving the same `eventId` more than once.

## Consumer identity and isolation

Retrieval, acknowledgement, and live delivery are scoped to the caller's authenticated logical consumer and integration binding. The extension does not carry a caller-selected consumer identifier. Servers derive the consumer from trusted transport or authentication context and MUST apply the same scope to all three operations.

A server MUST NOT reveal whether an event identifier belongs to another consumer. Credentials, bot tokens, and authorization policy MUST NOT be used as ordinary event payload fields.

## Retrieving pending events

The client retrieves a bounded page of currently unacknowledged events with `io.stagewise/push-notifications/get`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "io.stagewise/push-notifications/get",
  "params": { "limit": 100 }
}
```

A successful response contains complete pending events and a snapshot indication that additional pending events existed:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "events": [
      {
        "eventId": "01JZ8F4Q2M0QJ4V5NZ0V1QZV3B",
        "sourceId": "computer:local",
        "type": "process.exited",
        "createdAt": "2026-07-20T10:30:00.000Z",
        "content": [
          {
            "type": "text",
            "text": "pnpm test exited with code 1"
          }
        ],
        "data": {
          "command": "pnpm test",
          "exitCode": 1
        }
      }
    ],
    "hasMore": false
  }
}
```

`limit` MUST be a positive integer. Servers MAY enforce a lower maximum. A server SHOULD return pending events in deterministic oldest-first order, but strict processing order is not required and one unacknowledged event need not block all later events. `hasMore` describes the page snapshot; concurrent arrivals may make it stale immediately.

There is no cursor or page token. A client advances by accepting and acknowledging a returned page before retrieving again. If an acknowledgement response is lost, retrieval can return the same page again.

## Acknowledging events

After durable acceptance, the client sends `io.stagewise/push-notifications/ack`:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "io.stagewise/push-notifications/ack",
  "params": { "eventIds": ["01JZ8F4Q2M0QJ4V5NZ0V1QZV3B"] }
}
```

The server returns an empty result. Acknowledgement:

- MUST be idempotent;
- MUST immediately exclude the IDs from subsequent retrieval and live delivery for that consumer;
- means durable client acceptance, not completion of agent work;
- MUST succeed for an already acknowledged, compacted, or unknown identifier without disclosing whether it existed.

Servers MAY retain payloads and acknowledgement tombstones according to implementation-defined retention policies.

## Live event notifications

A subscribed server MAY push a pending event with `io.stagewise/push-notifications/event`:

```json
{
  "jsonrpc": "2.0",
  "method": "io.stagewise/push-notifications/event",
  "params": {
    "event": {
      "eventId": "01JZ8F4Q2M0QJ4V5NZ0V1QZV3B",
      "sourceId": "computer:local",
      "type": "process.exited",
      "createdAt": "2026-07-20T10:30:00.000Z",
      "content": [
        {
          "type": "text",
          "text": "pnpm test exited with code 1"
        }
      ],
      "data": {
        "command": "pnpm test",
        "exitCode": 1
      }
    }
  }
}
```

Receiving a live notification does not acknowledge it. The event remains pending until acknowledgement and can also appear in retrieval.

## Subscriptions and recovery

A client requests delivery through `subscriptions/listen` with an empty extension filter:

```json
{
  "method": "subscriptions/listen",
  "params": {
    "notifications": { "io.stagewise/push-notifications": {} }
  }
}
```

The server confirms the same empty filter through `notifications/subscriptions/acknowledged`. For each logical consumer binding, a server SHOULD keep one active live subscription. A new authenticated subscription SHOULD replace and close the previous one.

Clients recover in this order:

1. Establish the live subscription and await acknowledgement.
2. Retrieve pending events.
3. Durably accept and deduplicate each page.
4. Acknowledge every returned event ID.
5. Continue while `hasMore` is true.
6. Process live events buffered during recovery.

On subscription or connection failure, repeat the sequence. Events created around startup may arrive both live and through retrieval. Duplicate delivery is expected; silent loss is not.

## Retention and resource limits

Servers choose retention and compaction policy. They SHOULD retain unacknowledged events long enough for ordinary outages and MAY delete acknowledged payloads immediately. Event-ID tombstones may be retained longer for auditing and idempotency.

Servers SHOULD bound event size, pending queue size, retrieval page size, subscription count, and retention. Any overflow policy that can discard an unacknowledged event MUST be explicit and observable.

## Security

Events are scoped to the caller's existing MCP authorization context. Servers
MUST apply the same authorization checks to retrieval, acknowledgement, and
subscription delivery. Event identifiers MUST NOT grant access to an event outside
that context. Consumer resolution MUST rely on trusted authentication context,
never a caller-provided queue key.

Content and event data can contain untrusted environment or user input. Clients
MUST treat them as data, not instructions. MIME types, filenames, resource names,
and resource metadata are untrusted declarations and MUST NOT bypass content
inspection or authorization.

Servers SHOULD bound decoded media size, encoded event size, page size, and
retention to prevent resource exhaustion. They SHOULD account for base64
amplification before accepting inline media. Resource links MUST NOT grant broader
access than the containing event, and linked resources SHOULD remain resolvable
for as long as retained events may be recovered. Logs SHOULD avoid recording
complete content, data, or resource URIs where they may expose credentials,
personal information, or sensitive media.
