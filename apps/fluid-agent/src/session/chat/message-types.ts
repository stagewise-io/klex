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
 * Custom data part that stores a history summary of the chat session. This is used to provide context to the agent about what has happened in the session so far.
 */
export type ContextSummaryDataUIPart = {
  /**
   * A summary of the things that happened
   */
  summary: string;
};

export type CustomUIDataParts = {
  'context-summary': ContextSummaryDataUIPart;
  context: ContextDataUIPart;
  continue: ContinueDataUIPart;
};

export type ExtendedUIMessage = UIMessage<
  UIMessageMetadata,
  CustomUIDataParts,
  AgentUITools
>;
