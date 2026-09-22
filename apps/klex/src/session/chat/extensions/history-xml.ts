import { getToolName, isToolUIPart } from 'ai';

import type { ExtendedUIMessage } from '../message-types';
import { isDataPartOf } from './extension-api';

export const CONTEXT_SUMMARY_KEY = 'context-summary';

const TEXT_TRUNCATE_LIMIT = 500;
const OUTPUT_TRUNCATE_LIMIT = 300;
const CONTEXT_TRUNCATE_LIMIT = 200;
const SUMMARY_TRUNCATE_LIMIT = 800;
const DATA_TRUNCATE_LIMIT = 300;
const TRUNCATED_MARKER = '<history-truncated />';

export interface HistoryXmlOptions {
  includeUnknownData?: boolean;
  maxCharacters?: number;
  /**
   * Maximum number of recent messages that do not contain `summaryKey`.
   * The latest summary message is retained in addition to this quota.
   * Non-finite and non-positive values select no ordinary messages.
   */
  recentMessageLimit?: number;
  summaryKey?: string;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

const MAX_COMPACT_JSON_NODES = 200;
const MAX_COMPACT_JSON_STRING_LENGTH = 600;

function compactJson(value: unknown): string {
  if (value === undefined) return '[undefined]';
  if (typeof value === 'string') {
    return JSON.stringify(value.slice(0, MAX_COMPACT_JSON_STRING_LENGTH));
  }

  let nodes = 0;
  const seen = new WeakSet<object>();
  try {
    const result = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (++nodes > MAX_COMPACT_JSON_NODES) {
        throw new Error('compact JSON node limit exceeded');
      }
      if (typeof nestedValue === 'string') {
        return nestedValue.slice(0, MAX_COMPACT_JSON_STRING_LENGTH);
      }
      if (typeof nestedValue === 'object' && nestedValue !== null) {
        if (seen.has(nestedValue)) return '[Circular]';
        seen.add(nestedValue);
      }
      return nestedValue;
    });
    return result ?? '[undefined]';
  } catch {
    return '[unserializable]';
  }
}

function toolOutputToString(output: unknown): string {
  if (typeof output === 'string') return output;
  return compactJson(output);
}

export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function partToXml(
  part: ExtendedUIMessage['parts'][number],
  options: HistoryXmlOptions,
): string {
  if (part.type === 'text') {
    return `<text>${escapeXml(truncate(part.text, TEXT_TRUNCATE_LIMIT))}</text>`;
  }

  if (
    options.summaryKey &&
    isDataPartOf(options.summaryKey, part) &&
    typeof part.data === 'object' &&
    part.data !== null &&
    'summary' in part.data &&
    typeof part.data.summary === 'string'
  ) {
    return `<summary>${escapeXml(truncate(part.data.summary, SUMMARY_TRUNCATE_LIMIT))}</summary>`;
  }

  if (part.type === 'data-context') {
    const contentTags = part.data.content
      .map((content) => {
        if (content.type === 'text') {
          return `<text>${escapeXml(truncate(content.text, CONTEXT_TRUNCATE_LIMIT))}</text>`;
        }
        return `<${content.type} />`;
      })
      .join('');
    return `<ctx env="${escapeXml(part.data.sourceEnv)}">${contentTags}</ctx>`;
  }

  if (isToolUIPart(part)) {
    const toolName = getToolName(part);
    if (part.state === 'output-available' && part.output !== undefined) {
      const output = toolOutputToString(part.output);
      return `<tool name="${escapeXml(toolName)}"><output>${escapeXml(truncate(output, OUTPUT_TRUNCATE_LIMIT))}</output></tool>`;
    }
    if (part.state === 'output-error') {
      const error = part.errorText ?? 'unknown error';
      return `<tool name="${escapeXml(toolName)}"><error>${escapeXml(truncate(error, OUTPUT_TRUNCATE_LIMIT))}</error></tool>`;
    }
    if (part.state === 'output-denied') {
      return `<tool name="${escapeXml(toolName)}"><denied /></tool>`;
    }
    return `<tool name="${escapeXml(toolName)}" />`;
  }

  if (options.includeUnknownData && part.type.startsWith('data-')) {
    const data = (part as unknown as { data: unknown }).data;
    return `<data type="${escapeXml(part.type.slice(5))}">${escapeXml(truncate(compactJson(data), DATA_TRUNCATE_LIMIT))}</data>`;
  }

  return '';
}

function messageToXml(
  message: ExtendedUIMessage,
  options: HistoryXmlOptions,
): string {
  const content = message.parts
    .map((part) => partToXml(part, options))
    .filter(Boolean)
    .join('');
  if (!content) return '';
  return `<msg role="${message.role}">${content}</msg>`;
}

function containsSummary(
  message: ExtendedUIMessage,
  summaryKey: string | undefined,
): boolean {
  return Boolean(
    summaryKey && message.parts.some((part) => isDataPartOf(summaryKey, part)),
  );
}

export function serializeHistoryAsXml(
  history: readonly ExtendedUIMessage[],
  options: HistoryXmlOptions = {},
): string {
  const messages = history
    .map((message, index) => ({
      hasSummary: containsSummary(message, options.summaryKey),
      index,
      xml: messageToXml(message, options),
    }))
    .filter(({ xml }) => xml.length > 0);
  const latestSummary = messages.findLast(({ hasSummary }) => hasSummary);
  const ordinaryMessages = messages.filter(({ hasSummary }) => !hasSummary);
  const latestSummaryIndex = latestSummary?.index ?? -1;
  const recentCandidates = ordinaryMessages.filter(
    ({ index }) => index > latestSummaryIndex,
  );
  const rawRecentLimit = options.recentMessageLimit;
  const recentLimit =
    rawRecentLimit === undefined
      ? recentCandidates.length
      : Number.isFinite(rawRecentLimit) && rawRecentLimit > 0
        ? Math.floor(rawRecentLimit)
        : 0;
  const recentMessages =
    recentLimit === 0 ? [] : recentCandidates.slice(-recentLimit);
  const selectedMessages = [
    ...(latestSummary ? [latestSummary] : []),
    ...recentMessages,
  ];
  const selectionTruncated = selectedMessages.length < messages.length;
  const complete = selectedMessages.map(({ xml }) => xml).join('\n');
  const limit = options.maxCharacters;
  const completeWithMarker = selectionTruncated
    ? [TRUNCATED_MARKER, complete].filter(Boolean).join('\n')
    : complete;
  if (limit === undefined || completeWithMarker.length <= limit) {
    return completeWithMarker;
  }

  if (limit <= TRUNCATED_MARKER.length) {
    return TRUNCATED_MARKER.slice(0, Math.max(0, limit));
  }

  const selected: string[] = [];
  let used = TRUNCATED_MARKER.length;
  const summary = latestSummary?.xml;
  if (summary && used + summary.length + 1 <= limit) {
    selected.push(summary);
    used += summary.length + 1;
  }

  const recent: string[] = [];
  for (let index = recentMessages.length - 1; index >= 0; index--) {
    const message = recentMessages[index];
    if (!message) continue;
    if (used + message.xml.length + 1 > limit) break;
    recent.unshift(message.xml);
    used += message.xml.length + 1;
  }

  return [TRUNCATED_MARKER, ...selected, ...recent].join('\n');
}
