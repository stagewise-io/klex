import { formatTimeContext } from '@/session/chat/extensions/time';
import {
  createHistoryView,
  type FieldLimit,
  type FittedHistory,
  type ValueLimit,
} from '@/session/chat/utils/history-view';
import { redactAttachmentSecrets } from '@/shared-utilities/attachment-privacy';

import type { ExtendedUIMessage } from '../../message-types';

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

/** Writer view: compact agent actions, thoughts, outputs, context, and time. */
const EPISODIC_HISTORY_VIEW = createHistoryView({
  filter: {
    roles: ['user', 'assistant'],
    text: { roles: ['assistant'], limit: TEXT_LIMIT },
    reasoning: { limit: TEXT_LIMIT },
    tools: {
      name: { max: LABEL_LIMIT, truncate: 'end' },
      input: INPUT_LIMIT,
      output: OUTPUT_LIMIT,
      error: { max: VALUE_LIMIT, truncate: 'middle' },
      skip: (name) => name === 'recall',
    },
    context: {
      source: { max: LABEL_LIMIT, truncate: 'middle' },
      metadata: METADATA_LIMIT,
      text: CONTEXT_TEXT_LIMIT,
      resources: { limit: CONTEXT_TEXT_LIMIT },
      media: 'placeholder',
    },
    summary: false,
    data: { time: projectTime },
  },
  lines: { messageLimit: 4_000, contextLimit: 2_000 },
});

/**
 * Structured episodic records after `cursor`. Rendering them in line format
 * yields exactly the text of the episodic line view.
 */
export function collectEpisodicHistory(
  history: readonly ExtendedUIMessage[],
  cursor: string | null,
): FittedHistory {
  return EPISODIC_HISTORY_VIEW.fit(
    redactAttachmentSecrets(history) as ExtendedUIMessage[],
    { kind: 'after-cursor', cursor },
  );
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
