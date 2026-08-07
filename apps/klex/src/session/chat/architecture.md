# Chat Session Architecture

## Hierarchy

```
Router
  └─ Session (long-lived, owns messages + inbox + loop)
       └─ Turn (one inbox-drain-to-idle cycle)
            └─ Step (one generation + tool dispatch)
                 └─ Generation (one AI-SDK call, with retry + fallback)
```

## Session

Owns message history, inbox, extension handler, fallback manager, backoff manager, and the run loop. Lives for the application lifetime (or until a fatal error self-terminates it). Exposes `status: 'active' | 'terminated'` so the router can detect dead sessions and replace them.

**Loop:** processes one turn per iteration. Goes idle only when the inbox deferred buffer is empty, no pending immediate input (`hasPendingInput`), no backoff retry is needed, and no check-retry is needed. If a turn fails completely (all models exhausted) and no new inbox input arrives, applies exponential backoff before retrying. Fatal errors (e.g. 400, invalid prompt) terminate the session immediately.

## Inbox

Three-urgency event buffer fed by the router. Two entry points: `send(event)` for context events (from MCP push notifications, router) and `sendMessage(message, urgency)` for native messages (from extensions). Both share the same urgency semantics.

### Urgency levels

- **Critical** — appended to history immediately (via callback). Aborts current generation. Triggers a check-retry turn after the turn ends.
- **Default** — appended to history immediately (via callback). Does not abort. Triggers a check-retry turn after the turn ends.
- **Deferrable** — buffered in the inbox, drained at turn start. Background context.

### When events enter history

The timing depends on both the urgency and the current session state:

| Urgency | Session idle | Active turn | Backoff wait | Terminated |
|---------|-------------|-------------|--------------|------------|
| **Critical** | Immediately via callback. `hasPendingInput` starts the loop. | Immediately via callback. Generation aborted. `newInputDuringTurn` → check-retry after turn. | Immediately via callback. Backoff interrupted. `forceContinue` turn processes it. | Blocked — `SessionInboxClosedError`. |
| **Default** | Immediately via callback. `hasPendingInput` starts the loop. | Immediately via callback. `newInputDuringTurn` → check-retry after turn. | Immediately via callback. Backoff interrupted. `forceContinue` turn processes it. | Blocked — `SessionInboxClosedError`. |
| **Deferrable** | Buffered in inbox. `isEmpty()` false → loop starts, turn drains it. | Buffered in inbox. `newInputDuringTurn` → check-retry turn drains it. | Buffered in inbox. Backoff interrupted. `forceContinue` turn drains it. | Blocked — `SessionInboxClosedError`. |

### Loop trigger mechanism

Every `send()` and `sendMessage()` call invokes `onNewInput()` after dispatching/buffering. This callback:

- **If the loop is idle** (`loopActive = false`): sets `hasPendingInput = true` and starts `runLoop()`. The flag is necessary because Critical/Default events are already in `messages[]` — the loop's idle check uses `inbox.isEmpty()` which only inspects the deferred buffer, so without the flag the loop would go idle without processing the immediate event.
- **If the loop is active** (`loopActive = true`): sets `newInputDuringTurn = true`. The post-turn logic checks this flag and runs a check-retry turn (`forceCheck`) that injects a `data-check` prompt.
- **If in a backoff wait**: interrupts the wait via `backoffInterrupt`. The loop resumes and processes the new input.

Both flags are reset to `false` at the start of each turn iteration, so they only capture input that arrives during that specific turn.

### Mid-turn visibility

Critical and Default events bypass the buffer via `onImmediateEvent` / `onImmediateMessage` callbacks. The `structuredClone` generation copy ensures mid-turn appends are visible to the next step without corrupting the original. After a turn ends with a valid stop, if input arrived during the turn (`newInputDuringTurn`), the loop runs a check-retry turn with `forceCheck` that injects a `data-check` prompt asking the model to review new input and decide whether to respond.

### Critical urgency abort

Both `send()` and `sendMessage()` with Critical urgency abort the running generation via `currentTurn.abortGeneration('inbox_interrupt')`. The abort fires only if a turn is active (`currentTurn !== null`). For `sendMessage`, the urgency is passed to `onImmediateMessage` so the session can decide whether to abort.

### Session termination and event recovery

When a session terminates (fatal error, max failures, or explicit close), the inbox is closed first — any subsequent `send()` / `sendMessage()` throws `SessionInboxClosedError`. Deferred events remaining in the buffer are drained via `getEvents()` and passed to the router's `onTerminated` hook, which creates a replacement session and re-dispatches them via `restorePendingEvents()`. Immediate (Critical/Default) events that were already appended to history are lost with the terminated session's history — only deferred events survive.

## Turn

Drains deferrable inbox, then runs steps sequentially until no more generation is needed. Unifies "Continue." injection (backoff retry or salvage `forceNextStep`) and `data-check` injection (check-retry after new input) into a single code path. `completeFailure = hadAnyFailure && !hadAnySuccess` — salvaged content counts as non-failure.

## Step

Coordinator: history repair → decision (can a step run?) → model fetch → history transformation (clone → extension pre-process → model-aware core conversion → extension post-process) → delegate to GenerationRunner.

The step no longer drains the inbox. Immediate (Critical/Default) events are already in `messages[]` via callbacks; Deferrable events are drained at turn start. Generation operates on a `structuredClone` copy, so mid-turn appends are visible to the next step without corrupting the original.

The `messages[]` array is shared by reference across Session/Turn/Step. The critical window (extension processing + generation) operates on a `structuredClone` copy, so mutations can't corrupt the original. The original is only mutated in synchronous sequential code (turn-start drain, history repair, Continue/check injection, response push, immediate inbox appends via callbacks).

## Native media input

The router maps valid inline MCP image and audio blocks to canonical session content containing `mimeType` and base64 `data`. This representation is AI-SDK-independent, remains in canonical history, preserves its position relative to captions and other text, and is redacted from logs and tracing. Inline media is bounded to 10 MiB at ingress.

Core model-message conversion projects canonical context for the model already selected by the normal fallback order:

- If that model declares a matching native capability and the decoded media fits its byte limit, conversion emits an AI SDK UI file part, which becomes a model `FilePart`.
- Otherwise conversion emits an explicit `<unsupported-image>` or `<unsupported-audio>` text marker without binary data. Media is never silently omitted.

Media presence does not change model selection. A text-only primary model remains primary. Only an ordinary generation failure advances fallback; the next step then reprojects the untouched canonical history for the newly selected model, so a capable fallback can receive the original media.

Declare native support on a `knownModels` entry:

```json
{
  "inputCapabilities": {
    "image": {
      "mediaTypes": ["image/jpeg", "image/png"],
      "maxBytes": 10485760
    },
    "audio": {
      "mediaTypes": ["audio/mpeg", "audio/wav"],
      "maxBytes": 10485760
    }
  }
}
```

Missing `inputCapabilities.image` or `inputCapabilities.audio` means that modality is unsupported. Klex does not infer capabilities from model names. MIME matching against the selected model's configured list is exact: `audio/ogg` is not sent to a model that declares only `audio/mpeg` and `audio/wav`. Telegram voice commonly arrives as `audio/ogg`, so it degrades explicitly unless the selected model accepts that exact MIME type.

The core path validates MIME type, canonical base64, and decoded byte limits. It does not resize, re-encode, transcode, describe, transcribe, persist, or remotely fetch media. Deterministic format conversion and semantic fallback belong in separate future extensions.

## GenerationRunner

Owns the retry loop, model fallback, error classification, message salvage, stream progress tracking, and the ToolDispatcher. On failure, `decideOutcome` (pure) maps classification + content state to a coarse outcome, then `applyOutcome` performs side effects (span attrs, salvage, fallback) and refines it.

## ToolDispatcher

At-most-once tool execution via `dispatchedToolCallIds` Set. Owns tool lookup, execution, and in-place state mutation (`input-available` → `output-available` / `output-error`). Decoupled from generation abort (separate `toolAbortController`). Post-generation sweep catches tool calls that reached `input-available` after the stream ended. Tool execution is bounded by a configurable timeout (default 30 s).

## Extensions

Hook into history transformation (`onHistoryPreProcessing`, `onHistoryPostProcessing`), register custom data part converters, and can inject context via the inbox. Receive `ExtensionDeps` with `getHistory()` and `inbox` access.

## Error Handling

- **Model errors** (5xx, 429, timeouts, `NoOutputGeneratedError`) → fallback to next model, retry.
- **Fatal errors** (400, `InvalidPromptError`) → terminate session.
- **Salvage** — partial content with repairable issues → push to history, force next step.
- **Backoff** — all models exhausted, no new input → exponential backoff. New inbox input interrupts the wait.
- **Loop guard** — the `runLoop` is wrapped in a top-level try/catch/finally that resets `loopActive` and triggers clean termination on any unhandled error.
