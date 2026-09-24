import { createHistoryView } from './history-view';
import type { HistoryBudget, HistoryFilterOptions, HistoryView } from './types';

/** Data-part key of context-compaction summaries. */
export const CONTEXT_SUMMARY_KEY = 'context-summary';

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
    text: { max: 200, truncate: 'end-overflow' },
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
