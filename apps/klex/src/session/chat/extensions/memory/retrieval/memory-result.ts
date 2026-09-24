import type { ExtendedUIMessage } from '@/session/chat/message-types';

/** Opening or closing `memory` tag, tolerant of whitespace and attributes. */
const MEMORY_TAG = /<(\s*\/?\s*memory\b)/giu;

/**
 * Wraps retrieval output so the main session and filters can recognize it.
 * The only way memory may enter the main session. Memory tags inside `text`
 * are defused, so content can neither close the block early nor open a
 * forged one.
 */
export function wrapMemoryResult(text: string): string {
  const body = text.trim().replace(MEMORY_TAG, '\uFF1C$1');
  return `<memory>\n${body}\n</memory>`;
}

/** True for user messages carrying a memory-retrieval result. */
export function isMemoryResultMessage(message: ExtendedUIMessage): boolean {
  return message.parts.some(
    (part) => part.type === 'text' && /^<memory>\s/iu.test(part.text),
  );
}
