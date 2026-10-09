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

Coordinator: history repair → decision (can a step run?) → model fetch → history transformation (clone → extension pre-process → model-aware conversion → extension post-process) → delegate to GenerationRunner.

Generation operates on a `structuredClone` copy, so mid-turn appends are visible to the next step without corrupting the original. The original is only mutated in synchronous sequential code (turn-start drain, history repair, Continue/check injection, response push, immediate inbox appends).

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

**Episode feed.** Other extensions read episodes only through `EpisodeFeed` (`memory/episodes/episode-feed.ts`), never through memory's data directory. `main.ts` creates the feed with `createEpisodeFeed()`. The memory extension attaches its live `EpisodeStore` in `onStart` and detaches in `onClose`; until then the feed reports itself unavailable. `listCompleted` returns finished episodes ordered by date and numeric file index (the index is not zero-padded, so string order is wrong). An episode is finished when it is not the open episode, or when it is the open episode and has been idle for `idleTimeoutMs`, because the next append rotates it. After a restart every existing file is finished.

### Retrieval

The memory extension also owns a second child session, `memory-retrieval`, created by the coordinator in `memory/retrieval/`. Its model is the `memory` purpose, falling back to `chat` when none is configured. Unlike the writer, retrieval is optional: if the search index or the child fails to start, the extension keeps running, buffers recalls (bounded), and retries both with exponential backoff. The same happens when the child terminates later. Only an index written by a newer schema is permanent: retrieval then stays off, `recall` fails fast, and recalls already buffered get one explicit "memory is unavailable" answer.

- **Index**: `episodic-search.sqlite` in the extension data directory is a rebuildable FTS index over the JSONL episode files, registered as a local-data store. The episode files are the source of truth. The index reconciles against them before search; schema mismatches stop startup instead of rewriting the file.
- **Inputs**: the main session sends explicit `recall` tool calls, and after every step `renderObservation` streams the history delta after a cursor. Observations contain only incoming data (user text, context, one-line tool-call summaries), and exclude memory results and `recall` calls so the child never observes its own output. A backlog drains oldest-first in budget-sized batches (a few per step); each message is clipped on its own, so no message between batches is skipped. The cursor only advances past batches the child accepted.
- **Tools**: the child searches with `searchMemory` (`auto`, `exact`, or `fuzzy` mode; fuzzy expands unknown terms by bounded edit distance), expands hits with `readMemoryContext` through opaque per-turn handles, and checks index state with `inspectMemory`. Search, read, and output budgets apply per child turn.
- **Output**: the only path back is `surfaceMemory`. Every text memory puts into the main session is wrapped in exactly one `<memory>` block; memory tags inside the content are defused. Each recall carries an id (`<recall id="r1">`); a surface answers a recall only when it cites an id that is still open (answer window), otherwise it is proactive. Recall answers arrive with `Default` urgency and bypass deduplication. Proactive memories are `Default` while a main turn is active and `Deferrable` otherwise, and are deduplicated by scope and text fingerprint. Recalls are limited per fingerprint per main-session task (latest user message).

## Learned skills

The learning extension (`io.stagewise/learning`) loads only in the default session. It turns finished episodes into Agent Skills and shows them to the main session. One worker runs per agent.

- **Storage**: each skill is `{learningDataDir}/skills/{name}/SKILL.md`, with only `name` and `description` in frontmatter and a markdown body. Skill folders are documents, not migration stores. Bookkeeping lives in the registered JSON store `extensions/io.stagewise/learning/state.json`. Schema v2 holds the episode cursor, failure counts, per-skill timestamps and activity positions, read counts, source episode IDs, weighted consolidation counters, retry positions and deferred references. The forward v1-to-v2 migration preserves historical and unknown fields and starts the activity clock at zero, without manufacturing activity from timestamps. Losing it never breaks skills. Deleting the `skills/` folder wipes every learned skill.
- **Input**: the worker reads episodes only through the episode feed and renders them in line format. On the first run it starts from the newest `INITIAL_BACKFILL_EPISODES`. Short episodes are skipped and the cursor still advances. Tail reads scan from EOF. A truncated scan without enough complete records is an explicit episode failure, not a short-episode skip. Read exceptions also count against that episode. An episode with repeated read/start infrastructure failures is skipped with a warning after `MAX_FAILURES_PER_EPISODE`. Once a delivered child settles, its primary episode is consumed even without a submission; owner shutdown before settlement leaves the cursor unchanged.
- **Extraction**: subscribe before immediate startup catch-up, then wake on feed attachment or completed episodes. Notifications are hints; the persisted cursor and ordered feed are the durable queue. Sequential passes process up to 120,000 primary characters, yield, and continue until caught up. There is no startup delay, polling interval, or three-episode throughput ceiling. Memory's existing 30-second flush detects idle closure, never during an active main step. Actual failures get finite retries after 30 seconds and two minutes, with a fresh budget after cursor progress; normal idle periods make no model calls. Whole-run infrastructure failures exhaust that budget, log a warning, then wait for another feed event or restart. Close terminates active learning children and removes listeners and recovery timers. Children use `memory` models when configured, otherwise `chat`; normal chat-session retries and fallback apply. Cancellation prevents further submissions but does not roll back writes already committed by a tool. Extraction compares candidates with existing skills and may retire a skill only after verifying newer, same-scope contradictory evidence. Consolidation may update or delete existing skills, never create them.
- **Activity**: cursor advancement increments `processedEpisodeCount` exactly once per primary episode, including short and permanently skipped episodes. Pinning the initial newest-twenty window, investigation reads and deferred revisits do not advance it. Successfully persisted creates add two change points; materially different updates add one. No-op rewrites and consolidation writes add none. Creation, substantive update and main-session read positions determine staleness and LRU recency. Timestamps order the main-session list and break LRU ties for migrated skills still at activity position zero. Evidence-only updates preserve the skill's age. A skill is stale after 100 advanced episodes without any of these activities, not after elapsed days.
- **Consolidation**: check after each primary episode. Run at twenty pending change points, when skill count first reaches twenty-five, after five further points while above that soft threshold, or for stale skills after ten episodes since the last successful pass. Successful empty responses record the activity position and count to prevent repeated soft-threshold calls. A settled pass without an accepted submission or an infrastructure failure retains weight and spaces the next attempt by ten processed episodes. More than thirty skills overrides spacing, and activity-based LRU eviction enforces the thirty-skill hard cap even after generation failure.
- **Investigation**: extraction and consolidation get only `listEpisodeNeighbors`, `readEpisode` and literal case-insensitive `searchEpisodes`. Lists show at most five neighbours on each side. Pages return at most 12,000 rendered characters. Search covers at most the newest 200 completed episodes and reports partial scans. IDs are opaque, active episodes are excluded, and bounded readers reject symlinks and path escapes. Each investigation shares eight tool calls, six additional exposed episodes, 60,000 returned characters and two megabytes of file scanning across parallel calls and the child's native retries/fallback. Lists do not count as citation evidence; text pages and search snippets do. Proposals may cite only exposed evidence, plus the primary extraction episode. Existing and merged sources are preserved with a newest-twenty cap. Retrieved text is untrusted data, not instruction authority; these limits do not establish sender trust.
- **Execution and commits**: each investigation runs as an ordinary, tracked child chat session with a learning-specific system prompt and one extension exposing episode tools plus `submitLearnings`. It has no MCP environment or inherited parent extensions. Prompts guide investigation and submission; there is no learning-specific model-step ceiling, output cap or generation adapter. The child owns standard streamed generation, tool dispatch, retries, fallback and transcript/usage attribution. `submitLearnings` validates the batch and persists accepted operations during tool execution; it is the commit boundary. Repeated submissions return `already-submitted` without replaying writes, and later model failure cannot undo a committed batch. The worker waits for the child to settle and closes it in a `finally` path. Active and closing children gate parent quiescence. A settled extraction without submission still advances its primary cursor, avoiding replay of partially committed work. Only read/start infrastructure failures use episode-level retry accounting. Session-native retries can continue after tool execution; reader limits and submission idempotence protect durable state, but total model cost is not bounded by learning.
- **Deferred lessons**: a model may return an empty proposal with `deferred: true` when a future completed episode is needed to verify a fix. Store at most twenty primary references, continue ordinary cursor progress, and revisit only after newer progress. Each reference gets at most three completed revisits; read/start failures preserve eligibility and get the same bounded episode retry accounting. A settled revisit without submission is treated as no change and removes its reference. Unresolved entries are discarded after those revisits. This queue contains references, never raw transcript text.
- **Tuning**: what counts as a lesson and the output contract live in the labeled sections of `learning/extraction-prompt.md` and `learning/consolidation-prompt.md`. Numeric limits live in `learning/learning-config.ts`. Both are code, so changing them needs no config migration.
- **Main session**: the system prompt lists skill names and descriptions from an in-memory cache, most recently used first and capped at `MAX_PROMPT_LIST_CHARACTERS`. The intro text is `learning/system-prompt-part.md`. The `readSkill` tool returns a skill body and records the read.
- **Admin API**: `main.ts` creates a `SkillCatalog`, the learning extension attaches its store to it, and the catalog backs `GET /v1/skills` and `GET /v1/skills/{name}`. Both return 503 `not_running` while learning is not attached.
- **Known limits**: raw user text is not in episodes, so feedback typed directly into a local chat is not learned. Channel feedback arrives as incoming context and is learned. There is no sender-trust policy or approval step yet, so anyone who can reach a channel can teach the agent. This is **Temporary** and acceptable for in-house use only. Source episode IDs make a bad skill traceable. A single JSONL record larger than the two-megabyte scan budget cannot be parsed by the bounded reader. If the tail has insufficient complete evidence, learning retries and eventually skips that episode with a warning rather than reading it unboundedly.

## Consult context and lifecycle

Consult receives the latest durable context-compaction summary plus the configurable newest non-summary message suffix from the parent (five ordinary messages by default), rendered in the line format through the shared transcript preset of `utils/history-view`; the child prompt appends `LINES_FORMAT_PROMPT`. The durable summary is selected independently and does not consume the ordinary-message quota. This is deliberately separate from the episodic recorder preset: memory records are optimized for durable storage and omit raw user text, while the consult needs recent conversation evidence for the current task. The consult has no MCP access and can only receive the task, parent updates, and lifecycle messages. The parent publishes active consult state as a custom `consults` data part so it remains available in the main session context. The first visible snapshot is a compact Markdown table inside `<consults mode="full">`; subsequent changes use one line per change inside `<consults mode="change">`. After compaction, the history transformer reinjects the last known full snapshot. Reports are intermediate until the child explicitly marks one final; report-limit closure is surfaced as `termination="limit-reached"` rather than a verdict.

## History views

`utils/history-view` turns native history into compact model input for another model. It runs three stages:

1. **Filter**: scope (`all` or `after-cursor`) and projection into format-neutral records (text, reasoning, tool, context, summary, data) with per-field length limits and truncation styles.
2. **Render**: the line format. Records are separated by blank lines, external content lines start with `¦`, the agent's own records use `your_*` labels, messages and context records can be fitted to optional limits, and inline image/audio becomes segments. Readers need `LINES_FORMAT_PROMPT`.
3. **Budget**: `newest` keeps the latest summary plus the newest messages and marks truncation; `oldest` consumes messages in order and returns a resume cursor.

Consumers own their presets. The line-format transcript preset (`createTranscriptHistoryView`, `CONTEXT_SUMMARY_KEY`) serves context compaction without a limit and consult with a character and message budget. The episodic recorder preset lives in `memory/history-compression.ts`.

## Transcript persistence

Each `ChatSession` instance gets a random `instanceId` when it is constructed. The `id` is not unique enough: the default session reuses `sessionId = "default"` each time the host replaces it. When composed with `session-history`, the session opens a `SessionHistoryRecorder` with its kind, name, `parentInstanceId` (for child sessions), and extension identifier.

Persistence is write-only from the session's point of view. The session never reads its transcript back, and the in-memory `messages` array stays the source of truth for model input. `scheduleTranscriptSync()` hands the recorder a getter and does not wait for the write. The recorder merges calls that arrive in quick succession, compares each message's content hash with the stored row, and writes only messages that changed. It compares content, not object identity, because history repair mutates older messages in place. Sync errors are logged and retried on the next sync. They never reach the run loop.

Sync points are the moments when history is consistent:

- After each step commits its response (`flushPendingImmediate`). This runs even when no pending input exists.
- When immediate inbox input is appended while the session is idle. Deferrable events are buffered in the inbox until the next turn drains them, so they are persisted at that turn's post-step flush, not on arrival. The exception is a deferred event that is forwarded to an active lease: it is appended and synced at once.
- After history inserts from extensions, such as compaction summaries.
- After a realtime lease commit.
- On termination. `close()` waits up to 5 seconds for an aborted turn to commit its last step (skipped when the loop itself terminates the session). Then the recorder does a final sync, retries it once if it failed, and records `endReason`. A store failure here is caught so that session cleanup still runs.

On startup, any instance that has no end marker is marked as ended with reason `unclean_shutdown`. The size cap and eviction rules belong to `session-history`, not to the session.

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
