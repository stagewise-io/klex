import type { FilePart, ModelMessage, TextPart } from 'ai';

import type { ModuleLogger } from '@stagewise/logger';

import type { Config, ModelId } from '@/config';
import type { SessionInbox } from '@/session/inbox';
import type { CustomUIDataParts, ExtendedUIMessage } from '@/session/types';

import type { GenerationRunnerResult } from '../step/generation-runner';

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
}

/**
 * The result of a history transformation hook. Extensions can return either
 * the transformed history directly (shorthand) or an object containing the
 * history plus flags describing what the transformation did.
 */
export type PreProcessingResult =
  | ExtendedUIMessage[]
  | { history: ExtendedUIMessage[]; flags: TransformationFlags };

export type PostProcessingResult =
  | ModelMessage[]
  | { history: ModelMessage[]; flags: TransformationFlags };

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

  onHistoryPreProcessing?: (
    history: ExtendedUIMessage[],
  ) => PreProcessingResult | Promise<PreProcessingResult>;

  onHistoryPostProcessing?: (
    history: ModelMessage[],
  ) => PostProcessingResult | Promise<PostProcessingResult>;

  /**
   * Called after each generation step completes (success or failure).
   * Receives a shallow copy of the full GenerationRunnerResult — the
   * extension decides what to use (usage, text, toolCalls, etc.).
   *
   * Errors thrown by extensions are caught and logged by the
   * ExtensionHandler — one extension's failure does not break the step.
   */
  onStepComplete?: (result: GenerationRunnerResult) => void | Promise<void>;

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
  inbox: SessionInbox;

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
