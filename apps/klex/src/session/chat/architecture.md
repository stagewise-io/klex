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

Leased bootstrap checks `shouldRunStep` before assembling context, just like a chat step. A missing soul removes newly added canonical history and rejects bootstrap; the caller releases the failed setup lease. Other extension skips do not automatically remove history. God-mode sessions remain allowed without a soul.

Both chat steps and leased interactions use the same context assembly: provisional extension context, cloned canonical history (the bounded window), history transformers, model-message conversion, context transformers, tool collection, then instructions. The preparation handle is committed only after provider setup succeeds; setup failure rolls it back.

## Turn

Drains deferrable inbox, then runs steps sequentially until no more generation is needed. Unifies "Continue." injection (backoff retry or salvage) and `data-check` injection (check-retry after new input) into a single code path.

Every turn terminates. A hard cap of `MAX_STEPS_PER_TURN` (200) steps covers long tool loops. Consecutive failed steps (generation failure, model fallback, or request rejection) are limited to one full model rotation plus one retry: `max(1, chatModelCount) + 1`. A successful step resets the counter and the rejection count. On the first request rejection the next step runs on the same model, so extensions can drop the content they injected. From the second rejection on, the turn falls back to the next model before the next step, so a bad model ID still reaches the backup models. `TurnResult.stopReason` (`completed`, `failure_budget_exhausted`, `step_cap_reached`, `yielded`, `fatal`) and `TurnResult.requestRejected` report why the turn ended. A turn that ends on a failed step reports `completeFailure` even if earlier steps succeeded. The session does not retry a turn that hit the step cap or ended on an unsalvaged rejection; it waits for new input, or runs a check-retry turn if immediate input arrived during the turn. A turn that ends on a salvaged rejection gets a backoff retry, because its partial work is in history and the rejected content was dropped.

## Step

Coordinator: extension step decision → history repair → decision (can a step run?) → shared instinct → model fetch → history transformation (clone → extension pre-process → model-aware conversion → extension post-process) → delegate to GenerationRunner.

`shouldRunStep(history)` lets an extension remove newly added canonical messages and skip the step before lifecycle hooks or inference. The soul extension uses it to discard new history while no soul exists, preserving previously retained history. Skipped work is not queued for soul creation; there is no polling.

Generation operates on a `structuredClone` copy, so mid-turn appends are visible to the next step without corrupting the original. The original is only mutated in synchronous sequential code (turn-start drain, history repair, Continue/check injection, response push, immediate inbox appends).

### Instinct subsystem

`ChatSession` owns one `InstinctRunner`, shared through Turn and Step. It runs before every executable main-agent step, after history repair and the executable-step decision, but before main-model resolution and generation. Extensions opt into classification and/or context preparation through the hooks below; no built-in extension currently participates. With no participating extensions, the phase performs no classifier call.

#### Requests and history delta

Core snapshots canonical history and computes an ID-set delta against the last **committed** instinct, across steps and turns. The first delta contains all history; subsequent deltas include added messages in history order and removed IDs. Mid-history inserts are detected, but edits to an existing message ID are not additions. Interrupted instinct does not advance the baseline, so a retry sees the input again. Persistent parts committed by instinct appear in the next delta.

`getInstinctClassificationRequest(input)` synchronously returns a trusted `prompt`, boolean/predicate/enum/score `keys`, and optional changing `context`, or `null` to opt out. Keep fixed policy in `prompt` and extension state in `context`; never interpolate conversation data into the prompt. Throws and invalid requests opt out. The extension API documents request limits.

Valid requests share one stateless classification batch using `modelSelection.instincts`. Extensions describe classifications; core owns input projection, backend choice, deadlines, and fallback. Both adapters share short question IDs, exact-match policies and extension-state aliases. Generation retains temperature 0 and returns a flat `{ q0: ..., q1: ... }` object, with per-extension partial-JSON salvage after remapping. Evaluation maps predicate/choice/score to SDK boolean/choice/score questions and accepts only complete validated results. Both APIs use zero SDK retries. Each extension receives only its own normalized answer slice. No valid requests means no classifier call. An empty Instincts list defaults to the ordered Chat model list via generation; with neither list available, classification is `unavailable`. Reaction-only extensions receive `classification: null`.

Generation predicates and SDK booleans carry `P(true)`, not confidence in the selected answer. Legacy boolean keys normalize to true only when `P(true) > 0.5`; a tie is false. New predicate keys expose the numeric probability directly. Score keys declare 2–32 uniquely labelled, described, ordered levels and return a probability-weighted mean of zero-based level indices (fractional values allowed), not the most probable label. Provider-specific limits still apply (the installed native TypeSafe SDK allows at most 10 score levels). Successful evaluation outcomes may include key-scoped raw probabilities and genuine choice/score distributions; generation estimates are not represented as provider evaluation metadata or calibrated confidence. Enum descriptors may provide `valueDescriptions` for declared values (500 characters each); they do not introduce an implicit unknown option. The shared batch is capped at 128 questions and 128,000 serialized adapter-payload characters, including the schema and adapter-specific instructions/options. Oversized batches fail open rather than truncating extension policy.

#### Model input and configuration

Generation places trusted policies and question declarations in its system prompt, with question meanings omitted from the JSON schema to avoid duplication. Both adapters use the shared history-view `LINES_FORMAT_PROMPT` rather than a classifier-specific description of record headers. Evaluation places that legend and shared policies once in its shared state, not in every question. Evidence contains optional `<state extension="eN">` blocks and one chronological `<agent-activity>` block. The classifier selects exactly the last five main-agent history messages (or all if fewer exist), oldest to newest, without `[new]` / `[earlier]` annotations. The prompt explains that the final entry is the most recent. Empty projections consume a window slot; selection never scans further back to fill them. `createInstinctHistoryView` supplies the canonical records directly: `user`, `your_output`, `your_action <tool> <status>` with `result`/`error` sections, `context <source>` and extension data labels, with the shared `¦` data-line prefix; message IDs are omitted, not used to deduplicate equal text. State and activity are data, never question instructions. Wrapper, policy and question-tag lookalikes are neutralized. These are injection mitigations, not guarantees about model compliance.

The `instinct` config schema defines deadlines and size limits. The five-message window is fixed; legacy `recentMessageCount` and `deltaMessageCap` fields remain readable for stored-config compatibility but no longer control classifier input. Size limits can reduce the window further, preferring its newest messages; an oversized newest message is truncated. The history budget includes record separators but not the system prompt, schema or extension-state blocks. Data-part transformers project only the selected window, once per data-part occurrence, retaining full-history occurrence indices. Binary media and model-private reasoning are not forwarded. Delta tracking still serves extension lifecycle callbacks, not classifier evidence selection.

Configure `modelSelection.instincts` with ordered `{ providerId, modelId, api: 'generation' | 'evaluation', providerOptions?, attemptTimeoutMs? }` entries. Identity includes the API, so the same model can appear once per API. Other purposes remain generation-only. Existing selections migrate to generation without changing options/order or adding attempt limits. Its default list is empty. When no Instincts entries are selected, classification uses the ordered Chat model list via generation, preserving provider options without persisting a separate Instincts selection. Explicit Instincts entries replace this default; their failures do not append Chat candidates. With neither list available, classification reports unavailable. The instinct enabled flag and existing classifier budgets still apply.

Each attempt uses the lesser of its configured timeout and the remaining absolute classifier budget. Omitted timeouts use that remaining budget; new CLI entries default to 1,500 ms and can be edited from 1 to 120,000 ms or cleared. Resolution/preparation/inference/validation share the deadline. Candidates are resolved from one settings snapshot and attempted in order, including across APIs. Unsupported, malformed, and individually timed-out attempts permit fallback. A complete result wins. After exhaustion, core may salvage only the latest recoverable generation response, never fragments from multiple attempts or partial evaluation answers. Caller cancellation/global timeout discard even salvage. Late results cannot change preparation or session accounting.

OpenAI, Anthropic, and Google Gemini expose SDK evaluation factories, but the installed adapters internally perform structured generation, force reasoning off, and lack standard temperature/output-token controls. Evaluation is not inherently faster, cheaper, or more accurate. The native `typesafe-ai` provider exposes evaluation only, with documented `jev-latest` model listing; configure its `apiKey` (environment placeholders supported), optional `baseUrl`, and optional `headers` through the existing provider settings. It is rejected for chat. Its connectivity test itself performs a paid synthetic evaluation; listing/discovery does not.

In the instinct detail view, `e` edits the highlighted production attempt timeout. There is no synthetic operation-test action, results dialog, or dedicated Admin API test endpoint. Normal provider connectivity tests remain separate from session instinct execution.

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

Every settled attempt contributes available session usage once under `core:instinct-classifier`, including failed generation usage when exposed by the SDK. Durable SDK tracing records generation and evaluation separately, respecting the content-capture policy for evaluation state/questions/results and cleaning up errors/aborts without late duplicate records. Missing token/cache metrics are not emitted as measured zero; event records expose API and nullable availability flags, and aggregate incompleteness counts indicate when numeric sums are only reported lower bounds.

Classifier usage is attributed to `core:instinct-classifier`. In regular sessions, the session → turn → step trace contains `step.instinct` → `step.instinct.classifier` → `instinct.attempt` → the SDK model-call span (`generate_content` or `evaluate`), plus per-extension `step.instinct.reaction` spans. These spans share the session trace and conversation identity; the whole instinct phase finishes before the main `generate_content` span starts. Advanced tracing retains call metadata without prompt/output content. Debug tracing includes generation system instructions, input/output messages, or evaluation state/questions/answers, subject to credential scrubbing. Session-level integration tests exercise the production tracing registration and export-time privacy filter for generation, evaluation, and mixed fallback. Session introspection exposes `instinct.lastSummary`; step-completion events include instinct duration, classifier status, per-extension reaction status and staged-part counts, plus interruption accounting.

## Native media input

The session maps valid inline MCP image and audio blocks to canonical content containing `mimeType` and base64 `data`. This representation is AI-SDK-independent, remains in canonical history, preserves position relative to captions and text, and is redacted from logs.

Model-message conversion projects media for the selected model: if the model declares a matching native capability and the media fits its byte limit, conversion emits a file part; otherwise it emits an explicit `<unsupported-image>` or `<unsupported-audio>` text marker. Media is never silently omitted. Media presence does not change model selection.

## GenerationRunner

Owns the retry loop, model fallback, error classification, message salvage, stream progress tracking, and the ToolDispatcher. On failure, `decideOutcome` (pure) maps classification + content state to a coarse outcome, then `applyOutcome` performs side effects and refines it. A request rejection without content ends the step with `requestRejected: true` and no model fallback; the turn decides how to continue.

## ToolDispatcher

At-most-once tool execution via a `dispatchedToolCallIds` set. Owns tool lookup, execution, and in-place state mutation. Decoupled from generation abort. Post-generation sweep catches tool calls that reached `input-available` after the stream ended. Tool execution is bounded by a configurable timeout.

## Extensions

Extensions can transform UI history and model context, register custom data-part transformers, expose tools, and contribute system prompts. `onStepComplete` receives `requestRejected`; extensions that injected request content (for example `readAttachment` remote media) use it to replace that content with an error text in later model context. This degrade state is in memory and does not change persisted history. After a restart, at most one more rejected attempt happens before the content is degraded again. `getProvisionalStepContext` prepares dynamic context after model resolution, immediately before inference. Providers receive isolated history snapshots and run sequentially in factory order; they do not mutate canonical history directly.

## Context window and checkpoints

The in-memory `messages` array is a bounded **window** over the durable transcript log, not the whole conversation. `deps.getHistory()` returns exactly this window.

**Window invariant.** When a checkpoint exists, `messages[0]` is its header, followed by every non-checkpoint message with `ord` greater than the header's `covers_through_ord`, in `ord` order. `isCheckpointHeader()` (`checkpoint/`) identifies the header. The header is a user-role message (providers such as Anthropic require a user-first conversation) whose parts are a core-owned `context-summary` part (`{ summary, coversThroughMessageId }`), followed by state parts carried forward by extensions in factory order. Core registers the summary renderer (`CHECKPOINT_DATA_PART_TRANSFORMERS`); an extension that registers the same key fails. A window that starts with a header forces `hasCompacted` for inference, so span attributes and the generation runner see compaction without any extension raising a flag.

**Producers.** Checkpoints are a core concept. An extension, normally context compaction, calls `deps.checkpoints.commit({ coversThroughMessageId, summary })`. Core validates synchronously and returns `{ status: 'pending' }` or `{ status: 'rejected', reason }`. The anchor must be in the window, must not be the header, must lie past the current header's coverage, and at least one non-checkpoint message must follow it. A newer valid commit replaces an older pending one.

**Apply.** Core applies the pending checkpoint only at safe boundaries: after each step commits its response (`TurnDependencies.atStepBoundary`, right after `flushPendingImmediate`), or immediately when the session is idle. Within a step the provisional context, the generation runner, and tool dispatch mutate the window, so mid-step trims are never safe. Leases and new turns wait for an idle apply to finish. Apply runs these steps in order:

1. Re-validate the anchor (it may have been rolled back) and reject on failure.
2. `dropped` = current header (if any) plus window messages up to and including the anchor.
3. Collect `getCheckpointCarry(dropped)` from every extension, sequentially in factory order on structured clones. A throwing extension aborts this apply; the checkpoint stays pending.
4. Run `onCheckpointApplying({ droppedMessageIds, checkpointMessageId })` hooks. A hook that returns `{ defer: true }` or throws keeps the checkpoint pending for the next boundary. After `MAX_CHECKPOINT_DEFERRALS` (3) consecutive deferrals core applies anyway with a warning, so a broken extension cannot reintroduce unbounded growth. If the window prefix changed while hooks ran, the apply is retried later.
5. Durably append the header to the log (`recorder.commitCheckpoint`) and await it. Memory is trimmed only after the write succeeds, so a crash always restores a consistent window. A write failure keeps the checkpoint pending.
6. Splice the array in place (`messages.splice(0, anchorIndex + 1, header)`); turn, step, and generation runner hold the same array reference. Then `recorder.markTrimmed(droppedIds)` so the trimmed rows stay in the log.

Telemetry span events: `checkpoint.committed`, `checkpoint.applied`, `checkpoint.deferred`, `checkpoint.rejected`.

**Carry-forward.** `getCheckpointCarry(dropped)` returns data parts that represent the extension's latest state within the dropped messages (time and timezone, consult list, MCP server list and open resources, todos). Because the header is part of the window, the existing `latest*Part(history)` lookups find carried state like any other part, and `getProvisionalStepContext` does not re-emit it. Extensions no longer read pre-cutoff history in `historyTransformer`.

**Restore.** The default session restores its window before extensions start, so `onStart` hooks see it. `SessionHistory.loadWindow('default')` returns the latest checkpoint header plus its raw tail. Without a checkpoint it returns the newest messages within `RESTORE_FALLBACK_MAX_BYTES` (2 MiB), starting at a user message and never cutting a message; the first compaction threshold hit then produces a checkpoint. The session seeds its recorder with the restored IDs, ords, and hashes, so nothing is written twice. Child and god sessions start empty.

## Episodic memory

The memory extension loads only in the default session and owns an optional retrieval child. Canonical content is written once by session persistence to the bounded `sessions.sqlite` store. `activity-history` queries retained default-session messages and applies the shared history-view projection. There is no episode writer, feed, file rotation or persisted grouping.

### Triggers

Learning and activity titles subscribe independently to committed-history hints and check idle readiness every 30 seconds. They reconstruct pending work from their own durable source cursor after restart. Live step activity suppresses idle processing; hints never block persistence. Retrieval failure does not disable either consumer.

### Episode lifecycle

Consumers form disposable runtime batches using the existing `extensions.memory.episodes` settings: rendered-character size, elapsed duration, inactivity and UTC-date boundaries. Defaults remain 50,000 characters, one hour and ten minutes. Character accounting now measures rendered view text, not serialized JSONL. Reads are capped at 200 source messages and two megabytes; batch boundaries can differ after restart. No completion flags, group identities or memberships are persisted.

### Canonical input

`activity-history/history-projection.ts` retains the existing fitted-record and line-format preset: actions, thoughts, outputs, incoming context and time. Raw user text, `recall` calls and memory results are omitted. Media becomes MIME-type placeholders; fields and messages are bounded with omission counts. Source handles contain a logical ordinal, writing instance and message ID. Missing, evicted or replaced sources are unavailable; oversized bodies are explicitly omitted rather than loaded unboundedly.

The retrieval observation cursor still follows live-window checkpoint lifecycle independently. Startup seeds it at the restored window end. Applying a checkpoint drains observations and moves a dropped cursor to the new header. Canonical checkpoint durability is unchanged; there is no writer flush or writer-specific checkpoint deferral.

### Retention and cutover

The existing session-history cap (512 MiB by default), eviction ordering and checkpoint protection remain unchanged. Once evidence is evicted, recall and investigations cannot recover it. Search is a disposable derived cache, not an archive. Original JSONL/Markdown archives remain untouched and inactive: no import, scan, read, write or fallback.

Application composition creates one borrowed activity-history interface over session history. Learning and titles own independent single-worker guards, subscriptions, timers and processing cursors. Legacy file cursors cut over to the newest canonical source without replay; obsolete failure/deferred file work is cleared. Existing skills, provenance and title rows survive; legacy provenance has no canonical evidence mapping.

### Retrieval

The memory extension also owns a second child session, `memory-retrieval`, created by the coordinator in `memory/retrieval/`. Its model is the `memory` purpose, falling back to `chat` when none is configured. Retrieval is optional: if the search index or the child fails to start, the extension keeps running, buffers recalls (bounded), and retries both with exponential backoff. The same happens when the child terminates later. Only an index written by a newer schema is permanent: retrieval then stays off, `recall` fails fast, and recalls already buffered get one explicit "memory is unavailable" answer.

- **Index**: `episodic-search.sqlite` remains a registered, rebuildable FTS/fuzzy cache. Schema 2 retires its old file-derived corpus and indexes the canonical filtered view. Reconciliation checks source identity, byte size and revisions; deletions remove indexed text and vocabulary. Search hits and context handles revalidate against bounded canonical reads before exposing evidence, so repairs/rollback/retention cannot return stale cache text. The current manifest comparison scans source metadata, never the full transcript bodies.
- **Inputs**: the main session sends explicit `recall` tool calls, and after every step `renderObservation` streams the history delta after a cursor. Observations contain only incoming data (user text, context, one-line tool-call summaries), and exclude memory results and `recall` calls so the child never observes its own output. A backlog drains oldest-first in budget-sized batches (a few per step); each message is clipped on its own, so no message between batches is skipped. The cursor only advances past batches the child accepted.
- **Tools**: the child searches with `searchMemory` (`auto`, `exact`, or `fuzzy` mode; fuzzy expands unknown terms by bounded edit distance), expands hits with `readMemoryContext` through opaque per-turn handles, and checks index state with `inspectMemory`. Search, read, and output budgets apply per child turn.
- **Background output**: the retrieval child's path back is `surfaceMemory`. Every text memory puts into the main session is wrapped in exactly one `<memory>` block; memory tags inside the content are defused. Each recall carries an id (`<recall id="r1">`); a surface answers a recall only when it cites an id that is still open (answer window), otherwise it is proactive. Recall answers arrive with `Default` urgency and bypass deduplication. Proactive memories are `Default` while a main turn is active and `Deferrable` otherwise, and are deduplicated by scope and text fingerprint. Recalls are limited per fingerprint per main-session task (latest user message).

## Skills

Skills are agent-wide and owned by core (`src/skills/`), not by any extension. `application.ts` creates one `SkillRegistry` per agent; extensions contribute skills to it and the skills extension shows them to sessions.

- **Namespaces**: every skill lives in one namespace, its explicit source. The qualified id is `namespace/name`; bare names may repeat across namespaces. Namespaces and names share the Agent Skills name syntax. `user` is reserved for user-managed skills and `templates` for template skills; extensions cannot claim either.
- **Storage**: each skill is `skills/{namespace}/{name}/SKILL.md` in the agent data directory, with only `name` and `description` in frontmatter and a markdown body. Skill folders are documents, not migration stores; the files are the source of truth. Bookkeeping lives in the registered JSON store `skills/registry.json` (v1): the activity clock and, per qualified id, ISO dates (`createdAt`, `updatedAt`, `lastReadAt`), turn positions (`createdTurn`, `updatedTurn`, `lastReadTurn`), `readCount`, `userEdited` and namespace-owned `metadata` (JSON object, at most `MAX_METADATA_BYTES`). Unknown fields are preserved. Bookkeeping write failures are logged, never fatal. A skill without a record shows fresh in-memory usage that is persisted only once the skill is read, edited or written, so a later seeded `put` still applies. Entries without a document are dropped on the next write.
- **Clock**: dates serve UIs; turns serve relevance. The skills extension advances the clock once per default-session turn with at least one successful step, so child sessions and failed turns do not age skills. The turn is persisted lazily and flushed on close.
- **Extension handle**: an extension factory declares `skillNamespace`. The extension handler claims it for that extension (claims are exclusive and fail for invalid or reserved namespaces) and passes a `SkillNamespaceHandle` as `deps.skills`. The handle lists, reads, writes, sets metadata for and deletes skills only in its own namespace. Writes are serialized. A `put` with identical content is not a change; a content change moves `updated*` and clears `userEdited`. `setMetadata` never touches content or `updated*`.
- **Bot-facing extension**: `io.stagewise/skills` (`extensions/skills/`) loads in the default session; child sessions get it only if their spawning extension lists it. Its system-prompt part lists `- namespace/name: description` under the intro `skills/system-prompt-part.md`, capped at `MAX_PROMPT_LIST_CHARACTERS`. Namespaces take turns, each most recently used first, so one large namespace cannot crowd out others. When descriptions do not fit, a tenth of the cap lists remaining ids only. `readSkill` takes a qualified id, returns the `SKILL.md` content and records the read. An unknown id returns the available ids, those with the same bare name first.
- **Admin API**: the registry backs `GET /v1/skills` (all namespaces, with `namespace`, `id`, dates, turns and `currentTurn`) and `GET`, `PATCH`, `DELETE /v1/skills/{namespace}/{name}`. Admin content changes set `userEdited`, which is informational and grants no protection. `PUT /v1/skills/templates` makes the core-owned `templates` namespace hold exactly the given skill set (Cloud pushes a bot's template on connect): it validates the whole set first, then creates new, rewrites changed and deletes missing skills. Unchanged skills keep their usage; rewritten ones clear `userEdited`. The legacy `/v1/skills/{name}` routes stay for older clients: they resolve the bare name and return 409 `ambiguous_skill_name` when several namespaces contain it.

## Learned skills

The learning extension (`io.stagewise/learning`) loads only in the default session. It turns ready runtime activity batches into Agent Skills in the `learning` skill namespace. One worker runs per agent. Showing skills to the main session is the skills extension's job.

- **Storage**: learned skills are registry documents under `skills/learning/`; per-skill source episode IDs live in the registry's namespace-owned `metadata.sourceEpisodes`. Learning bookkeeping lives in the registered JSON store `extensions/io.stagewise/learning/state.json`. Schema v2 holds the episode cursor, failure counts, weighted consolidation counters, retry positions and deferred references. Its per-skill `skills` map is legacy and stays empty after the import. The forward v1-to-v2 migration preserves historical and unknown fields and starts the activity counters at zero, without manufacturing activity from timestamps. Losing the learning state never breaks skills.
- **Legacy import**: before its worker starts, the default-session instance moves pre-registry folders from `extensions/io.stagewise/learning/skills/` into the `learning` namespace. Content is byte-identical. Dates, read count, `userEdited` and source episodes are seeded from the legacy state, and turn positions start at the current turn. It writes the skill and its registry bookkeeping durably first, then deletes the legacy folder, then prunes the state entry, so restarting after a crash repeats work without duplicates; seeds apply while a skill has no persisted bookkeeping. Unparsable folders and their state entries stay and are retried; the legacy root is removed once empty, and a missing root prunes any leftover state entries. If the import throws or any parseable skill fails to import, the session still starts, but learning stays paused until a later start imports cleanly, so legacy content cannot overwrite newer learned skills. Learning-state compatibility v3 protects imported data; v4 additionally protects canonical source-cursor semantics (see `local-data/architecture.md`).
- **Input**: the worker queries `ActivityHistory` and renders the canonical activity preset at read time. Fresh learning starts from the newest `INITIAL_BACKFILL_EPISODES` source messages; a legacy file cursor cuts over without replay. Short batches advance progress without a model call. Budget-omitted evidence is explicit; repeated read/start failures eventually skip with a warning. A settled child consumes its primary batch even without submission; owner shutdown before settlement leaves progress unchanged.
- **Extraction**: subscribe before immediate startup catch-up, then wake on committed-history hints and a 30-second idle check. The consumer cursor and retained canonical sources recover missed hints. Sequential passes process up to 120,000 primary characters, yield, and continue until caught up. There is no startup delay or three-batch throughput ceiling. Live main-step tracking prevents idle processing during an active step. Actual failures get finite retries after 30 seconds and two minutes, with a fresh budget after cursor progress; normal idle periods make no model calls. Whole-run infrastructure failures exhaust that budget, log a warning, then wait for another activity hint, idle check or restart. Close terminates active learning children and removes listeners and recovery timers. Children use `memory` models when configured, otherwise `chat`; normal chat-session retries and fallback apply. Cancellation prevents further submissions but does not roll back writes already committed by a tool. Extraction compares candidates with existing skills and may retire a skill only after verifying newer, same-scope contradictory evidence. Consolidation may update or delete existing skills, never create them.
- **Activity**: cursor advancement increments `processedEpisodeCount` exactly once per primary episode, including short and permanently skipped episodes. Pinning the initial newest-twenty window, investigation reads and deferred revisits do not advance it. This counter only schedules consolidation. Successfully persisted creates add two change points; materially different updates add one. No-op rewrites and consolidation writes add none. Relevance uses the registry's agent turns: the latest of creation, substantive update and main-session read determines staleness and LRU recency. Dates break LRU ties among skills active in the same turn, such as imports. Evidence-only updates go through `setMetadata` and preserve the skill's age. A skill is stale after `STALE_AFTER_TURNS` (300) agent turns without any of these activities, not after elapsed days.
- **Consolidation**: check after each primary episode. Run at twenty pending change points, when skill count first reaches twenty-five, after five further points while above that soft threshold, or for stale skills after ten episodes since the last successful pass. Successful empty responses record the activity position and count to prevent repeated soft-threshold calls. A settled pass without an accepted submission or an infrastructure failure retains weight and spaces the next attempt by ten processed episodes. More than thirty skills overrides spacing, and activity-based LRU eviction enforces the thirty-skill hard cap of the `learning` namespace even after generation failure. Other namespaces do not count toward it.
- **Investigation**: extraction and consolidation get `listActivityNeighbors`, `readActivity` and literal case-insensitive `searchActivities`. Lists show at most five neighbors on each side. Pages return at most 12,000 rendered characters. Search examines at most the newest 200 retained canonical messages and reports partial scans. Opaque handles are checked against canonical source identity. Each investigation shares eight calls, six additional exposed sources, 60,000 returned characters and two megabytes of canonical-body reads across parallel calls and native retries/fallback. Lists are not citation evidence; text pages and snippets are. The compatibility fields `evidenceEpisodes` and `metadata.sourceEpisodes` now carry exposed canonical handles. Historical file citations survive as unavailable provenance, never as evidence of current facts. Text is untrusted data, not instruction authority.
- **Execution and commits**: each investigation runs as an ordinary, tracked child chat session with a learning-specific system prompt and one extension exposing activity tools plus `submitLearnings`. It has no MCP environment or inherited parent extensions. Prompts guide investigation and submission; there is no learning-specific model-step ceiling, output cap or generation adapter. The child owns standard streamed generation, tool dispatch, retries, fallback and transcript/usage attribution. `submitLearnings` validates the batch and persists accepted operations during tool execution; it is the commit boundary. Repeated submissions return `already-submitted` without replaying writes, and later model failure cannot undo a committed batch. The worker waits for the child to settle and closes it in a `finally` path. Active and closing children gate parent quiescence. A settled extraction without submission still advances its primary cursor, avoiding replay of partially committed work. Only read/start infrastructure failures use episode-level retry accounting. Session-native retries can continue after tool execution; reader limits and submission idempotence protect durable state, but total model cost is not bounded by learning.
- **Deferred lessons**: a model may return an empty proposal with `deferred: true` when a future completed episode is needed to verify a fix. Store at most twenty primary references, continue ordinary cursor progress, and revisit only after newer progress. Each reference gets at most three completed revisits; read/start failures preserve eligibility and get the same bounded episode retry accounting. A settled revisit without submission is treated as no change and removes its reference. Unresolved entries are discarded after those revisits. This queue contains references, never raw transcript text.
- **Tuning**: what counts as a lesson and the output contract live in the labeled sections of `learning/extraction-prompt.md` and `learning/consolidation-prompt.md`. Numeric limits live in `learning/learning-config.ts`. Both are code, so changing them needs no config migration.
- **Main session and admin API**: learned skills appear through the skills extension and the registry routes described under [Skills](#skills). Learning does not see or rewrite skills of other namespaces. A content write by learning clears `userEdited` set by an admin change.
- **Known limits**: raw user text is not in episodes, so feedback typed directly into a local chat is not learned. Channel feedback arrives as incoming context and is learned. There is no sender-trust policy or approval step yet, so anyone who can reach a channel can teach the agent. This is **Temporary** and acceptable for in-house use only. Source episode IDs make a bad skill traceable. A canonical message body larger than the two-megabyte budget is omitted explicitly. Insufficient partial evidence retries and eventually skips with a warning rather than triggering an unbounded read. SQLite eviction makes old evidence permanently unavailable; generated skills and titles remain.

## Legacy removal: skill registry

Compatibility code for the move to the skill registry is tagged `LEGACY(skill-registry)`. Each tag says what to remove and when. Find every site with `rg 'LEGACY\(skill-registry\)'` in this repository and in Cloud. Klex 0.28.0 is the first stable release with the registry; nightlies have it since 2026-11-01. Remove in this order:

1. **Cloud fallbacks.** The admin proxy allow-list, the bare-name request path and the optional registry fields in Cloud's skill types serve bots older than Klex 0.28.0. Remove them once no connected bot runs an older version.
2. **Bare-name Admin API.** `GET`, `PATCH` and `DELETE /v1/skills/{name}`, the 409 `ambiguous_skill_name` response and the deprecated `origin` and `sourceEpisodes` fields. Keep `SkillRegistry.resolveName`; `readSkill` uses it for error hints. Remove them after step 1 has shipped, because Cloud still calls these routes for older bots. This is a breaking Admin API change; commit it with the `klex,agent-admin-api` scopes.
3. **Legacy import.** `learning/legacy-skill-import.ts`, its tests and fixtures, and the import step in `learning.ts`. Remove it once no supported upgrade starts below Klex 0.28.0. Data that skips the import loses its learned skills; it is not corrupted.
4. **Learning-state `skills` map.** Released in schema v2, so removing it needs schema v3 with a forward migration that drops it. Do it after step 3, following `.stagewise/skills/local-data-migrations/SKILL.md`. Keep the historical v1 and v2 schemas and fixtures unchanged. Compatibility v3 and its floor stay.

## Episode summaries

The episode-summary extension (`io.stagewise/episode-summary`) gives newly ready canonical `ActivityHistory` batches short, past-tense English titles for a UI-facing activity log. Like learning, it loads only in the default session, and one owner runs per agent. Batches are reconstructed from retained SQLite messages, never episode files or a durable grouping catalogue.

- **Storage**: the registered SQLite store `extensions/io.stagewise/episode-summary/summaries.sqlite` holds one row per processed batch (`titled` or `skipped`) plus its final canonical source cursor. The released `episodeId` field names remain unchanged. A row and its cursor advance commit in one transaction with `INSERT OR IGNORE`, so a crash or duplicate pass never produces two rows. Existing titles survive the canonical cutover. Store errors propagate; summaries are not rebuilt or quarantined.
- **Only new activity**: on first start, or when cutting over a legacy file cursor, the cursor pins to the newest retained source while canonical history is available. Retained history is not backfilled.
- **Readiness and skips**: each consumer calls `ActivityHistory.readPending` with its own cursor and current size, duration and idle limits. UTC-date boundaries and the 200-source cap also close batches. Active main-session steps suppress processing. Batches with fewer than two rendered records are stored as `skipped` without a model call.
- **Passes**: committed-history hints and a 30-second idle-readiness check wake the summarizer. Passes are single-flight; a hint during a pass schedules a rerun. Each batch makes one `generateText` call with a schema-constrained `{ title: string }` output and a 12,000-character input (head and tail kept). The system prompt comes from `episode-summary/summary-prompt.md`; activity text is untrusted data. The strict schema allows only a nonempty, single-line title of at most 10 words and 100 characters. There is no model-controlled skip variant.
- **Failures**: failed, invalid or truncated generation stops the pass and leaves the cursor unchanged; a later history hint or idle check retries. There is no failure-backoff timer. Close aborts the in-flight call without advancing the cursor.
- **Models**: `memory` selection, falling back to `chat` when empty. There is no dedicated toggle or config field.
- **Admin API**: `main.ts` creates an `EpisodeSummaryLog`, the extension attaches its store to it, and it backs `GET /v1/episode-summaries?limit=&cursor=`. Titled entries return newest first by `startedAt`, then `episodeId`; the cursor is the last item's `episodeId`. It returns 503 `not_running` while the extension is not attached. The log is pull-only and has no retention policy.

## Consult context and lifecycle

Consult receives the latest durable context-compaction summary plus the configurable newest non-summary message suffix from the parent (five ordinary messages by default), rendered in the line format through the shared transcript preset of `utils/history-view`; the child prompt appends `LINES_FORMAT_PROMPT`. The durable summary is selected independently and does not consume the ordinary-message quota. This is deliberately separate from the episodic recorder preset: memory records are optimized for durable storage and omit raw user text, while the consult needs recent conversation evidence for the current task. The consult has no MCP access and can only receive the task, parent updates, and lifecycle messages. The parent publishes active consult state as a custom `consults` data part so it remains available in the main session context. The first visible snapshot is a compact Markdown table inside `<consults mode="full">`; subsequent changes use one line per change inside `<consults mode="change">`. When a checkpoint drops the latest snapshot, `getCheckpointCarry` places it in the header as `mode="full"`. Reports are intermediate until the child explicitly marks one final; report-limit closure is surfaced as `termination="limit-reached"` rather than a verdict.

## History views

`utils/history-view` turns native history into compact model input for another model. It runs three stages:

1. **Filter**: scope (`all` or `after-cursor`) and projection into format-neutral records (text, reasoning, tool, context, summary, data) with per-field length limits and truncation styles.
2. **Render**: the line format. Records are separated by blank lines, external content lines start with `¦`, the agent's own records use `your_*` labels, messages and context records can be fitted to optional limits, and inline image/audio becomes segments. Readers need `LINES_FORMAT_PROMPT`.
3. **Budget**: `newest` keeps the latest summary plus the newest messages and marks truncation; `oldest` consumes messages in order and returns a resume cursor.

Consumers own their presets. The line-format transcript preset (`createTranscriptHistoryView`, `CONTEXT_SUMMARY_KEY`) serves context compaction without a limit and consult with a character and message budget. The canonical activity preset lives in `activity-history/history-projection.ts`.

## Transcript persistence

Each `ChatSession` instance gets a random `instanceId` when it is constructed. The `id` is not unique enough: the default session reuses `sessionId = "default"` each time the host replaces it. When composed with `session-history`, the session opens a `SessionHistoryRecorder` with its kind, name, `parentInstanceId` (for child sessions), and extension identifier.

The log is append-only and addressed by `message_id` plus a per-`session_id` monotonic `ord`. Rows of all default-session instances share `session_id = "default"`, so the log continues across restarts and host replacements. The in-memory window stays the source of truth for model input; the session reads the log back only to restore the default window at startup (see [Context window and checkpoints](#context-window-and-checkpoints)).

`scheduleTranscriptSync()` hands the recorder a getter and does not wait for the write. The recorder merges calls that arrive in quick succession and tracks the window by ID (`messageId → { ord, hash }`):

- A new ID is inserted with the next `ord`.
- A known ID whose content hash changed is updated in place. It compares content, not object identity, because history repair mutates older messages in place.
- An ID passed to `markTrimmed` (checkpoint apply) is forgotten; its row stays.
- Any other ID that disappears (provisional rollback) has its row deleted, so restore never resurrects rolled-back context.

Sync errors are logged and retried on the next sync. They never reach the run loop. Only `commitCheckpoint` throws, because the checkpoint manager must not trim memory after a failed header write.

Sync points are the moments when history is consistent:

- After each step commits its response (`flushPendingImmediate`). This runs even when no pending input exists.
- When immediate inbox input is appended while the session is idle. Deferrable events are buffered in the inbox until the next turn drains them, so they are persisted at that turn's post-step flush, not on arrival. The exception is a deferred event that is forwarded to an active lease: it is appended and synced at once.
- After history inserts from extensions.
- When a checkpoint is applied (the header write is awaited; see above).
- After a realtime lease commit.
- On termination. `close()` waits up to 5 seconds for an aborted turn to commit its last step (skipped when the loop itself terminates the session). Then the recorder does a final sync, retries it once if it failed, and records `endReason`. A store failure here is caught so that session cleanup still runs.

On startup, any instance that has no end marker is marked as ended with reason `unclean_shutdown`. The size cap and eviction rules belong to `session-history`, not to the session. Eviction never deletes the latest default-session checkpoint row or any default-session row after it, so the restorable window survives the cap.

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
