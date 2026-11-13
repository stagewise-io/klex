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
      origin: 'push-notifications',
      eventId: 'e1',
      sourceId: 'chat-42',
      type: 'message',
      createdAt: '2026-09-23T10:00:00.000Z',
      resourceLink: { uri: 'chat://whatsapp/42' },
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
      resourceLink: { uri: 'chat://whatsapp/42' },
      sourceId: 'chat-42',
      data: {
        resourceLink: 'spoofed',
        sourceId: 'spoofed',
        conversationId: 'c-1',
      },
    });
  });

  it('preserves Events semantic metadata without duplicating generated text or routing state', () => {
    const input = notification();
    input.occurrence = {
      eventId: 'upstream-42',
      name: 'message',
      timestamp: '2026-11-12T14:00:00Z',
      data: { thread: 't1', json: '{ "keep": [1, 2] }' },
      cursor: 'secret-cursor',
      _meta: {
        'io.modelcontextprotocol/subscriptionId': 7,
        'example.com/project': 'production',
      },
    };
    const inbox = mcpPushNotificationToInboxEvent(input);
    expect(inbox.context.metadata).toEqual({
      origin: 'events',
      eventId: 'upstream-42',
      type: 'message',
      createdAt: '2026-11-12T14:00:00Z',
      data: input.occurrence.data,
      _meta: { 'example.com/project': 'production' },
    });
    expect(inbox.context.content).toEqual([]);
  });

  it('prefixes the event id with the namespace', () => {
    const inbox = mcpPushNotificationToInboxEvent(notification());

    expect(inbox.eventId).toBe('whatsapp:e1');
    expect(inbox.sourceEnv).toBe('whatsapp');
  });
});
