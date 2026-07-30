# Klex Agent

One durable agent. Many channels, model runs, subagents, and machines. User sees one coherent actor, not the machinery.

## Brain-only VM

Klex Agent VM holds brain, memory, config, and orchestration state. It is not the work machine.

Core must not use its host as a coding box, browser box, or general shell. Give it external environments through MCP. Need to write code? Attach a disposable Linux VM. Need to send a message? Attach a channel server.

This boundary keeps agent state durable and work environments replaceable.

## MCP is the environment boundary

MCP servers expose all outside capabilities:

- Tools: agent acts on an environment.
- Push Notifications: environment wakes or informs agent.
- Resources and other MCP primitives: environment gives context where useful.

Normal flow:

```text
channel or environment
  -> Push Notification
  -> router and durable memory
  -> model run or subagent
  -> MCP tool call
  -> channel or environment
```

Push Notifications use at-least-once delivery. Persist before ack. Deduplicate by `eventId`. Notifications are fast path; cursor retrieval is recovery path. The application owns durable event and cursor storage.

## No user-facing sessions

Model chats are private execution units. They may start, stop, fork, compress, or run in parallel.

User must not manage chats, context windows, subagents, tool calls, or transcripts. User talks to one agent through any connected channel. Raw model output is internal unless exposed for debugging.

## Memory

Memory lives above model chats. It preserves identity, user context, decisions, tasks, and useful history across runs and channels.

A transcript is input to memory, not memory itself. No single model session owns the agent's identity or full state. Concurrent runs share durable state and must tolerate races, retries, and duplicate events.

## Channels

WhatsApp, Slack, Telegram, local chat, and similar systems are MCP servers.

Incoming messages become Push Notifications. Agent replies by calling channel tools. Text emitted directly by a model is not automatically a user message.

## Code boundaries

- `apps/klex/`: brain, memory, routing, MCP clients, config, admin plane.
- `apps/klex/src/mcp/`: MCP client layer. Owns connection lifecycle, tool registry, and the push-notification inbox (cursor tracking + dedup) as an internal submodule. Exposes `onPushNotification()` to the router — no external inbox wiring.
- `mcp-servers/`: external channels and work environments.
- `packages/mcp-extension-push-notifications/`: durable event protocol and SDK helpers.
- `packages/`: shared protocol and runtime libraries.

Keep protocol packages free of application storage policy. Keep environment-specific actions out of agent core.

## Technical docs

- `apps/klex/src/mcp/architecture.md`
- `apps/klex/src/session/chat/architecture.md`
- `packages/mcp-extension-push-notifications/README.md`
- `packages/mcp-extension-push-notifications/specification/draft/events.md`
- `mcp-servers/chat-simulator/README.md`
- Package-level README files for local build and API details.
