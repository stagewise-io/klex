import { getToolName, isToolUIPart } from 'ai';

import { isDataPartOf } from '@/session/chat/extensions/extension-api';
import type { ContextDataUIPart } from '@/session/inbox';

import { serializeValue, truncateText } from './truncate';
import type {
  ContextItem,
  HistoryFilterOptions,
  HistoryMessage,
  HistoryRecord,
  HistoryScope,
  ProjectedMessage,
  ToolStatus,
} from './types';

type Part = HistoryMessage['parts'][number];
type ToolPart = Extract<Part, { type: 'dynamic-tool' | `tool-${string}` }>;
type ContextOptions = Exclude<HistoryFilterOptions['context'], false>;
type ToolOptions = Exclude<HistoryFilterOptions['tools'], false>;

export interface ScopedHistory {
  messages: readonly HistoryMessage[];
  /** Cursor that exists in history, otherwise `null`. */
  startCursor: string | null;
}

export function applyScope(
  history: readonly HistoryMessage[],
  scope: HistoryScope,
): ScopedHistory {
  if (scope.kind === 'all' || scope.cursor === null) {
    return { messages: history, startCursor: null };
  }
  const cursor = scope.cursor;
  const index = history.findIndex((message) => message.id === cursor);
  return index < 0
    ? { messages: history, startCursor: null }
    : { messages: history.slice(index + 1), startCursor: cursor };
}

/** Messages after `cursor`; the whole history when it is null or missing. */
export function historyAfterCursor(
  history: readonly HistoryMessage[],
  cursor: string | null,
): readonly HistoryMessage[] {
  return applyScope(history, { kind: 'after-cursor', cursor }).messages;
}

export function projectMessage(
  message: HistoryMessage,
  filter: HistoryFilterOptions,
): ProjectedMessage {
  const summaryKey = filter.summary ? filter.summary.key : undefined;
  const projected: ProjectedMessage = {
    id: message.id,
    role: message.role,
    hasSummary:
      summaryKey !== undefined &&
      message.parts.some((part) => isDataPartOf(summaryKey, part)),
    records: [],
  };
  if (filter.roles && !filter.roles.includes(message.role)) return projected;
  if (filter.skipMessage?.(message)) return projected;

  for (const part of message.parts) {
    const record = projectPart(part, message.role, filter);
    if (record) projected.records.push(record);
  }
  return projected;
}

function projectPart(
  part: Part,
  role: HistoryMessage['role'],
  filter: HistoryFilterOptions,
): HistoryRecord | null {
  if (part.type === 'text') {
    const text = filter.text;
    if (text === false || !text.roles.includes(role)) return null;
    if (!part.text && !text.keepEmpty) return null;
    return { kind: 'text', text: truncateText(part.text, text.limit) };
  }

  if (part.type === 'reasoning') {
    const reasoning = filter.reasoning;
    const value = (part as { text?: string }).text ?? '';
    if (!reasoning || !value) return null;
    return { kind: 'reasoning', text: truncateText(value, reasoning.limit) };
  }

  if (part.type === 'dynamic-tool' || isToolUIPart(part)) {
    return filter.tools ? projectTool(part, filter.tools) : null;
  }

  if (
    filter.summary &&
    isDataPartOf(filter.summary.key, part) &&
    typeof part.data === 'object' &&
    part.data !== null &&
    'summary' in part.data &&
    typeof part.data.summary === 'string'
  ) {
    return {
      kind: 'summary',
      text: truncateText(part.data.summary, filter.summary.limit),
    };
  }

  if (part.type === 'data-context') {
    return filter.context ? projectContext(part.data, filter.context) : null;
  }

  if (part.type.startsWith('data-')) {
    const projector = filter.data?.[part.type.slice('data-'.length)];
    const projectedData = projector?.(
      (part as unknown as { data: unknown }).data,
    );
    return projectedData ? { kind: 'data', ...projectedData } : null;
  }

  return null;
}

function projectTool(
  part: ToolPart,
  options: ToolOptions,
): HistoryRecord | null {
  const rawName =
    part.type === 'dynamic-tool' ? part.toolName : getToolName(part);
  if (options.skip?.(rawName)) return null;

  const record: Extract<HistoryRecord, { kind: 'tool' }> = {
    kind: 'tool',
    name: options.name ? truncateText(rawName, options.name) : rawName,
    status: toolStatus(part.state),
  };
  if (options.input) {
    const input = serializeValue(part.input, options.input);
    if (input !== null) record.input = input;
  }
  if (part.state === 'output-available' && part.output !== undefined) {
    if (options.output) {
      const output = serializeValue(part.output, options.output);
      if (output !== null) record.output = output;
    }
  } else if (part.state === 'output-error' && options.error) {
    record.error = truncateText(
      part.errorText ?? 'unknown error',
      options.error,
    );
  }
  return record;
}

function toolStatus(state: string): ToolStatus {
  if (state === 'output-available') return 'succeeded';
  if (state === 'output-error') return 'failed';
  if (state === 'output-denied') return 'denied';
  return 'pending';
}

function projectContext(
  data: ContextDataUIPart,
  options: ContextOptions,
): HistoryRecord | null {
  const record: Extract<HistoryRecord, { kind: 'context' }> = {
    kind: 'context',
    source: options.source
      ? truncateText(data.sourceEnv, options.source)
      : data.sourceEnv,
    items: [],
  };
  if (options.metadata) {
    const metadata = serializeValue(data.metadata, options.metadata);
    if (metadata !== null && metadata !== '{}') record.metadata = metadata;
  }
  for (const item of data.content) {
    const projected = projectContextItem(item, options);
    if (projected) record.items.push(projected);
  }
  // Only empty text items were present: nothing to show.
  const allItemsDropped = data.content.length > 0 && record.items.length === 0;
  return allItemsDropped && record.metadata === undefined ? null : record;
}

function projectContextItem(
  item: ContextDataUIPart['content'][number],
  options: ContextOptions,
): ContextItem | null {
  switch (item.type) {
    case 'text':
      if (!item.text && !options.keepEmptyText) return null;
      return { kind: 'text', text: truncateText(item.text, options.text) };
    case 'image':
    case 'audio':
      return options.media === 'inline'
        ? { kind: item.type, mimeType: item.mimeType, data: item.data }
        : { kind: item.type, mimeType: item.mimeType };
    case 'resource_link': {
      const resources = options.resources;
      if (resources === 'placeholder') return { kind: 'resource_link' };
      return {
        kind: 'resource_link',
        uri: truncateText(item.uri, resources.limit),
        name: truncateText(item.name, resources.limit),
      };
    }
    case 'resource': {
      const resources = options.resources;
      if (resources === 'placeholder') return { kind: 'resource' };
      const resource: Extract<ContextItem, { kind: 'resource' }> = {
        kind: 'resource',
        uri: truncateText(item.resource.uri, resources.limit),
      };
      if ('text' in item.resource && item.resource.text) {
        resource.text = truncateText(item.resource.text, resources.limit);
      }
      return resource;
    }
    default:
      return null;
  }
}
