import { describe, expect, it } from 'vitest';

import type { PushNotification } from '@stagewise/mcp-extension-push-notifications';

import { SessionInboxUrgency } from '@/session/inbox';

import { mcpPushNotificationToInboxEvent } from './push-notification-adapter';

function createNotification(data?: PushNotification['data']): PushNotification {
  return {
    eventId: 'event-1',
    sourceId: 'chat:user',
    type: 'chat.message.received',
    createdAt: '2026-07-20T10:30:00.000Z',
    content: [{ type: 'text', text: 'hello' }],
    ...(data !== undefined && { data }),
  };
}

describe('mcpPushNotificationToInboxEvent', () => {
  it('maps the stable MCP fields into session context', () => {
    const event = mcpPushNotificationToInboxEvent({
      namespace: 'local',
      event: createNotification(),
    });

    expect(event).toEqual({
      eventId: 'local:event-1',
      sourceEnv: 'local',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'local',
        metadata: {
          sourceId: 'chat:user',
          type: 'chat.message.received',
          createdAt: '2026-07-20T10:30:00.000Z',
        },
        content: [{ type: 'text', text: 'hello' }],
      },
    });
  });

  it('does not let event data overwrite reserved metadata keys', () => {
    const event = mcpPushNotificationToInboxEvent({
      namespace: 'local',
      event: createNotification({
        sourceId: 'spoofed',
        type: 'spoofed',
        createdAt: 'spoofed',
        constructor: 'safe',
        ['__proto__']: 'safe',
        nullable: null,
      }),
    });

    expect(event.context.metadata).toMatchObject({
      sourceId: 'chat:user',
      type: 'chat.message.received',
      createdAt: '2026-07-20T10:30:00.000Z',
      constructor: 'safe',
      nullable: null,
    });
    expect(Object.hasOwn(event.context.metadata, '__proto__')).toBe(true);
    expect(Reflect.get(event.context.metadata, '__proto__')).toBe('safe');
  });
});
