import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createProxyDaemon,
  type ProxyDaemonOptions,
} from '@klex/mcp-proxy-sdk/daemon/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectMachine } from '../src/cloud/connect.js';
import { MACHINE_FACTS_HEADER } from '../src/cloud/facts/index.js';
import { startCloudMachineRuntime } from '../src/cloud/runtime.js';

vi.mock('@klex/mcp-proxy-sdk/daemon/node', () => ({
  createProxyDaemon: vi.fn(() => ({
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    state: 'idle',
    activeExchangeCount: 0,
  })),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'facts-runtime-'));
  directories.push(dataDir);
  await connectMachine({
    dataDir,
    cloudBaseUrl: 'https://cloud.example',
    code: 'fixture',
    fetch: async () =>
      Response.json({
        machineId: 'machine-1',
        clientId: 'client-1',
        tokenEndpoint: 'https://cloud.example/api/auth/oauth2/token',
        proxyConnectionResource: 'https://cloud.example/machine-connections',
        proxyConnectionUrl: 'wss://cloud.example/machine-connections',
        mcpResourceUrl: 'https://cloud.example/machines/machine-1/mcp',
        oauthProtectedResourceUrl:
          'https://cloud.example/api/machines/machine-1/oauth-protected-resource',
      }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        access_token: 'fixture-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    ),
  );
  return dataDir;
}
const handler = { fetch: async () => new Response(), close: async () => {} };
function connection() {
  const options: ProxyDaemonOptions | undefined = vi
    .mocked(createProxyDaemon)
    .mock.calls.at(-1)?.[0];
  if (!options) throw new Error('Daemon was not created');
  return options.connection();
}

describe('Cloud facts transport', () => {
  it('collects on each connection with authorization and respects omission', async () => {
    const dataDir = await setup();
    const runtime = await startCloudMachineRuntime(dataDir, handler, {
      cwd: dataDir,
      version: '0.1.0',
      omitHostDetails: true,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const details = await connection();
      expect(details.headers?.authorization).toBe('Bearer fixture-token');
      const header = details.headers?.[MACHINE_FACTS_HEADER];
      expect(header).toBeDefined();
      const facts = JSON.parse(
        Buffer.from(header ?? '', 'base64url').toString('utf8'),
      );
      expect(facts.machineVersion).toBe('0.1.0');
      expect(facts).not.toHaveProperty('host');
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    await runtime.close();
  });
  it('keeps legacy runtime callers header-free', async () => {
    const runtime = await startCloudMachineRuntime(await setup(), handler);
    expect((await connection()).headers).not.toHaveProperty(
      MACHINE_FACTS_HEADER,
    );
    await runtime.close();
  });
});
