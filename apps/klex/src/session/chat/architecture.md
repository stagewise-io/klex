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

**Loop:** processes one turn per iteration. If a turn fails completely (all models exhausted) and no new inbox input arrives, applies exponential backoff before retrying. Fatal errors (e.g. 400, invalid prompt) terminate the session immediately.

## Inbox

Three-urgency event buffer fed by the router:

- **Critical** — appended to history immediately (via callback). Aborts current generation. Triggers a check-retry turn after the turn ends.
- **Default** — appended to history immediately (via callback). Does not abort. Triggers a check-retry turn after the turn ends.
- **Deferrable** — buffered in the inbox, drained at turn start. Background context.

Critical and Default events bypass the buffer via `onImmediateEvent` / `onImmediateMessage` callbacks. The `structuredClone` generation copy ensures mid-turn appends are visible to the next step without corrupting the original. After a turn ends with a valid stop, if input arrived during the turn (`newInputDuringTurn`), the loop runs a check-retry turn with `forceCheck` that injects a `data-check` prompt asking the model to review new input and decide whether to respond.

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
