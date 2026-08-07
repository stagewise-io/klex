import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createEventStore } from '../src/event-store.js';
import { createTelegramMcp } from '../src/mcp.js';
import {
  createTelegramChannel,
  downloadTelegramFile,
  type RawTelegramMessage,
  selectLargestPhoto,
  type TelegramBot,
  type TelegramChannel,
  type TelegramFileDownloadResult,
} from '../src/telegram.js';

const logging = createLogger({ type: 'hidden' });
const channels: TelegramChannel[] = [];

const textMessage = {
  botId: '77',
  updateId: '10',
  messageId: '20',
  chatId: '30',
  senderId: '40',
  kind: 'text' as const,
  text: 'hello',
  receivedAt: '2026-01-01T00:00:00.000Z',
};

const photoMessage = {
  botId: '77',
  updateId: '11',
  messageId: '21',
  chatId: '30',
  senderId: '40',
  kind: 'photo' as const,
  caption: 'caption',
  mimeType: 'image/jpeg',
  mediaData: 'AQID',
  mediaSize: 3,
  mediaStatus: 'included' as const,
  receivedAt: '2026-01-01T00:00:01.000Z',
};

afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.close();
  vi.useRealTimers();
});

function createFakeBot(getMeError?: Error) {
  let listener:
    | ((message: RawTelegramMessage) => void | Promise<void>)
    | undefined;
  const sends: {
    chatId: string;
    message: string;
    replyToMessageId?: number;
  }[] = [];
  const voiceSends: {
    chatId: string;
    voice: Uint8Array;
    caption?: string;
    duration?: number;
    replyToMessageId?: number;
  }[] = [];
  const photoSends: {
    chatId: string;
    photo: Uint8Array;
    caption?: string;
    replyToMessageId?: number;
  }[] = [];
  let profileName = 'Test Bot';
  let profileDescription = 'Test description';
  let profileShortDescription = 'Test short';
  const nameCalls: string[] = [];
  const descriptionCalls: string[] = [];
  const shortDescriptionCalls: string[] = [];
  const downloadCalls: string[] = [];
  const downloads = new Map<string, TelegramFileDownloadResult>();
  let startCount = 0;
  let stopCount = 0;
  const bot: TelegramBot = {
    async getMe() {
      if (getMeError) throw getMeError;
      return { id: 77 };
    },
    onMessage(value) {
      listener = value;
    },
    async downloadFile({ fileId }) {
      downloadCalls.push(fileId);
      return (
        downloads.get(fileId) ?? {
          status: 'included',
          bytes: new Uint8Array([1, 2, 3]),
        }
      );
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
    async sendVoice({ chatId, voice, caption, duration, replyToMessageId }) {
      voiceSends.push({ chatId, voice, caption, duration, replyToMessageId });
      return 100;
    },
    async sendPhoto({ chatId, photo, caption, replyToMessageId }) {
      photoSends.push({ chatId, photo, caption, replyToMessageId });
      return 101;
    },
    async setMyName(name) {
      nameCalls.push(name);
      profileName = name;
    },
    async setMyDescription(description) {
      descriptionCalls.push(description);
      profileDescription = description;
    },
    async setMyShortDescription(shortDescription) {
      shortDescriptionCalls.push(shortDescription);
      profileShortDescription = shortDescription;
    },
    async getMyName() {
      return profileName;
    },
    async getMyDescription() {
      return profileDescription;
    },
    async getMyShortDescription() {
      return profileShortDescription;
    },
    async getChat(chatId) {
      return {
        id: chatId,
        type: 'private',
        username: undefined,
        firstName: 'Test User',
        lastName: undefined,
        title: undefined,
      };
    },
  };
  return {
    bot,
    sends,
    voiceSends,
    photoSends,
    downloadCalls,
    downloads,
    nameCalls,
    descriptionCalls,
    shortDescriptionCalls,
    emit(message: Partial<RawTelegramMessage> = {}) {
      return listener?.({
        kind: 'text',
        updateId: 10,
        messageId: 20,
        chatId: 30,
        chatType: 'private',
        senderId: 40,
        senderIsBot: false,
        text: ' hello ',
        date: 1_700_000_000,
        ...message,
      } as RawTelegramMessage);
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
  options: { mediaMaxBytes?: number; mediaDownloadTimeoutMs?: number } = {},
) {
  const channel = createTelegramChannel({
    token: 'test-token',
    allowedUserIds: new Set(['40']),
    logging,
    onMessage,
    botFactory: () => fake.bot,
    ...options,
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
  it('deduplicates text events, pages oldest first, and deep-clones results', () => {
    const store = createEventStore();
    const first = store.append(textMessage);
    expect(first.isNew).toBe(true);
    expect(store.append(textMessage).isNew).toBe(false);
    store.append({ ...textMessage, updateId: '12' });
    expect(store.page({ limit: 1 })).toMatchObject({
      events: [
        {
          eventId: 'telegram:77:update:10',
          content: [{ type: 'text', text: 'hello' }],
          data: { messageId: '20', chatId: '30', senderId: '40' },
        },
      ],
      hasMore: true,
    });
    const event = store.page().events[0];
    if (event?.content[0]?.type === 'text') event.content[0].text = 'changed';
    if (event?.data) event.data.messageId = 'changed';
    expect(store.page().events[0]).toMatchObject({
      content: [{ type: 'text', text: 'hello' }],
      data: { messageId: '20' },
    });

    store.acknowledge([first.notification.event.eventId]);
    expect(store.append(textMessage).isNew).toBe(false);
    expect(() => store.acknowledge(['unknown'])).not.toThrow();
    store.close();
    expect(store.page()).toEqual({ events: [], hasMore: false });
  });

  it('stores multimodal blocks, applies queue budget, and releases it on ack', () => {
    const store = createEventStore({ pendingMediaMaxBytes: 3 });
    const first = store.append(photoMessage);
    expect(store.page().events[0]).toMatchObject({
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'AQID', mimeType: 'image/jpeg' },
      ],
      data: {
        mediaKind: 'photo',
        mediaStatus: 'included',
        mediaSize: 3,
      },
    });
    store.append({ ...photoMessage, updateId: '12', kind: 'voice' });
    expect(store.page().events[1]).toMatchObject({
      content: [
        { type: 'text', text: 'caption' },
        { type: 'text', text: expect.stringContaining('pending media budget') },
      ],
      data: { mediaKind: 'voice', mediaStatus: 'omitted_queue_budget' },
    });

    store.acknowledge([first.notification.event.eventId]);
    store.append({ ...photoMessage, updateId: '13', kind: 'audio' });
    expect(store.page().events[1]).toMatchObject({
      content: [{ type: 'text' }, { type: 'audio', data: 'AQID' }],
      data: { mediaStatus: 'included' },
    });
    expect(store.append(photoMessage).isNew).toBe(false);
  });
});

describe('Telegram channel', () => {
  it('accepts allowlisted private text and filters rejected senders', async () => {
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
        kind: 'text',
        text: 'hello',
        receivedAt: '2023-11-14T22:13:20.000Z',
      },
    ]);
  });

  it('downloads photos, audio, and voice with ordered captions', async () => {
    const received: unknown[] = [];
    const { fake } = await createStartedChannel(createFakeBot(), (message) => {
      received.push(message);
    });
    await fake.emit({
      kind: 'photo',
      fileId: 'largest-photo',
      fileSize: 3,
      caption: ' caption ',
    });
    await fake.emit({
      kind: 'audio',
      updateId: 11,
      fileId: 'audio',
      mimeType: 'audio/mpeg',
    });
    await fake.emit({ kind: 'voice', updateId: 12, fileId: 'voice' });
    expect(fake.downloadCalls).toEqual(['largest-photo', 'audio', 'voice']);
    expect(received).toMatchObject([
      {
        kind: 'photo',
        caption: 'caption',
        mimeType: 'image/jpeg',
        mediaData: 'AQID',
        mediaSize: 3,
        mediaStatus: 'included',
      },
      {
        kind: 'audio',
        mimeType: 'audio/mpeg',
        mediaStatus: 'included',
      },
      { kind: 'voice', mimeType: 'audio/ogg', mediaStatus: 'included' },
    ]);
  });

  it('omits rejected media without disrupting later updates', async () => {
    const received: unknown[] = [];
    const fake = createFakeBot();
    fake.downloads.set('failed', { status: 'omitted_download_failed' });
    const started = await createStartedChannel(
      fake,
      (message) => {
        received.push(message);
      },
      { mediaMaxBytes: 3 },
    );
    await started.fake.emit({
      kind: 'photo',
      fileId: 'large',
      fileSize: 4,
    });
    await started.fake.emit({
      kind: 'audio',
      updateId: 11,
      fileId: 'unsupported',
      mimeType: 'application/octet-stream',
    });
    await started.fake.emit({
      kind: 'voice',
      updateId: 12,
      fileId: 'failed',
    });
    await started.fake.emit({ updateId: 13, text: 'still works' });
    expect(fake.downloadCalls).toEqual(['failed']);
    expect(received).toMatchObject([
      { mediaStatus: 'omitted_too_large' },
      { mediaStatus: 'omitted_unsupported_type' },
      { mediaStatus: 'omitted_download_failed' },
      { kind: 'text', text: 'still works' },
    ]);
  });

  it('does not download media rejected by chat and sender filters', async () => {
    const fake = createFakeBot();
    await createStartedChannel(fake);
    await fake.emit({ kind: 'photo', fileId: 'group', chatType: 'group' });
    await fake.emit({ kind: 'voice', fileId: 'bot', senderIsBot: true });
    await fake.emit({ kind: 'audio', fileId: 'blocked', senderId: 41 });
    expect(fake.downloadCalls).toEqual([]);
  });

  it('sends only to allowlisted chats and keeps lifecycle idempotent', async () => {
    const fake = createFakeBot();
    const { channel } = await createStartedChannel(fake);
    await channel.start();
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
    channel.updateAllowedUserIds(new Set(['41']));
    await expect(
      channel.sendText({ chatId: '40', message: 'blocked' }),
    ).rejects.toThrow('not allowed');
    await channel.close();
    await channel.close();
    expect(fake.startCount()).toBe(1);
    expect(fake.stopCount()).toBe(1);
  });

  it('reports identity failures without starting a runtime', async () => {
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

describe('Telegram file downloader', () => {
  it('selects the largest Telegram photo variant', () => {
    expect(
      selectLargestPhoto([
        { file_id: 'small', file_size: 1 },
        { file_id: 'large', file_size: 3 },
      ]),
    ).toEqual({ file_id: 'large', file_size: 3 });
  });

  it('streams bounded bytes and never returns the credential-bearing URL', async () => {
    const requested: string[] = [];
    const result = await downloadTelegramFile({
      token: 'private-token',
      fileId: 'file-id',
      maxBytes: 3,
      timeoutMs: 1_000,
      getFile: async () => ({ file_path: 'voice/file.ogg', file_size: 3 }),
      fetchFile: (async (url: string | URL | Request) => {
        requested.push(String(url));
        return new Response(new Uint8Array([1, 2, 3]));
      }) as typeof fetch,
    });
    expect(result).toEqual({
      status: 'included',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(requested[0]).toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('voice/file.ogg');
  });

  it('rejects declared and streamed oversize files', async () => {
    const fetchFile = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3, 4])),
    );
    await expect(
      downloadTelegramFile({
        token: 'token',
        fileId: 'declared',
        maxBytes: 3,
        timeoutMs: 1_000,
        getFile: async () => ({ file_path: 'path', file_size: 4 }),
        fetchFile: fetchFile as typeof fetch,
      }),
    ).resolves.toEqual({ status: 'omitted_too_large' });
    expect(fetchFile).not.toHaveBeenCalled();

    await expect(
      downloadTelegramFile({
        token: 'token',
        fileId: 'streamed',
        maxBytes: 3,
        timeoutMs: 1_000,
        getFile: async () => ({ file_path: 'path' }),
        fetchFile: fetchFile as typeof fetch,
      }),
    ).resolves.toEqual({ status: 'omitted_too_large' });
  });

  it('turns timeout and lookup failures into sanitized failures', async () => {
    vi.useFakeTimers();
    const timeout = downloadTelegramFile({
      token: 'private-token',
      fileId: 'file-id',
      maxBytes: 3,
      timeoutMs: 10,
      getFile: async () => new Promise(() => {}),
      fetchFile: vi.fn() as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(timeout).resolves.toEqual({
      status: 'omitted_download_failed',
    });

    const stalledStream = downloadTelegramFile({
      token: 'private-token',
      fileId: 'file-id',
      maxBytes: 3,
      timeoutMs: 10,
      getFile: async () => ({ file_path: 'path' }),
      fetchFile: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {},
          }),
        )) as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(stalledStream).resolves.toEqual({
      status: 'omitted_download_failed',
    });

    await expect(
      downloadTelegramFile({
        token: 'private-token',
        fileId: 'file-id',
        maxBytes: 3,
        timeoutMs: 10,
        getFile: async () => {
          throw new Error('private-token path');
        },
        fetchFile: vi.fn() as typeof fetch,
      }),
    ).resolves.toEqual({ status: 'omitted_download_failed' });
  });
});

describe('MCP contract', () => {
  it('retrieves multimodal events and keeps sendMessage text-only', async () => {
    const store = createEventStore();
    const { channel, fake } = await createStartedChannel(
      createFakeBot(),
      (message) => {
        store.append(message);
      },
    );
    await fake.emit({
      kind: 'photo',
      fileId: 'photo',
      caption: 'caption',
    });
    const mcp = createTelegramMcp(channel, store);
    try {
      expect(
        await jsonRpc(mcp, {
          method: 'io.stagewise/push-notifications/get',
          params: { limit: 100 },
        }),
      ).toMatchObject({
        result: {
          events: [
            {
              content: [
                { type: 'text', text: 'caption' },
                { type: 'image', data: 'AQID', mimeType: 'image/jpeg' },
              ],
              data: { mediaKind: 'photo', mediaStatus: 'included' },
            },
          ],
        },
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

  it('sends voice messages via the sendVoice tool', async () => {
    const store = createEventStore();
    const { channel, fake } = await createStartedChannel();
    const mcp = createTelegramMcp(channel, store);
    try {
      const audioBase64 = Buffer.from('fake-ogg-data').toString('base64');
      expect(
        await jsonRpc(mcp, {
          method: 'tools/call',
          params: {
            name: 'sendVoice',
            arguments: {
              chatId: '40',
              voiceData: audioBase64,
              caption: 'voice caption',
              duration: 10,
            },
          },
        }),
      ).toMatchObject({ result: { content: [{ type: 'text' }] } });
      expect(fake.voiceSends).toHaveLength(1);
      expect(fake.voiceSends[0]).toMatchObject({
        chatId: '40',
        caption: 'voice caption',
        duration: 10,
      });
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it('sends photos via the sendPhoto tool', async () => {
    const store = createEventStore();
    const { channel, fake } = await createStartedChannel();
    const mcp = createTelegramMcp(channel, store);
    try {
      const photoBase64 = Buffer.from('fake-jpeg-data').toString('base64');
      expect(
        await jsonRpc(mcp, {
          method: 'tools/call',
          params: {
            name: 'sendPhoto',
            arguments: {
              chatId: '40',
              photoData: photoBase64,
              caption: 'photo caption',
            },
          },
        }),
      ).toMatchObject({ result: { content: [{ type: 'text' }] } });
      expect(fake.photoSends).toHaveLength(1);
      expect(fake.photoSends[0]).toMatchObject({
        chatId: '40',
        caption: 'photo caption',
      });
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it('fetches chat info via the getChatInfo tool', async () => {
    const store = createEventStore();
    const { channel } = await createStartedChannel();
    const mcp = createTelegramMcp(channel, store);
    try {
      const result = await jsonRpc(mcp, {
        method: 'tools/call',
        params: {
          name: 'getChatInfo',
          arguments: { chatId: '40' },
        },
      });
      const parsed = JSON.parse(
        (result as { result: { content: [{ text: string }] } }).result
          .content[0].text,
      );
      expect(parsed).toMatchObject({
        id: '40',
        type: 'private',
        firstName: 'Test User',
      });
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it('queries pending messages via the getChatHistory tool', async () => {
    const store = createEventStore();
    const { channel, fake } = await createStartedChannel(
      createFakeBot(),
      (message) => {
        store.append(message);
      },
    );
    await fake.emit({ text: 'first message' });
    await fake.emit({
      updateId: 11,
      kind: 'photo',
      fileId: 'photo',
      caption: 'photo caption',
    });
    const mcp = createTelegramMcp(channel, store);
    try {
      const result = await jsonRpc(mcp, {
        method: 'tools/call',
        params: {
          name: 'getChatHistory',
          arguments: { chatId: '30' },
        },
      });
      const parsed = JSON.parse(
        (result as { result: { content: [{ text: string }] } }).result
          .content[0].text,
      );
      expect(parsed.count).toBe(2);
      expect(parsed.events).toHaveLength(2);
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it('filters chat history by message kind', async () => {
    const store = createEventStore();
    const { channel, fake } = await createStartedChannel(
      createFakeBot(),
      (message) => {
        store.append(message);
      },
    );
    await fake.emit({ text: 'text msg' });
    await fake.emit({
      updateId: 11,
      kind: 'photo',
      fileId: 'photo',
      caption: 'photo msg',
    });
    const mcp = createTelegramMcp(channel, store);
    try {
      const result = await jsonRpc(mcp, {
        method: 'tools/call',
        params: {
          name: 'getChatHistory',
          arguments: { kind: 'text' },
        },
      });
      const parsed = JSON.parse(
        (result as { result: { content: [{ text: string }] } }).result
          .content[0].text,
      );
      expect(parsed.count).toBe(1);
      expect(parsed.events[0].data).toMatchObject({
        messageId: '20',
      });
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it('retrieves the bot profile via the getMyProfile tool', async () => {
    const store = createEventStore();
    const { channel } = await createStartedChannel();
    const mcp = createTelegramMcp(channel, store);
    try {
      const result = await jsonRpc(mcp, {
        method: 'tools/call',
        params: {
          name: 'getMyProfile',
          arguments: {},
        },
      });
      const parsed = JSON.parse(
        (result as { result: { content: [{ text: string }] } }).result
          .content[0].text,
      );
      expect(parsed).toEqual({
        name: 'Test Bot',
        description: 'Test description',
        shortDescription: 'Test short',
      });
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it('updates the bot name via the setMyName tool', async () => {
    const store = createEventStore();
    const { channel, fake } = await createStartedChannel();
    const mcp = createTelegramMcp(channel, store);
    try {
      expect(
        await jsonRpc(mcp, {
          method: 'tools/call',
          params: {
            name: 'setMyName',
            arguments: { name: 'New Bot Name' },
          },
        }),
      ).toMatchObject({ result: { content: [{ type: 'text' }] } });
      expect(fake.nameCalls).toEqual(['New Bot Name']);
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it('updates the bot description via the setMyDescription tool', async () => {
    const store = createEventStore();
    const { channel, fake } = await createStartedChannel();
    const mcp = createTelegramMcp(channel, store);
    try {
      expect(
        await jsonRpc(mcp, {
          method: 'tools/call',
          params: {
            name: 'setMyDescription',
            arguments: { description: 'A new description' },
          },
        }),
      ).toMatchObject({ result: { content: [{ type: 'text' }] } });
      expect(fake.descriptionCalls).toEqual(['A new description']);
    } finally {
      await mcp.close();
      store.close();
    }
  });

  it('updates the bot short description via the setMyShortDescription tool', async () => {
    const store = createEventStore();
    const { channel, fake } = await createStartedChannel();
    const mcp = createTelegramMcp(channel, store);
    try {
      expect(
        await jsonRpc(mcp, {
          method: 'tools/call',
          params: {
            name: 'setMyShortDescription',
            arguments: { shortDescription: 'New short' },
          },
        }),
      ).toMatchObject({ result: { content: [{ type: 'text' }] } });
      expect(fake.shortDescriptionCalls).toEqual(['New short']);
    } finally {
      await mcp.close();
      store.close();
    }
  });
});

describe('event store query', () => {
  it('filters by chatId, senderId, and kind', () => {
    const store = createEventStore();
    store.append(textMessage);
    store.append({ ...textMessage, updateId: '12', chatId: '31' });
    store.append({
      ...photoMessage,
      updateId: '13',
      chatId: '32',
      senderId: '41',
    });

    expect(store.query({ chatId: '30' }).events).toHaveLength(1);
    expect(store.query({ chatId: '31' }).events).toHaveLength(1);
    expect(store.query({ chatId: '32' }).events).toHaveLength(1);
    expect(store.query({ senderId: '40' }).events).toHaveLength(2);
    expect(store.query({ senderId: '41' }).events).toHaveLength(1);
    expect(store.query({ kind: 'text' }).events).toHaveLength(2);
    expect(store.query({ kind: 'photo' }).events).toHaveLength(1);
    expect(store.query({ kind: 'voice' }).events).toHaveLength(0);
    store.close();
  });

  it('respects limit and reports hasMore', () => {
    const store = createEventStore();
    store.append(textMessage);
    store.append({ ...textMessage, updateId: '12' });
    store.append({ ...textMessage, updateId: '13' });
    const result = store.query({ limit: 2 });
    expect(result.events).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    store.close();
  });

  it('rejects invalid limit values', () => {
    const store = createEventStore();
    expect(() => store.query({ limit: 0 })).toThrow(RangeError);
    expect(() => store.query({ limit: -1 })).toThrow(RangeError);
    store.close();
  });
});
