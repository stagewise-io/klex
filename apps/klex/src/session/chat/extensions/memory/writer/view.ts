import type { ActivityView } from '@/activity-history';
import { isMemoryResultMessage } from '@/session/chat/extensions/memory/retrieval/memory-result';
import {
  ACTIVITY_HISTORY_FILTER,
  createHistoryView,
} from '@/session/chat/utils/history-view';

import { maskSecrets } from './tools';

// Writer-only: the main session keeps the shared activity view unchanged.
const HIDDEN_TOOLS = new Set([
  'recall',
  'readSkill',
  'createTodo',
  'changeTodoReminder',
  'clearTodo',
]);

const historyView = createHistoryView({
  filter: {
    ...ACTIVITY_HISTORY_FILTER,
    skipMessage: isMemoryResultMessage,
    text: {
      roles: ['user', 'assistant'],
      limit: { max: 500, truncate: 'middle' },
    },
    tools: {
      ...(ACTIVITY_HISTORY_FILTER.tools as Exclude<
        typeof ACTIVITY_HISTORY_FILTER.tools,
        false
      >),
      input: { max: 200, truncate: 'end', json: 'lines' },
      output: { max: 300, truncate: 'middle', json: 'plain' },
      skip: (name) => HIDDEN_TOOLS.has(name),
    },
  },
  lines: { messageLimit: 4_000, contextLimit: 2_000 },
});

const TERMINAL_CODES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the purpose.
  /(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_=>]|\u009c/g;

/** Terminal colours, cursor codes and carriage returns cost tokens and carry no facts. */
function clean(value: unknown): unknown {
  if (typeof value === 'string')
    return maskSecrets(
      value.replace(TERMINAL_CODES, '').replace(/\r\n?/g, '\n'),
    );
  if (Array.isArray(value)) return value.map(clean);
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, clean(nested)]),
    );
  return value;
}

/** `{ text }` tool outputs render as JSON; unwrap so line breaks stay real. */
function unwrapText(part: unknown): unknown {
  if (typeof part !== 'object' || part === null || !('output' in part))
    return part;
  const { output } = part;
  return typeof output === 'object' &&
    output !== null &&
    Object.keys(output).length === 1 &&
    'text' in output &&
    typeof output.text === 'string'
    ? { ...part, output: output.text }
    : part;
}

/** Activity view for the memory writer: compact, terminal-clean, secrets masked. */
export const writerView: ActivityView = (messages) =>
  historyView.fit(
    messages.map(
      (message) =>
        ({
          ...message,
          parts: message.parts.map((part) => clean(unwrapText(part))),
        }) as typeof message,
    ),
  );
