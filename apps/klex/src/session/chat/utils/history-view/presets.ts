import { timeHistoryBlocks } from '@/session/chat/extensions/time';

import type { DataPartRegistry } from './data-parts';
import { createHistoryView } from './history-view';
import type { HistoryBudget, HistoryFilterOptions, HistoryView } from './types';

/** Compact activity filter shared by history readers and the memory writer. */
export const ACTIVITY_HISTORY_FILTER: HistoryFilterOptions = {
  roles: ['user', 'assistant'],
  text: { roles: ['assistant'], limit: { max: 500, truncate: 'middle' } },
  reasoning: { limit: { max: 500, truncate: 'middle' } },
  tools: {
    name: { max: 200, truncate: 'end' },
    input: { max: 500, truncate: 'end', json: 'lines' },
    output: { max: 500, truncate: 'middle', json: 'plain' },
    error: { max: 500, truncate: 'middle' },
    skip: (name) => name === 'recall',
  },
  context: {
    source: { max: 200, truncate: 'middle' },
    metadata: { max: 500, truncate: 'middle', json: 'lines' },
    text: { max: 300, truncate: 'middle' },
    resources: { limit: { max: 300, truncate: 'middle' } },
    media: 'placeholder',
  },
  summary: false,
  dataParts: { keys: ['time'] },
};

export function createActivityHistoryView(): HistoryView {
  return createHistoryView({
    filter: ACTIVITY_HISTORY_FILTER,
    transformers: { time: (data) => timeHistoryBlocks(data) },
    lines: { messageLimit: 4_000, contextLimit: 2_000 },
  });
}

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
  transformers: DataPartRegistry = {},
  keys: readonly string[] = [],
): HistoryView {
  return createHistoryView({
    filter: {
      ...TRANSCRIPT_HISTORY_FILTER,
      dataParts: {
        keys,
        limit: { max: 500, truncate: 'middle' },
        media: 'placeholder',
      },
    },
    transformers,
    budget,
  });
}

/**
 * Line-format transcript for the instinct classifier. Uses the transcript
 * filter plus projectors for extension data parts (so the classifier sees
 * extension content the way the main agent does). The classifier truncates
 * rendered messages before fitting its five-message window, then
 * applies its aggregate character budget while retaining newest activity.
 */
export function createInstinctHistoryView(options: {
  transformers?: DataPartRegistry;
}): HistoryView {
  return createHistoryView({
    transformers: options.transformers,
    filter: {
      ...TRANSCRIPT_HISTORY_FILTER,
      dataParts: options.transformers
        ? { keys: 'all', exclude: [CONTEXT_SUMMARY_KEY], media: 'placeholder' }
        : undefined,
    },
  });
}
