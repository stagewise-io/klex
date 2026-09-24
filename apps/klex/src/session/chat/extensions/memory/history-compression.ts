import { formatTimeContext } from '@/session/chat/extensions/time';
import {
  createHistoryView,
  type FieldLimit,
  type HistorySegment,
  historyAfterCursor,
  type ValueLimit,
} from '@/session/chat/utils/history-view';

import type { ExtendedUIMessage } from '../../message-types';
import {
  createWriterEventPart,
  createWriterMediaPart,
} from './episodic-writer/writer-input';

const TEXT_LIMIT: FieldLimit = { max: 500, truncate: 'middle' };
const CONTEXT_TEXT_LIMIT: FieldLimit = { max: 300, truncate: 'middle' };
const LABEL_LIMIT = 200;
const VALUE_LIMIT = 500;
const INPUT_LIMIT: ValueLimit = {
  max: VALUE_LIMIT,
  truncate: 'end',
  json: 'lines',
};
const METADATA_LIMIT: ValueLimit = {
  max: VALUE_LIMIT,
  truncate: 'middle',
  json: 'lines',
};
const OUTPUT_LIMIT: ValueLimit = {
  max: VALUE_LIMIT,
  truncate: 'middle',
  json: 'plain',
};

type CompressedHistory = {
  text: string;
  parts: ExtendedUIMessage['parts'];
  lastProcessedMessageId: string | null;
};

/**
 * Writer view: the agent's own prose, reasoning, and actions plus inbound
 * context and time. Raw user text is ignored because every inbound event
 * already arrives as a context part.
 */
const WRITER_HISTORY_VIEW = createHistoryView({
  filter: {
    roles: ['user', 'assistant'],
    text: { roles: ['assistant'], limit: TEXT_LIMIT },
    reasoning: { limit: TEXT_LIMIT },
    tools: {
      name: { max: LABEL_LIMIT, truncate: 'end' },
      input: INPUT_LIMIT,
      output: OUTPUT_LIMIT,
      error: { max: VALUE_LIMIT, truncate: 'middle' },
    },
    context: {
      source: { max: LABEL_LIMIT, truncate: 'middle' },
      metadata: METADATA_LIMIT,
      text: CONTEXT_TEXT_LIMIT,
      resources: { limit: CONTEXT_TEXT_LIMIT },
      media: 'inline',
    },
    summary: false,
    data: { time: projectTime },
  },
  lines: { messageLimit: 4_000, contextLimit: 2_000 },
  budget: { keep: 'oldest', maxCharacters: 12_000 },
});

export function countPendingUserMessages(
  history: readonly ExtendedUIMessage[],
  lastProcessedMessageId: string | null,
): number {
  return historyAfterCursor(history, lastProcessedMessageId).filter(
    (message) => message.role === 'user',
  ).length;
}

/**
 * Renders the history delta in line format. External content only appears
 * on `¦`-prefixed lines, so it cannot create records or labels, and
 * aggregate truncation happens only between complete native messages.
 */
export function compressHistoryForWriter(
  history: readonly ExtendedUIMessage[],
  lastProcessedMessageId: string | null,
): CompressedHistory {
  const view = WRITER_HISTORY_VIEW.render(history, {
    kind: 'after-cursor',
    cursor: lastProcessedMessageId,
  });
  return {
    text: view.text,
    parts: view.segments.map(toWriterPart),
    lastProcessedMessageId: view.cursor,
  };
}

function toWriterPart(
  segment: HistorySegment,
): ExtendedUIMessage['parts'][number] {
  return segment.type === 'text'
    ? createWriterEventPart(segment.text)
    : createWriterMediaPart(segment.kind, segment.mediaType, segment.data);
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
  ) {
    return null;
  }
  try {
    return {
      label: 'time_update',
      value: formatTimeContext(data.timestamp, data.tz, true),
    };
  } catch {
    return null;
  }
}
