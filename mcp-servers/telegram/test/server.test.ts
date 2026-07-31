import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createEventStore } from '../src/event-store.js';
import { createTelegramMcp } from '../src/mcp.js';
import {
  createTelegramChannel,
  type TelegramBot,
  type TelegramChannel,
} from '../src/telegram.js';

const logging = createLogger({ type: 'hidden' });
const channels: TelegramChannel[] = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.close();
});

function createFakeBot(getMeError?: Error) {
  type Raw = Parameters<Parameters<TelegramBot['onText']>[0]>[0];
  let listener: ((message: Raw) => void | Promise<void>) | undefined;
  const sends: {
    chatId: string;
    message: string;
    replyToMessageId?: number;
  }[] = [];
  let startCount = 0;
  let stopCount = 0;
  const bot: TelegramBot = {
    async getMe() {
      if (getMeError) throw getMeError;
      return { id: 77 };
    },
    onText(value) {
      listener = value;
    },
    async start() {
      startCount += 1;
      await new Promise(() => {});
    },
    async stop() {
      stopCount += 1;
    },
    async sendText(chatId, message, replyToMessageId) {
      sends.push({ chatId, message, replyToMessageId });
      return 99;
    },
  };
  return {
    bot,
    sends,
    emit(message: Partial<Raw> = {}) {
      return listener?.({
        updateId: 10,
        messageId: 20,
        chatId: 30,
        chatType: 'private',
        senderId: 40,
        senderIsBot: false,
        text: ' hello ',
        date: 1_700_000_000,
        ...message,
      });
    },
    startCount: () => startCount,
    stopCount: () => stopCount,
  };
}

async function createStartedChannel(
  fake = createFakeBot(),
  onMessage: Parameters<
    typeof createTelegramChannel
  >[0]['onMessage'] = () => {},
) {
  const channel = createTelegramChannel({
    token: 'test-token',
    allowedUserIds: new Set(['40']),
    logging,
    onMessage,
    botFactory: () => fake.bot,
  });
  channels.push(channel);
  await channel.start();
  return { channel, fake };
}

async function jsonRpc(
  mcp: ReturnType<typeof createTelegramMcp>,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await mcp.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        ...body,
        params: {
          ...(typeof body.params === 'object' ? body.params : {}),
          _meta: {
            'io.modelcontextprotocol/clientCapabilities': {
              extensions: { 'io.stagewise/push-notifications': {} },
            },
          },
        },
      }),
    }),
  );
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  return JSON.parse(data ?? text);
}

describe('event store', () => {
  it('deduplicates and hides acknowledged events', () => {
    const store = createEventStore();
    const message = {
      botId: '77',
      updateId: '10',
      messageId: '20',
      chatId: '30',
      senderId: '40',
      text: 'hello',
      receivedAt: '2026-01-01T00:00:00.000Z',
    };
    const notification = store.append(message);
    store.append(message);
    expect(store.page()).toMatchObject({
      events: [
        {
          eventId: 'telegram:77:update:10',
          sourceId: 'telegram:77',
          payload: { updateId: '10', message: 'hello' },
        },
      ],
      hasMore: false,
    });
    store.acknowledge([notification.event.eventId]);
    expect(store.page()).toEqual({ events: [], hasMore: false });
    expect(() => store.acknowledge([notification.event.eventId])).not.toThrow();
    expect(() => store.acknowledge(['unknown'])).not.toThrow();
  });

  it('pages over the oldest unacknowledged events without cursors', () => {
    const store = createEventStore();
    const message = {
      botId: '77',
      messageId: '20',
      chatId: '30',
      senderId: '40',
      text: 'hello',
      receivedAt: '2026-01-01T00:00:00.000Z',
    };
    const first = store.append({ ...message, updateId: '10' });
    store.append({ ...message, updateId: '11' });

    expect(store.page({ limit: 1 })).toMatchObject({
      events: [{ eventId: first.event.eventId }],
      hasMore: true,
    });
    store.acknowledge([first.event.eventId]);
    expect(store.page({ limit: 1 })).toMatchObject({
      events: [{ eventId: 'telegram:77:update:11' }],
      hasMore: false,
    });
  });
});

describe('Telegram channel', () => {
  it('accepts only allowlisted private user text', async () => {
    const received: unknown[] = [];
    const { fake } = await createStartedChannel(createFakeBot(), (message) => {
      received.push(message);
    });
    await fake.emit();
    await fake.emit({ chatType: 'group' });
    await fake.emit({ senderId: 41 });
    await fake.emit({ senderIsBot: true });
    await fake.emit({ text: ' ' });
    expect(received).toEqual([
      {
        botId: '77',
        updateId: '10',
        messageId: '20',
        chatId: '30',
        senderId: '40',
        text: 'hello',
        receivedAt: '2023-11-14T22:13:20.000Z',
      },
    ]);
  });

  it('sends only to allowlisted chats with an optional native reply', async () => {
    const { channel, fake } = await createStartedChannel();
    await expect(
      channel.sendText({ chatId: '41', message: 'blocked' }),
    ).rejects.toThrow('not allowed');
    await expect(
      channel.sendText({
        chatId: '40',
        message: 'reply',
        replyToMessageId: '20',
      }),
    ).resolves.toEqual({ messageId: '99' });
    expect(fake.sends).toEqual([
      { chatId: '40', message: 'reply', replyToMessageId: 20 },
    ]);
  });

  it('validates identity and keeps lifecycle idempotent', async () => {
    const fake = createFakeBot();
    const { channel } = await createStartedChannel(fake);
    await channel.start();
    await channel.close();
    await channel.close();
    expect(fake.startCount()).toBe(1);
    expect(fake.stopCount()).toBe(1);

    const failed = createTelegramChannel({
      token: 'bad',
      allowedUserIds: new Set(['40']),
      logging,
      onMessage: () => {},
      botFactory: () => createFakeBot(new Error('unauthorized')).bot,
    });
    await expect(failed.start()).rejects.toThrow('unauthorized');
    expect(failed.status()).toBe('disconnected');
  });
});

describe('MCP contract', () => {
  it('retrieves events and delegates sendMessage', async () => {
    const store = createEventStore();
    const { channel, fake } = await createStartedChannel(
      createFakeBot(),
      (message) => {
        store.append(message);
      },
    );
    await fake.emit();
    const mcp = createTelegramMcp(channel, store);
    try {
      expect(
        await jsonRpc(mcp, {
          method: 'io.stagewise/push-notifications/get',
          params: { limit: 100 },
        }),
      ).toMatchObject({
        result: { events: [{ payload: { message: 'hello' } }] },
      });
      expect(
        await jsonRpc(mcp, {
          method: 'tools/call',
          params: {
            name: 'sendMessage',
            arguments: {
              chatId: '40',
              message: 'reply',
              replyToMessageId: '20',
            },
          },
        }),
      ).toMatchObject({ result: { content: [{ type: 'text' }] } });
      expect(fake.sends).toEqual([
        { chatId: '40', message: 'reply', replyToMessageId: 20 },
      ]);
    } finally {
      await mcp.close();
      store.close();
    }
  });
});
