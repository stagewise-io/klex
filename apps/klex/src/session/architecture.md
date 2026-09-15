# Session Architecture

## Overview

Klex has one durable agent with many concurrent model execution units called **sessions**. Sessions are private — the user never manages them directly. Each session owns its own message history, inbox, extension handler, and run loop.

There are three kinds of sessions:

| Kind | MCP | Push notifications | Outside input | Created by |
|------|-----|--------------------|--------------|------------|
| `default` | ✅ | ✅ (subscribes in `start()`) | ✅ | `SessionHost` |
| `god` | ❌ | ❌ | God messages only | `GodMessages` module |
| `child` | ❌ | ❌ | Parent extension only | Extension via `createChildSession` |

The `default` session is the main execution unit — it talks to MCP servers, receives push notifications, and runs the agent's main loop. `god` and `child` sessions are isolated: no MCP, no push notifications, no outside-world access. Their only input is messages injected by their owner.

## Hierarchy

```
SessionHost
  └─ default session (owns MCP subscription + push notification → inbox wiring)
       └─ extension handler
            └─ extension (can spawn child sessions)
                 └─ child session (isolated — no MCP, no push notifications)
                      └─ extension handler
                           └─ extension (can explicitly spawn a grandchild)
```

```
GodMessages module
  └─ god session (no MCP — loads memory extension + god-messages trust extension)
```

## SessionHost

Owns exactly one session (the default) and manages its lifecycle. Does not wire push notifications — the session does that itself.

Responsibilities:

1. Create the default session with MCP + extensions + session context
2. Handle replacement on self-termination (create new session, re-dispatch pending inbox events)
3. Expose the session as `ConversationHost` for realtime
4. Create the root `sessions` introspection scope

```typescript
interface SessionHost extends RuntimeResource, ConversationHost {}
```

`SessionHost` implements `ConversationHost` by delegating `acquireInteractionLease` to the current default session. If the session has terminated, it creates a replacement first (same mutation-lock pattern).

### Session replacement

When the default session self-terminates (fatal error, max failures), `SessionHooks.onTerminated` fires. `SessionHost` creates and starts a replacement, re-dispatches pending deferred inbox events via `restorePendingEvents()`, and updates its reference. If a lease request already created the replacement, the termination hook reuses it instead of creating another session.

### Push notification → inbox conversion

The conversion of MCP push notifications to `SessionInboxEvent` is a pure function:

```typescript
function mcpPushNotificationToInboxEvent(
  ev: McpPushNotification,
): SessionInboxEvent
```

The default session calls this in its push notification listener and feeds the result into its own inbox via `inbox.send()`.

## Session kinds and context

```typescript
type SessionKind = 'default' | 'god' | 'child';

interface SessionContext {
  kind: SessionKind;
  sessionId: string;
  /** Parent session ID (child sessions only). */
  parentId?: string;
}
```

Extensions inspect `sessionContext.kind` to decide session-specific behavior. An extension that spawns a child explicitly supplies that child's complete extension list and is responsible for avoiding unwanted recursive composition.

### MCP access

`ExtensionDeps.mcp` is `Mcp | null`. The `default` session passes the real `Mcp` instance; `god` and `child` sessions pass `null`.

Extensions that require MCP check in their constructor:

```typescript
constructor(deps: ExtensionDeps) {
  if (!deps.mcp) throw new Error('js-repl-sandbox requires MCP access');
  // ...
}
```

Extensions that are MCP-agnostic (time, todos, soul, context-compaction) work unchanged in any session kind.

### Push notification subscription

The default session subscribes to MCP push notifications during `start()`:

```
1. If `deps.mcp` is present, subscribe to `mcp.onPushNotification`.
2. Start extensions sequentially.
3. If extension startup throws or the session terminates before startup completes, unsubscribe, close every attempted extension in reverse order, and propagate the startup error.
4. A default-session startup error rejects `SessionHost.start()` and fails application startup; child-session startup errors reject `createChildSession()` so the spawning extension decides whether to retry or propagate the failure.
```

And unsubscribes during `close()`:

```
1. Wait for any in-flight startup or startup rollback.
2. Unsubscribe from push notifications.
3. Close the inbox and abort active generation, tools, backoff, and leases.
4. Close extensions in reverse order.
```

The composition root starts `SessionHost` before MCP, so the default session listener is installed before MCP workers connect and drain pending events. MCP persists accepted events before acknowledgement and deduplicates them by `eventId`.

## Child sessions

Extensions can spawn child sessions — isolated execution units with their own message history, inbox, and extensions. Child sessions have no MCP access and no push notification subscription. Their only input is messages injected by the parent extension via the child session's inbox.

### Spawning

```typescript
interface ChildSessionOptions {
  extensions: ExtensionFactory[];
  systemPromptAssembler?: SystemPromptAssembler;
}

interface ChildSessionHandle {
  readonly sessionId: string;
  inbox: ChatSessionInbox;
  getMessages(): readonly ExtendedUIMessage[];
  getSessionInfo(): SessionInfo;
  close(): Promise<void>;
  /** Creates and fully starts an isolated grandchild session. */
  createChildSession(
    options: ChildSessionOptions,
  ): Promise<ChildSessionHandle>;
}
```

When an extension calls `deps.createChildSession(options)`:

1. Build a child context with `kind: 'child'` and `parentId: this.sessionId`.
2. Construct `ChatSession` with `mcp: null`, exactly the requested extensions, optional prompt assembler, and a child introspection scope. Each session starts an independent root trace span; child sessions are not nested under the spawning session's trace. Construction failures remove introspection state and end that span before propagating.
3. Await session startup. Startup failure is logged, cleaned up, and propagated to the extension.
4. Return the fully started handle.

### Extension selection

The spawning extension explicitly chooses every extension loaded by the child. No extensions are inherited or filtered automatically. Factory doc comments describe what each extension contributes so callers can compose a suitable child and avoid recursive self-loading.

### Lifecycle

Child sessions are owned by the extension that spawned them. The extension is responsible for closing them — typically in its `onClose` hook. If a parent session closes, all child sessions it spawned should be closed as part of the parent session's extension cleanup. There is no global orphan reclamation; ownership is explicit.

## ExtensionDeps

```typescript
interface ExtensionDeps {
  getHistory: () => ExtendedUIMessage[];
  insertMessageAfter: (afterMessageId: string, message: ExtendedUIMessage) => boolean;
  inbox: ChatSessionInbox;
  config: Config;
  modelResolver: ProviderModelResolver;
  generateText: (args: GenerateTextArgs) => Promise<GenerateTextResult>;
  logger: ModuleLogger;
  logging: RootLogger;
  mcp: Mcp | null;
  sessionId: string;
  sessionContext: SessionContext;
  createChildSession(
    options: ChildSessionOptions,
  ): Promise<ChildSessionHandle>;
  getDataDir: (global?: boolean) => string;
}
```

## ChatSessionDependencies

```typescript
interface ChatSessionDependencies {
  logging: RootLogger;
  modelResolver: ProviderModelResolver;
  config: Config;
  mcp: Mcp | null;
  extensionFactories: ExtensionFactory[];
  dataDirectory: string;
  introspectionScope: IntrospectionScope;
  hooks?: SessionHooks;
  sessionId?: string;
  sessionContext: SessionContext;
  /** Factory for creating child sessions. Absent if disabled. */
  sessionFactory?: SessionFactory;
}
```

The `sessionFactory` is a closure created by the composition root that captures shared deps (config, modelResolver, logging, dataDirectory). The session calls it with child-specific parameters when an extension invokes `createChildSession`.

## Composition root

The composition root wires shared deps once and passes a `sessionFactory` to both `SessionHost` and `GodMessages`:

```typescript
const sharedSessionDeps = {
  logging: logger,
  config,
  modelResolver: providerRegistry,
  dataDirectory,
};

const makeSessionFactory =
  (baseExtensions: ExtensionFactory[]): SessionFactory =>
  (params) =>
    createChatSession({
      ...sharedSessionDeps,
      mcp: params.mcp,
      sessionContext: params.sessionContext,
      extensionFactories: [...baseExtensions, ...params.extensionFactories],
      introspectionScope: params.introspectionScope,
      hooks: params.hooks,
      sessionId: params.sessionId,
      sessionFactory: makeSessionFactory([]),
    });

// Default session: full extension set + MCP access.
const sessionHost = createSessionHost({
  logging: logger,
  mcp,
  introspection: introspector,
  sessionFactory: makeSessionFactory([
    createNameLoaderExt,
    createSoulExt,
    createGodMessagesDistrustExt,
    createJsReplSandboxExt,
    ...commonExtensions,
  ]),
});

// God session: no MCP, trust-mode god-messages, soul-god variant.
const godMessages = createGodMessages({
  logging: logger,
  introspection: introspector,
  sessionFactory: makeSessionFactory([
    createNameLoaderExt,
    createSoulExtGod,
    createGodMessagesTrustExt,
  ]),
  extensionFactories: [...commonExtensions],
});

const realtime = createRealtime({
  // ...
  conversationHost: sessionHost,  // SessionHost implements ConversationHost
});
```

### Startup order

The `SessionHost` starts before MCP (so the default session is ready to subscribe) and before realtime (so `ConversationHost` is available):

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
      │   ├── io.stagewise/name-loader
      │   ├── io.stagewise/soul
      │   └── ...
      └── child-sessions
          └── <child-session-id>
              ├── extensions
              └── child-sessions
                  └── <grandchild-session-id>

god-sessions
  └── <god-session-id>
      └── extensions
          ├── io.stagewise/name-loader
          ├── io.stagewise/soul
          └── io.stagewise/god-messages-trust
```

Child sessions register under their parent session's `child-sessions` scope, giving full recursive visibility without a second source of lifecycle state.

## What stays unchanged

- **`ChatSession` core**: messages, inbox, loop, turns, steps, generation runner, tool dispatcher, fallback/backoff. See [Chat Session Architecture](./chat/architecture.md).
- **Extension interface** (`Extension`): `onStart`, `onClose`, `getTools`, `getSystemPromptPart`, `getProvisionalStepContext`, `historyTransformer`, `contextTransformer`, `onStepComplete`, `dataPartTransformers`, `introspect`.
- **Inbox system**: urgency levels, deferred/immediate buffers, mid-turn ordering.
- **Realtime session coordinator**: lease acquisition through `SessionHost` as `ConversationHost`.
- **God messages module**: session lifecycle, replacement, reset.
- **Admin API**: no changes.
