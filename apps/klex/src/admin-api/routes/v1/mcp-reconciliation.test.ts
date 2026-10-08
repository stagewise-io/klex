import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@stagewise/logger';

import {
  CONFIG_FILE_NAME,
  CONFIG_STORE_DEFINITION,
  type Config,
  createConfig,
  type McpServerConfig,
} from '@/config';
import { createLocalData } from '@/local-data';
import { KLEX_VERSION } from '@/release';

import {
  reconcileMcpServer,
  reconcileMcpServerRoute,
  removeMatchingMcpServers,
  removeMatchingMcpServersRoute,
} from './mcp';
import { setupTestApp } from './test-utils';

const url = 'https://proxy.example/machines/123/mcp';
const name = 'machine-julians-macbook-12345678';
const otherName = 'other-connector';
const credentials = {
  url,
  type: 'streamable-http',
  headers: { Authorization: 'Bearer test-only-secret' },
  versionNegotiation: { pin: '2025-11-25' },
} satisfies McpServerConfig;
const logging = createLogger({ console: false });
const handles: { config: Config; dataDirectory: string }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { config, dataDirectory } of handles.splice(0)) {
    await config.close();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

async function setup(mcpServers: Record<string, McpServerConfig> = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'klex-mcp-reconcile-'));
  const path = join(dataDirectory, CONFIG_FILE_NAME);
  await writeFile(
    path,
    JSON.stringify({
      configVersion: 2,
      officialName: 'Fixture',
      providers: {},
      modelSelection: {},
      mcpServers,
    }),
  );
  await createLocalData({
    logging,
    dataDirectory,
    klexVersion: KLEX_VERSION,
    stores: [CONFIG_STORE_DEFINITION],
  }).start();
  const config = createConfig({ logging, dataDirectory });
  handles.push({ config, dataDirectory });
  await config.start();
  const published = vi.fn();
  config.subscribe(published);
  const deps = { config, logger: logging };
  const app = setupTestApp((app) => {
    app.openapi(reconcileMcpServerRoute, reconcileMcpServer(deps));
    app.openapi(removeMatchingMcpServersRoute, removeMatchingMcpServers(deps));
  });
  const post = (route: string, body: unknown) =>
    app.request(`/v1/mcp-servers/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { config, app, post, path, dataDirectory, published };
}

const reconcile = { name, url };

describe('resource-verified MCP reconciliation', () => {
  it.each<{ servers: Record<string, McpServerConfig>; status: string }>([
    { servers: {}, status: 'created' },
    { servers: { [name]: credentials }, status: 'already_present' },
  ])(
    'reconciles $status and persists exactly one canonical entry',
    async ({ servers, status }) => {
      const { post, config, path, published } = await setup(servers);
      const response = await post('reconcile', reconcile);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        code: 'mcp_resource_reconciled',
        status,
      });
      expect(Object.keys(config.get().mcpServers)).toEqual([name]);
      if (status !== 'created')
        expect(config.get().mcpServers[name]).toEqual(credentials);
      expect(JSON.parse(await readFile(path, 'utf8')).mcpServers).toEqual(
        config.get().mcpServers,
      );
      expect(published).toHaveBeenCalledTimes(
        status === 'already_present' ? 0 : 1,
      );
      const beforeRetry = await readFile(path, 'utf8');
      published.mockClear();
      expect(await (await post('reconcile', reconcile)).json()).toEqual({
        code: 'mcp_resource_reconciled',
        status: 'already_present',
      });
      expect(await readFile(path, 'utf8')).toBe(beforeRetry);
      expect(published).not.toHaveBeenCalled();
    },
  );

  it.each<Record<string, McpServerConfig>>([
    { [name]: { url: 'https://other.example/mcp' } },
    { [name]: { command: 'stdio' } },
  ] satisfies Record<string, McpServerConfig>[])(
    'refuses wrong resources and stdio connectors without writes',
    async (servers) => {
      const { post, path, published } = await setup(servers);
      const before = await readFile(path, 'utf8');
      const response = await post('reconcile', reconcile);
      expect(response.status).toBe(409);
      expect(await response.text()).not.toMatch(
        /https:|test-only-secret|Bearer different|stdio/,
      );
      expect(await readFile(path, 'utf8')).toBe(before);
      expect(published).not.toHaveBeenCalled();
    },
  );

  it('recognizes equivalent HTTP URLs without losing settings', async () => {
    const server = {
      ...credentials,
      url: 'https://PROXY.example:443/machines/123/mcp',
    };
    const { post, config, published } = await setup({ [name]: server });
    expect((await post('reconcile', reconcile)).status).toBe(200);
    expect(config.get().mcpServers).toEqual({ [name]: server });
    expect(published).not.toHaveBeenCalled();
  });

  it('preserves unrelated concurrent mutations and serializes duplicate retries', async () => {
    const { post, config, published } = await setup();
    const responses = await Promise.all([
      post('reconcile', reconcile),
      config.addMcpServer('unrelated', {
        url: 'https://unrelated.example/mcp',
      }),
      post('reconcile', reconcile),
    ]);
    expect(responses[0].status).toBe(200);
    expect(responses[2].status).toBe(200);
    expect(Object.keys(config.get().mcpServers).sort()).toEqual([
      name,
      'unrelated',
    ]);
    expect(published).toHaveBeenCalledTimes(2);
  });

  it('recovers the canonical namespace and credentials after restarting config', async () => {
    const { post, config, dataDirectory, path } = await setup({
      [name]: credentials,
    });
    const metadata = JSON.parse(await readFile(path, 'utf8'))._klex;
    await post('reconcile', reconcile);
    await config.close();
    const restarted = createConfig({ logging, dataDirectory });
    try {
      await restarted.start();
      expect(restarted.get().mcpServers).toEqual({ [name]: credentials });
      expect(JSON.parse(await readFile(path, 'utf8'))._klex).toEqual(metadata);
    } finally {
      await restarted.close();
    }
  });

  it('does not publish or replace in-memory config when persistence fails', async () => {
    const { post, config, path, published } = await setup();
    const logged = vi.spyOn(logging, 'error');
    await rm(path);
    await mkdir(path);
    const response = await post('reconcile', reconcile);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Failed to reconcile connector',
      code: 'internal_error',
    });
    expect(config.get().mcpServers).toEqual({});
    expect(published).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      'MCP resource reconciliation failed',
    );
  });

  it.each([
    { ...reconcile, url: 'file:///tmp/mcp' },
    { ...reconcile, url: 'not a URL' },
    { ...reconcile, url: 'https://' },
    { ...reconcile, url: '' },
    { ...reconcile, name: '' },
    { ...reconcile, headers: { Authorization: 'Bearer rejected' } },
  ])('validates strict input before mutation', async (body) => {
    const { post, published } = await setup();
    expect((await post('reconcile', body)).status).toBe(400);
    expect(published).not.toHaveBeenCalled();
  });

  it('does not treat inherited object properties as configured connectors', async () => {
    const { post, config } = await setup();
    expect((await post('reconcile', { name: 'constructor', url })).status).toBe(
      200,
    );
    expect(Object.keys(config.get().mcpServers)).toEqual(['constructor']);
  });
});

describe('config mutation isolation', () => {
  it('validates and persists an in-place mutation before publishing it', async () => {
    const { config, path, published } = await setup();
    const before = config.get();
    await config.mutate((current) => {
      current.mcpServers[name] = credentials;
      return current;
    });
    expect(before.mcpServers).toEqual({});
    expect(config.get().mcpServers).toEqual({ [name]: credentials });
    expect(JSON.parse(await readFile(path, 'utf8')).mcpServers).toEqual({
      [name]: credentials,
    });
    expect(published).toHaveBeenCalledTimes(1);
  });

  it.each(['validation', 'callback', 'persistence'] as const)(
    'keeps committed config unchanged after an in-place %s failure and recovers the queue',
    async (failure) => {
      const { config, path, published } = await setup();
      const before = config.get();
      const stored = await readFile(path, 'utf8');
      if (failure === 'persistence') {
        await rm(path);
        await mkdir(path);
      }
      await expect(
        config.mutate((current) => {
          current.mcpServers[name] =
            failure === 'validation' ? { url: '' } : credentials;
          if (failure === 'callback') throw new Error('Callback failed');
          return current;
        }),
      ).rejects.toThrow();
      expect(config.get()).toBe(before);
      expect(config.get().mcpServers).toEqual({});
      expect(published).not.toHaveBeenCalled();
      if (failure === 'persistence') {
        await rm(path, { recursive: true });
        await writeFile(path, stored);
      } else {
        expect(await readFile(path, 'utf8')).toBe(stored);
      }
      await config.addMcpServer(name, credentials);
      expect(config.get().mcpServers).toEqual({ [name]: credentials });
      expect(published).toHaveBeenCalledTimes(1);
    },
  );

  it('skips unchanged mutations and documents both validation responses', async () => {
    const { config, app, path, published } = await setup();
    const before = config.get();
    const stored = await readFile(path, 'utf8');
    expect(await config.mutate((current) => current)).toBe(before);
    expect(await readFile(path, 'utf8')).toBe(stored);
    expect(published).not.toHaveBeenCalled();
    const document = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'Test', version: '1' },
    });
    for (const route of ['reconcile', 'remove-matching']) {
      expect(
        document.paths?.[`/v1/mcp-servers/${route}`]?.post?.responses?.['400'],
      ).toMatchObject({
        content: {
          'application/json': { schema: { $ref: expect.any(String) } },
        },
      });
    }
  });
});

describe('exact connector names', () => {
  it('reconciles only the requested whitespace-padded name', async () => {
    const padded = ` ${name} `;
    const { post, config } = await setup({ [name]: credentials });
    expect(
      await (await post('reconcile', { name: padded, url })).json(),
    ).toEqual({ code: 'mcp_resource_reconciled', status: 'created' });
    expect(config.get().mcpServers).toEqual({
      [name]: credentials,
      [padded]: { url },
    });
    expect(
      await (await post('reconcile', { name: padded, url })).json(),
    ).toEqual({ code: 'mcp_resource_reconciled', status: 'already_present' });
  });

  it('removes only the requested whitespace-padded name', async () => {
    const padded = ` ${name} `;
    const { post, config, published } = await setup({
      [name]: credentials,
      [padded]: credentials,
    });
    expect(
      (await post('remove-matching', { names: [padded], url })).status,
    ).toBe(200);
    expect(config.get().mcpServers).toEqual({ [name]: credentials });
    expect(published).toHaveBeenCalledTimes(1);
  });
});

describe('guarded MCP removal', () => {
  it('removes matching names atomically and tolerates lost-response retries', async () => {
    const { post, config, published } = await setup({
      [otherName]: credentials,
      [name]: credentials,
      unrelated: { url },
    });
    const body = { names: [otherName, name, otherName], url };
    expect(await (await post('remove-matching', body)).json()).toEqual({
      code: 'mcp_resource_removed',
      status: 'removed',
    });
    expect(config.get().mcpServers).toEqual({ unrelated: { url } });
    expect(published).toHaveBeenCalledTimes(1);
    expect(await (await post('remove-matching', body)).json()).toEqual({
      code: 'mcp_resource_removed',
      status: 'already_absent',
    });
    expect(published).toHaveBeenCalledTimes(1);
  });

  it.each([
    { url: 'https://other.example/mcp' },
    { command: 'stdio' },
  ] satisfies McpServerConfig[])(
    'leaves every connector intact on conflict',
    async (other) => {
      const { post, config, published } = await setup({
        [otherName]: credentials,
        [name]: other,
      });
      const response = await post('remove-matching', {
        names: [otherName, name],
        url,
      });
      expect(response.status).toBe(409);
      expect(config.get().mcpServers).toEqual({
        [otherName]: credentials,
        [name]: other,
      });
      expect(published).not.toHaveBeenCalled();
    },
  );

  it('preserves config when removal persistence fails', async () => {
    const { post, config, path, published } = await setup({
      [name]: credentials,
    });
    const logged = vi.spyOn(logging, 'error');
    await rm(path);
    await mkdir(path);
    expect((await post('remove-matching', { names: [name], url })).status).toBe(
      500,
    );
    expect(config.get().mcpServers).toEqual({ [name]: credentials });
    expect(published).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      { error: expect.any(Error) },
      'MCP resource removal failed',
    );
  });

  it.each(['not a URL', 'https://', '', 'file:///tmp/mcp'])(
    'returns 400 for invalid removal URL %s without mutation',
    async (invalidUrl) => {
      const { post, config, path, published } = await setup({
        [name]: credentials,
      });
      const before = await readFile(path, 'utf8');
      expect(
        (await post('remove-matching', { names: [name], url: invalidUrl }))
          .status,
      ).toBe(400);
      expect(config.get().mcpServers).toEqual({ [name]: credentials });
      expect(await readFile(path, 'utf8')).toBe(before);
      expect(published).not.toHaveBeenCalled();
    },
  );
});
