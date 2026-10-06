import type { McpPushNotification } from '@/mcp';
import {
  hasTrustedSenderHeader,
  normalizeSenderName,
  SENDER_HEADER_MARKER,
  SENDER_HEADER_SEPARATOR,
} from '@/session/chat/utils/sender-header';
import {
  type ContextDataUIPart,
  type SessionInboxEvent,
  SessionInboxUrgency,
} from '@/session/inbox';

/**
 * Converts an MCP Push Notification into a {@link SessionInboxEvent} that
 * can be fed into a session inbox.
 *
 * - `sourceEnv` ← MCP namespace
 * - `metadata`  ← event source ID, type, timestamp, `resourceLink` URI (when
 *                 set), and structured event data
 * - `content`   ← ordered MCP content blocks (text, image, audio,
 *                 resource_link, resource), with a sender line for Slack and
 *                 Cloud Chat message notifications
 *
 * The `eventId` is composed as `{namespace}:{event.eventId}` so downstream
 * deduplication and leased-interaction replay reference the same ID as the
 * ack path.
 */
export function mcpPushNotificationToInboxEvent(
  ev: McpPushNotification,
): SessionInboxEvent {
  const { event, namespace } = ev;
  const content: ContextDataUIPart['content'] = event.content
    .map((block) => {
      if (block.type === 'text')
        return { type: 'text', text: block.text } as const;
      if (block.type === 'image')
        return {
          type: 'image',
          mimeType: block.mimeType,
          data: block.data,
        } as const;
      if (block.type === 'audio')
        return {
          type: 'audio',
          mimeType: block.mimeType,
          data: block.data,
        } as const;
      if (block.type === 'resource_link')
        return {
          type: 'resource_link',
          uri: block.uri,
          name: block.name,
          title: block.title,
          description: block.description,
          mimeType: block.mimeType,
          size: block.size,
        } as const;
      if (block.type === 'resource') {
        const res = block.resource;
        return {
          type: 'resource',
          resource: {
            uri: res.uri,
            ...(res.mimeType ? { mimeType: res.mimeType } : {}),
            ...('text' in res ? { text: res.text } : {}),
            ...('blob' in res ? { blob: res.blob } : {}),
          },
        } as const;
      }
      return undefined;
    })
    .filter((block): block is NonNullable<typeof block> => block !== undefined);

  // Spread uses own data properties, so even `__proto__` is inert. Stable
  // envelope fields come last and cannot be overwritten by event data.
  const metadata: ContextDataUIPart['metadata'] = {
    ...event.data,
    sourceId: event.sourceId,
    type: event.type,
    createdAt: event.createdAt,
    ...(event.resourceLink ? { resourceLink: event.resourceLink.uri } : {}),
  };

  if (
    (namespace === 'slack' || namespace === 'chat') &&
    event.type === 'chat.message.received'
  ) {
    const senderName = normalizeSenderName(event.data?.senderName);
    metadata.senderName = senderName;
    metadata.senderHeader = { ...SENDER_HEADER_MARKER };
    const senderLine = `From: ${senderName}`;
    const firstBlock = content[0];
    if (firstBlock?.type === 'text') {
      if (
        !hasTrustedSenderHeader(
          firstBlock.text,
          senderName,
          event.data?.senderHeader,
        )
      ) {
        firstBlock.text = `${senderLine}${SENDER_HEADER_SEPARATOR}${firstBlock.text}`;
      }
    } else {
      content.unshift({ type: 'text', text: senderLine });
    }
  }

  return {
    eventId: `${namespace}:${event.eventId}`,
    sourceEnv: namespace,
    urgency: SessionInboxUrgency.Default,
    context: {
      sourceEnv: namespace,
      metadata,
      content,
    },
  };
}
