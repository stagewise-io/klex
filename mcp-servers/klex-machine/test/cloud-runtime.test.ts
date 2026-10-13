import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createProxyDaemon,
  type ProxyDaemonOptions,
} from '@klex/mcp-proxy-sdk/daemon/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectMachine } from '../src/cloud/connect.js';
import { MACHINE_FACTS_HEADER } from '../src/cloud/facts/index.js';
import { startCloudMachineRuntime } from '../src/cloud/runtime.js';
import { silentMachineLogger } from '../src/logger.js';

vi.mock('@klex/mcp-proxy-sdk/daemon/node', () => ({
  createProxyDaemon: vi.fn(() => ({
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    state: 'idle',
    activeExchangeCount: 0,
  })),
}));

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return {
    ...original,
    hostname: vi.fn(original.hostname),
    platform: vi.fn(original.platform),
  };
});

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
  it.each([false, true])(
    'recollects facts on each connection with omitHostDetails=%s',
    async (omitHostDetails) => {
      const dataDir = await setup();
      const runtime = await startCloudMachineRuntime(dataDir, handler, {
        cwd: dataDir,
        version: '0.1.0',
        omitHostDetails,
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        vi.mocked(hostname).mockReturnValue(`connection-${attempt}`);
        const details = await connection();
        expect(details.headers?.authorization).toBe('Bearer fixture-token');
        const header = details.headers?.[MACHINE_FACTS_HEADER];
        expect(header).toBeDefined();
        const facts = JSON.parse(
          Buffer.from(header ?? '', 'base64url').toString('utf8'),
        );
        expect(facts.machineVersion).toBe('0.1.0');
        if (omitHostDetails) {
          expect(facts).not.toHaveProperty('host');
        } else {
          expect(facts.host.hostname).toBe(`connection-${attempt}`);
          expect(facts.host.workspacePath).toBe(dataDir);
        }
      }
      expect(hostname).toHaveBeenCalledTimes(omitHostDetails ? 0 : 2);
      expect(fetch).toHaveBeenCalledTimes(2);
      await runtime.close();
    },
  );
  it.each(['collection failure', 'oversized header'])(
    'keeps authorization and warns on %s',
    async (failure) => {
      const dataDir = await setup();
      const warn = vi.fn();
      if (failure === 'collection failure') {
        vi.mocked(platform).mockImplementationOnce(() => {
          throw new Error('private probe failure');
        });
      }
      const runtime = await startCloudMachineRuntime(dataDir, handler, {
        cwd: failure === 'oversized header' ? '語'.repeat(1024) : dataDir,
        version: '0.1.0',
        omitHostDetails: false,
        logger: { ...silentMachineLogger, warn },
      });
      expect((await connection()).headers).toEqual({
        authorization: 'Bearer fixture-token',
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        failure === 'collection failure'
          ? 'Machine facts collection failed'
          : 'Machine facts exceed header size limit',
      );
      await runtime.close();
    },
  );

  it('keeps legacy runtime callers header-free', async () => {
    const runtime = await startCloudMachineRuntime(await setup(), handler);
    expect((await connection()).headers).not.toHaveProperty(
      MACHINE_FACTS_HEADER,
    );
    await runtime.close();
  });
});
