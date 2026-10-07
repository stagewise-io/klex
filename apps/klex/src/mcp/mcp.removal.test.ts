import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import {
  type Config,
  type ConfigListener,
  ConfigValidationError,
  type KlexConfig,
  type McpServerConfig,
} from '@/config';

import type { McpConnection, McpConnectionFactory } from './connection';
import { createMcp, type Mcp } from './mcp';
import { McpPendingAuthorizationRegistry } from './oauth/pending-authorizations';
import { McpOAuthStore } from './oauth/store';

const directories: string[] = [];
const modules: Mcp[] = [];
const url = 'https://mcp.example.com/mcp';
const issuer = 'https://auth.example.com';
const key = `clay\u0000${url}`;

function connection(namespace: string): McpConnection {
  return {
    namespace,
    tools: [],
    close: vi.fn(async () => undefined),
    listResources: async () => ({ resources: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
  } as unknown as McpConnection;
}

async function setup(
  connect: McpConnectionFactory = async ({ namespace }) =>
    connection(namespace),
) {
  const directory = await mkdtemp(join(tmpdir(), 'klex-mcp-removal-'));
  directories.push(directory);
  let servers: Record<string, McpServerConfig> = { clay: { url } };
  let listener: ConfigListener | undefined;
  const publish = (next: Record<string, McpServerConfig>) => {
    servers = next;
    void listener?.({ mcpServers: next } as KlexConfig);
  };
  const config = {
    getMcpServers: () => servers,
    subscribe: (next: ConfigListener) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    removeMcpServer: vi.fn(async (name: string) => {
      if (!servers[name])
        throw new ConfigValidationError('MCP server not found', {
          code: 'not_found',
        });
      const next = { ...servers };
      delete next[name];
      publish(next);
      return { mcpServers: next } as KlexConfig;
    }),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const pendingAuthorizations = new McpPendingAuthorizationRegistry();
  const mcp = createMcp({
    config: config as unknown as Config,
    logging: { child: () => logger } as unknown as RootLogger,
    dataDirectory: directory,
    connect,
    pendingAuthorizations,
  });
  modules.push(mcp);
  const store = new McpOAuthStore(
    join(directory, 'credentials', 'mcp-oauth.json'),
  );
  await store.saveTokens(key, {
    access_token: 'access',
    refresh_token: 'refresh',
    token_type: 'Bearer',
    issuer,
  });
  await store.saveClientInformation(key, 'https://cloud.example/callback', {
    client_id: 'client',
    issuer,
  });
  await store.saveCodeVerifier(key, 'verifier');
  return { mcp, config, store, publish, pendingAuthorizations, logger };
}

afterEach(async () => {
  await Promise.all(modules.splice(0).map((mcp) => mcp.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MCP server removal', () => {
  it('retries failed credential cleanup after the configuration is already gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const { mcp, store, config } = await setup();
    const remove = vi
      .spyOn(McpOAuthStore.prototype, 'removeServer')
      .mockRejectedValueOnce(new Error('disk full'));
    await expect(mcp.removeServer('clay')).rejects.toThrow('disk full');
    expect(config.getMcpServers()).toEqual({});
    await expect(store.tokens(key)).resolves.toBeDefined();
    await mcp.removeServer('clay');
    expect(remove).toHaveBeenCalledTimes(2);
    await expect(store.tokens(key)).resolves.toBeUndefined();
    await expect(mcp.removeServer('missing')).rejects.toThrow('not found');
  });

  it('disconnects, removes credentials and still succeeds if remote revocation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const active = connection('clay');
    const { mcp, config, store } = await setup(async () => active);
    await store.saveTokens('other', {
      access_token: 'other',
      token_type: 'Bearer',
    });
    await mcp.start();
    await vi.waitFor(() =>
      expect(mcp.getServerStatuses()[0]?.status).toBe('connected'),
    );
    await mcp.removeServer('clay');
    expect(config.getMcpServers()).toEqual({});
    expect(active.close).toHaveBeenCalledOnce();
    expect(mcp.getServerStatuses()).toEqual([]);
    await expect(store.tokens(key)).resolves.toBeUndefined();
    await expect(store.codeVerifier(key)).resolves.toBeUndefined();
    await expect(
      store.clientInformation(key, 'https://cloud.example/callback', issuer),
    ).resolves.toBeUndefined();
    await expect(store.tokens('other')).resolves.toMatchObject({
      access_token: 'other',
    });
  });

  it('cancels pending authorization and rejects a callback after deletion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    let signal: AbortSignal | undefined;
    const result = await setup(async (options) => {
      signal = options.signal;
      await result.pendingAuthorizations.register(
        {
          serverName: 'clay',
          serverUrl: url,
          authorizationUrl: `${issuer}/authorize`,
          state: 'state',
        },
        { signal, timeoutMs: 60_000 },
      );
      return connection('clay');
    });
    await result.mcp.start();
    expect(result.pendingAuthorizations.findByServer('clay')).toBeDefined();
    await result.mcp.removeServer('clay');
    expect(signal?.aborted).toBe(true);
    expect(result.pendingAuthorizations.findByServer('clay')).toBeUndefined();
    expect(
      result.mcp.completeAuthorization(
        'state',
        new URLSearchParams({ code: 'late' }),
      ),
    ).toBe('unknown');
  });

  it('waits for cleanup before connecting a replacement with the same name', async () => {
    let finishDiscovery!: (response: Response) => void;
    const discovery = new Promise<Response>((resolve) => {
      finishDiscovery = resolve;
    });
    const fetch = vi.fn(() => discovery);
    vi.stubGlobal('fetch', fetch);
    const connect = vi.fn(async ({ namespace }: { namespace: string }) =>
      connection(namespace),
    );
    const { mcp, publish, config } = await setup(connect);
    await mcp.start();
    const removal = mcp.removeServer('clay');
    expect(mcp.removeServer('clay')).toBe(removal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    publish({ clay: { url: 'https://replacement.example/mcp' } });
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(mcp.requestAuthorization('clay')).resolves.toEqual({
      outcome: 'unavailable',
    });
    finishDiscovery(
      Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ['code'],
      }),
    );
    await removal;
    expect(config.removeMcpServer).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1]?.[0]).toMatchObject({
      namespace: 'clay',
      config: { url: 'https://replacement.example/mcp' },
    });
  });

  it('keeps the connection and credentials if configuration removal fails', async () => {
    const active = connection('clay');
    const { mcp, config, store } = await setup(async () => active);
    await mcp.start();
    await vi.waitFor(() =>
      expect(mcp.getServerStatuses()[0]?.status).toBe('connected'),
    );
    config.removeMcpServer.mockRejectedValueOnce(new Error('disk full'));
    await expect(mcp.removeServer('clay')).rejects.toThrow('disk full');
    expect(active.close).not.toHaveBeenCalled();
    await expect(store.tokens(key)).resolves.toMatchObject({
      access_token: 'access',
    });
  });

  it('preserves credentials on shutdown and removes them even while stopped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const { mcp, store } = await setup();
    await mcp.start();
    await mcp.close();
    await expect(store.tokens(key)).resolves.toMatchObject({
      access_token: 'access',
    });
    await mcp.removeServer('clay');
    await expect(store.tokens(key)).resolves.toBeUndefined();
  });
});
