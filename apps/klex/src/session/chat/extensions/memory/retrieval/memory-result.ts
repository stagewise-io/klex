import type { ExtendedUIMessage } from '@/session/chat/message-types';

/** Wraps retrieval output so the main session and filters can recognize it. */
export function wrapMemoryResult(text: string): string {
  return `<memory>\n${text.trim()}\n</memory>`;
}

/** True for user messages carrying a memory-retrieval result. */
export function isMemoryResultMessage(message: ExtendedUIMessage): boolean {
  return message.parts.some(
    (part) => part.type === 'text' && /^<memory>\s/iu.test(part.text),
  );
}
