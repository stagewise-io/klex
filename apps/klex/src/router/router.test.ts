import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { IntrospectionScope } from '@/introspection';
import type { Mcp, McpPushNotification } from '@/mcp';
import { type SessionInboxEvent, SessionInboxUrgency } from '@/session/inbox';
import type { AgentSession } from '@/session/types';

import { createRouter } from './router';

function createIntrospectionMock(): IntrospectionScope {
  const make = (path: string[]): IntrospectionScope => {
    const children = new Set<string>();
    return {
      path,
      introspect: () => undefined,
      child: (id) => {
        if (children.has(id)) throw new Error(`Duplicate child: ${id}`);
        children.add(id);
        return make([...path, id]);
      },
      removeChild: (id) => {
        children.delete(id);
      },
    };
  };
  return make([]);
}

function setup() {
  const sent: SessionInboxEvent[] = [];
  let listener:
    | ((event: McpPushNotification) => void | Promise<void>)
    | undefined;
  const logging = {
    child: () => ({
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
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
  const introspection = createIntrospectionMock();
  const router = createRouter({
    logging,
    mcp,
    introspection,
    createChatSession: () => session,
  });

  return {
    emit(event: McpPushNotification) {
      if (!listener) throw new Error('Router is not listening');
      return listener(event);
    },
    router,
    sent,
  };
}

const envelope = {
  eventId: 'event-1',
  sourceId: 'telegram:77',
  type: 'chat.message.received',
  createdAt: '2026-07-20T10:30:00.000Z',
};

describe('Router Push Notification adaptation', () => {
  it('passes through content blocks without validation', async () => {
    const harness = setup();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/ogg' },
          { type: 'text', text: 'second' },
        ],
        data: { senderId: '40', nested: { z: 2, a: 1 }, chatId: '30' },
      },
    });

    expect(harness.sent).toEqual([
      {
        sourceEnv: 'telegram',
        urgency: SessionInboxUrgency.Default,
        context: {
          sourceEnv: 'telegram',
          metadata: {
            type: 'chat.message.received',
            createdAt: '2026-07-20T10:30:00.000Z',
            senderId: '40',
            chatId: '30',
            nested: { z: 2, a: 1 },
          },
          content: [
            { type: 'text', text: 'first' },
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/ogg' },
            { type: 'text', text: 'second' },
          ],
        },
      },
    ]);
  });

  it('awaits session delivery before publication settles', async () => {
    const harness = setup();
    await harness.router.start();
    let release: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(harness.router, 'sendInput').mockReturnValue(delivery);

    let settled = false;
    const publication = harness
      .emit({ namespace: 'telegram', event: { ...envelope, content: [] } })
      ?.then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await publication;
    expect(settled).toBe(true);
  });

  it('maps resource_link blocks to resource_link content', async () => {
    const harness = setup();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          {
            type: 'resource_link',
            uri: 'file:///message.txt',
            name: 'message.txt',
            title: 'Message',
            description: 'An embedded text message',
            mimeType: 'text/plain',
            size: 42,
          },
        ],
      },
    });

    expect(harness.sent[0]?.context.content).toEqual([
      {
        type: 'resource_link',
        uri: 'file:///message.txt',
        name: 'message.txt',
        title: 'Message',
        description: 'An embedded text message',
        mimeType: 'text/plain',
        size: 42,
      },
    ]);
  });

  it('maps embedded resource blocks with text contents', async () => {
    const harness = setup();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///message.txt',
              mimeType: 'text/plain',
              text: 'embedded message',
            },
          },
        ],
      },
    });

    expect(harness.sent[0]?.context.content).toEqual([
      {
        type: 'resource',
        resource: {
          uri: 'file:///message.txt',
          mimeType: 'text/plain',
          text: 'embedded message',
        },
      },
    ]);
  });

  it('maps embedded resource blocks with blob contents', async () => {
    const harness = setup();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///image.png',
              mimeType: 'image/png',
              blob: 'aW1hZ2U=',
            },
          },
        ],
      },
    });

    expect(harness.sent[0]?.context.content).toEqual([
      {
        type: 'resource',
        resource: {
          uri: 'file:///image.png',
          mimeType: 'image/png',
          blob: 'aW1hZ2U=',
        },
      },
    ]);
  });

  it('silently omits unknown content block types', async () => {
    const harness = setup();
    await harness.router.start();

    await harness.emit({
      namespace: 'telegram',
      event: {
        ...envelope,
        content: [
          // Simulate a future/unknown block type that the router doesn't know.
          { type: 'unknown_future_type', data: 'x' } as never,
        ],
      },
    });

    expect(harness.sent[0]?.context.content).toEqual([]);
  });

  it('supports close followed by start without leaking scopes', async () => {
    const harness = setup();

    await harness.router.start();
    await harness.router.close();
    await harness.router.start();

    await harness.router.close();
  });
});
