import type { OpenAPIHono } from '@hono/zod-openapi';
import { describe, expect, it } from 'vitest';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import { createIntrospector } from '@/introspection';

import {
  getIntrospectionPathHandler,
  getIntrospectionRoot,
  type IntrospectionRouteDependencies,
  introspectionRootRoute,
  registerIntrospectionPathRoute,
} from './introspection';
import { setupTestApp } from './test-utils';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
} as unknown as ModuleLogger;

const noopRootLogger = {
  child: () => noopLogger,
} as unknown as RootLogger;

function createApp(deps: IntrospectionRouteDependencies): OpenAPIHono {
  return setupTestApp((app) => {
    app.openapi(introspectionRootRoute, getIntrospectionRoot(deps));
    registerIntrospectionPathRoute(app);
    app.get('/v1/introspect/:path{.+}', getIntrospectionPathHandler(deps));
  });
}

// ---------------------------------------------------------------------------
// GET /v1/introspect
// ---------------------------------------------------------------------------

describe('GET /v1/introspect', () => {
  it('returns the root node', async () => {
    const introspector = createIntrospector({ logging: noopRootLogger });
    const app = createApp({ introspector });

    const response = await app.request('/v1/introspect');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string[];
      state: unknown;
      children: unknown[];
    };
    expect(body.path).toEqual([]);
    expect(body.state).toBeNull();
    expect(body.children).toEqual([]);
  });

  it('returns root children when nodes are registered', async () => {
    const introspector = createIntrospector({ logging: noopRootLogger });
    introspector.child('sessions').introspect(() => ({ count: 3 }));
    const app = createApp({ introspector });

    const response = await app.request('/v1/introspect');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string[];
      state: unknown;
      children: { id: string; hasState: boolean; hasChildren: boolean }[];
    };
    expect(body.children).toHaveLength(1);
    expect(body.children[0]?.id).toBe('sessions');
    expect(body.children[0]?.hasState).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/introspect/{path}
// ---------------------------------------------------------------------------

describe('GET /v1/introspect/{path}', () => {
  it('returns a node with state at a resolved path', async () => {
    const introspector = createIntrospector({ logging: noopRootLogger });
    introspector.child('sessions').introspect(() => ({ count: 3 }));
    const app = createApp({ introspector });

    const response = await app.request('/v1/introspect/sessions');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string[];
      state: unknown;
    };
    expect(body.path).toEqual(['sessions']);
    expect(body.state).toEqual({ count: 3 });
  });

  it('returns children listing without invoking child state', async () => {
    const introspector = createIntrospector({ logging: noopRootLogger });
    const sessionsScope = introspector.child('sessions');
    sessionsScope.child('sess-001').introspect(() => ({ status: 'active' }));
    sessionsScope.child('sess-002').introspect(() => null);
    const app = createApp({ introspector });

    const response = await app.request('/v1/introspect/sessions');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string[];
      state: unknown;
      children: {
        id: string;
        hasState: boolean;
        hasChildren: boolean;
      }[];
    };
    expect(body.path).toEqual(['sessions']);
    expect(body.state).toBeNull();
    expect(body.children).toHaveLength(2);
    const s1 = body.children.find((c) => c.id === 'sess-001');
    expect(s1?.hasState).toBe(true);
    const s2 = body.children.find((c) => c.id === 'sess-002');
    expect(s2?.hasState).toBe(true);
  });

  it('resolves deeply nested paths with plain slashes', async () => {
    const introspector = createIntrospector({ logging: noopRootLogger });
    const sessionsScope = introspector.child('sessions');
    const sessionScope = sessionsScope.child('sess-001');
    const extScope = sessionScope.child('extensions');
    extScope
      .child('io.stagewise/context-compaction')
      .introspect(() => ({ status: 'idle' }));
    const app = createApp({ introspector });

    const response = await app.request(
      '/v1/introspect/sessions/sess-001/extensions/io.stagewise%2Fcontext-compaction',
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      path: string[];
      state: unknown;
    };
    expect(body.path).toEqual([
      'sessions',
      'sess-001',
      'extensions',
      'io.stagewise/context-compaction',
    ]);
    expect(body.state).toEqual({ status: 'idle' });
  });

  it('returns 404 when the path does not resolve', async () => {
    const introspector = createIntrospector({ logging: noopRootLogger });
    const app = createApp({ introspector });

    const response = await app.request('/v1/introspect/nonexistent');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  it('returns 500 when a state function throws', async () => {
    const introspector = createIntrospector({ logging: noopRootLogger });
    introspector.child('bad').introspect(() => {
      throw new Error('state explosion');
    });
    const app = createApp({ introspector });

    const response = await app.request('/v1/introspect/bad');
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Internal server error');
  });
});
