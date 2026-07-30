import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it, vi } from 'vitest';

import type { Router } from '@/router';
import type { SessionInfo } from '@/session/types';

import { getSessions, sessionsRoute } from './sessions';
import { setupTestApp } from './test-utils';

function makeSessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'session-001',
    status: 'active',
    runtimeState: 'idle',
    model: {
      id: 'provider:chat:model-a',
      isFallback: false,
      fallbackIndex: 0,
    },
    usage: {
      chat: {
        latest: {
          inputTokens: 100,
          outputTokens: 50,
          inputCacheWriteTokens: 200,
          inputCacheReadTokens: 150,
        },
        total: {
          inputTokens: 500,
          outputTokens: 250,
          inputCacheWriteTokens: 800,
          inputCacheReadTokens: 600,
        },
      },
      extensions: {
        'io.stagewise/context-compaction': {
          latest: {
            inputTokens: 300,
            outputTokens: 100,
            inputCacheWriteTokens: 50,
            inputCacheReadTokens: 30,
          },
          total: {
            inputTokens: 600,
            outputTokens: 200,
            inputCacheWriteTokens: 100,
            inputCacheReadTokens: 60,
          },
        },
      },
    },
    turns: 3,
    steps: 7,
    messageCount: 12,
    createdAt: '2026-07-28T08:00:00.000Z',
    ...overrides,
  };
}

function createApp(router: Router): OpenAPIHono {
  return setupTestApp((app) => {
    app.openapi(sessionsRoute, getSessions({ router }));
  });
}

function routerWith(sessions: SessionInfo[]): Router {
  return { getSessions: () => sessions } as unknown as Router;
}

describe('sessions routes', () => {
  it('returns an empty array when no sessions exist', async () => {
    const app = createApp(routerWith([]));
    const response = await app.request('/v1/sessions');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessions: [] });
  });

  it('returns all sessions with full detail', async () => {
    const sessions = [
      makeSessionInfo(),
      makeSessionInfo({
        id: 'session-002',
        runtimeState: 'working',
        model: {
          id: 'provider:chat:fallback-model',
          isFallback: true,
          fallbackIndex: 1,
        },
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
        messageCount: 1,
      }),
    ];
    const app = createApp(routerWith(sessions));
    const response = await app.request('/v1/sessions');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessions: SessionInfo[] };
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toEqual(sessions[0]);
    expect(body.sessions[1]).toEqual(sessions[1]);
  });

  it('reflects fallback model flag correctly', async () => {
    const sessions = [
      makeSessionInfo({
        model: {
          id: 'provider:chat:fallback',
          isFallback: true,
          fallbackIndex: 2,
        },
      }),
    ];
    const app = createApp(routerWith(sessions));
    const response = await app.request('/v1/sessions');
    const body = (await response.json()) as { sessions: SessionInfo[] };
    expect(body.sessions[0]?.model.isFallback).toBe(true);
    expect(body.sessions[0]?.model.fallbackIndex).toBe(2);
  });

  it('reflects terminated status and runtime state', async () => {
    const sessions = [
      makeSessionInfo({
        status: 'terminated',
        runtimeState: 'terminated',
      }),
    ];
    const app = createApp(routerWith(sessions));
    const response = await app.request('/v1/sessions');
    const body = (await response.json()) as { sessions: SessionInfo[] };
    expect(body.sessions[0]?.status).toBe('terminated');
    expect(body.sessions[0]?.runtimeState).toBe('terminated');
  });

  it('reflects null latest chat usage when no generation has occurred', async () => {
    const sessions = [
      makeSessionInfo({
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
      }),
    ];
    const app = createApp(routerWith(sessions));
    const response = await app.request('/v1/sessions');
    const body = (await response.json()) as { sessions: SessionInfo[] };
    expect(body.sessions[0]?.usage.chat.latest).toBeNull();
    expect(body.sessions[0]?.usage.chat.total).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      inputCacheWriteTokens: 0,
      inputCacheReadTokens: 0,
    });
  });

  it('includes per-extension usage with latest and total', async () => {
    const sessions = [makeSessionInfo()];
    const app = createApp(routerWith(sessions));
    const response = await app.request('/v1/sessions');
    const body = (await response.json()) as { sessions: SessionInfo[] };
    const extUsage =
      body.sessions[0]?.usage.extensions['io.stagewise/context-compaction'];
    expect(extUsage).toBeDefined();
    expect(extUsage?.latest).toEqual({
      inputTokens: 300,
      outputTokens: 100,
      inputCacheWriteTokens: 50,
      inputCacheReadTokens: 30,
    });
    expect(extUsage?.total).toEqual({
      inputTokens: 600,
      outputTokens: 200,
      inputCacheWriteTokens: 100,
      inputCacheReadTokens: 60,
    });
  });

  it('calls router.getSessions() once per request', async () => {
    const getSessionsFn = vi.fn(() => [makeSessionInfo()]);
    const app = createApp({ getSessions: getSessionsFn } as unknown as Router);
    await app.request('/v1/sessions');
    expect(getSessionsFn).toHaveBeenCalledOnce();
  });
});
