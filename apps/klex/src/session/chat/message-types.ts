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
 * Custom data part that signals the model should review new input that
 * arrived during its previous turn and decide whether to do more.
 * The converter turns this into a text part with a review prompt.
 */
export type CheckDataUIPart = Record<string, never>;

/**
 * Custom data part that carries a god message — a high-priority
 * directive received via the admin API. The converter wraps its content
 * in `<god-message>...</god-message>` XML, handling text, image, audio,
 * resource_link, and resource blocks identically to `data-context`.
 *
 * Unlike `ContextDataUIPart`, god messages have no `sourceEnv` or
 * `metadata` — they originate from the admin API, not an external
 * environment.
 */
export type GodMessageDataUIPart = {
  content: ContextDataUIPart['content'];
};

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
  'god-message': GodMessageDataUIPart;
  continue: ContinueDataUIPart;
  check: CheckDataUIPart;
};

export type ExtendedUIMessage = UIMessage<
  UIMessageMetadata,
  CustomUIDataParts,
  AgentUITools
>;
