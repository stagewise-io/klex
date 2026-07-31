import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import { parseTelegramCredentials } from '../src/runtime-manager/credentials.js';
import { createTelegramRuntimeManager } from '../src/runtime-manager/index.js';
import {
  createTelegramChannel,
  type TelegramBot,
  type TelegramChannel,
  type TelegramChannelDependencies,
} from '../src/telegram.js';

const loggerMethods = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};
const logging = {
  ...loggerMethods,
  child: () => loggerMethods,
} as unknown as RootLogger;

function request(
  token: string | undefined,
  allowedUserIds = '1',
  extraHeaders: Record<string, string> = {},
): Request {
  const headers = new Headers(extraHeaders);
  if (token) headers.set('x-telegram-bot-token', token);
  if (allowedUserIds) {
    headers.set('x-telegram-allowed-user-ids', allowedUserIds);
  }
  return new Request('http://localhost/mcp', { method: 'POST', headers });
}

async function rpc(
  manager: ReturnType<typeof createTelegramRuntimeManager>,
  token: string,
  allowedUserIds: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await manager.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Token': token,
        'X-Telegram-Allowed-User-Ids': allowedUserIds,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
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
  return JSON.parse(data ?? text) as Record<string, unknown>;
}

async function readSseMessage(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes('\n\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('SSE stream closed');
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  const data = buffer
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  if (!data) throw new Error('Missing SSE data');
  return JSON.parse(data) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Telegram credentials', () => {
  it('accepts either token header and rejects conflicts', () => {
    expect(parseTelegramCredentials(request('123:abc')).botToken).toBe(
      '123:abc',
    );
    expect(
      parseTelegramCredentials(
        request(undefined, '1', { authorization: 'Bearer 456:def' }),
      ).botToken,
    ).toBe('456:def');
    expect(() =>
      parseTelegramCredentials(
        request('123:abc', '1', { authorization: 'Bearer 456:def' }),
      ),
    ).toThrow('Conflicting Telegram credentials');
  });

  it('rejects missing, malformed, and empty credential values', () => {
    expect(() => parseTelegramCredentials(request(undefined))).toThrow(
      'bot token',
    );
    expect(() =>
      parseTelegramCredentials(
        request(undefined, '1', { authorization: 'Basic secret' }),
      ),
    ).toThrow('Authorization');
    expect(() => parseTelegramCredentials(request('token', '1,,2'))).toThrow(
      'allowed user IDs',
    );
    expect(() => parseTelegramCredentials(request('token', '0'))).toThrow(
      'allowed user IDs',
    );
  });
});

describe('Telegram runtime manager', () => {
  function setup(idleTimeoutMs = 50) {
    const channels: Array<{
      token: string;
      start: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      updates: string[][];
      channel: TelegramChannel;
    }> = [];
    const mcpCloses: Array<ReturnType<typeof vi.fn>> = [];
    const subscriptions: Array<(active: boolean) => void> = [];
    const manager = createTelegramRuntimeManager({
      logging,
      processSecret: new Uint8Array(32).fill(7),
      idleTimeoutMs,
      createChannel(deps: TelegramChannelDependencies) {
        const start = vi.fn(async () => undefined);
        const close = vi.fn(async () => undefined);
        const updates: string[][] = [];
        const channel: TelegramChannel = {
          start,
          close,
          status: () => 'connected',
          updateAllowedUserIds(ids) {
            updates.push([...ids]);
          },
          sendText: vi.fn(),
        };
        channels.push({ token: deps.token, start, close, updates, channel });
        return channel;
      },
      createMcp(_channel, _eventStore, options) {
        const close = vi.fn(async () => undefined);
        mcpCloses.push(close);
        subscriptions.push((active) =>
          options.onSubscriptionStateChanged?.(active),
        );
        return {
          fetch: vi.fn(async () => new Response('ok')),
          publish: vi.fn(),
          close,
        };
      },
    });
    return { manager, channels, mcpCloses, subscriptions };
  }

  it('single-flights same-token creation and isolates different tokens', async () => {
    const { manager, channels } = setup();
    await Promise.all([
      manager.fetch(request('token-a', '1')),
      manager.fetch(request('token-a', '2')),
    ]);
    expect(channels).toHaveLength(1);
    expect(channels[0]?.start).toHaveBeenCalledOnce();
    expect(channels[0]?.updates).toEqual(
      expect.arrayContaining([['1'], ['2']]),
    );

    await manager.fetch(request('token-b', '3'));
    expect(channels.map(({ token }) => token)).toEqual(['token-a', 'token-b']);
    expect(manager.health()).toEqual({
      activeRuntimeCount: 2,
      startingRuntimeCount: 0,
    });
    await manager.close();
  });

  it('keeps subscribed runtimes alive and recreates them after idle cleanup', async () => {
    vi.useFakeTimers();
    const { manager, channels, mcpCloses, subscriptions } = setup();
    await manager.fetch(request('token-a'));
    subscriptions[0]?.(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(channels[0]?.close).not.toHaveBeenCalled();

    subscriptions[0]?.(false);
    await vi.advanceTimersByTimeAsync(25);
    subscriptions[0]?.(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(channels[0]?.close).not.toHaveBeenCalled();

    subscriptions[0]?.(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(channels[0]?.close).toHaveBeenCalledOnce();
    expect(mcpCloses[0]).toHaveBeenCalledOnce();
    expect(manager.health().activeRuntimeCount).toBe(0);

    await manager.fetch(request('token-a'));
    expect(channels).toHaveLength(2);
    await manager.close();
  });

  it('isolates pending queues, acknowledgements, and tools by token', async () => {
    type Raw = Parameters<Parameters<TelegramBot['onText']>[0]>[0];
    const bots = new Map<
      string,
      {
        emit: (message: Raw) => Promise<void>;
        sends: string[];
        stop: ReturnType<typeof vi.fn>;
      }
    >();
    const manager = createTelegramRuntimeManager({
      logging,
      processSecret: new Uint8Array(32).fill(7),
      createChannel(deps) {
        let listener: ((message: Raw) => void | Promise<void>) | undefined;
        const sends: string[] = [];
        const stop = vi.fn(async () => undefined);
        const botId = deps.token === 'token-a' ? 77 : 88;
        const bot: TelegramBot = {
          async getMe() {
            if (deps.token === 'bad-token') {
              throw new Error('Telegram rejected bad-token');
            }
            return { id: botId };
          },
          onText(value) {
            listener = value;
          },
          start: async () => undefined,
          stop,
          async sendText(_chatId, message) {
            sends.push(message);
            return 99;
          },
        };
        bots.set(deps.token, {
          async emit(message) {
            await listener?.(message);
          },
          sends,
          stop,
        });
        return createTelegramChannel({ ...deps, botFactory: () => bot });
      },
    });

    await rpc(manager, 'token-a', '40', 'tools/list', {});
    await rpc(manager, 'token-b', '50', 'tools/list', {});
    await bots.get('token-a')?.emit({
      updateId: 10,
      messageId: 20,
      chatId: 40,
      chatType: 'private',
      senderId: 40,
      senderIsBot: false,
      text: 'from a',
      date: 1_700_000_000,
    });
    await bots.get('token-b')?.emit({
      updateId: 11,
      messageId: 21,
      chatId: 50,
      chatType: 'private',
      senderId: 50,
      senderIsBot: false,
      text: 'from b',
      date: 1_700_000_001,
    });

    const pendingA = await rpc(
      manager,
      'token-a',
      '40',
      'io.stagewise/push-notifications/get',
      { limit: 10 },
    );
    const pendingB = await rpc(
      manager,
      'token-b',
      '50',
      'io.stagewise/push-notifications/get',
      { limit: 10 },
    );
    expect(pendingA).toMatchObject({
      result: { events: [{ eventId: 'telegram:77:update:10' }] },
    });
    expect(pendingB).toMatchObject({
      result: { events: [{ eventId: 'telegram:88:update:11' }] },
    });

    const subscriptionResponse = await manager.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Token': 'token-a',
          'X-Telegram-Allowed-User-Ids': '40',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'subscriptions/listen',
          params: {
            notifications: { 'io.stagewise/push-notifications': {} },
            _meta: {
              'io.modelcontextprotocol/clientCapabilities': {
                extensions: { 'io.stagewise/push-notifications': {} },
              },
            },
          },
        }),
      }),
    );
    const reader = subscriptionResponse.body?.getReader();
    if (!reader) throw new Error('Missing subscription response body');
    await readSseMessage(reader);
    await bots.get('token-a')?.emit({
      updateId: 12,
      messageId: 22,
      chatId: 40,
      chatType: 'private',
      senderId: 40,
      senderIsBot: false,
      text: 'live a',
      date: 1_700_000_002,
    });
    expect(await readSseMessage(reader)).toMatchObject({
      method: 'io.stagewise/push-notifications/event',
      params: { event: { eventId: 'telegram:77:update:12' } },
    });
    await reader.cancel();

    await rpc(manager, 'token-a', '40', 'tools/call', {
      name: 'sendMessage',
      arguments: { chatId: '40', message: 'reply a' },
    });
    expect(bots.get('token-a')?.sends).toEqual(['reply a']);
    expect(bots.get('token-b')?.sends).toEqual([]);

    await rpc(manager, 'token-a', '40', 'io.stagewise/push-notifications/ack', {
      eventIds: ['telegram:77:update:10', 'telegram:77:update:12'],
    });
    await bots.get('token-a')?.emit({
      updateId: 10,
      messageId: 20,
      chatId: 40,
      chatType: 'private',
      senderId: 40,
      senderIsBot: false,
      text: 'from a',
      date: 1_700_000_000,
    });
    expect(
      await rpc(
        manager,
        'token-a',
        '40',
        'io.stagewise/push-notifications/get',
        { limit: 10 },
      ),
    ).toMatchObject({ result: { events: [] } });

    const rejected = await manager.fetch(request('bad-token', '999'));
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).not.toContain('bad-token');
    expect(manager.health().activeRuntimeCount).toBe(2);

    await manager.close();
    expect(bots.get('token-a')?.stop).toHaveBeenCalledOnce();
    expect(bots.get('token-b')?.stop).toHaveBeenCalledOnce();
  });

  it('returns sanitized credential and startup failures', async () => {
    const missing = await setup().manager.fetch(request(undefined));
    expect(missing.status).toBe(401);

    const token = 'private-token';
    const allowed = '12345';
    const manager = createTelegramRuntimeManager({
      logging,
      createChannel: () => {
        throw new Error(`failed ${token} ${allowed}`);
      },
    });
    const response = await manager.fetch(request(token, allowed));
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain(allowed);
    expect(loggerMethods.warn).toHaveBeenCalledWith(
      {},
      'Failed to create Telegram runtime',
    );
    const capturedLogs = JSON.stringify(loggerMethods.warn.mock.calls);
    expect(capturedLogs).not.toContain(token);
    expect(capturedLogs).not.toContain(allowed);
    expect(capturedLogs).not.toMatch(/[a-f0-9]{64}/);
  });
});
