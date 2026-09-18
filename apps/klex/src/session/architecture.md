# Session Architecture

## Overview

Klex has one durable agent with many concurrent model execution units called **sessions**. Sessions are private — the user never manages them directly. Each session owns its own message history, inbox, extension handler, and run loop.

There are three kinds of sessions:

| Kind | MCP | Push notifications | Outside input | Created by |
|------|-----|--------------------|--------------|------------|
| `default` | ✅ | ✅ when composed with the MCP ingress extension | ✅ | `SessionHost` |
| `god` | ❌ | ❌ | God messages only | `GodMessages` module |
| `child` | ❌ | ❌ | Parent extension only | Extension via `createChildSession` |

The `default` session is the main execution unit — it talks to MCP servers, receives push notifications, and runs the agent's main loop. `god` and `child` sessions are isolated: no MCP, no push notifications, no outside-world access. Their only input is messages injected by their owner.

## Hierarchy

```
SessionHost
  └─ default session (has MCP access)
       └─ extension handler
            ├─ MCP ingress extension (push notification → inbox wiring)
            └─ extension (can spawn child sessions)
                 └─ child session (isolated — no MCP, no push notifications)
                      └─ extension handler
                           └─ extension (can spawn a grandchild)
```

```
GodMessages module
  └─ god session (no MCP — loads memory extension + god-messages trust extension)
```

## SessionHost

Owns exactly one session (the default) and manages its lifecycle. It does not wire push notifications; MCP ingress is owned by an extension in the default session's composition.

Responsibilities:

1. Create the default session with MCP + extensions + session context
2. Handle replacement on self-termination (create new session, re-dispatch pending inbox events)
3. Expose the session as `ConversationHost` for realtime
4. Create the root `sessions` introspection scope

Realtime accepts `SessionHost` as a `ConversationHost` through TypeScript structural typing. The host delegates `acquireInteractionLease` to the current default session. If the session has terminated, it creates a replacement first.

### Session replacement

When the default session self-terminates, `SessionHooks.onTerminated` fires. `SessionHost` creates and starts a replacement, re-dispatches pending deferred inbox events, and updates its reference. If a lease request already created the replacement, the termination hook reuses it.

### Push notification → inbox conversion

The MCP ingress extension converts MCP push notifications to `SessionInboxEvent` and feeds them into the session's inbox via `inbox.send()`. Resource-aware ingress may suppress or replace an event when a linked resource is already open and live.

## Session kinds and context

Extensions inspect `sessionContext.kind` to decide session-specific behavior. An extension that spawns a child explicitly supplies that child's complete extension list and is responsible for avoiding unwanted recursive composition.

### MCP access

`ExtensionDeps.mcp` is `Mcp | null`. The `default` session passes the real `Mcp` instance; `god` and `child` sessions pass `null`. Extensions that require MCP check in their constructor.

### Push notification subscription

MCP access and MCP ingress are independent. Supplying `deps.mcp` makes MCP tools available, but does not implicitly subscribe to push notifications. The composition root installs the MCP ingress extension in the default session only.

The `SessionHost` starts before MCP, so the ingress extension's listener is installed before MCP workers connect and drain pending events. MCP persists accepted events before acknowledgement and deduplicates by `eventId`.

## Child sessions

Extensions can spawn child sessions — isolated execution units with their own message history, inbox, and extensions. Child sessions have no MCP access and no MCP ingress extension. Their only input is messages injected by the parent extension.

### Spawning

When an extension calls `deps.createChildSession(options)`, a child context with `kind: 'child'` is built, a `ChatSession` is constructed with `mcp: null` and exactly the requested extensions, startup is awaited, and the fully started handle is returned.

### Extension selection

The spawning extension explicitly chooses every extension loaded by the child. No extensions are inherited or filtered automatically.

### Lifecycle

Child sessions are owned by the extension that spawned them. The extension is responsible for closing them — typically in its `onClose` hook. `waitForIdle(timeoutMs)` lets an owner provide bounded drain time before closing. There is no global orphan reclamation; ownership is explicit.

## Composition root

The composition root wires shared deps once and passes a `sessionFactory` to both `SessionHost` and `GodMessages`. The factory captures shared deps (config, modelResolver, logging, dataDirectory) and creates chat sessions with child-specific parameters.

### Startup order

```
model-call-logger → admin-api → cloud-connectivity
  → session-host → realtime → mcp → telemetry-manager → god-messages
```

### God messages

The `GodMessages` module creates its session via `sessionFactory` with `mcp: null` and `sessionContext.kind: 'god'`. The session loads trust extensions. No push notifications, no MCP tools.

## Introspection tree

```
sessions
  └── default
      ├── extensions
      └── child-sessions
          └── <child-session-id>
              ├── extensions
              └── child-sessions

god-sessions
  └── <god-session-id>
      └── extensions
```

Child sessions register under their parent session's `child-sessions` scope, giving full recursive visibility without a second source of lifecycle state.

## See also

- [Chat Session Architecture](./chat/architecture.md) — session loop, turns, steps, inbox, generation
