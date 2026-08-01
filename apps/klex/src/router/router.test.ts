import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { Mcp, McpPushNotification } from '@/mcp';
import { type SessionInboxEvent, SessionInboxPriority } from '@/session/inbox';
import type { AgentSession } from '@/session/types';

import { createRouter } from './router';

function setup() {
  const sent: SessionInboxEvent[] = [];
  const warn = vi.fn();
  let listener:
    | ((event: McpPushNotification) => void | Promise<void>)
    | undefined;
  const logging = {
    child: () => ({
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn,
    }),
  } as unknown as RootLogger;
  const mcp = {
    onPushNotification: (
      next: (event: McpPushNotification) => void | Promise<void>,
    ) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as Mcp;
  const session = {
    status: 'active',
    inbox: { send: (event: SessionInboxEvent) => sent.push(event) },
    start: async () => undefined,
    close: async () => undefined,
  } as unknown as AgentSession;
  const router = createRouter({
    logging,
    mcp,
    createChatSession: () => session,
  });

  return {
    emit(event: McpPushNotification) {
      if (!listener) throw new Error('Router is not listening');
      return listener(event);
    },
    router,
    sent,
    warn,
  };
}

const envelope = {
  eventId: 'event-1',
  sourceId: 'telegram:77',
  type: 'chat.message.received',
  createdAt: '2026-07-20T10:30:00.000Z',
};

describe('Router Push Notification adaptation', () => {
  it('preserves ordered text and deterministically serialized event data', async () => {
    const harness = setup();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          { type: 'text', text: 'second' },
        ],
        data: { senderId: '40', nested: { z: 2, a: 1 }, chatId: '30' },
      },
    });

    expect(harness.sent).toEqual([
      {
        sourceEnv: 'telegram:77',
        priority: SessionInboxPriority.Medium,
        context: {
          sourceEnv: 'telegram:77',
          metadata: {
            eventId: 'event-1',
            namespace: 'telegram',
            type: 'chat.message.received',
            createdAt: '2026-07-20T10:30:00.000Z',
          },
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
            {
              type: 'text',
              text: 'Event data: {"chatId":"30","nested":{"a":1,"z":2},"senderId":"40"}',
            },
          ],
        },
      },
    ]);
    expect(harness.warn).toHaveBeenCalledWith(
      { eventId: 'event-1', contentTypes: ['image'] },
      'Router omitted unsupported Push Notification content blocks',
    );
  });

  it('handles missing data and explicitly omits unsupported content', async () => {
    const harness = setup();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [{ type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/ogg' }],
      },
    });

    expect(harness.sent[0]?.context.content).toEqual([]);
    expect(harness.warn).toHaveBeenCalledWith(
      { eventId: 'event-1', contentTypes: ['audio'] },
      'Router omitted unsupported Push Notification content blocks',
    );
  });
});
