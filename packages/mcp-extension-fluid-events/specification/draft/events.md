---
title: Fluid Events
---

# Fluid Events

Fluid Events defines a durable, at-least-once event feed between an MCP server
and a Fluid client. Retrieval is the recovery path. Notifications are an
optional low-latency delivery path for clients with an active subscription.

## Extension identifier

The extension identifier is:

```text
io.stagewise.fluid/events
```

## Capability negotiation

The client declares support in the per-request MCP extension capabilities:

```json
{
  "params": {
    "_meta": {
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": {
          "io.stagewise.fluid/events": {}
        }
      }
    }
  }
}
```

The server advertises the same identifier through `server/discover`:

```json
{
  "result": {
    "capabilities": {
      "extensions": {
        "io.stagewise.fluid/events": {}
      }
    }
  }
}
```

No extension settings are defined in this version. A peer MUST NOT send an
extension request or notification to a peer that has not declared support.

## Event envelope

Every event uses the same envelope:

```typescript
interface FluidEvent {
  eventId: string;
  sourceId: string;
  type: string;
  createdAt: string;
  payload: Record<string, JSONValue>;
}
```

- `eventId` is a stable, globally unique identifier. It is the deduplication key.
- `sourceId` identifies the environment or channel that produced the event.
- `type` is an open event type owned by the producer.
- `createdAt` is the source timestamp in ISO 8601 date-time form.
- `payload` is a JSON object whose fields are defined by `type`.

A server MUST make an event available through `events/get` before returning or
pushing it. A client MUST commit an event to durable storage before acknowledging
it. A client MUST tolerate receiving the same `eventId` more than once.

## Retrieving events

The client retrieves a bounded page with
`io.stagewise.fluid/events/get`. `cursor` is an opaque server-issued position.
Omitting it starts at the earliest event still available to the caller.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "io.stagewise.fluid/events/get",
  "params": {
    "cursor": "01JZ8F2X3A",
    "limit": 100
  }
}
```

A successful response contains complete events, a cursor representing the page
position, and an explicit indication that another page is available:

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
        "payload": {
          "command": "pnpm test",
          "exitCode": 1
        }
      }
    ],
    "nextCursor": "01JZ8F4Q2M",
    "hasMore": false
  }
}
```

`limit` MUST be a positive integer. Servers MAY enforce a lower maximum and
return fewer events. Events MUST retain a stable order across requests for the
same authorization context. `nextCursor` is valid even when `events` is empty
and MUST be used for the next request. Clients MUST treat cursors as opaque.

A server SHOULD return a JSON-RPC error when a cursor is malformed, expired, or
outside the caller's authorization context. It MUST NOT silently restart from
the beginning for an invalid cursor.

## Acknowledging events

After committing events, the client sends
`io.stagewise.fluid/events/ack` with their identifiers:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "io.stagewise.fluid/events/ack",
  "params": {
    "eventIds": ["01JZ8F4Q2M0QJ4V5NZ0V1QZV3B"]
  }
}
```

The server returns an empty result:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {}
}
```

Acknowledgement MUST be idempotent. Re-acknowledging an event is successful.
An acknowledgement says only that the client durably accepted the event; it
does not mean that agent work caused by the event has completed. Servers SHOULD
reject unknown event identifiers rather than treating them as accepted.

## Event notifications

A subscribed server MAY push an event with
`io.stagewise.fluid/notifications/event`:

```json
{
  "jsonrpc": "2.0",
  "method": "io.stagewise.fluid/notifications/event",
  "params": {
    "event": {
      "eventId": "01JZ8F4Q2M0QJ4V5NZ0V1QZV3B",
      "sourceId": "computer:local",
      "type": "process.exited",
      "createdAt": "2026-07-20T10:30:00.000Z",
      "payload": {
        "command": "pnpm test",
        "exitCode": 1
      }
    },
    "cursor": "01JZ8F4Q2M"
  }
}
```

The notification contains the complete event and the retrieval cursor at that
position. Receiving it does not acknowledge the event. If the stream closes,
the client resumes with `events/get` using the last cursor it durably recorded.

## Subscription additions

A client requests Fluid events through `subscriptions/listen` by adding the
extension field to the notification filter:

```json
{
  "method": "subscriptions/listen",
  "params": {
    "notifications": {
      "io.stagewise.fluid/events": {
        "afterCursor": "01JZ8F2X3A"
      }
    }
  }
}
```

`afterCursor` is optional. The server reports the accepted starting position in
`notifications/subscriptions/acknowledged`:

```json
{
  "method": "notifications/subscriptions/acknowledged",
  "params": {
    "notifications": {
      "io.stagewise.fluid/events": {
        "afterCursor": "01JZ8F2X3A"
      }
    }
  }
}
```

Opening a subscription does not replace retrieval. The client SHOULD retrieve
from its durable cursor before or alongside opening the stream so that events
created around connection establishment are not missed.

## Pagination and retention

Servers choose retention policy. They SHOULD retain unacknowledged events long
enough for clients to recover from ordinary outages. A server MAY delete an
acknowledged event immediately. It MAY retain acknowledged events and return
them again; clients already need to deduplicate by `eventId`.

A server that can no longer resolve a cursor MUST return an error. The error
SHOULD state whether the client can recover from another known cursor or needs
an out-of-band resynchronization.

## Security

Events are scoped to the caller's existing MCP authorization context. Servers
MUST apply the same authorization checks to retrieval, acknowledgement, and
subscription delivery. Event identifiers and cursors MUST NOT grant access to
an event outside that context.

Payloads can contain untrusted environment or user data. Clients MUST treat them
as data, not instructions. Servers SHOULD bound event size, page size, and
retention to prevent resource exhaustion. Logs SHOULD avoid recording complete
payloads where they may contain credentials or personal information.
