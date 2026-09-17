import type { McpPushNotification } from '@/mcp';
import {
  type ContextDataUIPart,
  type ContextMetadataValue,
  type SessionInboxEvent,
  SessionInboxUrgency,
} from '@/session/inbox';

/**
 * Converts an MCP Push Notification into a {@link SessionInboxEvent} that
 * can be fed into a session inbox.
 *
 * - `sourceEnv` ← MCP namespace
 * - `metadata`  ← event source ID, type, timestamp, and structured event data
 * - `content`   ← ordered MCP content blocks (text, image, audio,
 *                 resource_link, resource), mapped 1:1
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
  };

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
