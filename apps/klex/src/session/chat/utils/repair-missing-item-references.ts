import type { ModelMessage } from 'ai';

import type { ExtendedUIMessage } from '../message-types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function extractMissingOpenAIItemId(error: unknown): string | null {
  const seen = new Set<unknown>();
  const pattern = /\bItem with id ['"]([^'"]+)['"] not found\b/i;
  function visit(value: unknown, depth: number): string | null {
    if (depth > 10 || seen.has(value)) return null;
    seen.add(value);
    if (typeof value === 'string') return pattern.exec(value)?.[1] ?? null;
    if (!isRecord(value)) return null;
    if (
      typeof value.statusCode !== 'number' ||
      value.statusCode === 404 ||
      value.statusCode === 400
    ) {
      for (const text of [value.message, value.responseBody]) {
        if (typeof text === 'string') {
          const match = pattern.exec(text);
          if (match) return match[1] ?? null;
        }
      }
    }
    return visit(value.lastError, depth + 1) ?? visit(value.cause, depth + 1);
  }
  return visit(error, 0);
}

/** Strip references without discarding inline encrypted reasoning or other providers. */
function stripPart(part: Record<string, unknown>, fields: string[]) {
  let modified = false;
  for (const field of fields) {
    const metadata = part[field];
    if (!isRecord(metadata)) continue;
    for (const provider of ['openai', 'azure']) {
      const options = metadata[provider];
      if (!isRecord(options)) continue;
      if (part.type === 'reasoning') {
        if (typeof options.itemId !== 'string') continue;
        if (
          typeof options.reasoningEncryptedContent === 'string' &&
          options.reasoningEncryptedContent.length > 0
        ) {
          delete options.itemId;
        } else {
          delete metadata[provider];
        }
      } else {
        if (options.itemId === undefined) continue;
        delete options.itemId;
        if (Object.keys(options).length === 0) delete metadata[provider];
      }
      modified = true;
      if (Object.keys(metadata).length === 0) delete part[field];
    }
  }
  const remove =
    modified &&
    ((part.type === 'reasoning' &&
      !fields.some((field) => {
        const metadata = part[field];
        return isRecord(metadata) && Object.keys(metadata).length > 0;
      })) ||
      (part.type === 'custom' && part.kind === 'openai.compaction'));
  return { modified, remove };
}

export function stripOpenAIItemReferencesFromMessage(
  message: ExtendedUIMessage,
): boolean {
  let modified = false;
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]!;
    const result = stripPart(
      part as unknown as Record<string, unknown>,
      part.type === 'reasoning'
        ? ['providerMetadata']
        : [
            'providerMetadata',
            'callProviderMetadata',
            'resultProviderMetadata',
          ],
    );
    if (result.remove) message.parts.splice(i, 1);
    modified = result.modified || modified;
  }
  return modified;
}

export function stripOpenAIItemReferencesFromMessages(
  messages: ExtendedUIMessage[],
): boolean {
  let modified = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (!stripOpenAIItemReferencesFromMessage(message)) continue;
    modified = true;
    if (
      message.role === 'assistant' &&
      !message.parts.some((p) => p.type !== 'step-start')
    ) {
      messages.splice(i, 1);
    }
  }
  return modified;
}

export function stripOpenAIItemReferencesFromModelMessages(
  modelMessages: ModelMessage[],
): boolean {
  let modified = false;
  for (let i = modelMessages.length - 1; i >= 0; i--) {
    const message = modelMessages[i]!;
    if (
      (message.role !== 'assistant' && message.role !== 'tool') ||
      !Array.isArray(message.content)
    )
      continue;
    let messageModified = false;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const result = stripPart(
        message.content[j]! as unknown as Record<string, unknown>,
        ['providerOptions', 'providerMetadata'],
      );
      if (result.remove) message.content.splice(j, 1);
      messageModified = result.modified || messageModified;
    }
    if (messageModified) {
      modified = true;
      if (message.content.length === 0) modelMessages.splice(i, 1);
    }
  }
  return modified;
}

export function stripOpenAIItemReferences(
  messages: ExtendedUIMessage[],
  modelMessages: ModelMessage[],
): boolean {
  const strippedMessages = stripOpenAIItemReferencesFromMessages(messages);
  const strippedModelMessages =
    stripOpenAIItemReferencesFromModelMessages(modelMessages);
  return strippedMessages || strippedModelMessages;
}
