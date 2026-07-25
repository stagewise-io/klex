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

**Loop:** processes one turn per iteration. If a turn fails completely (all models exhausted) and no new inbox input arrives, applies exponential backoff before retrying. Fatal errors (400, `InvalidPromptError`) terminate the session immediately.

## Inbox

Three-priority event buffer fed by the router:

- **Low** — drained at turn start. Background context.
- **Medium** — drained at step start. Normal user input, tool results.
- **High** — aborts current generation immediately, drained by next step.

Turn drains `≥ Low`; Step drains `≥ Medium`.

## Turn

Drains low-priority inbox, then runs steps sequentially until no more generation is needed. Unifies "Continue." injection (backoff retry or salvage `forceNextStep`) into a single code path. `completeFailure = hadAnyFailure && !hadAnySuccess` — salvaged content counts as non-failure.

## Step

Coordinator: inbox drain (medium) → decision (can a step run?) → history transformation (clone → extension pre-process → convert to ModelMessages → extension post-process) → model fetch → delegate to GenerationRunner.

The `messages[]` array is shared by reference across Session/Turn/Step. The critical window (extension processing + generation) operates on a `structuredClone` copy, so mutations can't corrupt the original. The original is only mutated in synchronous sequential code (inbox drain, history repair, Continue injection, response push).

## GenerationRunner

Owns the retry loop (`MAX_GENERATION_ATTEMPTS = 20`), model fallback, error classification, message salvage, stream progress tracking, and the ToolDispatcher. On failure, `decideOutcome` (pure) maps classification + content state to a coarse outcome, then `applyOutcome` performs side effects (span attrs, salvage, fallback) and refines it.

## ToolDispatcher

At-most-once tool execution via `dispatchedToolCallIds` Set. Owns tool lookup, execution, and in-place state mutation (`input-available` → `output-available` / `output-error`). Decoupled from generation abort (separate `toolAbortController`). Post-generation sweep catches tool calls that reached `input-available` after the stream ended.

## Extensions

Hook into history transformation (`onHistoryPreProcessing`, `onHistoryPostProcessing`), register custom data part converters, and can inject context via the inbox. Receive `ExtensionDeps` with `getHistory()` and `inbox` access.

## Error Handling

- **Model errors** (5xx, 429, timeouts, `NoOutputGeneratedError`) → fallback to next model, retry.
- **Fatal errors** (400, `InvalidPromptError`) → terminate session.
- **Salvage** — partial content with repairable issues → push to history, force next step.
- **Backoff** — all models exhausted, no new input → exponential backoff with immediate-retry budget (3 attempts). New inbox input interrupts the wait.
