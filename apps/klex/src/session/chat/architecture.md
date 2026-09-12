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
| **Critical** | Immediately via callback. `hasPendingInput` starts the loop. | Queued in `pendingImmediate`. Generation aborted. Flushed after step commits response. `newInputDuringTurn` → check-retry after turn. | Immediately via callback. Backoff interrupted. `forceContinue` turn processes it. | Blocked — `SessionInboxClosedError`. |
| **Default** | Immediately via callback. `hasPendingInput` starts the loop. | Queued in `pendingImmediate`. Flushed after step commits response. `newInputDuringTurn` → check-retry after turn. | Immediately via callback. Backoff interrupted. `forceContinue` turn processes it. | Blocked — `SessionInboxClosedError`. |
| **Deferrable** | Buffered in inbox. `isEmpty()` false → loop starts, turn drains it. | Buffered in inbox. Drained at next turn start. Does NOT set `newInputDuringTurn`. | Buffered in inbox. Backoff interrupted. `forceContinue` turn drains it. | Blocked — `SessionInboxClosedError`. |

### Loop trigger mechanism

Every `send()` and `sendMessage()` call invokes `onNewInput()` after dispatching/buffering. This callback:

- **If the loop is idle** (`loopActive = false`): sets `hasPendingInput = true` and starts `runLoop()`. The flag is necessary because Critical/Default events are already in `messages[]` — the loop's idle check uses `inbox.isEmpty()` which only inspects the deferred buffer, so without the flag the loop would go idle without processing the immediate event.
- **If the loop is active** (`loopActive = true`): for Critical/Default urgency, sets `newInputDuringTurn = true` (triggers check-retry). For Deferrable, does NOT set the flag — the buffered event will be drained at the next turn start without needing a check-retry. The event itself is queued in `pendingImmediate` (for Critical/Default) to preserve response-before-new-input ordering.
- **If in a backoff wait**: interrupts the wait via `backoffInterrupt`. The loop resumes and processes the new input.

Both flags are reset to `false` at the start of each turn iteration, so they only capture input that arrives during that specific turn.

### Mid-turn visibility and ordering

Critical and Default events that arrive during an active turn are queued in a `pendingImmediate` buffer instead of being pushed to `messages[]` immediately. This prevents a stale response (generated from the pre-event history) from appearing after the new user event in the conversation. The buffer is flushed after each step commits its response via `flushPendingImmediate()`, ensuring the ordering is always `[..., ASSISTANT_RESPONSE, NEW_USER_EVENT]`.

The `structuredClone` generation copy ensures the generation does not see mid-turn appends. After a turn ends with a valid stop, if non-deferrable input arrived during the turn (`newInputDuringTurn`), the loop runs a check-retry turn with `forceCheck` that injects a `data-check` prompt asking the model to review new input and decide whether to respond.

Deferrable events do not set `newInputDuringTurn` — they are buffered in the inbox and drained at the next turn start, so no check-retry is needed.

### Critical urgency abort

Both `send()` and `sendMessage()` with Critical urgency abort the running generation via `currentTurn.abortGeneration('inbox_interrupt')`. The abort fires only if a turn is active (`currentTurn !== null`). For `sendMessage`, the urgency is passed to `onImmediateMessage` so the session can decide whether to abort.

### Session termination and event recovery

When a session terminates (fatal error, max failures, or explicit close), the inbox is closed first — any subsequent `send()` / `sendMessage()` throws `SessionInboxClosedError`. Deferred events remaining in the buffer are drained via `getEvents()` and passed to the router's `onTerminated` hook, which creates a replacement session and re-dispatches them via `restorePendingEvents()`. Immediate (Critical/Default) events that were already appended to history are lost with the terminated session's history — only deferred events survive.

## Generation-lane leasing

The primary chat session is the sole owner of canonical history, extension instances, and tool execution. Realtime does not create a parallel chat session. It requests an exclusive generation-lane lease through the router's `ConversationHost` interface.

Lease acquisition is a safe-boundary handoff:

1. mark the generation lane as quiescing;
2. interrupt only an active model stream;
3. allow already-dispatched tools and the current step commit to settle;
4. prevent the next chat step from starting;
5. prepare one atomic inference context and expose its history revision and update watermark.

This ordering preserves chat-originated call framing. Assistant text, a call-opening tool invocation, and its settled result are canonical before realtime bootstrap. A concurrent lease is rejected. Closing or terminating the primary session revokes its lease; normal release resumes the chat lane without generating a duplicate response for inputs already handled during the call.

### Context preparation

Both chat steps and leased interactions use the same context assembly order: provisional extension context, cloned canonical history, history transformers and compaction, model-message conversion, context transformers, tool collection, then base and extension instructions. The returned preparation handle is committed only after provider setup succeeds. Setup failure rolls it back, so provisional context cannot leak into canonical history.

The bootstrap contains provider-neutral `ModelMessage[]`, non-secret model metadata, JSON-Schema tool descriptors, `historyRevision`, and `updateWatermark`. Provider credentials and wire-format conversion remain outside the chat session.

### Canonical updates and commits

Accepted Critical and Default inbox events are first recorded in canonical history, assigned a monotonic session sequence, then published to the active lease. The bootstrap watermark and ordered update stream eliminate the snapshot/subscription race. Stable event IDs support process-local deduplication and reconnect replay. `requestResponse` is explicit; forwarding a notification does not inherently request speech.

Only finalized user and assistant transcripts are committed. Partial deltas remain ephemeral, and interrupted assistant text is truncated to synchronized playout before commitment. Realtime tool calls and results use the session-owned executor and canonical commit path. Execution IDs provide lease-lifetime at-most-once side effects, while commit event IDs make transcript and tool records idempotent.

The pending update buffer is bounded to 256 entries by default. Overflow revokes the lease rather than silently dropping or reordering canonical input. Acknowledged updates are pruned from the replay cursor. These guarantees are process-local because canonical history is currently process-local.

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
  "capabilities": {
    "input": {
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

Missing `capabilities.input.image` or `capabilities.input.audio` means that modality is unsupported. Klex does not infer capabilities from model names. MIME matching against the selected model's configured list is exact: `audio/ogg` is not sent to a model that declares only `audio/mpeg` and `audio/wav`. Telegram voice commonly arrives as `audio/ogg`, so it degrades explicitly unless the selected model accepts that exact MIME type.

The core path validates MIME type, canonical base64, and decoded byte limits. It does not resize, re-encode, transcode, describe, transcribe, persist, or remotely fetch media. Deterministic format conversion and semantic fallback belong in separate future extensions.

## GenerationRunner

Owns the retry loop, model fallback, error classification, message salvage, stream progress tracking, and the ToolDispatcher. On failure, `decideOutcome` (pure) maps classification + content state to a coarse outcome, then `applyOutcome` performs side effects (span attrs, salvage, fallback) and refines it.

## ToolDispatcher

At-most-once tool execution via `dispatchedToolCallIds` Set. Owns tool lookup, execution, and in-place state mutation (`input-available` → `output-available` / `output-error`). Decoupled from generation abort (separate `toolAbortController`). Post-generation sweep catches tool calls that reached `input-available` after the stream ended. Tool execution is bounded by a configurable timeout (default 30 s).

## Extensions

Extensions can transform UI history and model context, register custom data-part transformers, expose tools, and contribute system prompts. `getProvisionalStepContext` prepares dynamic context after the step decision and model resolution, immediately before inference. Core appends all contributed parts as one synthetic user message: it retains that message when generation completes and removes it when generation fails or falls back to another step. Providers receive isolated history snapshots and run sequentially in factory order; they do not mutate canonical history directly. Inbox access remains available for genuine turn-triggering input, not just-in-time generation context.

## Error Handling

- **Model errors** (5xx, 429, timeouts, `NoOutputGeneratedError`) → fallback to next model, retry.
- **Fatal errors** (400, `InvalidPromptError`) → terminate session.
- **Salvage** — partial content with repairable issues → push to history, force next step.
- **Backoff** — all models exhausted, no new input → exponential backoff. New inbox input interrupts the wait.
- **Loop guard** — the `runLoop` is wrapped in a top-level try/catch/finally that resets `loopActive` and triggers clean termination on any unhandled error.
