import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  createHistoryView,
  type HistoryFilterOptions,
} from '@/session/chat/utils/history-view';

import { isMemoryResultMessage } from './memory-result';

/** Default character budget of one rendered observation. */
const DEFAULT_OBSERVATION_MAX_CHARACTERS = 2_000;
/** Share of the budget one context record may use. */
const CONTEXT_RECORD_SHARE = 0.75;

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
  /** Last message consumed by `text`; resume from here next time. */
  cursor: string | null;
  /** Messages after `cursor` did not fit and need another batch. */
  hasMore: boolean;
}

/**
 * Renders the oldest batch of main-session history after `cursor` that fits
 * `maxCharacters`. Nothing is dropped between batches: `cursor` stops at
 * the last included message. Each message is clipped to the budget on its
 * own (`[… N more parts]`), so every batch makes progress.
 */
export function renderObservation(
  history: readonly ExtendedUIMessage[],
  cursor: string | null,
  maxCharacters = DEFAULT_OBSERVATION_MAX_CHARACTERS,
): RenderedObservation {
  const rendered = createHistoryView({
    filter: OBSERVATION_HISTORY_FILTER,
    lines: {
      messageLimit: maxCharacters,
      contextLimit: Math.floor(maxCharacters * CONTEXT_RECORD_SHARE),
    },
    budget: { keep: 'oldest', maxCharacters },
  }).render(history, { kind: 'after-cursor', cursor });
  return {
    text: rendered.text,
    cursor: rendered.cursor,
    hasMore: rendered.truncated,
  };
}
