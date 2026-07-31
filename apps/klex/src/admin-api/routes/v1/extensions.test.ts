import { describe, expect, it, vi } from 'vitest';

import type { Router } from '@/router';

import {
  extensionListRoute,
  extensionStateRoute,
  getExtensionList,
  getExtensionState,
} from './extensions';
import { setupTestApp } from './test-utils';

function createAppState(router: Router) {
  return setupTestApp((app) => {
    app.openapi(extensionStateRoute, getExtensionState({ router }));
  });
}

function createAppList(router: Router) {
  return setupTestApp((app) => {
    app.openapi(extensionListRoute, getExtensionList({ router }));
  });
}

function routerReturning(
  state: Record<string, unknown> | null | undefined,
): Router {
  return {
    getExtensionState: vi.fn(async () => state),
  } as unknown as Router;
}

describe('extension state route', () => {
  it('returns 200 with bare state object when extension has state', async () => {
    const router = routerReturning({ count: 42, label: 'active' });
    const app = createAppState(router);
    const res = await app.request(
      '/v1/sessions/sess-1/extensions/io.stagewise%2Fmy-ext/state',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 42, label: 'active' });
  });

  it('returns 200 with null when extension has no introspect()', async () => {
    const router = routerReturning(null);
    const app = createAppState(router);
    const res = await app.request(
      '/v1/sessions/sess-1/extensions/io.stagewise%2Fno-introspect/state',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('returns 404 when session or extension is not found (undefined)', async () => {
    const router = routerReturning(undefined);
    const app = createAppState(router);
    const res = await app.request(
      '/v1/sessions/sess-1/extensions/io.stagewise%2Funknown/state',
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Session or extension not found');
  });

  it('passes sessionId and extensionId to router.getExtensionState', async () => {
    const spy = vi.fn(async () => ({ ok: true }));
    const router = { getExtensionState: spy } as unknown as Router;
    const app = createAppState(router);
    await app.request(
      '/v1/sessions/sess-1/extensions/io.stagewise%2Fmy-ext/state',
    );
    expect(spy).toHaveBeenCalledExactlyOnceWith(
      'sess-1',
      'io.stagewise/my-ext',
    );
  });

  it('returns 500 when introspect() throws', async () => {
    const router = {
      getExtensionState: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as Router;
    const app = createAppState(router);
    const res = await app.request(
      '/v1/sessions/sess-1/extensions/io.stagewise%2Fthrows/state',
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});

describe('extension list route', () => {
  it('returns 200 with extension map when session exists', async () => {
    const router = {
      getExtensions: vi.fn(
        () =>
          ({
            'io.stagewise/ext-a': { displayName: 'Extension A' },
            'io.stagewise/ext-b': { displayName: 'Extension B' },
          }) as Record<string, { displayName?: string }>,
      ),
    } as unknown as Router;
    const app = createAppList(router);
    const res = await app.request('/v1/sessions/sess-1/extensions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      'io.stagewise/ext-a': { displayName: 'Extension A' },
      'io.stagewise/ext-b': { displayName: 'Extension B' },
    });
  });

  it('returns 200 with empty object when session has no extensions', async () => {
    const router = {
      getExtensions: vi.fn(() => ({})),
    } as unknown as Router;
    const app = createAppList(router);
    const res = await app.request('/v1/sessions/sess-1/extensions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('returns 404 when session is not found', async () => {
    const router = {
      getExtensions: vi.fn(() => undefined),
    } as unknown as Router;
    const app = createAppList(router);
    const res = await app.request('/v1/sessions/unknown/extensions');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Session not found');
  });

  it('passes sessionId to router.getExtensions', async () => {
    const spy = vi.fn(() => ({}));
    const router = { getExtensions: spy } as unknown as Router;
    const app = createAppList(router);
    await app.request('/v1/sessions/sess-42/extensions');
    expect(spy).toHaveBeenCalledExactlyOnceWith('sess-42');
  });
});
