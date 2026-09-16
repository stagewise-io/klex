# Klex Bot

One durable agent. Many channels, model runs, subagents, and machines. User sees one coherent actor, not the machinery.

## Brain-only VM

Klex Bot VM holds brain, memory, config, and orchestration state. It is not the work machine.

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
  -> default session and durable memory
  -> model run or subagent
  -> MCP tool call
  -> channel or environment
```

Push Notifications use at-least-once delivery. The server owns an identity-scoped pending queue. Clients subscribe before draining pending notifications, persist before ack, and deduplicate by `eventId`. Live notifications are the fast path; pending retrieval is the recovery path.

## No user-facing sessions

Model chats are private execution units. They may start, stop, fork, compress, or run in parallel.

User must not manage chats, context windows, subagents, tool calls, or transcripts. User talks to one agent through any connected channel. Raw model output is internal unless exposed for debugging.

## Memory

Memory lives above model chats. It preserves identity, user context, decisions, tasks, and useful history across runs and channels.

A transcript is input to memory, not memory itself. No single model session owns the agent's identity or full state. Concurrent runs share durable state and must tolerate races, retries, and duplicate events.

## Channels

WhatsApp, Slack, Telegram, local chat, and similar systems are MCP servers.

Incoming messages become Push Notifications. Agent replies by calling channel tools. Text emitted directly by a model is not automatically a user message.

## Formatting

Use the repository formatter instead of formatting files by hand. After editing any
formatter-supported file, run `pnpm format` from the repository root. Before
finishing, run `pnpm format:check` to verify that the tree is clean.

Instructions to use file-editing tools apply to authored content changes. They do
not prohibit running the repository's formatting, linting, code-generation, test,
or other validation commands.

## Code boundaries

- `apps/klex/`: brain, memory, session host, MCP clients, config, admin plane.
- `apps/klex/src/mcp/`: MCP client layer. Owns connection lifecycle, tool registry, subscribe-before-drain recovery, and process-local `eventId` deduplication as an internal submodule. Exposes `onPushNotification()` to the default session — no external inbox wiring.
- `mcp-servers/`: external channels and work environments.
- `packages/mcp-extension-push-notifications/`: identity-scoped pending-queue protocol and SDK helpers.
- `packages/`: shared protocol and runtime libraries.

Keep protocol packages free of application storage policy. Keep environment-specific actions out of agent core.

## npm package ownership

Every publishable npm package must use either the `@klex/*` or `@stagewise/*`
scope. Unscoped publishable packages are forbidden because npm organizations only
own names within their scopes.

Use `@klex/*` for packages specific to the Klex product, control plane, runtime,
deployment, or branded CLI. Use `@stagewise/*` only for product-neutral libraries
intentionally shared across Stagewise products. Repository location alone does not
decide ownership; use the product boundary and intended reuse.

Packages that expose command-line binaries remain organization-scoped. Their `bin`
keys may expose unscoped commands such as `klex-machine`.

Before enabling automated releases for a new public package, create it under the
correct npm organization and configure trusted publishing from this repository.

## Native dependencies

`apps/klex` ships as a Node SEA executable, which cannot bundle native modules. Any
dependency with a `.node` addon or a prebuilt binary must be virtualized at build time,
copied at packaging time, and proven loadable by `klex --verify-native`. Existence checks
are not verification, and lazy loaders can hide a broken addon until a user hits it.

Before adding or changing such a dependency, read
`.stagewise/skills/native-dependencies/SKILL.md`.

## Local data

Every structured store under an agent data directory participates in the forward-only migration registry. Before changing a config schema, persisted JSON, SQLite schema, metadata, or migration code, read `.stagewise/skills/local-data-migrations/SKILL.md`. New stores must be registered before any service can write them. Never add down migrations or transform `identity/private-key.pem`.

## Technical docs

- `apps/klex/src/local-data/architecture.md`
- `apps/klex/src/mcp/architecture.md`
- `apps/klex/src/session/architecture.md`
- `apps/klex/src/session/chat/architecture.md`
- `packages/mcp-extension-push-notifications/README.md`
- `packages/mcp-extension-push-notifications/specification/draft/events.md`
- `mcp-servers/chat-simulator/README.md`
- Package-level README files for local build and API details.
