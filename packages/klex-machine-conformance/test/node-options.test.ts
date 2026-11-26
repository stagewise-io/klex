import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type FakeCloud, startFakeCloud } from '../src/cloud.js';
import {
  runCli,
  spawnCli,
  temporaryDirectory,
  windows,
} from '../src/harness.js';

interface RecordingProxy {
  url: string;
  /** `CONNECT` targets, with the local port of each upstream socket. */
  tunnels: { target: string; upstreamPort: number | undefined }[];
  close(): Promise<void>;
}

async function startRecordingProxy(): Promise<RecordingProxy> {
  const tunnels: RecordingProxy['tunnels'] = [];
  const server: Server = createServer((_request, response) => {
    response.writeHead(502).end();
  });
  server.on('connect', (request, client, head) => {
    const [host, port] = (request.url ?? '').split(':');
    const upstream = connect(Number(port), host, () => {
      tunnels.push({
        target: request.url ?? '',
        upstreamPort: upstream.localPort,
      });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    tunnels,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

let cloud: FakeCloud;
let proxy: RecordingProxy;

beforeEach(async () => {
  cloud = await startFakeCloud(await temporaryDirectory());
  proxy = await startRecordingProxy();
});
afterEach(async () => {
  await cloud.close();
  await proxy.close();
});

/** Points every proxy variable spelling at the recording proxy. */
const proxyEnv = (): NodeJS.ProcessEnv => ({
  NODE_EXTRA_CA_CERTS: cloud.caFile,
  HTTP_PROXY: proxy.url,
  HTTPS_PROXY: proxy.url,
  http_proxy: proxy.url,
  https_proxy: proxy.url,
  NO_PROXY: '',
  no_proxy: '',
});

async function enrollAndServe(env: NodeJS.ProcessEnv) {
  const machine = spawnCli(
    [
      'cloud',
      'enroll',
      cloud.issueCode(),
      '--omit-host-details',
      '--cloud-base-url',
      cloud.baseUrl,
      '--data-dir',
      await temporaryDirectory(),
    ],
    { env },
  );
  await machine.stdoutContains('is live');
  return machine;
}

describe('Node runtime options', () => {
  it('sends Cloud HTTP requests through the env proxy, but not the WebSocket', async () => {
    await enrollAndServe({ ...proxyEnv(), NODE_USE_ENV_PROXY: '1' });
    const proxied = new Set(proxy.tunnels.map((tunnel) => tunnel.upstreamPort));
    const target = new URL(cloud.baseUrl).host;
    expect(proxy.tunnels.length).toBeGreaterThan(0);
    expect(proxy.tunnels.every((tunnel) => tunnel.target === target)).toBe(
      true,
    );
    const requests = cloud.peers.filter((peer) => !peer.upgrade);
    expect(requests.map((peer) => peer.path)).toContain('/api/machines/enroll');
    expect(requests.every((peer) => proxied.has(peer.remotePort))).toBe(true);
    // The TS server's `ws` client builds its own connection, so Node's env
    // proxy never applies to it.
    const upgrades = cloud.peers.filter((peer) => peer.upgrade);
    expect(upgrades.map((peer) => peer.path)).toEqual(['/machine-connections']);
    expect(proxied.has(upgrades[0]!.remotePort)).toBe(false);
  });

  it('accepts --use-env-proxy in NODE_OPTIONS', async () => {
    await enrollAndServe({ ...proxyEnv(), NODE_OPTIONS: '--use-env-proxy' });
    expect(proxy.tunnels.length).toBeGreaterThan(0);
  });

  it('ignores proxy variables without the switch', async () => {
    await enrollAndServe(proxyEnv());
    expect(proxy.tunnels).toEqual([]);
  });

  it('bypasses the proxy for NO_PROXY hosts', async () => {
    await enrollAndServe({
      ...proxyEnv(),
      NODE_USE_ENV_PROXY: '1',
      // Windows treats both spellings as one variable.
      NO_PROXY: 'localhost, 127.0.0.1',
      no_proxy: 'localhost, 127.0.0.1',
    });
    expect(proxy.tunnels).toEqual([]);
  });

  // macOS and Windows read their native stores, which SSL_CERT_FILE can't seed.
  it.skipIf(windows || process.platform === 'darwin')(
    'trusts the system store with --use-system-ca',
    async () => {
      const enroll = (env: NodeJS.ProcessEnv) =>
        temporaryDirectory().then((dataDir) =>
          runCli(
            [
              'cloud',
              'enroll',
              cloud.issueCode(),
              '--no-serve',
              '--cloud-base-url',
              cloud.baseUrl,
              '--data-dir',
              dataDir,
            ],
            { env: { SSL_CERT_FILE: cloud.caFile, SSL_CERT_DIR: '', ...env } },
          ),
        );
      const untrusted = await enroll({});
      expect(untrusted.code).toBe(1);
      expect(untrusted.stderr).toContain('fetch failed');
      expect((await enroll({ NODE_USE_SYSTEM_CA: '1' })).code).toBe(0);
      expect((await enroll({ NODE_OPTIONS: '--use-system-ca' })).code).toBe(0);
    },
  );
});
