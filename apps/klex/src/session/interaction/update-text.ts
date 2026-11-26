import {
  contextBlock,
  renderDataBlock,
} from '@/session/chat/utils/history-view';
import type { SessionInboxEvent } from '@/session/inbox';

/**
 * Renders a canonical inbox event as a single plain-text block for
 * interaction modes that can only accept text input.
 *
 * The framing shares the chat path's typed context projection, so a
 * notification reads the same way whether the model sees it through chat
 * generation or through a realtime conversation item.
 *
 * Binary content (image/audio blobs) is reduced to a descriptive
 * placeholder: realtime text items cannot carry it, and inlining base64
 * payloads would corrupt the conversation.
 */
export function renderInteractionUpdateText(event: SessionInboxEvent): string {
  return renderDataBlock(contextBlock(event.context));
}
