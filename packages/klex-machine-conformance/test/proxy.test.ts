import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { type FakeCloud, startFakeCloud } from '../src/cloud.js';
import {
  events,
  McpClient,
  PUSH,
  runCli,
  spawnCli,
  subscribe,
  temporaryDirectory,
  waitFor,
} from '../src/harness.js';

let cloud: FakeCloud;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  cloud = await startFakeCloud(await temporaryDirectory());
  env = { NODE_EXTRA_CA_CERTS: cloud.caFile };
});
afterEach(async () => {
  await cloud.close();
});

const push = { push: true };
const MAX_CHUNK = 64 * 1024;

/** Enrolls a machine and serves it until the test ends. */
async function serveCloudMachine() {
  const dataDir = await temporaryDirectory();
  const cwd = await temporaryDirectory();
  const enrolled = await runCli(
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
    { env },
  );
  expect(enrolled).toMatchObject({ code: 0, stderr: '' });
  const machineId = [...cloud.machines.keys()].at(-1)!;
  const machine = spawnCli(
    ['serve', '--mode', 'enrolled', '--data-dir', dataDir, '--cwd', cwd],
    { env },
  );
  await machine.stdoutContains('is live');
  const client = async (principal: string) =>
    new McpClient(cloud.mcpUrl(machineId), {
      authorization: `Bearer ${await cloud.accessToken(principal, machineId)}`,
    });
  return { machine, machineId, cwd, client };
}

/** Frames exchanged for the request whose body contains `marker`. */
function exchangeFrames(marker: string) {
  const open = cloud.frames.find(
    ({ to, frame }) =>
      to === 'machine' &&
      frame.type === 'exchange.open' &&
      Buffer.from(frame.body ?? '', 'base64')
        .toString('utf8')
        .includes(marker),
  );
  if (!open) return undefined;
  return cloud.frames
    .filter(({ frame }) => frame.exchangeId === open.frame.exchangeId)
    .map(({ to, frame }) => ({ to, ...frame }));
}

describe('cloud traffic through the proxy', () => {
  it('carries tool calls and splits large responses into 64 KiB chunks', async () => {
    const { client, cwd } = await serveCloudMachine();
    const agent = await client('agent-a');
    const content = Array.from(
      { length: 4_000 },
      (_, line) => `line ${line} ${'ü'.repeat(40)}`,
    ).join('\n');
    expect(Buffer.byteLength(content)).toBeGreaterThan(4 * MAX_CHUNK);
    await agent.tool('write', { path: 'big.txt', content });
    const read = await agent.tool<{ path: string; content: string }>('read', {
      path: 'big.txt',
    });
    expect(read.path.endsWith('big.txt')).toBe(true);
    expect(read.path.startsWith(cwd)).toBe(true);
    expect(read.content).toBe(content);

    const frames = exchangeFrames('"read"')!;
    expect(frames[0]).toMatchObject({ to: 'machine', type: 'exchange.open' });
    expect(frames[1]).toMatchObject({
      to: 'proxy',
      type: 'exchange.opened',
      status: 200,
    });
    const chunks = frames.filter((frame) => frame.type === 'exchange.chunk');
    const sizes = chunks.map(
      (chunk) => Buffer.from((chunk as { data: string }).data, 'base64').length,
    );
    expect(sizes.length).toBeGreaterThan(4);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(MAX_CHUNK);
    expect(frames.at(-1)).toEqual({
      to: 'proxy',
      version: 2,
      type: 'exchange.close',
      exchangeId: frames[0]!.exchangeId,
    });
    expect(
      frames.filter((frame) => frame.type === 'exchange.close'),
    ).toHaveLength(1);
  });

  it('streams push subscriptions and isolates principals', async () => {
    const { client } = await serveCloudMachine();
    const a = await client('agent-a');
    const b = await client('agent-b');
    const streamA = await subscribe(a);
    const streamB = await subscribe(b);
    try {
      expect(streamA.response.status).toBe(200);
      expect(streamA.response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      for (const stream of [streamA, streamB])
        expect(await stream.next()).toMatchObject({
          method: 'notifications/subscriptions/acknowledged',
          params: { notifications: { [PUSH]: {} } },
        });

      const watcherA = await a.tool<{ id: string }>(
        'createWatcher',
        { command: 'echo from-a', title: 'a', timeoutMs: 10_000 },
        push,
      );
      expect(await streamA.next()).toMatchObject({
        method: `${PUSH}/event`,
        params: { event: { eventId: `watcher:${watcherA.id}:completed` } },
      });
      expect((await events(a)).map((event) => event.eventId)).toEqual([
        `watcher:${watcherA.id}:completed`,
      ]);
      expect(await events(b)).toEqual([]);
      expect(await b.tool('listWatchers', {}, push)).toEqual([]);
      const running = await a.tool<{ id: string }>(
        'createWatcher',
        {
          command: `"${process.execPath}" -e "setInterval(()=>{},1000)"`,
          title: 'running',
          timeoutMs: 30_000,
        },
        push,
      );
      expect(
        await b.toolError('cancelWatcher', { id: running.id }, push),
      ).toContain(running.id);
      await expect(
        a.tool('cancelWatcher', { id: running.id }, push),
      ).resolves.toEqual({ ok: true });

      const shell = await a.tool<{ id: string }>('createShellSession', {});
      expect(
        (await a.tool<{ id: string }[]>('listShellSessions')).map(
          (session) => session.id,
        ),
      ).toEqual([shell.id]);
      expect(await b.tool('listShellSessions')).toEqual([]);
      await a.tool('closeShellSession', { id: shell.id });

      const watcherB = await b.tool<{ id: string }>(
        'createWatcher',
        { command: 'echo from-b', title: 'b', timeoutMs: 10_000 },
        push,
      );
      expect(await streamB.next()).toMatchObject({
        method: `${PUSH}/event`,
        params: { event: { eventId: `watcher:${watcherB.id}:completed` } },
      });
      expect((await events(b)).map((event) => event.eventId)).toEqual([
        `watcher:${watcherB.id}:completed`,
      ]);
    } finally {
      await streamA.close();
      await streamB.close();
    }
  });

  it('stops an exchange when the proxy cancels it', async () => {
    const { client } = await serveCloudMachine();
    const agent = await client('agent-a');
    const stream = await subscribe(agent);
    await stream.next();
    await stream.close();
    const cancelled = await waitFor(() => {
      const frames = exchangeFrames('subscriptions/listen');
      return frames?.some(
        (frame) => frame.to === 'machine' && frame.type === 'exchange.close',
      )
        ? frames
        : undefined;
    });
    const exchangeId = cancelled[0]!.exchangeId;
    const sentAfterCancel = (exchangeId: string) => {
      const index = cloud.frames.findIndex(
        ({ to, frame }) =>
          to === 'machine' &&
          frame.type === 'exchange.close' &&
          frame.exchangeId === exchangeId,
      );
      return cloud.frames
        .slice(index)
        .filter(
          ({ to, frame }) => to === 'proxy' && frame.exchangeId === exchangeId,
        );
    };

    const watcher = await agent.tool<{ id: string }>(
      'createWatcher',
      { command: 'echo after-cancel', title: 'later', timeoutMs: 10_000 },
      push,
    );
    await waitFor(async () =>
      (await events(agent)).length ? true : undefined,
    );
    const shell = await agent.tool<{ id: string }>('createShellSession', {
      shell: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    });
    await new Promise((done) => setTimeout(done, 300));
    const { cursor } = await agent.tool<{ cursor: number }>(
      'readShellSession',
      { id: shell.id },
    );
    const poll = new AbortController();
    const reading = agent
      .call(
        'readShellSession',
        { id: shell.id, cursor, waitMs: 1_500 },
        { signal: poll.signal },
      )
      .catch(() => undefined);
    const polled = await waitFor(() => exchangeFrames('"waitMs":1500'));
    await new Promise((done) => setTimeout(done, 300));
    poll.abort();
    await reading;
    await waitFor(() =>
      exchangeFrames('"waitMs":1500')!.some(
        (frame) => frame.to === 'machine' && frame.type === 'exchange.close',
      )
        ? true
        : undefined,
    );
    await new Promise((done) => setTimeout(done, 2_000));

    expect(sentAfterCancel(exchangeId)).toEqual([]);
    expect(sentAfterCancel(polled[0]!.exchangeId)).toEqual([]);
    const live = await subscribe(agent);
    try {
      await live.next();
      expect((await events(agent)).map((event) => event.eventId)).toEqual([
        `watcher:${watcher.id}:completed`,
      ]);
    } finally {
      await live.close();
    }
  });
});

/** The machine end of an intercepted proxy WebSocket. */
class RawProxy {
  readonly frames: Record<string, unknown>[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(
    readonly socket: WebSocket,
    readonly machineId: string,
  ) {
    socket.on('message', (data) =>
      this.frames.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    this.closed = new Promise((done) =>
      socket.once('close', (code, reason) =>
        done({ code, reason: reason.toString() }),
      ),
    );
  }

  send(data: string | Buffer | Record<string, unknown>): void {
    this.socket.send(
      typeof data === 'string' || Buffer.isBuffer(data)
        ? data
        : JSON.stringify(data),
    );
  }

  open(
    exchangeId: string,
    client: McpClient,
    method: string,
    params: Record<string, unknown> = {},
    options: { push?: boolean } = {},
  ): void {
    const { headers, body } = client.request(method, params, options);
    this.send({
      version: 2,
      type: 'exchange.open',
      exchangeId,
      method: 'POST',
      url: client.url,
      headers,
      body: Buffer.from(body).toString('base64'),
    });
  }

  framesFor(exchangeId: string) {
    return this.frames.filter((frame) => frame.exchangeId === exchangeId);
  }

  /** Waits for the machine to close `exchangeId` and returns the body. */
  async response(exchangeId: string): Promise<{
    status: unknown;
    body: string;
    close: Record<string, unknown>;
  }> {
    const close = await waitFor(() =>
      this.framesFor(exchangeId).find(
        (frame) => frame.type === 'exchange.close',
      ),
    );
    const frames = this.framesFor(exchangeId);
    return {
      status: frames.find((frame) => frame.type === 'exchange.opened')?.status,
      body: Buffer.concat(
        frames
          .filter((frame) => frame.type === 'exchange.chunk')
          .map((frame) => Buffer.from(frame.data as string, 'base64')),
      ).toString('utf8'),
      close,
    };
  }
}

describe('proxy protocol', () => {
  async function serveIntercepted() {
    const sockets: RawProxy[] = [];
    cloud.intercept((socket, machineId) =>
      sockets.push(new RawProxy(socket, machineId)),
    );
    const { machineId } = await serveCloudMachine();
    const token = await cloud.accessToken('agent-a', machineId);
    const client = new McpClient(cloud.mcpUrl(machineId), {
      authorization: `Bearer ${token}`,
    });
    const connection = (index: number) =>
      waitFor(() => sockets[index], { timeout: 15_000 });
    return { client, connection };
  }

  it('closes with 1002 on invalid frames and reconnects', async () => {
    const { client, connection } = await serveIntercepted();
    const invalid: ((proxy: RawProxy) => Promise<void> | void)[] = [
      (proxy) => proxy.send(Buffer.from('{}')),
      (proxy) => proxy.send('not json'),
      (proxy) =>
        proxy.send({ version: 1, type: 'exchange.close', exchangeId: 'e' }),
      (proxy) =>
        proxy.send({
          version: 2,
          type: 'exchange.chunk',
          exchangeId: 'e',
          data: '',
        }),
      (proxy) =>
        proxy.send({
          version: 2,
          type: 'exchange.open',
          exchangeId: 'e',
          method: 'post',
          url: client.url,
          headers: {},
        }),
      async (proxy) => {
        proxy.open(
          'dup',
          client,
          'subscriptions/listen',
          {
            notifications: { [PUSH]: {} },
          },
          push,
        );
        await waitFor(() =>
          proxy
            .framesFor('dup')
            .find((frame) => frame.type === 'exchange.chunk'),
        );
        proxy.open('dup', client, 'tools/list');
      },
    ];
    for (const [index, send] of invalid.entries()) {
      const proxy = await connection(index);
      await send(proxy);
      await expect(proxy.closed).resolves.toEqual({
        code: 1002,
        reason: 'Protocol error',
      });
    }
    const healthy = await connection(invalid.length);
    healthy.open('after', client, 'tools/list');
    const response = await healthy.response('after');
    expect(response.status).toBe(200);
    expect(response.body).toContain('createShellSession');
  });

  it('forgets cancelled exchanges and ignores unknown closes', async () => {
    const { client, connection } = await serveIntercepted();
    const proxy = await connection(0);
    proxy.send({ version: 2, type: 'exchange.close', exchangeId: 'unknown' });
    proxy.open(
      'reused',
      client,
      'subscriptions/listen',
      {
        notifications: { [PUSH]: {} },
      },
      push,
    );
    await waitFor(() =>
      proxy
        .framesFor('reused')
        .find((frame) => frame.type === 'exchange.chunk'),
    );
    proxy.send({
      version: 2,
      type: 'exchange.close',
      exchangeId: 'reused',
      reason: 'Client went away',
    });
    const before = proxy.framesFor('reused').length;
    proxy.open('reused', client, 'tools/list');
    const response = await waitFor(() => {
      const frames = proxy.framesFor('reused').slice(before);
      return frames.some((frame) => frame.type === 'exchange.close')
        ? frames
        : undefined;
    });
    expect(response[0]).toMatchObject({ type: 'exchange.opened', status: 200 });
    expect(
      Buffer.concat(
        response
          .filter((frame) => frame.type === 'exchange.chunk')
          .map((frame) => Buffer.from(frame.data as string, 'base64')),
      ).toString('utf8'),
    ).toContain('createShellSession');
    expect(response.at(-1)).toEqual({
      version: 2,
      type: 'exchange.close',
      exchangeId: 'reused',
    });
    expect(proxy.socket.readyState).toBe(proxy.socket.OPEN);
  });
});
