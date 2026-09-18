import { getToolName, isToolUIPart } from 'ai';

import { formatTimeContext } from '@/session/chat/extensions/time';
import type { ContextDataUIPart } from '@/session/inbox';

import type { ExtendedUIMessage } from '../../message-types';
import { isDataPartOf } from '../extension-api';
import {
  createWriterEventPart,
  createWriterMediaPart,
} from './episodic-writer/writer-input';

const TEXT_LIMIT = 500;
const CONTEXT_TEXT_LIMIT = 300;
const SERIALIZED_VALUE_LIMIT = 500;
const CONTEXT_RECORD_LIMIT = 2_000;
const MESSAGE_RECORD_LIMIT = 4_000;
const MAX_SUMMARY_LENGTH = 12_000;

type CompressedHistory = {
  text: string;
  parts: ExtendedUIMessage['parts'];
  lastProcessedMessageId: string | null;
};

type WriterPart = Record<string, unknown> & { type: string };
type WriterMedia = {
  type: 'image' | 'audio';
  mediaType: string;
  data: string;
};
type WriterEvent = {
  record: WriterPart;
  media: WriterMedia[];
  inlineItems?: WriterEvent[];
};

export function countPendingUserMessages(
  history: readonly ExtendedUIMessage[],
  lastProcessedMessageId: string | null,
): number {
  let count = 0;
  for (const message of history.slice(
    getHistoryStartIndex(history, lastProcessedMessageId),
  )) {
    if (message.role === 'user') count++;
  }
  return count;
}

/**
 * Renders the history delta as newline-delimited JSON. Every nonblank line is
 * one complete JSON record. JSON string escaping prevents content from
 * creating records or changing field boundaries, and aggregate truncation
 * happens only between complete native messages.
 */
export function compressHistoryForWriter(
  history: readonly ExtendedUIMessage[],
  lastProcessedMessageId: string | null,
): CompressedHistory {
  const slice = history.slice(
    getHistoryStartIndex(history, lastProcessedMessageId),
  );
  const events: WriterEvent[] = [];
  const lines: string[] = [];
  let lastProcessed = getExistingCursor(history, lastProcessedMessageId);
  let totalLength = 0;

  for (const message of slice) {
    const messageEvents = compressMessage(message);
    if (messageEvents.length === 0) {
      lastProcessed = message.id;
      continue;
    }

    const messageLines = messageEvents.map((event) =>
      JSON.stringify(event.record),
    );
    const addedLength =
      messageLines.join('\n').length + (lines.length > 0 ? 1 : 0);
    if (totalLength + addedLength > MAX_SUMMARY_LENGTH) break;

    events.push(...messageEvents);
    lines.push(...messageLines);
    totalLength += addedLength;
    lastProcessed = message.id;
  }

  return {
    text: lines.join('\n'),
    parts: events.flatMap(createWriterParts),
    lastProcessedMessageId: lastProcessed,
  };
}

function createWriterParts(event: WriterEvent): ExtendedUIMessage['parts'] {
  if (!event.inlineItems || event.media.length === 0) {
    return [createWriterEventPart(`${JSON.stringify(event.record)}\n`)];
  }

  const skeleton = JSON.stringify({ ...event.record, items: [] });
  const marker = '"items":[]';
  const markerIndex = skeleton.indexOf(marker);
  if (markerIndex < 0) {
    return [createWriterEventPart(`${JSON.stringify(event.record)}\n`)];
  }

  const parts: ExtendedUIMessage['parts'] = [];
  let text = skeleton.slice(0, markerIndex + '"items":['.length);
  for (const [index, item] of event.inlineItems.entries()) {
    if (index > 0) text += ',';
    const media = item.media[0];
    if (!media) {
      text += JSON.stringify(item.record);
      continue;
    }

    if (text) parts.push(createWriterEventPart(text));
    parts.push(createWriterMediaPart(media.type, media.mediaType, media.data));
    text = '';
  }
  text += skeleton.slice(markerIndex + marker.length - 1);
  if (text) parts.push(createWriterEventPart(`${text}\n`));
  return parts;
}

function getHistoryStartIndex(
  history: readonly ExtendedUIMessage[],
  lastProcessedMessageId: string | null,
): number {
  if (lastProcessedMessageId === null) return 0;
  const index = history.findIndex(
    (message) => message.id === lastProcessedMessageId,
  );
  return index < 0 ? 0 : index + 1;
}

function getExistingCursor(
  history: readonly ExtendedUIMessage[],
  lastProcessedMessageId: string | null,
): string | null {
  return history.some((message) => message.id === lastProcessedMessageId)
    ? lastProcessedMessageId
    : null;
}

function compressMessage(message: ExtendedUIMessage): WriterEvent[] {
  if (message.role === 'assistant') return compressAssistant(message);
  if (message.role === 'user') return compressUser(message);
  return [];
}

function compressAssistant(message: ExtendedUIMessage): WriterEvent[] {
  const parts: WriterPart[] = [];

  for (const part of message.parts) {
    if (part.type === 'reasoning') {
      const text = (part as { text?: string }).text ?? '';
      if (text)
        parts.push({
          type: 'your_thought',
          text: truncateMiddle(text, TEXT_LIMIT),
        });
    } else if (part.type === 'text') {
      if (part.text) {
        parts.push({
          type: 'your_loud_thought',
          text: truncateMiddle(part.text, TEXT_LIMIT),
        });
      }
    } else if (part.type === 'dynamic-tool' || isToolUIPart(part)) {
      parts.push(compressTool(part));
    }
  }

  return fitMessageParts(parts).map((record) => ({ record, media: [] }));
}

function compressUser(message: ExtendedUIMessage): WriterEvent[] {
  const events: WriterEvent[] = [];

  for (const part of message.parts) {
    if (isDataPartOf('time', part)) {
      const value = renderTimePart((part as unknown as { data: unknown }).data);
      if (value)
        events.push({ record: { type: 'time_update', value }, media: [] });
    } else if (part.type === 'data-context') {
      events.push(compressContext(part.data));
    }
  }

  const records = fitMessageParts(events.map((event) => event.record));
  return records.map((record, index) => ({
    record,
    media: events[index]?.media ?? [],
    inlineItems: events[index]?.inlineItems,
  }));
}

function compressTool(
  part: Extract<
    ExtendedUIMessage['parts'][number],
    { type: 'dynamic-tool' | `tool-${string}` }
  >,
): WriterPart {
  const name = part.type === 'dynamic-tool' ? part.toolName : getToolName(part);
  const result: WriterPart = {
    type: 'your_action',
    name: truncateEnd(name, 200),
    status: toolStatus(part.state),
  };
  const input = serializeValue(part.input, 'end');
  if (input) result.input = input;

  if (part.state === 'output-available' && part.output !== undefined) {
    const output = serializeValue(part.output, 'middle');
    if (output) result.output = output;
  } else if (part.state === 'output-error') {
    result.error = truncateMiddle(
      part.errorText ?? 'unknown error',
      SERIALIZED_VALUE_LIMIT,
    );
  }

  return result;
}

function toolStatus(state: string): string {
  if (state === 'output-available') return 'succeeded';
  if (state === 'output-error') return 'failed';
  if (state === 'output-denied') return 'denied';
  return 'pending';
}

function compressContext(data: ContextDataUIPart): WriterEvent {
  const base: WriterPart = {
    type: 'context',
    source: truncateMiddle(data.sourceEnv, 200),
  };
  const metadata = serializeValue(data.metadata, 'middle');
  if (metadata && metadata !== '{}') base.metadata = metadata;

  const candidates = data.content
    .map(compressContextItem)
    .filter((item): item is WriterEvent => item !== null);
  const { record, includedItems } = fitContextItems(base, candidates);
  return {
    record,
    media: includedItems.flatMap((item) => item.media),
    inlineItems: includedItems,
  };
}

function compressContextItem(
  item: ContextDataUIPart['content'][number],
): WriterEvent | null {
  switch (item.type) {
    case 'text':
      return item.text
        ? {
            record: {
              type: 'text',
              text: truncateMiddle(item.text, CONTEXT_TEXT_LIMIT),
            },
            media: [],
          }
        : null;
    case 'image':
      return {
        record: { type: 'image', mimeType: item.mimeType },
        media: [{ type: 'image', mediaType: item.mimeType, data: item.data }],
      };
    case 'audio':
      return {
        record: { type: 'audio', mimeType: item.mimeType },
        media: [{ type: 'audio', mediaType: item.mimeType, data: item.data }],
      };
    case 'resource_link':
      return {
        record: {
          type: 'resource-link',
          uri: truncateMiddle(item.uri, CONTEXT_TEXT_LIMIT),
          name: truncateMiddle(item.name, CONTEXT_TEXT_LIMIT),
        },
        media: [],
      };
    case 'resource': {
      const resource: WriterPart = {
        type: 'resource',
        uri: truncateMiddle(item.resource.uri, CONTEXT_TEXT_LIMIT),
      };
      if ('text' in item.resource && item.resource.text) {
        resource.text = truncateMiddle(item.resource.text, CONTEXT_TEXT_LIMIT);
      }
      return { record: resource, media: [] };
    }
    default:
      return null;
  }
}

function fitContextItems(
  base: WriterPart,
  candidates: WriterEvent[],
): { record: WriterPart; includedItems: WriterEvent[] } {
  const includedItems: WriterEvent[] = [];
  for (const candidate of candidates) {
    const next = {
      ...base,
      items: [...includedItems.map((item) => item.record), candidate.record],
    };
    if (JSON.stringify(next).length > CONTEXT_RECORD_LIMIT) break;
    includedItems.push(candidate);
  }

  const omittedItems = candidates.length - includedItems.length;
  return {
    record: {
      ...base,
      ...(includedItems.length > 0
        ? { items: includedItems.map((item) => item.record) }
        : {}),
      ...(omittedItems > 0 ? { omittedItems } : {}),
    },
    includedItems,
  };
}

function fitMessageParts(candidates: WriterPart[]): WriterPart[] {
  const parts: WriterPart[] = [];
  for (const candidate of candidates) {
    if (serializedRecordsLength([...parts, candidate]) > MESSAGE_RECORD_LIMIT)
      break;
    parts.push(candidate);
  }

  while (parts.length > 0 && parts.length < candidates.length) {
    const withOmission = parts.map((part, index) =>
      index === parts.length - 1
        ? { ...part, omittedParts: candidates.length - parts.length }
        : part,
    );
    if (serializedRecordsLength(withOmission) <= MESSAGE_RECORD_LIMIT)
      return withOmission;
    parts.pop();
  }

  return parts;
}

function serializedRecordsLength(records: WriterPart[]): number {
  return records.map((record) => JSON.stringify(record)).join('\n').length;
}

function serializeValue(
  value: unknown,
  strategy: 'end' | 'middle',
): string | null {
  if (value === undefined) return null;
  try {
    const serialized =
      typeof value === 'string' ? value : JSON.stringify(value);
    if (!serialized) return null;
    return strategy === 'end'
      ? truncateEnd(serialized, SERIALIZED_VALUE_LIMIT)
      : truncateMiddle(serialized, SERIALIZED_VALUE_LIMIT);
  } catch {
    return null;
  }
}

function renderTimePart(data: unknown): string | null {
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
    return formatTimeContext(data.timestamp, data.tz, true);
  } catch {
    return null;
  }
}

function truncateEnd(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const keep = limit - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}
