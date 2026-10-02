# Chat Session Architecture

## Hierarchy

```
SessionHost
  └─ Session (long-lived, owns messages + inbox + loop)
       └─ Turn (one inbox-drain-to-idle cycle)
            └─ Step (one generation + tool dispatch)
                 └─ Generation (one AI-SDK call, with retry + fallback)
```

## Session

Owns message history, inbox, extension handler, fallback manager, backoff manager, and the run loop. Lives for the application lifetime (or until a fatal error self-terminates it). Exposes `status: 'active' | 'terminated'` so the session host can detect dead sessions and replace them.

**Loop:** processes one turn per iteration. Goes idle only when the inbox deferred buffer is empty, no pending immediate input, no backoff retry, and no check-retry needed. If a turn fails completely (all models exhausted) and no new input arrives, applies exponential backoff. A turn that fails because the provider rejected the request skips backoff and its termination counter; the session stays alive and the next inbox input starts a fresh turn. Fatal errors terminate immediately.

## Inbox

Three-urgency event buffer. Two entry points: `send(event)` for context events (from MCP push notifications, session host) and `sendMessage(message, urgency)` for native messages (from extensions). Both share the same urgency semantics.

### Urgency levels

- **Critical** — appended to history immediately. Aborts current generation. Triggers a check-retry turn.
- **Default** — appended to history immediately. Does not abort. Triggers a check-retry turn.
- **Deferrable** — buffered in the inbox, drained at turn start. Background context.

### Mid-turn ordering

Critical/Default events arriving during an active turn are queued in `pendingImmediate` instead of being pushed to history immediately. This prevents a stale response from appearing after the new event. The buffer is flushed after each step commits its response, preserving `[..., ASSISTANT_RESPONSE, NEW_USER_EVENT]` ordering.

After a turn ends with a valid stop, if non-deferrable input arrived during the turn, the loop runs a check-retry turn asking the model to review new input and decide whether to respond.

### Session termination and event recovery

When a session terminates, the inbox is closed — subsequent `send()` / `sendMessage()` throws `SessionInboxClosedError`. Deferred events remaining in the buffer are passed to the session host's `onTerminated` hook, which creates a replacement session and re-dispatches them. Immediate events already in history are lost with the terminated session.

## Generation-lane leasing

The default chat session is the sole owner of canonical history, extensions, and tool execution. Realtime does not create a parallel chat session — it requests an exclusive generation-lane lease through `ConversationHost`.

Lease acquisition is a safe-boundary handoff: quiesce the generation lane, interrupt only an active model stream, let dispatched tools and the current step commit settle, prevent the next chat step from starting, then prepare one atomic inference context. A concurrent lease is rejected. Normal release resumes the chat lane without generating a duplicate response.

### Context preparation

Both chat steps and leased interactions use the same context assembly: provisional extension context, cloned canonical history, history transformers and compaction, model-message conversion, context transformers, tool collection, then instructions. The preparation handle is committed only after provider setup succeeds; setup failure rolls it back.

## Turn

Drains deferrable inbox, then runs steps sequentially until no more generation is needed. Unifies "Continue." injection (backoff retry or salvage) and `data-check` injection (check-retry after new input) into a single code path.

Every turn terminates. A hard cap of `MAX_STEPS_PER_TURN` (200) steps covers long tool loops. Consecutive failed steps (generation failure, model fallback, or request rejection) are limited to one full model rotation plus one retry: `max(1, chatModelCount) + 1`. A successful step resets the counter and the rejection count. On the first request rejection the next step runs on the same model, so extensions can drop the content they injected. From the second rejection on, the turn falls back to the next model before the next step, so a bad model ID still reaches the backup models. `TurnResult.stopReason` (`completed`, `failure_budget_exhausted`, `step_cap_reached`, `yielded`, `fatal`) and `TurnResult.requestRejected` report why the turn ended. A turn that ends on a failed step reports `completeFailure` even if earlier steps succeeded. The session does not retry a turn that hit the step cap or ended on an unsalvaged rejection; it waits for new input, or runs a check-retry turn if immediate input arrived during the turn. A turn that ends on a salvaged rejection gets a backoff retry, because its partial work is in history and the rejected content was dropped.

## Step

Coordinator: history repair → decision (can a step run?) → shared instinct → model fetch → history transformation (clone → extension pre-process → model-aware conversion → extension post-process) → delegate to GenerationRunner.

Generation operates on a `structuredClone` copy, so mid-turn appends are visible to the next step without corrupting the original. The original is only mutated in synchronous sequential code (turn-start drain, history repair, Continue/check injection, response push, immediate inbox appends).

### Instinct subsystem

`ChatSession` owns one `InstinctRunner`, shared through Turn and Step. It lets extensions classify new input and prepare context after history repair and the executable-step decision, but before main-model resolution. The phase is opt-in; no built-in extension currently participates.

#### Requests and history delta

Core snapshots canonical history and computes an ID-set delta against the last **committed** instinct, across steps and turns. The first delta contains all history; subsequent deltas include added messages in history order and removed IDs. Mid-history inserts are detected, but edits to an existing message ID are not additions. Interrupted instinct does not advance the baseline, so a retry sees the input again. Persistent parts committed by instinct appear in the next delta.

`getInstinctClassificationRequest(input)` synchronously returns a trusted `prompt`, boolean/enum `keys`, and optional changing `context`, or `null` to opt out. Keep fixed policy in `prompt` and extension state in `context`; never interpolate conversation data into the prompt. Throws and invalid requests opt out. The extension API documents request limits.

Valid requests share one stateless structured inference using `modelSelection.classifier` at temperature 0. Each extension receives only its own validated answer slice; valid slices can be salvaged from partial JSON. No valid requests means no classifier call. An empty classifier model list produces `unavailable`, not chat fallback. Reaction-only extensions receive `classification: null`.

#### Model input and configuration

The system prompt combines the classifier's base instructions, the existing line-history format documentation and each extension's trusted prompt/key descriptions. The user prompt contains escaped `<external-input>` blocks: optional per-extension `kind="state"` blocks, a `source="conversation" kind="recent"` block when earlier history exists, and a `source="conversation" kind="new"` block for added messages (or an explicit no-new-messages marker). State and conversation are data, not instructions. External wrapper-tag lookalikes are neutralized, and conversation content uses the line renderer's `¦` data prefix. These are injection mitigations, not guarantees about model compliance.

The `instinct` config schema defines deadlines and input limits. New input takes priority over recent history; newest messages are retained in chronological order. Omission markers count toward the history budget, which covers recent/new content but not the system prompt, schema or extension-state blocks. Data-part transformers project extension text; binary media is not forwarded.

Configure `modelSelection.classifier` with the normal ordered `{ providerId, modelId, providerOptions? }` entries for its own primary/fallback models. Its default list is empty, so the API alone introduces no classifier-provider traffic.

#### Awaited reactions and staging

`onInstinct(ctx)` runs concurrently for every extension defining it, with isolated snapshots and private staging buffers. Main generation waits for all reactions or the shared deadline. Classification consumes part of that budget.

Pass `ctx.signal` to I/O and avoid blocking the event loop. Await all staged writes: buffers seal as each reaction settles, and late writes throw. Background results must use normal inbox delivery.

| Preparation method | Retention |
| --- | --- |
| `appendPersistent(parts)` | One canonical message per extension, in factory order; survives generation failure. Only extension-owned `data-*` parts with registered transformers are accepted. |
| `appendProvisional(parts)` | Merged into provisional step context; retained only on successful generation without fallback, like `getProvisionalStepContext`. |
| `appendEphemeral(parts)` | This step's inference clone only; never canonical history or the next classifier's transcript. |

Successful buffers commit synchronously in factory order, once. A failed or timed-out reaction loses its entire buffer; already successful reactions can still commit. Critical input, lease quiescence or session cancellation drops **all** staged context and preserves the delta baseline. The transaction covers staged parts only: extension-owned state mutations and external side effects are not rolled back automatically.

#### Integration example

Inside an extension class, with extension-owned state and context-loading methods:

```ts
const CONTEXT_QUESTION = defineInstinctClassification({
  prompt:
    'Decide whether the new input needs additional context beyond the supplied state. Choose false when already covered or uncertain.',
  keys: {
    needsContext: {
      type: 'boolean',
      description: 'Whether additional context should be loaded before generation.',
    },
  },
});

getInstinctClassificationRequest(input: InstinctInput) {
  if (!input.delta.added.some((message) => message.role === 'user')) return null;
  return { ...CONTEXT_QUESTION, context: this.describeLoadedState() };
}

async onInstinct(ctx: InstinctContext): Promise<void> {
  const answers = readInstinctClassification(ctx, CONTEXT_QUESTION);
  if (!answers?.needsContext || ctx.signal.aborted) return;
  const text = await this.loadContext(ctx.history, ctx.signal);
  if (text && !ctx.signal.aborted) {
    ctx.prepare.appendEphemeral([{ type: 'text', text }]);
  }
}
```

Import the helpers and types from the extension API. This example skips work on absent or unsuccessful classification. Ephemeral results must not be recorded as durably loaded in extension state.

#### Observability

Classifier usage is attributed to `core:instinct-classifier`. Traces contain `step.instinct`, `step.instinct.classifier` and per-extension `step.instinct.reaction` spans. Session introspection exposes `instinct.lastSummary`; step-completion events include instinct duration, classifier status, per-extension reaction status and staged-part counts, plus interruption accounting.

## Native media input

The session maps valid inline MCP image and audio blocks to canonical content containing `mimeType` and base64 `data`. This representation is AI-SDK-independent, remains in canonical history, preserves position relative to captions and text, and is redacted from logs.

Model-message conversion projects media for the selected model: if the model declares a matching native capability and the media fits its byte limit, conversion emits a file part; otherwise it emits an explicit `<unsupported-image>` or `<unsupported-audio>` text marker. Media is never silently omitted. Media presence does not change model selection.

## GenerationRunner

Owns the retry loop, model fallback, error classification, message salvage, stream progress tracking, and the ToolDispatcher. On failure, `decideOutcome` (pure) maps classification + content state to a coarse outcome, then `applyOutcome` performs side effects and refines it. A request rejection without content ends the step with `requestRejected: true` and no model fallback; the turn decides how to continue.

## ToolDispatcher

At-most-once tool execution via a `dispatchedToolCallIds` set. Owns tool lookup, execution, and in-place state mutation. Decoupled from generation abort. Post-generation sweep catches tool calls that reached `input-available` after the stream ended. Tool execution is bounded by a configurable timeout.

## Extensions

Extensions can transform UI history and model context, register custom data-part transformers, expose tools, and contribute system prompts. `onStepComplete` receives `requestRejected`; extensions that injected request content (for example `readAttachment` remote media) use it to replace that content with an error text in later model context. This degrade state is in memory and does not change persisted history. After a restart, at most one more rejected attempt happens before the content is degraded again. `getProvisionalStepContext` prepares dynamic context after model resolution, immediately before inference. Providers receive isolated history snapshots and run sequentially in factory order; they do not mutate canonical history directly.

## Episodic memory

The memory extension loads only in the default session. During startup it creates a deterministic episode recorder and an optional retrieval child. The recorder has no model, child session, or MCP access.

### Triggers

The recorder flushes after every successful main-session step, every 30 seconds between steps, and during shutdown. Failed, cancelled, or fallback steps are skipped because their provisional context may be rolled back.

### Episode lifecycle

Episodes rotate when the next persisted representation would exceed `maxCharacters`, when `maxDurationMs` elapses, after `idleTimeoutMs` of inactivity, or when the UTC date changes. The defaults are 50,000 characters, one hour, and ten minutes. Rotation is checked before each appended record; files are created only with their first record.

### Writer input

The recorder tracks the last native message ID and renders only the history excerpt after that cursor through the shared line-format history view. It records agent actions, thoughts, outputs, incoming context, and time. Raw user text, `recall` calls, and memory results are omitted. Media is represented by MIME-type placeholders; text and serialized values are aggressively bounded, and explicit omission counts mark dropped parts.

### Episode storage

Episodes are JSON Lines files under `episodic/yyyy-MM-dd/` named `index-HH-mm.jsonl`. The first line is a header (`kind: "episode"`, `v`, `analyzed: false`); every further line is one record with `v`, ISO `at`, `messageId`, `role`, the structured fitted `record`, and an optional `omittedRecords` count on the last record of a truncated message. Rendering a record with `renderRecordText` reproduces the line-format text exactly, so search and context reads keep the line format. Readers skip invalid lines (for example a crash-truncated tail) and ignore unknown fields. Legacy `.md` episodes are not read but still reserve their file index. The store serializes writes and uses collision-safe creation; a restart opens a new file rather than reopening the previous one.

### Retrieval

The memory extension also owns a second child session, `memory-retrieval`, created by the coordinator in `memory/retrieval/`. Its model is the `memory` purpose, falling back to `chat` when none is configured. Unlike the writer, retrieval is optional: if the search index or the child fails to start, the extension keeps running, buffers recalls (bounded), and retries both with exponential backoff. The same happens when the child terminates later. Only an index written by a newer schema is permanent: retrieval then stays off, `recall` fails fast, and recalls already buffered get one explicit "memory is unavailable" answer.

- **Index**: `episodic-search.sqlite` in the extension data directory is a rebuildable FTS index over the JSONL episode files, registered as a local-data store. The episode files are the source of truth. The index reconciles against them before search; schema mismatches stop startup instead of rewriting the file.
- **Inputs**: the main session sends explicit `recall` tool calls, and after every step `renderObservation` streams the history delta after a cursor. Observations contain only incoming data (user text, context, one-line tool-call summaries), and exclude memory results and `recall` calls so the child never observes its own output. A backlog drains oldest-first in budget-sized batches (a few per step); each message is clipped on its own, so no message between batches is skipped. The cursor only advances past batches the child accepted.
- **Tools**: the child searches with `searchMemory` (`auto`, `exact`, or `fuzzy` mode; fuzzy expands unknown terms by bounded edit distance), expands hits with `readMemoryContext` through opaque per-turn handles, and checks index state with `inspectMemory`. Search, read, and output budgets apply per child turn.
- **Background output**: the retrieval child's path back is `surfaceMemory`. Every text memory puts into the main session is wrapped in exactly one `<memory>` block; memory tags inside the content are defused. Each recall carries an id (`<recall id="r1">`); a surface answers a recall only when it cites an id that is still open (answer window), otherwise it is proactive. Recall answers arrive with `Default` urgency and bypass deduplication. Proactive memories are `Default` while a main turn is active and `Deferrable` otherwise, and are deduplicated by scope and text fingerprint. Recalls are limited per fingerprint per main-session task (latest user message).

## Consult context and lifecycle

Consult receives the latest durable context-compaction summary plus the configurable newest non-summary message suffix from the parent (five ordinary messages by default), rendered in the line format through the shared transcript preset of `utils/history-view`; the child prompt appends `LINES_FORMAT_PROMPT`. The durable summary is selected independently and does not consume the ordinary-message quota. This is deliberately separate from the episodic recorder preset: memory records are optimized for durable storage and omit raw user text, while the consult needs recent conversation evidence for the current task. The consult has no MCP access and can only receive the task, parent updates, and lifecycle messages. The parent publishes active consult state as a custom `consults` data part so it remains available in the main session context. The first visible snapshot is a compact Markdown table inside `<consults mode="full">`; subsequent changes use one line per change inside `<consults mode="change">`. After compaction, the history transformer reinjects the last known full snapshot. Reports are intermediate until the child explicitly marks one final; report-limit closure is surfaced as `termination="limit-reached"` rather than a verdict.

## History views

`utils/history-view` turns native history into compact model input for another model. It runs three stages:

1. **Filter**: scope (`all` or `after-cursor`) and projection into format-neutral records (text, reasoning, tool, context, summary, data) with per-field length limits and truncation styles.
2. **Render**: the line format. Records are separated by blank lines, external content lines start with `¦`, the agent's own records use `your_*` labels, messages and context records can be fitted to optional limits, and inline image/audio becomes segments. Readers need `LINES_FORMAT_PROMPT`.
3. **Budget**: `newest` keeps the latest summary plus the newest messages and marks truncation; `oldest` consumes messages in order and returns a resume cursor.

Consumers own their presets. The line-format transcript preset (`createTranscriptHistoryView`, `CONTEXT_SUMMARY_KEY`) serves context compaction without a limit and consult with a character and message budget. The episodic recorder preset lives in `memory/history-compression.ts`.

## Error handling

- **Model errors** (5xx, 408, 429, 401/403, timeouts, no output) → fallback to next model, retry
- **Request rejections** (other 4xx, including 400 and 404) → no fallback within the step; extensions degrade injected content, the turn retries within its failure budget, then ends without session backoff
- **Fatal errors** (invalid prompt, raised locally before any request) → terminate session
- **Salvage** — partial content with repairable issues → push to history, force next step; a salvaged request rejection is still reported as `requestRejected`
- **Backoff** — all models exhausted, no new input → exponential backoff; new inbox input interrupts
- **Loop guard** — top-level try/catch/finally resets `loopActive` and triggers clean termination on unhandled errors

## See also

- [Session Architecture](../architecture.md) — session kinds, hierarchy, composition root
- [Extension Architecture](./extensions/context-compaction/architecture.md) — extension interface, hooks, dispatch
