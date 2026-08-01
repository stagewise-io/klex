import { describe, expect, it } from 'vitest';

import type { PushNotification } from '@stagewise/mcp-extension-push-notifications';

import { createInMemoryPushNotificationInbox } from './push-notification-inbox';

const event: PushNotification = {
  eventId: 'event-1',
  sourceId: 'chat:local',
  type: 'chat.message.received',
  createdAt: '2026-07-20T10:30:00.000Z',
  content: [{ type: 'text', text: 'hello' }],
  data: { messageId: 'message-1' },
};

describe('In-memory Push Notification inbox', () => {
  it('deduplicates events within a namespace and preserves order', async () => {
    const inbox = createInMemoryPushNotificationInbox();
    const second = { ...event, eventId: 'event-2' };

    await expect(inbox.commit('chat', [event, second, event])).resolves.toEqual(
      [event, second],
    );
    await expect(inbox.commit('chat', [event])).resolves.toEqual([]);
  });

  it('isolates event identifiers by namespace', async () => {
    const inbox = createInMemoryPushNotificationInbox();

    await expect(inbox.commit('chat-a', [event])).resolves.toEqual([event]);
    await expect(inbox.commit('chat-b', [event])).resolves.toEqual([event]);
  });

  it('does not expose mutable stored events', async () => {
    const inbox = createInMemoryPushNotificationInbox();
    const input = structuredClone(event);
    const accepted = await inbox.commit('chat', [input]);

    if (input.content[0]?.type === 'text') {
      input.content[0].text = 'changed input';
    }
    if (input.data) input.data.messageId = 'changed input';
    const acceptedEvent = accepted[0];
    if (acceptedEvent?.content[0]?.type === 'text') {
      acceptedEvent.content[0].text = 'changed result';
    }
    if (acceptedEvent?.data) acceptedEvent.data.messageId = 'changed result';

    await expect(inbox.commit('chat', [event])).resolves.toEqual([]);
  });
});
