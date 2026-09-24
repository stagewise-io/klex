import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  createHistoryView,
  type HistoryFilterOptions,
} from '@/session/chat/utils/history-view';

import { isMemoryResultMessage } from './memory-result';

/** Default character budget of one rendered observation. */
const DEFAULT_OBSERVATION_MAX_CHARACTERS = 2_000;

/**
 * Incoming data only: user text, context events, and one-line tool-call
 * summaries. No thoughts, assistant text, tool output, media payloads, or
 * summaries. Memory results and `recall` calls are dropped to prevent the
 * retrieval child from observing its own output.
 */
const OBSERVATION_HISTORY_FILTER: HistoryFilterOptions = {
  skipMessage: isMemoryResultMessage,
  text: { roles: ['user'], limit: { max: 500, truncate: 'middle' } },
  reasoning: false,
  tools: {
    input: { max: 150, truncate: 'end', json: 'lines' },
    output: false,
    error: false,
    skip: (name) => name === 'recall',
  },
  context: {
    metadata: { max: 500, truncate: 'middle', json: 'lines' },
    text: { max: 500, truncate: 'middle' },
    resources: { limit: { max: 500, truncate: 'middle' } },
    media: 'placeholder',
  },
  summary: false,
};

export interface RenderedObservation {
  /** Line-format observation; empty when nothing observable happened. */
  text: string;
  /** Last message in scope; resume from here next time. */
  cursor: string | null;
}

/**
 * Renders the main-session history after `cursor` as a retrieval
 * observation, keeping the newest content within `maxCharacters`.
 */
export function renderObservation(
  history: readonly ExtendedUIMessage[],
  cursor: string | null,
  maxCharacters = DEFAULT_OBSERVATION_MAX_CHARACTERS,
): RenderedObservation {
  const { text, cursor: next } = createHistoryView({
    filter: OBSERVATION_HISTORY_FILTER,
    budget: { keep: 'newest', maxCharacters },
  }).render(history, { kind: 'after-cursor', cursor });
  return { text, cursor: next };
}
