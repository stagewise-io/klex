import { describe, expect, it, vi } from 'vitest';

import { AttioClient, retryAfter } from '../src/attio.js';
import { CredentialCipher } from '../src/credentials.js';
import { LocalKeyWrapper, MemoryConnectionStore } from '../src/dev.js';
import { safeError } from '../src/errors.js';
import { createAttioHttp } from '../src/http.js';
import { AttioService } from '../src/service.js';
import { operation, type ToolName } from '../src/tools.js';

const workspace = '11111111-1111-4111-8111-111111111111';
const recordId = '22222222-2222-4222-8222-222222222222';
const objectId = '33333333-3333-4333-8333-333333333333';
const otherWorkspace = '44444444-4444-4444-8444-444444444444';
const principal = { tenantId: 'tenant-a', principalId: 'agent-a' };
const identity = {
  active: true,
  client_id: 'customer-app',
  token_type: 'Bearer',
  scope: 'object_configuration:read record_permission:read-write',
  exp: null,
  workspace_id: workspace,
};
const record = {
  id: { workspace_id: workspace, record_id: recordId, object_id: objectId },
  values: { name: [{ value: 'Example' }] },
};
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(body, { status, headers });
function fixture() {
  let now = 1_000_000;
  const store = new MemoryConnectionStore();
  const keys = new Map([
    ['v1', Buffer.alloc(32, 1)],
    ['v2', Buffer.alloc(32, 2)],
  ]);
  const cipher = new CredentialCipher(new LocalKeyWrapper(keys, 'v1'));
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/token'))
      return json({ access_token: 'TOKEN_CANARY', token_type: 'Bearer' });
    if (String(url).endsWith('/introspect')) return json(identity);
    if (String(url).endsWith('/query')) return json({ data: [record] });
    if (String(url).endsWith('/search'))
      return json({
        data: [
          { id: record.id, record_text: 'Example', object_slug: 'people' },
        ],
      });
    return json({ data: record });
  });
  const sleep = vi.fn(async () => {});
  const client = new AttioClient({
    fetch: fetcher,
    now: () => now,
    sleep,
    jitter: () => 0,
  });
  const options = {
    store,
    cipher,
    client,
    now: () => now,
    redirectUri: 'https://connector.example/attio/callback',
  };
  const service = new AttioService(options);
  async function pending() {
    const row = await service.create(principal, {
      clientId: 'customer-app',
      clientSecret: 'SECRET_CANARY',
    });
    const start = await service.start(principal, row.id, 'browser-session');
    const state = new URL(start.authorizationUrl).searchParams.get(
      'state',
    ) as string;
    return { id: row.id, state, url: start.authorizationUrl };
  }
  async function active() {
    const row = await pending();
    await service.callback(principal, 'browser-session', {
      state: row.state,
      code: 'CODE_CANARY',
    });
    return row;
  }
  return {
    store,
    cipher,
    keys,
    client,
    service,
    options,
    fetcher,
    sleep,
    pending,
    active,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('credentials', () => {
  it('encrypts with random data keys/nonces, binds tenant/entity/purpose, rejects tampering and supports rotation', async () => {
    const f = fixture();
    const context = {
      tenantId: 't',
      connectionId: 'c',
      purpose: 'access-token' as const,
    };
    const envelope = await f.cipher.seal('TOKEN_CANARY', context);
    expect(JSON.stringify(envelope)).not.toContain('TOKEN_CANARY');
    expect(await f.cipher.seal('TOKEN_CANARY', context)).not.toEqual(envelope);
    expect(await f.cipher.open(envelope, context)).toBe('TOKEN_CANARY');
    for (const changed of [
      { ...context, tenantId: 'other' },
      { ...context, connectionId: 'other' },
      { ...context, purpose: 'client-secret' as const },
    ])
      await expect(f.cipher.open(envelope, changed)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
    await expect(
      f.cipher.open({ ...envelope, ciphertext: 'AAAA' }, context),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const rotated = new CredentialCipher(new LocalKeyWrapper(f.keys, 'v2'));
    expect(await rotated.open(envelope, context)).toBe('TOKEN_CANARY');
    expect((await rotated.seal('new', context)).keyVersion).toBe('v2');
    await expect(
      new CredentialCipher(
        new LocalKeyWrapper(new Map([['v1', Buffer.alloc(32, 3)]]), 'v1'),
      ).open(envelope, context),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('stores only encrypted secrets and returns credential-free management status', async () => {
    const f = fixture();
    const row = await f.active();
    const stored = JSON.stringify(
      await f.store.get(principal.tenantId, row.id),
    );
    const status = JSON.stringify(await f.service.status(principal, row.id));
    for (const secret of ['TOKEN_CANARY', 'SECRET_CANARY', 'CODE_CANARY']) {
      expect(stored).not.toContain(secret);
      expect(status).not.toContain(secret);
    }
    expect(status).not.toContain('ciphertext');
  });
});

describe('OAuth and lifecycle', () => {
  it('pins authorization, form exchange, bearer introspection, and workspace binding', async () => {
    const f = fixture();
    const row = await f.active();
    const url = new URL(row.url);
    expect(url.origin + url.pathname).toBe('https://app.attio.com/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe(f.options.redirectUri);
    const [tokenUrl, init] = f.fetcher.mock.calls[0] ?? [];
    expect(tokenUrl).toBe('https://app.attio.com/oauth/token');
    expect(init?.redirect).toBe('error');
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'customer-app',
      client_secret: 'SECRET_CANARY',
      code: 'CODE_CANARY',
      redirect_uri: f.options.redirectUri,
    });
    expect(f.fetcher.mock.calls[1]?.[1]?.headers).toEqual({
      Authorization: 'Bearer TOKEN_CANARY',
    });
    expect(await f.service.status(principal, row.id)).toMatchObject({
      status: 'active',
      workspaceId: workspace,
    });
  });
  it('rejects absent, wrong, expired, cross-session, cross-tenant and replayed state', async () => {
    const f = fixture();
    const row = await f.pending();
    await expect(
      f.service.callback(principal, 'browser-session', {}),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    for (const [who, session, state] of [
      [principal, 'wrong', row.state],
      [{ ...principal, tenantId: 'other' }, 'browser-session', row.state],
      [principal, 'browser-session', 'a'.repeat(43)],
    ] as const)
      await expect(
        f.service.callback(who, session, { state, code: 'code' }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.advance(600_000);
    await expect(
      f.service.callback(principal, 'browser-session', {
        state: row.state,
        code: 'code',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const active = await f.active();
    await expect(
      f.service.callback(principal, 'browser-session', {
        state: active.state,
        code: 'code',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
  it('consumes denial and concurrent callbacks only once', async () => {
    const f = fixture();
    const denied = await f.pending();
    await expect(
      f.service.callback(principal, 'browser-session', {
        state: denied.state,
        error: 'access_denied',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      f.service.callback(principal, 'browser-session', {
        state: denied.state,
        code: 'code',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const row = await f.pending();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        f.service.callback(principal, 'browser-session', {
          state: row.state,
          code: 'code',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/token')),
    ).toHaveLength(1);
  });
  it.each(['disconnect', 'rotate', 'restart'] as const)(
    'fences a callback after %s',
    async (action) => {
      const f = fixture();
      const row = await f.pending();
      if (action === 'disconnect')
        await f.service.disconnect(principal, row.id);
      if (action === 'rotate')
        await f.service.rotateAppSecret(principal, row.id, 'rotated');
      if (action === 'restart')
        await f.service.start(principal, row.id, 'browser-session');
      await expect(
        f.service.callback(principal, 'browser-session', {
          state: row.state,
          code: 'code',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it('fences an already exchanging callback after disconnect', async () => {
    const f = fixture();
    const row = await f.pending();
    f.fetcher.mockImplementationOnce(async () => {
      await f.service.disconnect(principal, row.id);
      return json({ access_token: 'TOKEN_CANARY', token_type: 'Bearer' });
    });
    await expect(
      f.service.callback(principal, 'browser-session', {
        state: row.state,
        code: 'code',
      }),
    ).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
    expect(await f.service.status(principal, row.id)).toMatchObject({
      status: 'disconnected',
    });
  });
  it.each([
    { active: false },
    { ...identity, exp: 1 },
    { ...identity, scope: 'record_permission:read' },
    { ...identity, client_id: 'other' },
    { ...identity, workspace_id: otherWorkspace },
  ])('fails closed on invalid identity %j', async (invalid) => {
    const f = fixture();
    const row = await f.active();
    f.fetcher.mockImplementationOnce(async () => json(invalid));
    await expect(
      f.service.execute(principal, row.id, 'get_record', {
        object: 'people',
        record_id: recordId,
      }),
    ).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
    const restartedService = new AttioService(f.options);
    expect(await restartedService.status(principal, row.id)).toMatchObject({
      status: 'reconnect_required',
    });
    const calls = f.fetcher.mock.calls.length;
    await expect(
      restartedService.execute(principal, row.id, 'get_record', {
        object: 'people',
        record_id: recordId,
      }),
    ).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });
  it('blocks an introspection outage without revoking and prevents records dispatch', async () => {
    const f = fixture();
    const row = await f.active();
    f.fetcher.mockReset().mockResolvedValue(json({}, 503));
    await expect(
      f.service.execute(principal, row.id, 'get_record', {
        object: 'people',
        record_id: recordId,
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(await f.service.status(principal, row.id)).toMatchObject({
      status: 'active',
    });
  });
  it('keeps the original workspace on reconnect', async () => {
    const f = fixture();
    const row = await f.active();
    await f.service.disconnect(principal, row.id);
    const url = await f.service.start(principal, row.id, 'browser-session');
    f.fetcher.mockImplementation(async (input) =>
      String(input).endsWith('/token')
        ? json({ access_token: 'token', token_type: 'Bearer' })
        : json({ ...identity, workspace_id: otherWorkspace }),
    );
    await expect(
      f.service.callback(principal, 'browser-session', {
        state: new URL(url.authorizationUrl).searchParams.get('state'),
        code: 'code',
      }),
    ).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
    expect(await f.service.status(principal, row.id)).toMatchObject({
      workspaceId: workspace,
      status: 'pending',
    });
  });
});

describe('record mappings and isolation', () => {
  const cases: [ToolName, Record<string, unknown>, string, string, unknown][] =
    [
      [
        'query_records',
        {
          object: 'companies',
          filter: { domains: { domain: { $eq: 'example.com' } } },
          limit: 10,
          offset: 20,
        },
        'POST',
        '/v2/objects/companies/records/query',
        {
          filter: { domains: { domain: { $eq: 'example.com' } } },
          limit: 10,
          offset: 20,
        },
      ],
      [
        'search_records',
        { query: 'Ada', objects: ['people'], limit: 5 },
        'POST',
        '/v2/objects/records/search',
        {
          query: 'Ada',
          objects: ['people'],
          limit: 5,
          request_as: { type: 'workspace' },
        },
      ],
      [
        'get_record',
        { object: 'people', record_id: recordId },
        'GET',
        `/v2/objects/people/records/${recordId}`,
        undefined,
      ],
      [
        'create_record',
        { object: 'custom_object', values: { name: [{ value: 'Example' }] } },
        'POST',
        '/v2/objects/custom_object/records',
        { data: { values: { name: [{ value: 'Example' }] } } },
      ],
      [
        'update_record_append',
        {
          object: 'people',
          record_id: recordId,
          values: { tags: ['new'], score: 2 },
        },
        'PATCH',
        `/v2/objects/people/records/${recordId}`,
        { data: { values: { tags: ['new'], score: 2 } } },
      ],
      [
        'update_record_replace',
        { object: 'people', record_id: recordId, values: { tags: [] } },
        'PUT',
        `/v2/objects/people/records/${recordId}`,
        { data: { values: { tags: [] } } },
      ],
    ];
  it.each(cases)(
    '%s uses exact method/path/body',
    async (name, input, method, path, body) => {
      const f = fixture();
      const row = await f.active();
      await f.service.execute(principal, row.id, name, input);
      const [url, init] = f.fetcher.mock.calls.at(-1) ?? [];
      expect(url).toBe(`https://api.attio.com${path}`);
      expect(init?.method).toBe(method);
      expect(
        init?.body === undefined ? undefined : JSON.parse(init.body as string),
      ).toEqual(body);
      expect(init?.redirect).toBe('error');
    },
  );
  it('passes PATCH/PUT typed values and omitted attributes without local merge or flattening', () => {
    const values = {
      tags: ['new'],
      name: [{ first_name: 'Ada', last_name: 'Lovelace' }],
    };
    const append = operation('update_record_append', {
      object: 'people',
      record_id: recordId,
      values,
    });
    const replace = operation('update_record_replace', {
      object: 'people',
      record_id: recordId,
      values: { tags: [] },
    });
    expect(append.body).toEqual({ data: { values } });
    expect(replace.body).toEqual({ data: { values: { tags: [] } } });
  });
  it.each([
    { object: '../escape' },
    { object: 'https://evil.example' },
    { object: 'people', token: 'canary' },
    { object: 'people', workspace_id: workspace },
    { object: 'people', limit: 101 },
  ])('rejects routing overrides and invalid bounds %j', (input) => {
    expect(() => operation('query_records', input)).toThrow('Invalid input');
  });
  it('bounds input size and depth', () => {
    expect(() =>
      operation('create_record', {
        object: 'people',
        values: { large: 'a'.repeat(70_000) },
      }),
    ).toThrow();
    let nested: unknown = {};
    for (let i = 0; i < 20; i++) nested = { child: nested };
    expect(() =>
      operation('query_records', { object: 'people', filter: nested }),
    ).toThrow();
  });
  it('denies guessed connections and different principals before any upstream call', async () => {
    const f = fixture();
    const row = await f.active();
    f.fetcher.mockClear();
    for (const who of [
      { ...principal, tenantId: 'other' },
      { ...principal, principalId: 'other' },
    ])
      await expect(
        f.service.execute(who, row.id, 'get_record', {
          object: 'people',
          record_id: recordId,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('rejects foreign record results and revokes the connection', async () => {
    const f = fixture();
    const row = await f.active();
    f.fetcher
      .mockImplementationOnce(async () => json(identity))
      .mockImplementationOnce(async () =>
        json({
          data: {
            ...record,
            id: { ...record.id, workspace_id: otherWorkspace },
          },
        }),
      );
    await expect(
      f.service.execute(principal, row.id, 'get_record', {
        object: 'people',
        record_id: recordId,
      }),
    ).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
  });
  it.each(['before', 'after'])(
    'fences disconnect %s record dispatch',
    async (when) => {
      const f = fixture();
      const row = await f.active();
      f.fetcher.mockImplementation(async (url) => {
        if (String(url).endsWith('/introspect')) {
          if (when === 'before') await f.service.disconnect(principal, row.id);
          return json(identity);
        }
        await f.service.disconnect(principal, row.id);
        return json({ data: record });
      });
      await expect(
        f.service.execute(principal, row.id, 'get_record', {
          object: 'people',
          record_id: recordId,
        }),
      ).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
      expect(await f.service.status(principal, row.id)).toMatchObject({
        status: 'disconnected',
      });
    },
  );
});

describe('HTTP failures and retry policy', () => {
  it('parses both Retry-After forms and caps the delay', () => {
    expect(retryAfter('2', 0)).toBe(2000);
    expect(retryAfter(new Date(3000).toUTCString(), 0)).toBe(3000);
    expect(retryAfter('999999', 0)).toBe(60_000);
    expect(retryAfter('bad', 0)).toBeUndefined();
  });
  it.each([400, 401, 403, 404, 409, 429, 500])(
    'sanitizes status %s and never replays a mutation',
    async (status) => {
      const f = fixture();
      f.fetcher.mockReset().mockImplementation(async () =>
        json({ message: 'TOKEN_CANARY SECRET_CANARY' }, status, {
          'Retry-After': '2',
        }),
      );
      const error = await f.client
        .records(
          'token',
          workspace,
          operation('create_record', { object: 'people', values: {} }),
          async () => {},
        )
        .catch((e) => e);
      expect(JSON.stringify(safeError(error))).not.toContain('CANARY');
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      if (status === 500) expect(error.code).toBe('WRITE_OUTCOME_UNKNOWN');
      if (status === 409) expect(error.code).toBe('CONFLICT');
    },
  );
  it('retries query/search reads at most twice and honors Retry-After', async () => {
    const f = fixture();
    f.fetcher
      .mockReset()
      .mockImplementation(async () => json({}, 429, { 'Retry-After': '2' }));
    await expect(
      f.client.records(
        'token',
        workspace,
        operation('query_records', { object: 'people' }),
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.sleep.mock.calls).toEqual([[2000], [2000]]);
  });
  it.each(['network', 'malformed', 'oversized'])(
    'reports ambiguous %s writes without replay',
    async (failure) => {
      const f = fixture();
      f.fetcher.mockReset().mockImplementation(async () => {
        if (failure === 'network') throw new Error('SECRET_CANARY');
        return new Response(
          failure === 'malformed'
            ? 'not-json TOKEN_CANARY'
            : 'a'.repeat(1_048_577),
        );
      });
      await expect(
        f.client.records(
          'token',
          workspace,
          operation('create_record', { object: 'people', values: {} }),
          async () => {},
        ),
      ).rejects.toMatchObject({ code: 'WRITE_OUTCOME_UNKNOWN' });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('reports unavailable search without fallback', async () => {
    const f = fixture();
    f.fetcher.mockReset().mockResolvedValue(json({}, 404));
    await expect(
      f.client.records(
        'token',
        workspace,
        operation('search_records', { query: 'Ada', objects: ['people'] }),
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('MCP transport', () => {
  it('returns sanitized tool errors, denies foreign principals and bounds request bodies', async () => {
    const f = fixture();
    const row = await f.active();
    const request = (body: string) =>
      new Request(`https://connector.example/connections/${row.id}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body,
      });
    const call = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_record',
        arguments: { object: 'people', values: {} },
      },
    });
    const http = createAttioHttp(f.service, {
      authenticate: async () => principal,
    });
    f.fetcher
      .mockImplementationOnce(async () => json(identity))
      .mockImplementationOnce(async () =>
        json({ message: 'SECRET_CANARY TOKEN_CANARY' }, 409),
      );
    const response = await http.fetch(request(call));
    const body = await response.text();
    expect(body).toContain('CONFLICT');
    expect(body).toContain('isError');
    expect(body).not.toContain('CANARY');
    const foreign = createAttioHttp(f.service, {
      authenticate: async () => ({ ...principal, principalId: 'other' }),
    });
    expect((await foreign.fetch(request(call))).status).toBe(404);
    expect((await http.fetch(request('a'.repeat(131_073)))).status).toBe(400);
  });
  it('authenticates and authorizes every request and exposes only six records tools', async () => {
    const f = fixture();
    const row = await f.active();
    const auth = {
      authenticate: vi.fn(async (request: Request) =>
        request.headers.get('Authorization') === 'Bearer klex-credential'
          ? principal
          : undefined,
      ),
    };
    const http = createAttioHttp(f.service, auth);
    const request = (authorized: boolean) =>
      new Request(`https://connector.example/connections/${row.id}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(authorized ? { Authorization: 'Bearer klex-credential' } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await http.fetch(request(false))).status).toBe(401);
    const response = await http.fetch(request(true));
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const name of [
      'query_records',
      'search_records',
      'get_record',
      'create_record',
      'update_record_append',
      'update_record_replace',
    ])
      expect(text).toContain(name);
    expect(text).not.toContain('CANARY');
    expect(auth.authenticate).toHaveBeenCalledTimes(2);
  });
});

describe('additional isolation guarantees', () => {
  it('serves two tenants and workspaces independently and strips unknown response metadata', async () => {
    const f = fixture();
    const first = await f.active();
    const secondPrincipal = { tenantId: 'tenant-b', principalId: 'agent-b' };
    const second = await f.service.create(secondPrincipal, {
      clientId: 'customer-app-b',
      clientSecret: 'secret-b',
    });
    const start = await f.service.start(
      secondPrincipal,
      second.id,
      'session-b',
    );
    const secondIdentity = {
      ...identity,
      client_id: 'customer-app-b',
      workspace_id: otherWorkspace,
    };
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/token'))
        return json({ access_token: 'token-b', token_type: 'Bearer' });
      const tenantB =
        new Headers(init?.headers).get('Authorization') === 'Bearer token-b';
      if (String(url).endsWith('/introspect'))
        return json(tenantB ? secondIdentity : identity);
      return json({
        data: {
          ...record,
          id: {
            ...record.id,
            workspace_id: tenantB ? otherWorkspace : workspace,
          },
          access_token: 'TOKEN_CANARY',
        },
      });
    });
    await f.service.callback(secondPrincipal, 'session-b', {
      state: new URL(start.authorizationUrl).searchParams.get('state'),
      code: 'code-b',
    });
    for (const [who, id, expected] of [
      [principal, first.id, workspace],
      [secondPrincipal, second.id, otherWorkspace],
    ] as const) {
      const result = await f.service.execute(who, id, 'get_record', {
        object: 'people',
        record_id: recordId,
      });
      expect(result.data).toMatchObject({ id: { workspace_id: expected } });
      expect(JSON.stringify(result)).not.toContain('TOKEN_CANARY');
    }
  });
  it.each([401, 403])(
    'handles record status %s without confusing permissions with revocation',
    async (status) => {
      const f = fixture();
      const row = await f.active();
      f.fetcher
        .mockImplementationOnce(async () => json(identity))
        .mockImplementationOnce(async () => json({}, status));
      await expect(
        f.service.execute(principal, row.id, 'get_record', {
          object: 'people',
          record_id: recordId,
        }),
      ).rejects.toMatchObject({
        code: status === 401 ? 'RECONNECT_REQUIRED' : 'PERMISSION_DENIED',
      });
      expect(await f.service.status(principal, row.id)).toMatchObject({
        status: status === 401 ? 'reconnect_required' : 'active',
      });
    },
  );
  it('does not retry a read past its deadline or return malformed/oversized results', async () => {
    const f = fixture();
    const op = operation('get_record', {
      object: 'people',
      record_id: recordId,
    });
    f.fetcher
      .mockReset()
      .mockImplementation(async () => json({}, 429, { 'Retry-After': '60' }));
    await expect(
      f.client.records('token', workspace, op, async () => {}),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 60_000 });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    for (const response of [
      new Response('bad'),
      new Response('a'.repeat(1_048_577)),
      json({ data: {} }),
    ]) {
      f.fetcher.mockReset().mockResolvedValue(response);
      await expect(
        f.client.records('token', workspace, op, async () => {}),
      ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
