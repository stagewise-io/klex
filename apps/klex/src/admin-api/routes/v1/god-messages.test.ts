import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import { GodMessagesError } from '@/god-messages';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import type { SessionInfo } from '@/session/types';

import {
  createGodMessage,
  createGodMessageRoute,
  type GodMessagesRouteDependencies,
  getGodMessages,
  getGodMessagesRoute,
  getGodSession,
  getGodSessionRoute,
  resetGodSession,
  resetGodSessionRoute,
} from './god-messages';
import { setupTestApp } from './test-utils';

function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'test-session-id',
    status: 'active',
    runtimeState: 'idle',
    model: { id: 'openai:gpt-4o', isFallback: false, fallbackIndex: 0 },
    usage: {
      chat: {
        latest: null,
        total: {
          inputTokens: 0,
          outputTokens: 0,
          inputCacheWriteTokens: 0,
          inputCacheReadTokens: 0,
        },
      },
      extensions: {},
    },
    turns: 0,
    steps: 0,
    messageCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface MessagesResponseBody {
  messages: Array<{ id: string; parts: Array<Record<string, unknown>> }>;
  nextCursor: string | null;
  hasMore: boolean;
}

function makeMessages(count: number): ExtendedUIMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `Message ${i}` }],
  })) as unknown as ExtendedUIMessage[];
}

interface MockGodMessages {
  getSessionInfo: ReturnType<typeof vi.fn>;
  getMessages: ReturnType<typeof vi.fn>;
  resetSession: ReturnType<typeof vi.fn>;
  sendGodMessage: ReturnType<typeof vi.fn>;
}

function makeDeps(mock: MockGodMessages): GodMessagesRouteDependencies {
  return {
    godMessages: mock as unknown as GodMessagesRouteDependencies['godMessages'],
  };
}

function createApp(deps: GodMessagesRouteDependencies): OpenAPIHono {
  return setupTestApp((app) => {
    app.openapi(createGodMessageRoute, createGodMessage(deps));
    app.openapi(getGodSessionRoute, getGodSession(deps));
    app.openapi(getGodMessagesRoute, getGodMessages(deps));
    app.openapi(resetGodSessionRoute, resetGodSession(deps));
  });
}

describe('POST /v1/god-messages', () => {
  it('accepts and forwards a god message', async () => {
    const sendGodMessage = vi.fn(async () => ({ sessionId: 'session-1' }));
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => []),
      resetSession: vi.fn(),
      sendGodMessage,
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: [{ type: 'text', text: 'Do this' }] }),
      },
    );

    expect(response.status).toBe(202);
    expect(sendGodMessage).toHaveBeenCalledWith([
      { type: 'text', text: 'Do this' },
    ]);
  });

  it('rejects oversized and ambiguous content', async () => {
    const sendGodMessage = vi.fn();
    const app = createApp(
      makeDeps({
        getSessionInfo: vi.fn(),
        getMessages: vi.fn(() => []),
        resetSession: vi.fn(),
        sendGodMessage,
      }),
    );

    const tooMany = await app.request('/v1/god-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: Array.from({ length: 17 }, () => ({
          type: 'text',
          text: 'x',
        })),
      }),
    });
    const ambiguous = await app.request('/v1/god-messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: [
          {
            type: 'resource',
            resource: { uri: 'test://resource', text: 'x', blob: 'eA==' },
          },
        ],
      }),
    });

    expect(tooMany.status).toBe(400);
    expect(ambiguous.status).toBe(400);
    expect(sendGodMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['reset-in-progress', 409, 'reset_in_progress'],
    ['not-running', 503, 'not_running'],
  ] as const)(
    'maps %s domain errors to HTTP %i',
    async (errorCode, status, responseCode) => {
      const mock: MockGodMessages = {
        getSessionInfo: vi.fn(),
        getMessages: vi.fn(() => []),
        resetSession: vi.fn(),
        sendGodMessage: vi.fn(async () => {
          throw new GodMessagesError(errorCode, 'Unavailable');
        }),
      };
      const response = await createApp(makeDeps(mock)).request(
        '/v1/god-messages',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: [{ type: 'text', text: 'Do this' }],
          }),
        },
      );

      expect(response.status).toBe(status);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.code).toBe(responseCode);
    },
  );
});

describe('GET /v1/god-messages/session', () => {
  it('returns 200 with session info when session exists', async () => {
    const info = makeSessionInfo({ runtimeState: 'idle' });
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(() => info),
      getMessages: vi.fn(() => []),
      resetSession: vi.fn(),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/session',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.id).toBe('test-session-id');
    expect(body.runtimeState).toBe('idle');
  });

  it('returns 200 with terminated state when session is terminated', async () => {
    const info = makeSessionInfo({
      status: 'terminated',
      runtimeState: 'terminated',
    });
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(() => info),
      getMessages: vi.fn(() => []),
      resetSession: vi.fn(),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/session',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.runtimeState).toBe('terminated');
  });

  it('returns 404 when no session exists', async () => {
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(() => null),
      getMessages: vi.fn(() => []),
      resetSession: vi.fn(),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/session',
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/god-messages/messages
// ---------------------------------------------------------------------------

describe('GET /v1/god-messages/messages', () => {
  it('returns the last N messages without a cursor', async () => {
    const messages = makeMessages(10);
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => [...messages]),
      resetSession: vi.fn(),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/messages?limit=5',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as MessagesResponseBody;
    expect(body.messages).toHaveLength(5);
    expect(body.messages[0]?.id).toBe('msg-5');
    expect(body.messages[4]?.id).toBe('msg-9');
    expect(body.nextCursor).toBe('msg-5');
    expect(body.hasMore).toBe(true);
  });

  it('returns empty array when no messages exist', async () => {
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => []),
      resetSession: vi.fn(),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/messages',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as MessagesResponseBody;
    expect(body.messages).toHaveLength(0);
    expect(body.nextCursor).toBeNull();
    expect(body.hasMore).toBe(false);
  });

  it('returns older messages with a cursor', async () => {
    const messages = makeMessages(20);
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => [...messages]),
      resetSession: vi.fn(),
      sendGodMessage: vi.fn(),
    };
    // cursor=msg-10 means "return messages older than msg-10"
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/messages?limit=5&cursor=msg-10',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as MessagesResponseBody;
    // msg-10 is at index 10, so we get messages at indices 5..9 (msg-5..msg-9)
    expect(body.messages).toHaveLength(5);
    expect(body.messages[0]?.id).toBe('msg-5');
    expect(body.messages[4]?.id).toBe('msg-9');
    expect(body.nextCursor).toBe('msg-5');
    expect(body.hasMore).toBe(true);
  });

  it('returns hasMore=false when all older messages fit in one page', async () => {
    const messages = makeMessages(10);
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => [...messages]),
      resetSession: vi.fn(),
      sendGodMessage: vi.fn(),
    };
    // cursor=msg-5, limit=50 → messages 0..4 (5 messages), hasMore=false
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/messages?cursor=msg-5&limit=50',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as MessagesResponseBody;
    expect(body.messages).toHaveLength(5);
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
  });

  it('returns empty array when cursor not found', async () => {
    const messages = makeMessages(5);
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => [...messages]),
      resetSession: vi.fn(),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/messages?cursor=nonexistent',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as MessagesResponseBody;
    expect(body.messages).toHaveLength(0);
    expect(body.hasMore).toBe(false);
  });

  it('redacts base64 data in image content blocks', async () => {
    const messages: ExtendedUIMessage[] = [
      {
        id: 'msg-with-image',
        role: 'user',
        parts: [
          {
            type: 'data-god-message',
            data: {
              content: [
                { type: 'text', text: 'Look at this' },
                {
                  type: 'image',
                  mimeType: 'image/png',
                  data: 'iVBORw0KGgo=',
                },
              ],
            },
          } as never,
        ],
      } as never,
    ] as unknown as ExtendedUIMessage[];

    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => [...messages]),
      resetSession: vi.fn(),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/messages',
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as MessagesResponseBody;
    const part = body.messages[0]?.parts[0];
    if (!part) throw new Error('Expected serialized god message part');
    const content = part.data as {
      content: Array<{ type: string; data?: string }>;
    };
    const imageBlock = content.content.find((b) => b.type === 'image');
    expect(imageBlock?.data).toBe('[redacted, 12 bytes]');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/god-messages/reset
// ---------------------------------------------------------------------------

describe('POST /v1/god-messages/reset', () => {
  it('returns 200 with new sessionId on success', async () => {
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => []),
      resetSession: vi.fn(async () => ({ sessionId: 'new-session-id' })),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/reset',
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.sessionId).toBe('new-session-id');
  });

  it('returns 409 when session is busy', async () => {
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => []),
      resetSession: vi.fn(async () => {
        throw new GodMessagesError(
          'session-busy',
          'God session is busy (state: working).',
        );
      }),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/reset',
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('session_busy');
  });

  it('returns 409 when already resetting', async () => {
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => []),
      resetSession: vi.fn(async () => {
        throw new GodMessagesError(
          'reset-in-progress',
          'God session is already being reset',
        );
      }),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/reset',
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('reset_in_progress');
  });

  it('returns 404 when module is not running', async () => {
    const mock: MockGodMessages = {
      getSessionInfo: vi.fn(),
      getMessages: vi.fn(() => []),
      resetSession: vi.fn(async () => {
        throw new GodMessagesError(
          'not-running',
          'God messages module is not running',
        );
      }),
      sendGodMessage: vi.fn(),
    };
    const response = await createApp(makeDeps(mock)).request(
      '/v1/god-messages/reset',
      { method: 'POST' },
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('not_found');
  });
});
