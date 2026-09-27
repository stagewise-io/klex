import type { FittedRecord } from '@/session/chat/utils/history-view';

import {
  createEpisodeHeader,
  createEpisodeRecordEntry,
  type EpisodeRecordInput,
  parseEpisodeRecordLine,
} from './episode-format';

export const HEADER_LINE = `${JSON.stringify(createEpisodeHeader())}\n`;

/** Assistant text record; its line text is `your_output\n¦<text>`. */
export function output(text: string, messageId = 'm1'): EpisodeRecordInput {
  return { messageId, role: 'assistant', record: { kind: 'text', text } };
}

export function input(
  record: FittedRecord,
  overrides: Partial<EpisodeRecordInput> = {},
): EpisodeRecordInput {
  return { messageId: 'm1', role: 'assistant', record, ...overrides };
}

/** One serialized record line, as the store writes it. */
export function recordLine(record: EpisodeRecordInput, at: string): string {
  return `${JSON.stringify(createEpisodeRecordEntry(record, new Date(at)))}\n`;
}

/** Header plus one line per record, all stamped with `at`. */
export function episodeFile(
  at: string,
  ...records: EpisodeRecordInput[]
): string {
  return HEADER_LINE + records.map((record) => recordLine(record, at)).join('');
}

/** Texts of the assistant text records in an episode file. */
export function outputTexts(content: string): string[] {
  return content.split('\n').flatMap((line) => {
    const entry = parseEpisodeRecordLine(line);
    return entry?.record.kind === 'text' ? [entry.record.text] : [];
  });
}
