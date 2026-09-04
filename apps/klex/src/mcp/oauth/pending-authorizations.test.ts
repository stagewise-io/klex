import { describe, expect, it } from 'vitest';

import { McpPendingAuthorizationRegistry } from './pending-authorizations';

function register(
  registry: McpPendingAuthorizationRegistry,
  overrides: {
    serverName?: string;
    state?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<URLSearchParams> {
  return registry.register(
    {
      serverName: overrides.serverName ?? 'qonto',
      serverUrl: 'https://mcp.example.com/mcp',
      authorizationUrl: 'https://auth.example.com/authorize?state=secret',
      state: overrides.state ?? 'secret',
    },
    {
      signal: overrides.signal ?? new AbortController().signal,
      timeoutMs: overrides.timeoutMs ?? 1_000,
    },
  );
}

describe('McpPendingAuthorizationRegistry', () => {
  it('resolves a parked authorization with the delivered callback parameters', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const pending = register(registry);

    const [entry] = registry.list();
    expect(entry?.serverName).toBe('qonto');
    expect(
      registry.complete(
        'secret',
        new URLSearchParams({ code: 'auth-code', state: 'secret' }),
      ),
    ).toBe('accepted');

    expect((await pending).get('code')).toBe('auth-code');
    expect(registry.list()).toHaveLength(0);
  });

  it('rejects the authorization when the provider reports an error', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const pending = register(registry);
    const rejection = expect(pending).rejects.toThrow('denied or failed');

    expect(
      registry.complete(
        'secret',
        new URLSearchParams({ error: 'access_denied' }),
      ),
    ).toBe('accepted');
    await rejection;
  });

  it('rejects a callback that carries neither code nor error', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const pending = register(registry);
    const rejection = expect(pending).rejects.toThrow(
      'did not include an authorization code',
    );

    expect(registry.complete('secret', new URLSearchParams())).toBe('accepted');
    await rejection;
  });

  it('treats unknown and replayed states as unknown', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const pending = register(registry);

    expect(registry.complete('other', new URLSearchParams({ code: 'x' }))).toBe(
      'unknown',
    );
    expect(
      registry.complete('secret', new URLSearchParams({ code: 'x' })),
    ).toBe('accepted');
    expect(
      registry.complete('secret', new URLSearchParams({ code: 'x' })),
    ).toBe('unknown');
    await pending;
  });

  it('times out and drops the entry', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    await expect(register(registry, { timeoutMs: 5 })).rejects.toThrow(
      'timed out',
    );
    expect(registry.list()).toHaveLength(0);
    expect(
      registry.complete('secret', new URLSearchParams({ code: 'x' })),
    ).toBe('unknown');
  });

  it('rejects when the connection attempt aborts', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const controller = new AbortController();
    const pending = register(registry, { signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow('canceled');

    controller.abort();
    await rejection;
    expect(registry.list()).toHaveLength(0);
  });

  it('never exposes the state or the authorization URL in listings', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const pending = register(registry);

    const [entry] = registry.list();
    expect(entry).toBeDefined();
    expect(Object.keys(entry as object)).not.toContain('state');
    expect(Object.keys(entry as object)).not.toContain('authorizationUrl');

    registry.cancel((entry as { id: string }).id);
    await expect(pending).rejects.toThrow('canceled');
  });

  it('keeps concurrent authorizations for different servers independent', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const first = register(registry, { serverName: 'a', state: 'state-a' });
    const second = register(registry, { serverName: 'b', state: 'state-b' });

    expect(registry.list()).toHaveLength(2);
    registry.complete(
      'state-b',
      new URLSearchParams({ code: 'code-b', state: 'state-b' }),
    );
    expect((await second).get('code')).toBe('code-b');
    expect(registry.list()).toHaveLength(1);

    registry.complete('state-a', new URLSearchParams({ code: 'code-a' }));
    expect((await first).get('code')).toBe('code-a');
  });

  it('resolves waitForServer for existing and later registrations', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const pending = register(registry, { serverName: 'qonto' });
    await expect(registry.waitForServer('qonto', 50)).resolves.toMatchObject({
      serverName: 'qonto',
    });
    registry.complete('secret', new URLSearchParams({ code: 'x' }));
    await pending;

    const waiting = registry.waitForServer('later', 1_000);
    const laterPending = register(registry, {
      serverName: 'later',
      state: 'state-later',
    });
    await expect(waiting).resolves.toMatchObject({ serverName: 'later' });

    await expect(registry.waitForServer('missing', 5)).resolves.toBeUndefined();

    registry.closeAll();
    await expect(laterPending).rejects.toThrow('registry closed');
  });

  it('releases waitForServer callers on shutdown', async () => {
    const registry = new McpPendingAuthorizationRegistry();
    const waiting = registry.waitForServer('qonto', 60_000);
    registry.closeAll();
    await expect(waiting).resolves.toBeUndefined();
  });
});
