import type { UIMessage } from 'ai';

import type { AgentUITools } from './tools';

/**
 * This is the interface that AgentSessions must implement in order to become controllable by the Router.
 */
export interface AgentSession {
  sendMessage: (input: string) => void;
}

/**
 * Extension to the metadata of UI messages for agents
 */
export type UIMessageMetadata = Record<string, never>;

/**
 * Custom data part that stores a history summary of the chat session. This is used to provide context to the agent about what has happened in the session so far.
 */
export type HistorySummaryDataUIPart = {
  /**
   * A summary of the things that happened
   */
  summary: string;
};

/**
 * Custom data part that stores context information for the agent. This is used to provide additional information from the outside world to the agent.
 */
export type ContextDataUIPart = {
  /**
   * The source environment this input is coming from
   */
  sourceEnv: string;

  /**
   * A record of key-value pairs that help describe the content to the agent.
   */
  metadata: {
    [key: string]: string | number | boolean;
  };

  /**
   * A record of key-value pairs that help describe the content to the agent.
   */
  content: (
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; url: string }
    | { type: 'video'; mimeType: string; url: string }
    | { type: 'audio'; mimeType: string; url: string }
  )[];
};

export type CustomUIDataParts = {
  'history-summary': HistorySummaryDataUIPart;
  context: ContextDataUIPart;
};

export type ExtendedUIMessage = UIMessage<
  UIMessageMetadata,
  CustomUIDataParts,
  AgentUITools
>;
