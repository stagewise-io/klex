import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { klexConfigSchema } from '@/config';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';
import type { ExtendedUIMessage } from '@/session/chat/message-types';
import {
  createSessionHistory,
  SESSION_HISTORY_STORE_DEFINITION,
  type SessionHistory,
  type SessionHistoryRecorderMetadata,
} from '@/session-history';

import {
  getSessionHistory,
  getSessionHistoryMessages,
  getSessionHistoryMessagesRoute,
  getSessionHistoryRoute,
  listSessionHistory,
  listSessionHistoryRoute,
} from './sessions';
import { setupTestApp } from './test-utils';

const logger = createLogger({ name: 'test' });
const directories: string[] = [];
const modules: SessionHistory[] = [];

interface SessionsBody {
  sessions: Array<{ instanceId: string; kind: string; live: boolean }>;
  nextCursor: string | null;
  hasMore: boolean;
}

interface MessagesBody {
  messages: Array<{
    id: string;
    seq: number;
    persistedAt: string;
    parts: Array<Record<string, unknown>>;
  }>;
  nextCursor: number | null;
  hasMore: boolean;
  trimmedMessageCount: number;
}

function message(id: string): ExtendedUIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text: id }],
  } as unknown as ExtendedUIMessage;
}

function meta(
  overrides: Partial<SessionHistoryRecorderMetadata> = {},
): SessionHistoryRecorderMetadata {
  return {
    instanceId: randomUUID(),
    sessionId: 'default',
    kind: 'default',
    name: 'Default',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function setup(): Promise<{
  app: OpenAPIHono;
  history: SessionHistory;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'klex-sessions-route-'));
  directories.push(directory);
  await createLocalData({
    logging: logger,
    dataDirectory: directory,
    klexVersion: KLEX_VERSION,
    stores: [SESSION_HISTORY_STORE_DEFINITION],
  }).start();
  const config = klexConfigSchema.parse({});
  const history = createSessionHistory({
    logging: logger,
    dataDirectory: directory,
    config: { get: () => config },
  });
  modules.push(history);
  await history.start();
  const deps = { sessionHistory: history };
  const app = setupTestApp((app) => {
    app.openapi(listSessionHistoryRoute, listSessionHistory(deps));
    app.openapi(getSessionHistoryRoute, getSessionHistory(deps));
    app.openapi(
      getSessionHistoryMessagesRoute,
      getSessionHistoryMessages(deps),
    );
  });
  return { app, history };
}

afterEach(async () => {
  await Promise.all(modules.splice(0).map((module) => module.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('GET /v1/sessions', () => {
  it('finds the live main session and pages with filters', async () => {
    const { app, history } = await setup();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const ended = history.openRecorder(
      meta({ createdAt: new Date(base).toISOString() }),
    );
    ended.scheduleSync(() => [message('old')]);
    await ended.end('replaced');
    const main = history.openRecorder(
      meta({ createdAt: new Date(base + 1000).toISOString() }),
    );
    main.scheduleSync(() => [message('current')]);
    const god = history.openRecorder(
      meta({
        sessionId: 'god',
        kind: 'god',
        createdAt: new Date(base + 2000).toISOString(),
      }),
    );
    god.scheduleSync(() => [message('god')]);
    await history.flush();

    const live = await app.request(
      '/v1/sessions?kind=default&live=true&limit=1',
    );
    expect(live.status).toBe(200);
    const liveBody = (await live.json()) as SessionsBody;
    expect(liveBody.sessions.map((s) => s.instanceId)).toEqual([
      main.instanceId,
    ]);
    expect(liveBody.sessions[0]?.live).toBe(true);

    const first = await app.request('/v1/sessions?limit=2');
    const firstBody = (await first.json()) as SessionsBody;
    expect(firstBody.sessions.map((s) => s.instanceId)).toEqual([
      god.instanceId,
      main.instanceId,
    ]);
    expect(firstBody.hasMore).toBe(true);
    if (!firstBody.nextCursor) throw new Error('Expected a cursor');

    const second = await app.request(
      `/v1/sessions?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    const secondBody = (await second.json()) as SessionsBody;
    expect(secondBody).toMatchObject({ hasMore: false, nextCursor: null });
    expect(secondBody.sessions.map((s) => s.instanceId)).toEqual([
      ended.instanceId,
    ]);

    const endedOnly = await app.request('/v1/sessions?live=false');
    const endedBody = (await endedOnly.json()) as SessionsBody;
    expect(endedBody.sessions.map((s) => s.instanceId)).toEqual([
      ended.instanceId,
    ]);
  });

  it('rejects invalid cursors and query values', async () => {
    const { app } = await setup();
    const badCursor = await app.request('/v1/sessions?cursor=nope');
    expect(badCursor.status).toBe(400);
    expect(await badCursor.json()).toMatchObject({ code: 'invalid_cursor' });
    expect((await app.request('/v1/sessions?kind=other')).status).toBe(400);
    expect((await app.request('/v1/sessions?limit=0')).status).toBe(400);
  });
});

describe('GET /v1/sessions/{instanceId}', () => {
  it('returns metadata or 404', async () => {
    const { app, history } = await setup();
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() => [message('a'), message('b')]);
    await history.flush();

    const found = await app.request(`/v1/sessions/${recorder.instanceId}`);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      instanceId: recorder.instanceId,
      kind: 'default',
      live: true,
      messageCount: 2,
    });

    const missing = await app.request('/v1/sessions/unknown');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'session_not_found' });
  });
});

describe('GET /v1/sessions/{instanceId}/messages', () => {
  it('pages backwards in chronological order', async () => {
    const { app, history } = await setup();
    const recorder = history.openRecorder(meta());
    recorder.scheduleSync(() =>
      Array.from({ length: 5 }, (_, index) => message(`m${index}`)),
    );
    await history.flush();
    const path = `/v1/sessions/${recorder.instanceId}/messages`;

    const newest = await app.request(`${path}?limit=2`);
    expect(newest.status).toBe(200);
    const newestBody = (await newest.json()) as MessagesBody;
    expect(newestBody.messages.map((m) => m.id)).toEqual(['m3', 'm4']);
    expect(newestBody).toMatchObject({
      hasMore: true,
      nextCursor: 3,
      trimmedMessageCount: 0,
    });
    expect(newestBody.messages[0]?.seq).toBe(3);
    expect(typeof newestBody.messages[0]?.persistedAt).toBe('string');

    const older = await app.request(
      `${path}?limit=10&cursor=${newestBody.nextCursor}`,
    );
    const olderBody = (await older.json()) as MessagesBody;
    expect(olderBody.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
    expect(olderBody).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it('redacts base64 content', async () => {
    const { app, history } = await setup();
    const recorder = history.openRecorder(meta());
    const withImage = {
      id: 'img',
      role: 'user',
      parts: [
        {
          type: 'data-god-message',
          data: {
            content: [
              { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
            ],
          },
        },
      ],
    } as unknown as ExtendedUIMessage;
    recorder.scheduleSync(() => [withImage]);
    await history.flush();

    const response = await app.request(
      `/v1/sessions/${recorder.instanceId}/messages`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as MessagesBody;
    const content = body.messages[0]?.parts[0]?.data as {
      content: Array<{ type: string; data?: string }>;
    };
    expect(content.content[0]?.data).toBe('[redacted, 12 bytes]');
  });

  it('returns stored AI SDK parts in full without provider metadata', async () => {
    const { app, history } = await setup();
    const recorder = history.openRecorder(meta());
    const longOutput = 'x'.repeat(5000);
    const stored = [
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'data-time', data: { now: '2026-01-01T00:00:00.000Z' } },
          { type: 'data-todos', data: { todos: [{ id: 't1', done: false }] } },
          { type: 'text', text: 'hi' },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'step-start' },
          {
            type: 'reasoning',
            text: '',
            state: 'done',
            providerMetadata: {
              openai: { itemId: 'rs_1', reasoningEncryptedContent: 'gAAA' },
            },
          },
          {
            type: 'tool-runInSandbox',
            toolCallId: 'call_1',
            state: 'output-available',
            input: { code: 'tools.search({query: "x"})' },
            output: { content: [{ type: 'text', text: longOutput }] },
            callProviderMetadata: { openai: { itemId: 'fc_1' } },
          },
          {
            type: 'tool-recall',
            toolCallId: 'call_2',
            state: 'output-error',
            input: undefined,
            rawInput: '{"bad"',
            errorText: 'invalid input',
          },
          {
            type: 'text',
            text: 'done',
            state: 'done',
            providerMetadata: { openai: { itemId: 'msg_1' } },
          },
        ],
      },
    ] as unknown as ExtendedUIMessage[];
    recorder.scheduleSync(() => stored);
    await history.flush();
    const path = `/v1/sessions/${recorder.instanceId}/messages`;

    const body = (await (await app.request(path)).json()) as MessagesBody;
    expect(body.messages[0]?.parts).toEqual([
      { type: 'data-time', data: { now: '2026-01-01T00:00:00.000Z' } },
      { type: 'data-todos', data: { todos: [{ id: 't1', done: false }] } },
      { type: 'text', text: 'hi' },
    ]);
    expect(body.messages[1]?.parts).toEqual([
      { type: 'step-start' },
      { type: 'reasoning', text: '', state: 'done' },
      {
        type: 'tool-runInSandbox',
        toolCallId: 'call_1',
        state: 'output-available',
        input: { code: 'tools.search({query: "x"})' },
        output: { content: [{ type: 'text', text: longOutput }] },
      },
      {
        type: 'tool-recall',
        toolCallId: 'call_2',
        state: 'output-error',
        rawInput: '{"bad"',
        errorText: 'invalid input',
      },
      { type: 'text', text: 'done', state: 'done' },
    ]);

    const withMetadata = (await (
      await app.request(`${path}?includeProviderMetadata=true`)
    ).json()) as MessagesBody;
    const parts = withMetadata.messages[1]?.parts ?? [];
    expect(parts[1]?.providerMetadata).toEqual({
      openai: { itemId: 'rs_1', reasoningEncryptedContent: 'gAAA' },
    });
    expect(parts[2]?.callProviderMetadata).toEqual({
      openai: { itemId: 'fc_1' },
    });
    expect(parts[4]?.providerMetadata).toEqual({
      openai: { itemId: 'msg_1' },
    });

    expect(
      (await app.request(`${path}?includeProviderMetadata=yes`)).status,
    ).toBe(400);
  });

  it('redacts binary payloads inside tool outputs and file parts', async () => {
    const { app, history } = await setup();
    const recorder = history.openRecorder(meta());
    const stored = {
      id: 'a1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-screenshot',
          toolCallId: 'call_1',
          state: 'output-available',
          input: {},
          output: {
            content: [
              { type: 'text', text: 'ok' },
              { type: 'image', mimeType: 'image/png', data: 'AAAAAAAA' },
              { type: 'audio', mimeType: 'audio/wav', data: 'BBBB' },
              {
                type: 'resource',
                resource: { uri: 'file:///a.bin', blob: 'CCCCCC' },
              },
            ],
          },
        },
        {
          type: 'tool-modelOutput',
          toolCallId: 'call_2',
          state: 'output-available',
          input: {},
          output: {
            type: 'content',
            value: [{ type: 'media', mediaType: 'image/png', data: 'DDDD' }],
          },
        },
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'data:image/png;base64,EEEEEEEE',
        },
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'https://example.com/a.png',
        },
      ],
    } as unknown as ExtendedUIMessage;
    recorder.scheduleSync(() => [stored]);
    await history.flush();

    const body = (await (
      await app.request(`/v1/sessions/${recorder.instanceId}/messages`)
    ).json()) as MessagesBody;
    expect(body.messages[0]?.parts).toEqual([
      {
        type: 'tool-screenshot',
        toolCallId: 'call_1',
        state: 'output-available',
        input: {},
        output: {
          content: [
            { type: 'text', text: 'ok' },
            {
              type: 'image',
              mimeType: 'image/png',
              data: '[redacted, 8 bytes]',
            },
            {
              type: 'audio',
              mimeType: 'audio/wav',
              data: '[redacted, 4 bytes]',
            },
            {
              type: 'resource',
              resource: { uri: 'file:///a.bin', blob: '[redacted, 6 bytes]' },
            },
          ],
        },
      },
      {
        type: 'tool-modelOutput',
        toolCallId: 'call_2',
        state: 'output-available',
        input: {},
        output: {
          type: 'content',
          value: [
            {
              type: 'media',
              mediaType: 'image/png',
              data: '[redacted, 4 bytes]',
            },
          ],
        },
      },
      {
        type: 'file',
        mediaType: 'image/png',
        url: 'data:image/png;base64,[redacted, 8 bytes]',
      },
      {
        type: 'file',
        mediaType: 'image/png',
        url: 'https://example.com/a.png',
      },
    ]);
  });

  it('returns 404 for unknown instances and 400 for bad cursors', async () => {
    const { app } = await setup();
    expect((await app.request('/v1/sessions/unknown/messages')).status).toBe(
      404,
    );
    expect(
      (await app.request('/v1/sessions/unknown/messages?cursor=-1')).status,
    ).toBe(400);
  });
});
