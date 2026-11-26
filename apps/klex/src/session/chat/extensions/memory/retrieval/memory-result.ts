import type { ExtendedUIMessage } from '@/session/chat/message-types';
import { field, renderDataBlock } from '@/session/chat/utils/history-view';

/**
 * Wraps retrieval output so the main session and filters can recognize it.
 * The legacy recall-result ingress, distinct from auto-load data parts.
 * New results use bot-prefixed content; legacy XML remains read-compatible.
 */
export function wrapMemoryResult(text: string): string {
  return renderDataBlock({
    type: 'memory-result',
    fields: [field('content', text.trim(), 'bot')],
  });
}

/** True for user messages carrying a memory-retrieval result. */
export function isMemoryResultMessage(message: ExtendedUIMessage): boolean {
  return message.parts.some(
    (part) =>
      part.type === 'text' &&
      (/^<memory>\s/iu.test(part.text) ||
        (message.id.startsWith('memory-result:') &&
          part.text.startsWith('# memory-result\ncontent: |\n~ '))),
  );
}
