import type { UIMessage } from 'ai';

import type { ContextDataUIPart } from '@/session/inbox';

import type { AgentUITools } from './tools';

/**
 * Extension to the metadata of UI messages for agents
 */
export type UIMessageMetadata = Record<string, never>;

/**
 * Custom data part that signals the model should continue its previous
 * generation (e.g. after truncation or a salvaged partial response).
 * The converter turns this into a text part with content "Continue.".
 */
export type ContinueDataUIPart = Record<string, never>;

/**
 * Core custom data part types. Only types that are fundamental to the
 * session itself live here — extension-defined data parts are NOT
 * registered centrally. Extensions define their own part types locally
 * and use the helpers from `extension-api.ts` (`createDataPart`,
 * `isDataPartOf`, `dataPartTransformer`) for type-safe creation,
 * consumption, and transformation.
 */
export type CustomUIDataParts = {
  context: ContextDataUIPart;
  continue: ContinueDataUIPart;
};

export type ExtendedUIMessage = UIMessage<
  UIMessageMetadata,
  CustomUIDataParts,
  AgentUITools
>;
