import { describe, expect, it } from 'vitest';

import type { McpPushNotification } from '@/mcp';

import { mcpPushNotificationToInboxEvent } from './push-notification-adapter';

function notification(
  event: Partial<McpPushNotification['event']> = {},
): McpPushNotification {
  return {
    namespace: 'whatsapp',
    event: {
      eventId: 'e1',
      sourceId: 'chat-42',
      type: 'message',
      createdAt: '2026-09-23T10:00:00.000Z',
      content: [{ type: 'text', text: 'hello' }],
      ...event,
    },
  };
}

describe('mcpPushNotificationToInboxEvent', () => {
  it('carries the resource link URI into metadata', () => {
    const inbox = mcpPushNotificationToInboxEvent(
      notification({ resourceLink: { uri: 'chat://whatsapp/42' } }),
    );

    expect(inbox.context.metadata).toEqual({
      sourceId: 'chat-42',
      type: 'message',
      createdAt: '2026-09-23T10:00:00.000Z',
      resourceLink: 'chat://whatsapp/42',
    });
  });

  it('omits resourceLink when the event has none', () => {
    const inbox = mcpPushNotificationToInboxEvent(notification());

    expect(inbox.context.metadata).not.toHaveProperty('resourceLink');
  });

  it('keeps envelope fields over event data', () => {
    const inbox = mcpPushNotificationToInboxEvent(
      notification({
        data: {
          resourceLink: 'spoofed',
          sourceId: 'spoofed',
          conversationId: 'c-1',
        },
        resourceLink: { uri: 'chat://whatsapp/42' },
      }),
    );

    expect(inbox.context.metadata).toMatchObject({
      resourceLink: 'chat://whatsapp/42',
      sourceId: 'chat-42',
      conversationId: 'c-1',
    });
  });

  it('prefixes the event id with the namespace', () => {
    const inbox = mcpPushNotificationToInboxEvent(notification());

    expect(inbox.eventId).toBe('whatsapp:e1');
    expect(inbox.sourceEnv).toBe('whatsapp');
  });
});
