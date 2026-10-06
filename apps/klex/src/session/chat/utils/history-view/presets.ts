import {
  hasTrustedSenderHeader,
  MAX_SENDER_NAME_CODE_POINTS,
  SENDER_HEADER_SEPARATOR,
} from '../sender-header';
import { createHistoryView } from './history-view';
import type { HistoryBudget, HistoryFilterOptions, HistoryView } from './types';

/** Data-part key of context-compaction summaries. */
export const CONTEXT_SUMMARY_KEY = 'context-summary';

const MAX_SENDER_LINE_LENGTH =
  'From: '.length +
  MAX_SENDER_NAME_CODE_POINTS * 2 +
  SENDER_HEADER_SEPARATOR.length;

/**
 * Transcript filter shared by compaction and consult: all text, tool
 * results, context text, and the latest summary; no reasoning, tool input,
 * metadata, or other data parts.
 */
const TRANSCRIPT_HISTORY_FILTER: HistoryFilterOptions = {
  text: {
    roles: ['user', 'assistant', 'system'],
    limit: { max: 500, truncate: 'end-overflow' },
    keepEmpty: true,
  },
  reasoning: false,
  tools: {
    input: false,
    output: { max: 300, truncate: 'end-overflow', json: 'compact' },
    error: { max: 300, truncate: 'end-overflow' },
  },
  context: {
    metadata: false,
    text: (data, itemIndex) => {
      const limit = { max: 200, truncate: 'end-overflow' } as const;
      if (
        itemIndex !== 0 ||
        (data.sourceEnv !== 'slack' && data.sourceEnv !== 'chat') ||
        data.metadata?.type !== 'chat.message.received' ||
        typeof data.metadata.senderName !== 'string'
      )
        return limit;

      const senderLine = `From: ${data.metadata.senderName}`;
      const firstBlock = data.content[0];
      if (
        firstBlock?.type !== 'text' ||
        !hasTrustedSenderHeader(
          firstBlock.text,
          data.metadata.senderName,
          data.metadata.senderHeader,
        )
      )
        return limit;

      return {
        ...limit,
        max: Math.max(
          limit.max,
          Math.min(
            MAX_SENDER_LINE_LENGTH,
            senderLine.length + SENDER_HEADER_SEPARATOR.length,
          ),
        ),
      };
    },
    keepEmptyText: true,
    resources: 'placeholder',
    media: 'placeholder',
  },
  summary: {
    key: CONTEXT_SUMMARY_KEY,
    limit: { max: 800, truncate: 'end-overflow' },
  },
};

/**
 * Line-format transcript for consult and context compaction (no character
 * limit by default). Always starts at the latest summary (marking dropped
 * messages). Readers need `LINES_FORMAT_PROMPT` in their system prompt.
 */
export function createTranscriptHistoryView(
  budget: HistoryBudget = { keep: 'newest' },
): HistoryView {
  return createHistoryView({
    filter: TRANSCRIPT_HISTORY_FILTER,
    budget,
  });
}
