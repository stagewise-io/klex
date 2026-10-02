import type {
  FilePart,
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  TextPart,
  ToolSet,
} from 'ai';
import type z from 'zod';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type {
  Config,
  ModelId,
  ModelInputCapabilities,
  ModelSelectionEntry,
} from '@/config';
import type { Mcp } from '@/mcp';
import type { ProviderModelResolver } from '@/provider-registry';
import type {
  ChildSessionHandle,
  ChildSessionOptions,
  SessionContext,
} from '@/session/types';

import type { ChatSessionInbox } from '../inbox';
import type { ExtendedUIMessage } from '../message-types';

// ---------------------------------------------------------------------------
// Extension data part helpers
//
// Extensions define their own data part types locally — there is no central
// registry. These helpers provide compile-time safety for creating,
// identifying, and transforming extension-defined data parts without
// adding them to `CustomUIDataParts` in `message-types.ts`.
// ---------------------------------------------------------------------------

/**
 * Creates a type-safe `data-{type}` UI part for an extension-defined data
 * part type. The runtime shape is `{ type: 'data-{KEY}', data: DATA }`,
 * which the AI SDK recognises as a `DataUIPart`. Since the part type is
 * not in the central `CustomUIDataParts` map, a cast through `never` is
 * needed to satisfy `ExtendedUIMessage['parts'][number]`.
 *
 * @example
 * type SummaryPart = { summary: string };
 * const summaryMsg = createDataPart('context-summary', { summary: '...' });
 */
export function createDataPart<KEY extends string, DATA>(
  key: KEY,
  data: DATA,
): { type: `data-${KEY}`; data: DATA } {
  return { type: `data-${key}`, data } as { type: `data-${KEY}`; data: DATA };
}

/**
 * A type guard that narrows a message part to an extension-defined data
 * part. Use in `historyTransformer` or `onStepComplete` to inspect parts
 * by their `data-{key}` type string.
 *
 * @example
 * if (isDataPartOf('context-summary', part)) {
 *   part.data.summary  // string, type-safe
 * }
 */
export function isDataPartOf<KEY extends string, DATA>(
  key: KEY,
  part: { type: string },
): part is { type: `data-${KEY}`; data: DATA } {
  return part.type === `data-${key}`;
}

/**
 * A typed data-part transformer. Extensions use this instead of bare
 * functions to get compile-time safety on the input shape.
 *
 * The second parameter is the zero-based occurrence index of this
 * data-part type within the current conversion pass (resets every step).
 * Extensions that don't need it can omit the parameter.
 *
 * @example
 * const summaryTransformer = dataPartTransformer<SummaryPart>(
 *   (data) => [{ type: 'text', text: `<summary>${data.summary}</summary>` }],
 * );
 */
export function dataPartTransformer<DATA>(
  fn: (data: DATA, occurrence: number) => (TextPart | FilePart)[],
): (data: unknown, occurrence?: number) => (TextPart | FilePart)[] {
  return (data: unknown, occurrence?: number) =>
    fn(data as DATA, occurrence ?? 0);
}

/**
 * A runtime data-part transformer. Each extension provides a record of
 * these keyed by their part type string. The handler merges them across
 * extensions and the converter dispatches by the `data-{key}` prefix.
 *
 * Keys are arbitrary strings — there is no central type map. Extensions
 * use `dataPartTransformer<T>()` to get type safety on the data shape.
 */
export type RuntimeDataPartTransformer = (
  data: unknown,
  occurrence?: number,
) => (TextPart | FilePart)[];

/**
 * Maps data part type keys to their transformers. Keys are arbitrary
 * strings (e.g. `'context-summary'`) — not limited to `CustomUIDataParts`.
 */
export type DataPartTransformers = Record<string, RuntimeDataPartTransformer>;

/**
 * Flags that an extension can set when transforming history, describing
 * what the transformation did. Merged across all extensions via OR semantics.
 */
export interface TransformationFlags {
  /** The history was compacted (e.g. summaries replaced older messages). */
  hasCompacted?: boolean;
}

/**
 * The result of a history transformation hook. Extensions can return either
 * the transformed history directly (shorthand) or an object containing the
 * history plus flags describing what the transformation did.
 */
export type HistoryProcessingResult =
  | ExtendedUIMessage[]
  | { history: ExtendedUIMessage[]; flags: TransformationFlags };

export type ContextProcessingResult =
  | ModelMessage[]
  | { history: ModelMessage[]; flags: TransformationFlags };

/**
 * Context prepared just in time for one imminent model-generation attempt.
 * It is provisional because returning it does not itself persist anything:
 * the step owns the synthetic message and decides whether to commit or roll it
 * back after the attempt.
 */
export interface ProvisionalStepContext {
  /**
   * Parts to expose to the imminent generation. Core combines parts from all
   * providers into one synthetic user message in canonical history before
   * cloning history for inference. It keeps that message only when generation
   * returns without generation failure, model fallback, or a fatal error.
   * Otherwise, including when later preparation or generation throws, core
   * removes the message by its generated ID. Returning an empty array does not
   * create or mutate a message.
   */
  parts: ExtendedUIMessage['parts'];
}

// ---------------------------------------------------------------------------
// Resolved model metadata
// ---------------------------------------------------------------------------

/**
 * Lightweight model metadata passed to extension transformers so they can
 * make model-aware decisions during history/context transformation.
 *
 * Contains only what extensions need — no provider credentials or endpoint
 * details are exposed.
 */
export interface ResolvedModel {
  /** Selected provider/model, for model-aware tools. Absent for realtime leases. */
  reference?: ModelSelectionEntry;
  /** Full model ID (e.g. `"remote:gpt-4o"`). */
  modelId: ModelId;
  /** Human-readable name from `knownModels`, if declared. */
  displayName?: string;
  /** Resolved context size in tokens (defaults to `DEFAULT_CONTEXT_SIZE`). */
  contextSize: number;
  /** Native input formats accepted by the selected model. */
  inputCapabilities: ModelInputCapabilities;
}

// ---------------------------------------------------------------------------
// Extension generation API
// ---------------------------------------------------------------------------

/**
 * Arguments for {@link ExtensionDeps.generateText}.
 *
 * Either `prompt` (single-turn) or `messages` (multi-turn) must be provided.
 * Both are passed through to the AI SDK's `generateText`.
 */
export interface GenerateTextArgs {
  /** Ordered list of model selection entries to try. First success wins. */
  modelIds: readonly ModelSelectionEntry[];
  /** System prompt. */
  system?: string;
  /** User prompt for single-turn generation. */
  prompt?: string;
  /** Multi-turn message history. */
  messages?: ModelMessage[];
  /** Tools available to the model during generation. */
  tools?: ToolSet;
  /** Sampling temperature (provider-specific range, typically 0–2). */
  temperature?: number;
  /** Maximum number of tokens to generate. */
  maxOutputTokens?: number;
  /** Max retries per model (default 0 — the fallback list handles retries). */
  maxRetries?: number;
  /**
   * Cancels the in-flight call and stops the fallback loop. The result is
   * then a failure with reason `aborted`.
   */
  abortSignal?: AbortSignal;
  /**
   * Requests structured output validated against this schema (AI SDK
   * `Output.object`). The parsed value is returned as `output`. A model
   * whose output does not match counts as failed and the next model is
   * tried.
   */
  outputSchema?: z.ZodType;
}

/**
 * Successful generation result.
 */
export interface GenerateTextSuccess {
  /** The generated text. */
  text: string;
  /** The model ID that produced the output. */
  modelId: string;
  /** Token usage from the successful generation, including cache details. */
  usage: LanguageModelUsage;
  /** Validated structured output; set only when `outputSchema` was given. */
  output?: unknown;
}

/**
 * Structured failure reason — a literal so extensions can compare
 * without parsing free-form strings. Mirrors the AI SDK's `FinishReason`
 * approach of small enumerable values.
 */
export type GenerateTextFailureReason =
  /** No model IDs were provided. */
  | 'no-models'
  /** Every model in the fallback list threw an error. */
  | 'all-models-failed'
  /** The model returned a content-filter finish reason. */
  | 'content-filter'
  /** The caller's `abortSignal` fired. */
  | 'aborted'
  /** Catch-all for unexpected failures. */
  | 'other';

/**
 * Failed generation result — all models in the fallback list failed.
 */
export interface GenerateTextFailure {
  /** Structured reason for the failure — comparable as a literal. */
  failureReason: GenerateTextFailureReason;
  /** Human-readable details (per-model error messages). */
  failureDetails?: string;
  /**
   * Raw text of the last model whose structured output failed validation,
   * so callers can salvage valid parts. Only set with `outputSchema`.
   */
  unparsedOutputText?: string;
  /** Model that produced {@link unparsedOutputText}. */
  unparsedOutputModelId?: string;
}

/**
 * Discriminated union result of {@link ExtensionDeps.generateText}.
 */
export type GenerateTextResult =
  | ({ success: true } & GenerateTextSuccess)
  | ({ success: false } & GenerateTextFailure);

// ---------------------------------------------------------------------------
// Step event types
// ---------------------------------------------------------------------------

/**
 * Information about a single tool call that was dispatched during a step.
 * Extracted from the assistant message's tool UI parts after all tool
 * executions have settled.
 */
export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  input: unknown;
  state: 'output-available' | 'output-error' | 'output-denied';
  /** Present when `state` is `'output-available'`. */
  output?: unknown;
  /** Present when `state` is `'output-error'`. */
  errorText?: string;
}

/**
 * Metadata about the model generation that occurred during a step.
 * `null` when no generation happened (skipped step, fatal error, or
 * all generation attempts exhausted without usable output).
 */
export interface GenerationInfo {
  /** The model ID that produced the output. */
  modelId: string;
  /** The finish reason reported by the model. */
  finishReason: FinishReason;
  /** Full token usage from the provider, including cache/reasoning details. */
  usage: LanguageModelUsage;
}

/**
 * A comprehensive event describing everything that happened during a step.
 *
 * Extensions receive a structured clone of this object in
 * {@link Extension.onStepComplete}. The event is guaranteed to fire on
 * every step completion — whether the step was skipped, produced a
 * successful generation, salvaged partial output, or failed.
 */
export interface StepCompleteEvent {
  /** True if the turn should run another step after this one. */
  shouldContinue: boolean;
  /** True if the turn must inject a "Continue." message before the next step. */
  forceNextStep: boolean;
  /**
   * True if the step failed with a fatal (non-recoverable) error, e.g.
   * an invalid prompt or a failed transformer extension. The session
   * should be terminated rather than retried.
   */
  fatalError: boolean;
  /** Human-readable reason for the fatal error, if fatalError is true. */
  fatalErrorReason: string | null;
  /**
   * True if generation was attempted but all retries were exhausted
   * without producing any usable output.
   */
  generationFailed: boolean;
  /**
   * Generation metadata — null when no generation happened (skipped step,
   * fatal error, or all attempts exhausted).
   */
  generation: GenerationInfo | null;
  /** Tool calls dispatched and settled during this step — empty when no generation. */
  toolCalls: ToolCallInfo[];
  /**
   * True when the generation runner detected a model error (no content)
   * and advanced the fallback manager. The turn should create a new step
   * that re-fetches the model and re-runs the transformation pipeline,
   * since transformations are bound to specific model capabilities.
   */
  modelFallbackOccurred: boolean;
  /**
   * True when the provider rejected the request (4xx other than 401,
   * 403, 408, and 429), including rejections after partial content was
   * salvaged. No model fallback was performed. Extensions may drop
   * request content they injected so the next step can succeed.
   */
  requestRejected: boolean;
  /**
   * Summary of the step's instinct phase. Absent when instinct did not
   * run (skipped step, no participating extension, or instinct disabled).
   */
  instinct?: InstinctSummary;
  /**
   * True when cancellation interrupted instinct or subsequent preparation
   * before generation. Such an attempt is not a successful generation.
   */
  instinctAborted?: boolean;
}

// ---------------------------------------------------------------------------
// Step instinct & shared classification
// See ../architecture.md#instinct-subsystem for the lifecycle and an example.
// ---------------------------------------------------------------------------

/**
 * ID-set delta since this session's last committed instinct. Detects inserts
 * anywhere in history, not edits to existing IDs. Interrupted runs preserve
 * the baseline for retry; committed instinct parts appear in the next delta.
 */
export interface InstinctHistoryDelta {
  /** Messages whose IDs were not in the previous instinct snapshot, in history order. */
  readonly added: readonly ExtendedUIMessage[];
  /** IDs present in the previous snapshot but gone now (compaction, rollback). */
  readonly removedIds: readonly string[];
  /** True on the first instinct of the session: `added` is then the full history. */
  readonly initial: boolean;
}

/**
 * Input for both instinct hooks. Built once per step; every extension
 * receives its own structured clone.
 */
export interface InstinctInput {
  /** Snapshot of canonical history at the start of instinct. */
  readonly history: readonly ExtendedUIMessage[];
  readonly delta: InstinctHistoryDelta;
}

/**
 * Fixed-vocabulary answer descriptor; free-form model text is not accepted.
 */
export type InstinctClassificationKey =
  | { readonly type: 'boolean'; readonly description: string }
  | {
      readonly type: 'enum';
      readonly values: readonly [string, ...string[]];
      readonly description: string;
    };

export type InstinctClassificationKeys = Readonly<
  Record<string, InstinctClassificationKey>
>;

/**
 * Valid requests share one inference using `modelSelection.classifier`.
 * No valid requests means no call; an empty model list yields `unavailable`
 * rather than chat fallback. Core supplies bounded conversation history.
 */
export interface InstinctClassificationRequest<
  K extends InstinctClassificationKeys = InstinctClassificationKeys,
> {
  /**
   * Trusted, extension-authored instructions (1–4,000 characters).
   * Must not contain conversation data or changing state.
   */
  readonly prompt: string;
  /**
   * 1..16 keys. Key names must match `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`. Core
   * namespaces them under the extension identifier; all keys are required
   * in the answer. Enum keys allow up to 32 unique values of 1..64 characters.
   * Descriptions are non-empty and bounded to 500 characters.
   */
  readonly keys: K;
  /**
   * Current extension state, framed as external data and capped by
   * `instinct.contextCharacterCap`. Used only for this call, never stored
   * in canonical history.
   */
  readonly context?: string;
}

/** Maps key descriptors to answer types: boolean → boolean, enum → union of its values. */
export type InstinctClassificationAnswers<
  K extends InstinctClassificationKeys,
> = {
  -readonly [P in keyof K]: K[P] extends {
    type: 'enum';
    values: readonly (infer V)[];
  }
    ? V
    : boolean;
};

/**
 * The classification outcome one extension receives. `answers` holds only
 * that extension's own validated slice. Other slices can succeed even if
 * this one fails validation. `unavailable` means no usable configured model;
 * `failed` includes provider errors and invalid answers. Extensions decide
 * whether to skip preparation or use a conservative fallback on non-ok results.
 */
export type InstinctClassificationOutcome =
  | {
      readonly status: 'ok';
      readonly answers: Readonly<Record<string, boolean | string>>;
      readonly modelId: string;
    }
  | {
      readonly status: 'unavailable' | 'failed' | 'timeout' | 'aborted';
      readonly reason?: string;
    };

/**
 * Transactional staging for step context. Operations are buffered per
 * extension and applied by core in one synchronous commit after all
 * reactions settle. Each buffer seals immediately when its own reaction
 * settles; later writes throw even while another reaction is still running.
 * Rejected/timed-out reactions lose their entire buffer. Step cancellation
 * drops every buffer. This transaction covers staged context only, not an
 * extension's own state changes or external side effects.
 */
export interface InstinctPreparation {
  /**
   * Committed to canonical history at instinct commit as one message per
   * extension, in factory order. Survives generation failure. Only
   * extension-owned `data-*` parts with a registered `dataPartTransformer`
   * are allowed, so compaction, observation and writers can recognise them.
   */
  appendPersistent(parts: ExtendedUIMessage['parts']): void;
  /**
   * Merged into the step's provisional context message; kept only when
   * generation succeeds without fallback (same rules as
   * {@link Extension.getProvisionalStepContext}).
   */
  appendProvisional(parts: ExtendedUIMessage['parts']): void;
  /** Visible to this step's inference clone only; never enters canonical history. */
  appendEphemeral(parts: ExtendedUIMessage['parts']): void;
}

export interface InstinctContext extends InstinctInput {
  /** `null` when this extension supplied no valid classification request this step. */
  readonly classification: InstinctClassificationOutcome | null;
  /** Aborts on critical inbox input, lease quiesce, session close, or the deadline. */
  readonly signal: AbortSignal;
  /**
   * Shared instinct deadline in epoch milliseconds, including time already
   * spent classifying. Work still pending at this deadline loses its buffer;
   * preparations from reactions that already completed successfully are kept.
   */
  readonly deadline: number;
  /** Stage this step's context; do not write to the history snapshot or detach writers. */
  readonly prepare: InstinctPreparation;
}

export type InstinctReactionStatus = 'ok' | 'timeout' | 'failed' | 'aborted';

export interface InstinctSummary {
  readonly durationMs: number;
  /** `skipped` when no extension requested classification (no model call). */
  readonly classifierStatus:
    | InstinctClassificationOutcome['status']
    | 'skipped';
  readonly reactions: readonly {
    readonly extensionIdentifier: string;
    readonly status: InstinctReactionStatus;
    readonly persistentPartCount: number;
    readonly provisionalPartCount: number;
    readonly ephemeralPartCount: number;
  }[];
}

/**
 * Preserves literal key types for {@link readInstinctClassification}.
 * Does not validate or freeze the request; core validates each returned request.
 */
export function defineInstinctClassification<
  const K extends InstinctClassificationKeys,
>(request: InstinctClassificationRequest<K>): InstinctClassificationRequest<K> {
  return request;
}

/**
 * Reads this extension's answers with types derived from the request.
 * Returns `null` unless the outcome is `ok`. Pass the same key descriptors
 * returned for this step; the request is a type witness, not a runtime lookup
 * or validator. Core has already validated the extension's answer slice.
 */
export function readInstinctClassification<
  K extends InstinctClassificationKeys,
>(
  ctx: Pick<InstinctContext, 'classification'>,
  _request: InstinctClassificationRequest<K>,
): InstinctClassificationAnswers<K> | null {
  if (ctx.classification?.status !== 'ok') return null;
  return ctx.classification.answers as InstinctClassificationAnswers<K>;
}

export interface Extension {
  /**
   * Called once when the session starts, before the first step.
   * Extensions use this to initialize owned resources (e.g. starting
   * a worker, opening a connection).
   *
   * Hooks are called sequentially in factory order. If a hook throws,
   * startup aborts immediately and the error propagates to the caller.
   */
  onStart?: () => Promise<void>;

  /**
   * Called once when the session closes, after the last step completes.
   * Extensions use this to release owned resources (e.g. stopping a
   * worker, closing a connection).
   *
   * Hooks are called sequentially in reverse factory order (LIFO).
   * Errors are caught and logged per-extension — cleanup is best-effort
   * and one extension's failure does not prevent others from closing.
   */
  onClose?: () => Promise<void>;

  /**
   * Returns the tools this extension provides to the LLM for the given
   * model.
   *
   * Called once per step, after the model has been resolved, so that
   * extensions can make model-aware decisions about which tools to
   * expose. The returned `ToolSet` is merged with tools from all other
   * extensions and passed to the generation runner. Tool names must be
   * unique across all extensions — a duplicate throws at collection
   * time.
   *
   * The {@link ResolvedModel} parameter gives extensions access to the
   * active model's ID, context size, and input capabilities. Extensions
   * that always expose the same tools can ignore the parameter.
   */
  getTools?: (model: ResolvedModel) => ToolSet;

  /**
   * Returns a string that this extension contributes to the system
   * prompt. Called once per step, at the beginning of the step, for
   * every extension that defines the method. Parts are collected in
   * factory order and appended to the base system prompt (separated by
   * blank lines) before generation.
   *
   * Extensions that don't need to inject system prompt content can
   * omit this method.
   */
  getSystemPromptPart?: () => string;

  /**
   * Awaited in parallel before history repair and the step decision.
   * Lifecycle notification only; use context hooks to affect inference.
   * Errors are logged per extension without breaking the step.
   */
  onStepStart?: () => void | Promise<void>;

  /**
   * Synchronously requests classification for an executable step, or returns
   * `null` to opt out. Must be cheap: no I/O or model calls. Throws and
   * invalid requests are treated as `null`. See {@link InstinctClassificationRequest}
   * for prompt/state separation and limits.
   */
  getInstinctClassificationRequest?: (
    input: InstinctInput,
  ) => InstinctClassificationRequest | null;

  /**
   * Runs in parallel whether or not this extension requested classification.
   * Main generation waits for reactions within the remaining shared
   * `instinct.timeoutMs` budget after classification.
   *
   * Pass `ctx.signal` to I/O; avoid blocking the event loop. Stage context
   * through `ctx.prepare` and await all writes before returning. See
   * {@link InstinctPreparation} for sealing, rollback and retention rules.
   * Core stops waiting on cancellation but cannot undo external side effects.
   * Background results must use normal inbox delivery with their own
   * cancellation and deduplication policy.
   */
  onInstinct?: (ctx: InstinctContext) => void | Promise<void>;

  /**
   * Produces context just in time for one imminent model-generation attempt.
   * Called after the step is known to be executable and its model is resolved,
   * but before canonical history is copied for inference.
   *
   * Each provider receives an isolated clone of the same canonical history.
   * Providers run sequentially in factory order, and core combines all returned
   * parts into one synthetic user message. A provider failure aborts collection
   * before that message is appended, so canonical history is not partially
   * mutated.
   *
   * The message is provisional, not immediately persistent. The step appends it
   * before history transformation and conversion so the imminent generation can
   * consume it. Afterward, the step commits it by leaving it in canonical
   * history only when generation returns without generation failure, model
   * fallback, or a fatal error. On those outcomes, or if later preparation or
   * generation throws, the step rolls it back by its generated message ID.
   * Returning no parts causes no history mutation.
   */
  getProvisionalStepContext?: (
    history: readonly ExtendedUIMessage[],
    model: ResolvedModel,
  ) => ProvisionalStepContext | Promise<ProvisionalStepContext>;

  /**
   * Transforms the UI message history before it is converted to model
   * messages. Extensions are called in order; each receives the output
   * of the previous one. Flags from all extensions are merged (OR
   * semantics).
   *
   * If a transformer throws, the error is caught, logged with the
   * extension identifier, and re-thrown — the step aborts immediately
   * and no subsequent transformers run.
   */
  historyTransformer?: (
    history: ExtendedUIMessage[],
    model: ResolvedModel,
  ) => HistoryProcessingResult | Promise<HistoryProcessingResult>;

  /**
   * Transforms the model messages after conversion from UI messages.
   * Extensions are called in order; each receives the output of the
   * previous one. Flags from all extensions are merged (OR semantics).
   *
   * If a transformer throws, the error is caught, logged with the
   * extension identifier, and re-thrown — the step aborts immediately
   * and no subsequent transformers run.
   */
  contextTransformer?: (
    history: ModelMessage[],
    model: ResolvedModel,
  ) => ContextProcessingResult | Promise<ContextProcessingResult>;

  /**
   * Called after each step completes — whether the step was skipped,
   * produced a successful generation, salvaged partial output, or
   * failed. Receives a structured clone of the full
   * {@link StepCompleteEvent}.
   *
   * This is a fire-and-observe lifecycle notification — it cannot
   * influence control flow. All extensions' hooks are called in
   * parallel via `Promise.allSettled`. The step waits for all hooks
   * to settle before returning. Errors from individual hooks are
   * caught and logged — one extension's hook failure does not break
   * the step.
   */
  onStepComplete?: (event: StepCompleteEvent) => void | Promise<void>;

  dataPartTransformers?: DataPartTransformers;

  /**
   * Optionally return a JSON-serializable state object describing the
   * extension's current internal state. Exposed via the admin API at
   * `GET /v1/introspect/sessions/:sessionId/extensions/:extensionId`.
   *
   * If not implemented, the introspection endpoint returns `null` for
   * this extension's node.
   */
  introspect?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface ExtensionDeps {
  /**
   * @returns A copy of the current history inside the session.
   */
  getHistory: () => ExtendedUIMessage[];

  /**
   * Inserts a message into the session history immediately after the
   * message whose ID matches `afterMessageId`.
   *
   * Unlike {@link SessionInbox.sendMessage}, whose timing depends on
   * urgency (Critical/Default append immediately or after the current
   * step; Deferrable buffers until the next turn), this mutates the
   * live history array directly. The inserted message is visible to
   * the next step's history preprocessing.
   *
   * @returns `true` if the message was found and the insert succeeded,
   *          `false` if no message with the given ID exists.
   */
  insertMessageAfter: (
    afterMessageId: string,
    message: ExtendedUIMessage,
  ) => boolean;

  /**
   * Access to the session inbox, allowing you to send context events or
   * native messages into the session.
   */
  inbox: ChatSessionInbox;

  /**
   * Access to the application config — model selections, providers, etc.
   */
  config: Config;
  modelResolver: ProviderModelResolver;

  /**
   * Generates text using model fallback, proxied through the session so
   * that AI usage can be tracked at the session level. Tries each model ID
   * in order until one succeeds.
   *
   * Supports both single-turn (`system` + `prompt`) and multi-turn
   * (`messages`) generation, optional tools, and standard generation
   * parameters. Usage from the successful call is accumulated into the
   * session's token counters.
   *
   * @returns A discriminated union — `{ success: true, text, modelId, usage }`
   *          on success, or `{ success: false, failureReason }` when all
   *          models failed.
   */
  generateText: (args: GenerateTextArgs) => Promise<GenerateTextResult>;

  /**
   * Module-scoped logger for the extension.
   */
  logger: ModuleLogger;

  /**
   * The root logger, allowing extensions to create their own child
   * loggers for sub-components (e.g. a worker or background task).
   */
  logging: RootLogger;

  /**
   * The MCP module — client for all MCP servers the session has access
   * to. Extends `ToolProvider` with push notifications, server statuses,
   * and tool call history. Extensions can use the full MCP surface.
   *
   * `null` for `god` and `child` sessions, which have no MCP access.
   * Extensions that require MCP should check for `null` in their
   * constructor.
   */
  mcp: Mcp | null;

  /**
   * Stable identifier of the session that owns this extension. Used for
   * observability correlation. The default session uses `default`;
   * god and child sessions normally use UUIDs.
   */
  sessionId: string;

  /**
   * Context describing the session's kind and position in the session
   * tree. Extensions inspect this to decide behavior and which
   * extensions to load in child sessions.
   */
  sessionContext: SessionContext;

  /** Identifier of the extension receiving these dependencies. */
  readonly extensionIdentifier?: string;

  /**
   * Spawns an isolated child session owned by this extension. The parent
   * session owns and cleans up the child while startup is in flight; ownership
   * transfers to the extension only when this promise resolves. The child has
   * no MCP access and no push notification subscription — its only input is
   * messages injected by this extension via the returned handle's inbox.
   *
   * The requested extension list is used exactly as supplied. The spawning
   * extension is responsible for choosing the child's complete extension set
   * and avoiding recursive self-loading. Duplicate identifiers are rejected.
   *
   * The child uses the explicit base prompt supplied in `options` and
   * appends system-prompt contributions from its requested extensions.
   *
   * Only available on sessions that have a session factory. Absent
   * (throws when called) on sessions where child creation is disabled.
   */
  createChildSession: (
    options: ChildSessionOptions,
  ) => Promise<ChildSessionHandle>;

  /**
   * Returns an absolute path to a directory the calling extension can
   * use exclusively for its own persistent storage. The directory is
   * **not** guaranteed to exist — the extension must create it (e.g.
   * `fs.mkdirSync(path, { recursive: true })`) before writing.
   *
   * @param global If `false` (default), returns a session-scoped path:
   *   `{agentDataDir}/sessions/{sessionId}/extensions/{extensionIdentifier}`.
   *   If `true`, returns an agent-wide path:
   *   `{agentDataDir}/extensions/{extensionIdentifier}`.
   */
  getDataDir: (global?: boolean) => string;
}

/**
 * The base dependencies the session provides to every extension.
 * The handler augments these with a per-extension `getDataDir` before
 * passing them to each factory.
 */
export type BaseExtensionDeps = Omit<ExtensionDeps, 'getDataDir'>;

/**
 * The descriptor passed to the extension handler when registering an
 * extension. The handler reads {@link identifier} and {@link displayName}
 * upfront to set up per-extension dependencies (like `getDataDir`) and
 * enforce identifier uniqueness before the factory is invoked.
 */
export interface ExtensionFactory {
  /**
   * Unique identifier in reverse-domain notation
   * (e.g. `"io.stagewise/context-compaction"`).
   */
  readonly identifier: string;

  /**
   * Optional human-readable name shown in UIs and logs.
   */
  readonly displayName?: string;

  /**
   * Creates the extension instance with the provided dependencies. Construction
   * must be side-effect free; acquire resources in `onStart` so startup rollback
   * can release them through `onClose`.
   */
  create: (deps: ExtensionDeps) => Extension;
}
