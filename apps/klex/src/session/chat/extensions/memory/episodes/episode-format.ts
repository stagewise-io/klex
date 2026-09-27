import z from 'zod';

import {
  type FittedMessage,
  type FittedRecord,
  type HistoryRole,
  renderRecordText,
} from '@/session/chat/utils/history-view';

/**
 * Episode files are JSON Lines (`.jsonl`): one header line, then one record
 * line per history record. Every line carries `v`; readers skip lines they
 * cannot validate, so a crash-truncated trailing line is harmless. Unknown
 * extra fields are ignored, which keeps additive extensions compatible.
 */
export const EPISODE_FORMAT_VERSION = 1;
export const EPISODE_FILE_EXTENSION = '.jsonl';

export interface EpisodeHeader {
  kind: 'episode';
  v: number;
  analyzed: boolean;
}

export interface EpisodeRecordEntry {
  kind: 'record';
  v: number;
  /** ISO 8601 UTC instant the record was persisted. */
  at: string;
  messageId: string;
  role: HistoryRole;
  record: FittedRecord;
  /** Records dropped after this one by the per-message line limit. */
  omittedRecords?: number;
}

/** A record entry before the store stamps version and time. */
export type EpisodeRecordInput = Omit<EpisodeRecordEntry, 'kind' | 'v' | 'at'>;

export function createEpisodeHeader(): EpisodeHeader {
  return { kind: 'episode', v: EPISODE_FORMAT_VERSION, analyzed: false };
}

export function createEpisodeRecordEntry(
  input: EpisodeRecordInput,
  at: Date,
): EpisodeRecordEntry {
  return {
    kind: 'record',
    v: EPISODE_FORMAT_VERSION,
    at: at.toISOString(),
    ...input,
  };
}

/** One entry per record; the last record of a message keeps the omissions. */
export function toEpisodeRecordInputs(
  messages: readonly FittedMessage[],
): EpisodeRecordInput[] {
  return messages.flatMap((message) => {
    const last = message.records.length - 1;
    return message.records.map((record, index) => ({
      messageId: message.id,
      role: message.role,
      record,
      ...(index === last && message.omittedRecords > 0
        ? { omittedRecords: message.omittedRecords }
        : {}),
    }));
  });
}

/** Parses one JSONL line; null for headers, blank, or invalid lines. */
export function parseEpisodeRecordLine(
  line: string,
): EpisodeRecordEntry | null {
  if (line.trim() === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = recordEntrySchema.safeParse(value);
  return parsed.success ? (parsed.data as EpisodeRecordEntry) : null;
}

/** Line-format text of an entry, as the history view renders it. */
export function episodeEntryText(entry: EpisodeRecordEntry): string {
  return renderRecordText(entry.record, entry.role, entry.omittedRecords ?? 0);
}

const count = z.number().int().positive();
const toolStatus = z.enum(['pending', 'succeeded', 'failed', 'denied']);

const contextItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.enum(['image', 'audio']),
    mimeType: z.string(),
    data: z.string().optional(),
  }),
  z.object({
    kind: z.literal('resource_link'),
    uri: z.string().optional(),
    name: z.string().optional(),
  }),
  z.object({
    kind: z.literal('resource'),
    uri: z.string().optional(),
    text: z.string().optional(),
  }),
]);

const recordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('reasoning'), text: z.string() }),
  z.object({ kind: z.literal('summary'), text: z.string() }),
  z.object({ kind: z.literal('data'), label: z.string(), value: z.string() }),
  z.object({
    kind: z.literal('tool'),
    name: z.string(),
    status: toolStatus,
    input: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal('context'),
    source: z.string(),
    metadata: z.string().optional(),
    items: z.array(contextItemSchema),
    omittedItems: count.optional(),
  }),
]);

const recordEntrySchema = z.object({
  kind: z.literal('record'),
  v: z.number().int().positive(),
  at: z.iso.datetime(),
  messageId: z.string(),
  role: z.enum(['system', 'user', 'assistant']),
  record: recordSchema,
  omittedRecords: count.optional(),
});
