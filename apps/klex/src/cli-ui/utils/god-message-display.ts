import type { SerializedMessage, SerializedPart } from '../api-client';

const MAX_JSON_LENGTH = 100;

export interface GodChatEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

function stringifyBounded(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return '[unserializable]';
    return json.length > MAX_JSON_LENGTH
      ? `${json.slice(0, MAX_JSON_LENGTH)}...`
      : json;
  } catch {
    return '[unserializable]';
  }
}

function extractGodMessageText(parts: SerializedPart[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type !== 'data-god-message') continue;
    const data = part.data;
    if (!data || typeof data !== 'object') continue;
    const content = (data as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        texts.push((block as { text: string }).text);
      }
    }
  }
  return texts.join('\n');
}

function extractAgentText(parts: SerializedPart[]): string {
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text) lines.push(part.text);
      continue;
    }
    if (part.type !== 'tool-invocation') continue;

    const toolName =
      typeof part.toolName === 'string' ? part.toolName : 'unknown-tool';
    if (part.state === 'input-available' || part.state === 'input-streaming') {
      lines.push(`Running ${toolName}(${stringifyBounded(part.args ?? {})})`);
    } else if (part.state === 'output-available') {
      lines.push(`${toolName}() → ${stringifyBounded(part.result ?? '')}`);
    } else if (part.state === 'output-error') {
      const result = part.result;
      const message =
        result &&
        typeof result === 'object' &&
        typeof (result as { error?: unknown }).error === 'string'
          ? (result as { error: string }).error
          : typeof result === 'string'
            ? result
            : stringifyBounded(result ?? 'unknown error');
      lines.push(`${toolName}() → error: ${message}`);
    }
  }
  return lines.join('\n');
}

export function toGodChatEntries(
  messages: SerializedMessage[],
): GodChatEntry[] {
  const entries: GodChatEntry[] = [];
  for (const message of messages) {
    const role = message.role === 'user' ? 'user' : 'assistant';
    const text =
      role === 'user'
        ? extractGodMessageText(message.parts)
        : extractAgentText(message.parts);
    if (text) entries.push({ id: message.id, role, text });
  }
  return entries;
}

export function maxScrollOffset(
  entryCount: number,
  viewportHeight: number,
): number {
  return Math.max(0, entryCount - viewportHeight);
}

export function getVisibleChatEntries(
  entries: GodChatEntry[],
  viewportHeight: number,
  requestedOffset: number,
): { visible: GodChatEntry[]; scrollOffset: number } {
  const scrollOffset = Math.min(
    Math.max(0, requestedOffset),
    maxScrollOffset(entries.length, viewportHeight),
  );
  const end = entries.length - scrollOffset;
  const start = Math.max(0, end - viewportHeight);
  return { visible: entries.slice(start, end), scrollOffset };
}
