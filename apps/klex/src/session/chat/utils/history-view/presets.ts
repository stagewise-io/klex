import { formatTimeContext } from '@/session/chat/extensions/time';

import { createHistoryView } from './history-view';
import type {
  DataProjector,
  HistoryBudget,
  HistoryFilterOptions,
  HistoryView,
} from './types';

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
  data: { time: projectTime },
};

export function createActivityHistoryView(): HistoryView {
  return createHistoryView({
    filter: ACTIVITY_HISTORY_FILTER,
    lines: { messageLimit: 4_000, contextLimit: 2_000 },
  });
}

function projectTime(data: unknown): { label: string; value: string } | null {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('timestamp' in data) ||
    !('tz' in data) ||
    typeof data.timestamp !== 'number' ||
    !Number.isFinite(data.timestamp) ||
    typeof data.tz !== 'string'
  )
    return null;
  try {
    return {
      label: 'time_update',
      value: formatTimeContext(data.timestamp, data.tz, true),
    };
  } catch {
    return null;
  }
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
): HistoryView {
  return createHistoryView({
    filter: TRANSCRIPT_HISTORY_FILTER,
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
  data: Readonly<Record<string, DataProjector>>;
}): HistoryView {
  return createHistoryView({
    filter: {
      ...TRANSCRIPT_HISTORY_FILTER,
      data: options.data,
    },
  });
}
