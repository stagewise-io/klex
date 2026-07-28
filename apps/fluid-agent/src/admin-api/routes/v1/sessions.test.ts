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
    tokens: {
      latest: { inputTokens: 100, outputTokens: 50 },
      total: { inputTokens: 500, outputTokens: 250 },
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
        tokens: {
          latest: null,
          total: { inputTokens: 0, outputTokens: 0 },
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
    expect(body.sessions[0]!.model.isFallback).toBe(true);
    expect(body.sessions[0]!.model.fallbackIndex).toBe(2);
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
    expect(body.sessions[0]!.status).toBe('terminated');
    expect(body.sessions[0]!.runtimeState).toBe('terminated');
  });

  it('reflects null latest usage when no generation has occurred', async () => {
    const sessions = [
      makeSessionInfo({
        tokens: {
          latest: null,
          total: { inputTokens: 0, outputTokens: 0 },
        },
      }),
    ];
    const app = createApp(routerWith(sessions));
    const response = await app.request('/v1/sessions');
    const body = (await response.json()) as { sessions: SessionInfo[] };
    expect(body.sessions[0]!.tokens.latest).toBeNull();
    expect(body.sessions[0]!.tokens.total).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('calls router.getSessions() once per request', async () => {
    const getSessionsFn = vi.fn(() => [makeSessionInfo()]);
    const app = createApp({ getSessions: getSessionsFn } as unknown as Router);
    await app.request('/v1/sessions');
    expect(getSessionsFn).toHaveBeenCalledOnce();
  });
});
