import type { FilePart, ModelMessage, TextPart } from 'ai';

import type { SessionInbox } from '@/session/inbox';
import type { CustomUIDataParts, ExtendedUIMessage } from '@/session/types';

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
  onHistoryPreProcessing?: (
    history: ExtendedUIMessage[],
  ) => PreProcessingResult | Promise<PreProcessingResult>;

  onHistoryPostProcessing?: (
    history: ModelMessage[],
  ) => PostProcessingResult | Promise<PostProcessingResult>;

  dataPartTransformers?: DataPartTransformers;
}

/**
 * The interface that gets provided to an Extension, allowing it to interoperate
 * with the session asynchronously.
 */
export interface ExtensionDeps {
  /**
   * @returns A copy of the current history inside the session.
   */
  getHistory: () => ExtendedUIMessage[];

  /**
   * Access to the session inbox, allowing you to send context events or
   * native messages into the session.
   */
  inbox: SessionInbox;
}

/**
 * The type of function that must be passed in when adding an Extension.
 * The session will create the extension and pass the right dependencies to the
 * extension at creation time.
 */
export type ExtensionFactory = (deps: ExtensionDeps) => Extension;
