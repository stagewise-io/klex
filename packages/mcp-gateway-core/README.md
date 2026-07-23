# MCP Gateway Core

Reusable gateway logic for connecting Fluid Agents to MCP environments that are
not directly reachable over the network.

## Problem

Agents and environments may run behind NAT, firewalls, or changing IP addresses.
Neither side can reliably expose a public endpoint. Both therefore connect
outbound to a durable, publicly reachable gateway.

```text
Fluid Agent MCP client
  <-> Streamable HTTP
MCP Gateway
  <-> WebSocket
Environment MCP server
```

The gateway relays MCP traffic. It maps sessions between the two transports but
does not change MCP JSON-RPC messages or implement environment tools itself.
Direct peer-to-peer connections may be added later as an optimization; relaying
through the gateway remains the reliable default.

## Identity and access

The normalized identity consists of:

- `tenantId`: deployment or customer boundary. Self-hosted setups use one
  implicit tenant.
- `agentId`: one Fluid Agent instance.
- `environmentId`: one logical MCP server.

A physical machine may register several environment IDs when it runs independent
MCP servers. Several agents may use the same environment at the same time.

Authentication happens outside the core. The core receives authenticated
principals and uses an injected `authorize(agent, environment)` function. A
credential must be bound to its claimed identity; IDs supplied by a client are
not trusted on their own.

The self-hosted gateway can use shared secrets and config-based authorization.
Hosted deployments can provide database-backed authentication and authorization
without changing the gateway core.

## Connections and sessions

An environment keeps one outbound WebSocket connection to the gateway. One
connection can carry multiple isolated MCP sessions, with each session belonging
to one agent connection.

Only one connection may be active for a `(tenantId, environmentId)` pair. A new
authenticated connection replaces and closes the old one.

The core owns environment registration, authorization at session opening,
session mapping, isolated routing, opening timeouts, cancellation, connection
replacement, and lifecycle cleanup.

Environment daemons and transport adapters own authentication, heartbeats,
reconnects, ordered frame delivery, and transport backpressure. Embedding
applications own configuration, deployment limits, operational policy, and any
dynamic authorization revocation.

Live MCP sessions are not durable. If an environment disconnects, its active
sessions fail and clients establish new sessions after it reconnects.

Fluid Events remain durable at the application layer. Cursor retrieval is the
recovery path; notifications only provide low-latency delivery.

## Package boundary

This package contains reusable gateway behavior and transport-agnostic
contracts. It does not own a particular authentication system, database,
configuration format, WebSocket implementation, HTTP server, or other server
runtime.

The self-hosted executable belongs in `apps/mcp-gateway`. A hosted service can
build a separate application around this package with its own trusted adapters.
Concrete agent-facing HTTP and environment-facing WebSocket adapters belong in
those embedding applications, not in this package.
