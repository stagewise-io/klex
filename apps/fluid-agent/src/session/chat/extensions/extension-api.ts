import type {
  FilePart,
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  TextPart,
} from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, ModelId } from '@/config';

import type { ChatSessionInbox } from '../inbox';
import type { CustomUIDataParts, ExtendedUIMessage } from '../message-types';

/**
 * A transformer that converts a custom data part into model message parts.
 *
 * One transformer per data part type. Duplicate registration for the same
 * type crashes at registration time.
 */
export type DataPartTransformer<K extends keyof CustomUIDataParts> = (
  data: CustomUIDataParts[K],
) => (TextPart | FilePart)[];

/**
 * Maps each custom data part type to its transformer. All entries optional.
 */
export type DataPartTransformers = Partial<{
  [K in keyof CustomUIDataParts]: DataPartTransformer<K>;
}>;

/**
 * Flags that an extension can set when transforming history, describing
 * what the transformation did. Merged across all extensions via OR semantics.
 */
export interface TransformationFlags {
  /** The history was compacted (e.g. summaries replaced older messages). */
  hasCompacted?: boolean;
  /**
   * True when one or more extensions' transformers threw an error.
   * The caller must treat the context as potentially corrupted and
   * cancel the step — generation should not proceed on uncertain data.
   */
  hasTransformerError?: boolean;
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
}

/**
 * Return value of the {@link Extension.onStepComplete} hook.
 *
 * - `void` — the extension observed the event but does not want to
 *   influence control flow.
 * - `{ stop: true, stopReason }` — request the agent to stop after this
 *   step. The handler collects stop signals from all extensions in
 *   parallel; if any extension requests a stop, `shouldContinue` is set
 *   to `false` on the event returned by the step.
 */
export type StepCompleteHookResult = void | {
  stop?: boolean;
  stopReason?: string;
};

export interface Extension {
  /**
   * Unique identifier in reverse-domain notation
   * (e.g. `"io.stagewise/context-compaction"`).
   *
   * Must match the identifier declared on the {@link ExtensionFactory}.
   * The handler enforces uniqueness at registration time.
   */
  readonly identifier: string;

  /**
   * Optional human-readable name shown in UIs and logs.
   */
  readonly displayName?: string;

  /**
   * Transforms the UI message history before it is converted to model
   * messages. Extensions are called in order; each receives the output
   * of the previous one. Flags from all extensions are merged (OR
   * semantics).
   *
   * If a transformer throws, the error is caught and logged, and the
   * pipeline continues with the current history unchanged — one
   * extension's failure does not cancel subsequent extensions. However,
   * the `hasTransformerError` flag is set, and the step caller will
   * cancel the step because context integrity cannot be guaranteed.
   */
  historyTransformer?: (
    history: ExtendedUIMessage[],
  ) => HistoryProcessingResult | Promise<HistoryProcessingResult>;

  /**
   * Transforms the model messages after conversion from UI messages.
   * Extensions are called in order; each receives the output of the
   * previous one. Flags from all extensions are merged (OR semantics).
   *
   * If a transformer throws, the error is caught and logged, and the
   * pipeline continues with the current history unchanged — one
   * extension's failure does not cancel subsequent extensions. However,
   * the `hasTransformerError` flag is set, and the step caller will
   * cancel the step because context integrity cannot be guaranteed.
   */
  contextTransformer?: (
    history: ModelMessage[],
  ) => ContextProcessingResult | Promise<ContextProcessingResult>;

  /**
   * Called after each step completes — whether the step was skipped,
   * produced a successful generation, salvaged partial output, or
   * failed. Receives a structured clone of the full
   * {@link StepCompleteEvent}.
   *
   * All extensions' hooks are called in parallel via
   * `Promise.allSettled`. The step waits for all hooks to settle
   * before returning. Errors from individual hooks are caught and
   * logged — one extension's hook failure does not break the step.
   *
   * Return `{ stop: true }` to request that the agent stops after
   * this step.
   */
  onStepComplete?: (
    event: StepCompleteEvent,
  ) => StepCompleteHookResult | Promise<StepCompleteHookResult>;

  dataPartTransformers?: DataPartTransformers;
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
   * @returns The generated text, or `null` if all models failed.
   */
  generateTextWithFallback: (args: {
    modelIds: readonly ModelId[];
    system: string;
    prompt: string;
  }) => Promise<string | null>;

  /**
   * Module-scoped logger for the extension.
   */
  logger: ModuleLogger;

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
 * The descriptor passed to the extension handler when registering an
 * extension. The handler reads {@link identifier} and {@link displayName}
 * upfront to set up per-extension dependencies (like `getDataDir`) and
 * enforce identifier uniqueness before the factory is invoked.
 */
/**
 * The base dependencies the session provides to every extension.
 * The handler augments these with a per-extension `getDataDir` before
 * passing them to each factory.
 */
export type BaseExtensionDeps = Omit<ExtensionDeps, 'getDataDir'>;

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
   * The returned extension's `identifier` must match this factory's
   * `identifier`.
   */
  create: (deps: ExtensionDeps) => Extension;
}
