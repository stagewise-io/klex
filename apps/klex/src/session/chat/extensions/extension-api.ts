import type {
  FilePart,
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  TextPart,
  ToolSet,
} from 'ai';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type {
  Config,
  ModelId,
  ModelInputCapabilities,
  ModelSelectionEntry,
} from '@/config';
import type { Mcp } from '@/mcp';
import type { RouterApi } from '@/router';

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
 * @example
 * const summaryTransformer = dataPartTransformer<SummaryPart>(
 *   (data) => [{ type: 'text', text: `<summary>${data.summary}</summary>` }],
 * );
 */
export function dataPartTransformer<DATA>(
  fn: (data: DATA) => (TextPart | FilePart)[],
): (data: unknown) => (TextPart | FilePart)[] {
  return (data: unknown) => fn(data as DATA);
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
   * a 400 bad request or an invalid prompt. The session should be
   * terminated rather than retried.
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
}

export interface Extension {
  /**
   * Called at the very beginning of each step — before inbox drain,
   * history repair, or the step decision. This is a fire-and-observe
   * lifecycle notification, not a transformer: it cannot influence
   * what the model sees or cancel the step.
   *
   * All extensions' hooks are called in parallel via
   * `Promise.allSettled`. The step waits for all hooks to settle
   * before proceeding. Errors from individual hooks are caught and
   * logged — one extension's hook failure does not break the step.
   *
   * Typical uses: resetting per-step flags, preparing caches, or
   * recording step-start telemetry.
   */
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

  onStepStart?: () => void | Promise<void>;

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
   * Unlike {@link SessionInbox.sendMessage}, which buffers the message
   * for the next turn, this mutates the live history array directly.
   * The inserted message is visible to the next step's history
   * preprocessing.
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
   */
  mcp: Mcp;

  /**
   * UUID of the session that owns this extension. Used for
   * observability correlation.
   */
  sessionId: string;

  /**
   * The router API — allows extensions to send input events that the
   * router dispatches to the active session. Unlike {@link inbox}, this
   * survives session termination: the router creates a replacement
   * session if the current one has terminated.
   */
  router: RouterApi;

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
   * Creates the extension instance with the provided dependencies.
   */
  create: (deps: ExtensionDeps) => Extension;
}
