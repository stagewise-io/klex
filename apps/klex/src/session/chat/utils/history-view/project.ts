import { getToolName, isToolUIPart } from 'ai';

import { isDataPartOf } from '@/session/chat/extensions/extension-api';
import type { ContextDataUIPart } from '@/session/inbox';
import {
  describeMediaContent,
  extractContentOutputText,
} from '@/shared-utilities/tool-result';

import { compactDataBlocks, createDataPartDispatcher } from './data-parts';
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
  dispatcher = createDataPartDispatcher({}),
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
  const skipped =
    (filter.roles && !filter.roles.includes(message.role)) ||
    filter.skipMessage?.(message);
  for (const [partIndex, part] of message.parts.entries()) {
    const occurrence = dispatcher.consume(part);
    if (skipped) continue;
    const record = projectPart(
      part,
      message.role,
      filter,
      dispatcher,
      occurrence,
      { messageId: message.id, partIndex },
    );
    if (record) projected.records.push(record);
  }
  return projected;
}

function projectPart(
  part: Part,
  role: HistoryMessage['role'],
  filter: HistoryFilterOptions,
  dispatcher: ReturnType<typeof createDataPartDispatcher>,
  occurrence: number,
  contextOccurrence: { messageId: string; partIndex: number },
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

  if (part.type === 'file' && filter.text && filter.text.roles.includes(role)) {
    return {
      kind: 'text',
      text: truncateText(describeMediaContent(part), filter.text.limit),
    };
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
    if (!filter.context) return null;
    const projected =
      filter.projectContext?.(part.data, contextOccurrence) ?? part.data;
    return projectContext(projected, filter.context, projected !== part.data);
  }

  if (part.type.startsWith('data-')) {
    const key = part.type.slice('data-'.length);
    const selection = filter.dataParts;
    if (
      selection &&
      (selection.keys === 'all' || selection.keys.includes(key)) &&
      !selection.exclude?.includes(key)
    ) {
      const blocks = compactDataBlocks(
        dispatcher.project(
          key,
          (part as { data: unknown }).data,
          occurrence,
          true,
        ),
        selection,
      );
      return blocks.length ? { kind: 'data', blocks } : null;
    }
    return null;
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
      const output = serializeValue(
        extractContentOutputText(part.output) ?? part.output,
        options.output,
      );
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
  prepared: boolean,
): HistoryRecord | null {
  const record: Extract<HistoryRecord, { kind: 'context' }> = {
    kind: 'context',
    type:
      data.metadata?.origin === 'events'
        ? 'event'
        : data.metadata?.origin === 'push-notifications'
          ? 'push-notification'
          : 'input',
    source: options.source
      ? truncateText(data.sourceEnv, options.source)
      : data.sourceEnv,
    items: [],
  };
  const reference =
    prepared &&
    typeof data.metadata?.inputEventRef === 'string' &&
    /^[a-z0-9]{8}$/.test(data.metadata.inputEventRef)
      ? data.metadata.inputEventRef
      : undefined;
  if (reference) {
    record.items.push({
      kind: 'text',
      text: `inputEventRef: ${reference}; ${data.metadata.inputFiltered === true ? 'filtered view may omit keys or limit values; ' : ''}use getUnfilteredInput for the original event`,
    });
  }
  if (options.metadata) {
    const metadata = serializeValue(data.metadata, options.metadata);
    if (metadata !== null && metadata !== '{}') record.metadata = metadata;
  }
  // Events carry their semantic body in metadata rather than MCP content
  // blocks. Transcript presets omit general metadata, but must retain Events
  // for compaction, consult and the classifier under the context text budget.
  if (!options.metadata && (data.metadata?.origin === 'events' || reference)) {
    // Occurrences are size/depth bounded at ingress. Serialize their JSON body
    // directly before applying the text budget: compactJson's node cap would
    // replace wide but valid payloads wholesale with [unserializable]. Keep
    // transport metadata and delivery IDs out of model-facing projections too.
    const event = serializeValue(
      {
        type: data.metadata.type,
        data: data.metadata.data,
        createdAt: data.metadata.createdAt,
        ...(data.metadata.projectionStatus
          ? { projectionStatus: data.metadata.projectionStatus }
          : {}),
        ...(reference
          ? {
              inputEventRef: reference,
              inputFiltered: data.metadata.inputFiltered,
            }
          : {}),
      },
      {
        ...options.text,
        json: 'plain',
      },
    );
    if (event !== null) record.items.push({ kind: 'text', text: event });
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
