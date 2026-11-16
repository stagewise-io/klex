import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';

import {
  type DesktopLink,
  startDesktopLink,
} from '../src/cloud/desktop-link.js';
import {
  type DesktopBackend,
  type DesktopControlChange,
  DesktopControlLease,
  DesktopInputDeniedError,
  DesktopService,
  LEASE_DISCONNECT_GRACE_MS,
  RfbClientFilter,
  RfbProtocolError,
} from '../src/desktop/index.js';
import { silentMachineLogger } from '../src/logger.js';
import { createMachineMcp, type MachineMcp } from '../src/mcp.js';
import { createNotificationStore } from '../src/notifications/index.js';

vi.mock('../src/cloud/facts/device-type.js', () => ({
  detectMachineDeviceType: vi.fn(async () => 'laptop'),
}));

const STREAM_ID = '7f8d2c1a-4b3e-4f5a-9c6d-0e1f2a3b4c5d';
const VERSION = Buffer.from('RFB 003.008\n', 'latin1');
const KEY = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
const POINTER = Buffer.from([5, 0, 0, 10, 0, 20]);
const UPDATE = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const QEMU_KEY = Buffer.from([255, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 30]);

function handshake(): Buffer {
  return Buffer.concat([VERSION, Buffer.from([1]), Buffer.from([0])]);
}

function fakeBackend(): DesktopBackend {
  const noop = async () => undefined;
  return {
    probe: async () => ({ width: 1280, height: 800 }),
    capture: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    click: noop,
    drag: noop,
    move: noop,
    scroll: noop,
    type: noop,
    key: noop,
    focusWindow: noop,
    listWindows: async () => [],
    launch: async () => ({ pid: 1 }),
  };
}

describe('RfbClientFilter', () => {
  it('relays the handshake, forces a shared session and drops view-only input', () => {
    const filter = new RfbClientFilter();
    const out = filter.push(
      Buffer.concat([handshake(), KEY, UPDATE, POINTER, QEMU_KEY]),
      false,
    );
    expect(out).toEqual(
      Buffer.concat([VERSION, Buffer.from([1]), Buffer.from([1]), UPDATE]),
    );
    expect(filter.input).toEqual({ forwarded: 0, dropped: 3 });
  });

  it('forwards input while allowed and reassembles split messages', () => {
    const filter = new RfbClientFilter();
    filter.push(handshake(), true);
    const stream = Buffer.concat([KEY, QEMU_KEY, UPDATE]);
    const forwarded: Buffer[] = [];
    for (const byte of stream)
      forwarded.push(filter.push(Buffer.from([byte]), true));
    expect(Buffer.concat(forwarded)).toEqual(stream);
    expect(filter.input).toEqual({ forwarded: 2, dropped: 0 });
  });

  it('parses variable-length messages', () => {
    const filter = new RfbClientFilter();
    filter.push(handshake(), false);
    const encodings = Buffer.from([
      2, 0, 0, 2, 0, 0, 0, 0, 0xff, 0xff, 0xfe, 0xfc,
    ]);
    const cut = Buffer.concat([
      Buffer.from([6, 0, 0, 0]),
      Buffer.from([0xff, 0xff, 0xff, 0xfc]),
      Buffer.from([1, 2, 3, 4]),
    ]);
    const fence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 2, 9, 9]);
    const resize = Buffer.concat([
      Buffer.from([251, 0, 5, 0, 3, 32, 1, 0]),
      Buffer.alloc(16),
    ]);
    expect(
      filter.push(
        Buffer.concat([encodings, cut, fence, resize, UPDATE]),
        false,
      ),
    ).toEqual(Buffer.concat([encodings, fence, UPDATE]));
  });

  it('supports RFB 3.3 without a client security byte', () => {
    const filter = new RfbClientFilter();
    expect(
      filter.push(
        Buffer.concat([Buffer.from('RFB 003.003\n'), Buffer.from([0]), UPDATE]),
        false,
      ),
    ).toEqual(
      Buffer.concat([Buffer.from('RFB 003.003\n'), Buffer.from([1]), UPDATE]),
    );
  });

  it('rejects other security types and unknown messages', () => {
    expect(() =>
      new RfbClientFilter().push(
        Buffer.concat([VERSION, Buffer.from([2])]),
        true,
      ),
    ).toThrow(RfbProtocolError);
    const filter = new RfbClientFilter();
    filter.push(handshake(), true);
    expect(() => filter.push(Buffer.from([7, 0, 0, 0]), true)).toThrow(
      RfbProtocolError,
    );
  });
});

describe('DesktopControlLease', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('denies agent input while a human holds control', () => {
    const lease = new DesktopControlLease();
    lease.apply({ mode: 'human', holder: { name: 'Julian' }, expiresAt: null });
    expect(() => lease.authorize()).toThrow(DesktopInputDeniedError);
    try {
      lease.authorize();
    } catch (error) {
      expect(error).toMatchObject({
        code: 'desktop_controlled_by_user',
        holder: 'Julian',
      });
    }
    lease.apply({ mode: 'agent' });
    expect(() => lease.authorize()).not.toThrow();
  });

  it('limits stream input to the holder stream when named', () => {
    const lease = new DesktopControlLease();
    expect(lease.allowsStreamInput(STREAM_ID)).toBe(false);
    lease.apply({ mode: 'human', holder: { name: 'J', streamId: STREAM_ID } });
    expect(lease.allowsStreamInput(STREAM_ID)).toBe(true);
    expect(lease.allowsStreamInput('other')).toBe(false);
    lease.apply({ mode: 'human', holder: { name: 'J' } });
    expect(lease.allowsStreamInput('other')).toBe(true);
  });

  it('reports changes once and reverts on expiry and lost connections', () => {
    vi.useFakeTimers();
    const lease = new DesktopControlLease();
    const changes: DesktopControlChange[] = [];
    lease.onChange((change) => changes.push(change));
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    lease.apply({ mode: 'human', holder: { name: 'Julian' }, expiresAt });
    lease.apply({ mode: 'human', holder: { name: 'Julian' }, expiresAt });
    vi.advanceTimersByTime(5_000);
    lease.apply({ mode: 'human', holder: { name: 'Ana' } });
    lease.disconnected();
    vi.advanceTimersByTime(LEASE_DISCONNECT_GRACE_MS - 1);
    expect(lease.state.mode).toBe('human');
    vi.advanceTimersByTime(1);
    expect(
      changes.map(({ mode, holder, reason }) => ({ mode, holder, reason })),
    ).toEqual([
      { mode: 'human', holder: 'Julian', reason: 'cloud' },
      { mode: 'agent', holder: undefined, reason: 'expired' },
      { mode: 'human', holder: 'Ana', reason: 'cloud' },
      { mode: 'agent', holder: undefined, reason: 'disconnected' },
    ]);
  });

  it('checks the lease after the screen refresh that precedes input', async () => {
    const backend = fakeBackend();
    const click = vi.fn(async () => undefined);
    const desktop = new DesktopService({
      ...backend,
      click,
      probe: async () => {
        desktop.lease.apply({ mode: 'human', holder: { name: 'Julian' } });
        return { width: 1280, height: 800 };
      },
    });
    await expect(
      desktop.click('bot', { x: 1, y: 1 }, 'left', 1, []),
    ).rejects.toBeInstanceOf(DesktopInputDeniedError);
    expect(click).not.toHaveBeenCalled();
  });

  it('cancels the disconnect grace when Cloud resends the lease', () => {
    vi.useFakeTimers();
    const lease = new DesktopControlLease();
    lease.apply({ mode: 'human', holder: { name: 'Julian' } });
    lease.disconnected();
    lease.apply({ mode: 'human', holder: { name: 'Julian' } });
    vi.advanceTimersByTime(LEASE_DISCONNECT_GRACE_MS * 2);
    expect(lease.state.mode).toBe('human');
  });
});

describe('desktop control notifications', () => {
  let cwd: string;
  let mcp: MachineMcp | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'klex-machine-lease-'));
  });

  afterEach(async () => {
    await mcp?.close();
    mcp = undefined;
    await rm(cwd, { force: true, recursive: true });
  });

  it('queues a memory-only event for each principal when control changes', async () => {
    const store = createNotificationStore({ logger: silentMachineLogger });
    const desktop = new DesktopService(fakeBackend());
    mcp = createMachineMcp(cwd, {
      principalId: 'bot-1',
      omitHostDetails: true,
      notifications: store,
      desktop,
    });
    desktop.lease.apply({ mode: 'human', holder: { name: 'Julian' } });
    const [event] = store.pending('bot-1').events;
    expect(event).toMatchObject({
      sourceId: 'klex-machine',
      type: 'desktop.control_changed',
      data: { mode: 'human', holder: 'Julian', reason: 'cloud' },
    });
    await store.acknowledge('bot-1', [event?.eventId ?? '']);
    expect(store.pending('bot-1').events).toEqual([]);
    await mcp.close();
    mcp = undefined;
    await store.close();
  });
});

interface CloudFake {
  url: string;
  control: Promise<{ socket: WebSocket; request: IncomingMessage }>;
  stream: Promise<{ socket: WebSocket; request: IncomingMessage }>;
  messages: unknown[];
  next(type: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startCloud(): Promise<CloudFake> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const messages: unknown[] = [];
  const waiters: Array<() => void> = [];
  let resolveControl!: (value: {
    socket: WebSocket;
    request: IncomingMessage;
  }) => void;
  let resolveStream!: (value: {
    socket: WebSocket;
    request: IncomingMessage;
  }) => void;
  const control = new Promise<{ socket: WebSocket; request: IncomingMessage }>(
    (resolve) => {
      resolveControl = resolve;
    },
  );
  const stream = new Promise<{ socket: WebSocket; request: IncomingMessage }>(
    (resolve) => {
      resolveStream = resolve;
    },
  );
  server.on('connection', (socket, request) => {
    if (request.url === '/api/machine-desktop/control') {
      socket.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
        for (const waiter of waiters.splice(0)) waiter();
      });
      resolveControl({ socket, request });
    } else resolveStream({ socket, request });
  });
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    control,
    stream,
    messages,
    async next(type) {
      for (;;) {
        const index = messages.findIndex(
          (message) => (message as { type?: string }).type === type,
        );
        if (index >= 0)
          return messages.splice(index, 1)[0] as Record<string, unknown>;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startVnc(path: string) {
  const received: Buffer[] = [];
  let client: Socket | undefined;
  const changed: Array<() => void> = [];
  const server: Server = createServer((socket) => {
    client = socket;
    socket.write(VERSION);
    socket.on('data', (chunk: Buffer) => {
      received.push(chunk);
      for (const waiter of changed.splice(0)) waiter();
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    async bytes(length: number): Promise<Buffer> {
      while (Buffer.concat(received).length < length)
        await new Promise<void>((resolve) => changed.push(resolve));
      return Buffer.concat(received);
    },
    close: () =>
      new Promise<void>((resolve) => {
        client?.destroy();
        server.close(() => resolve());
      }),
  };
}

function nextBinary(socket: WebSocket): Promise<Buffer> {
  return new Promise((resolve) =>
    socket.once('message', (data) => resolve(data as Buffer)),
  );
}

describe('desktop link', () => {
  let dir: string;
  let link: DesktopLink | undefined;
  let cloud: CloudFake | undefined;
  let vnc: Awaited<ReturnType<typeof startVnc>> | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'klex-machine-link-'));
  });

  afterEach(async () => {
    await link?.close();
    await cloud?.close();
    await vnc?.close();
    link = undefined;
    cloud = undefined;
    vnc = undefined;
    await rm(dir, { force: true, recursive: true });
  });

  it('applies leases and relays filtered RFB between a viewer stream and Xvnc', async () => {
    cloud = await startCloud();
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\klex-machine-vnc-${randomUUID()}`
        : join(dir, 'vnc.sock');
    vnc = await startVnc(socketPath);
    const desktop = new DesktopService(fakeBackend());
    link = startDesktopLink({
      cloudBaseUrl: cloud.url,
      getToken: async () => 'machine-token',
      invalidateToken: () => undefined,
      desktop,
      machineVersion: '1.2.3',
      vncSocketPath: socketPath,
    });

    const { socket: control, request } = await cloud.control;
    expect(request.headers.authorization).toBe('Bearer machine-token');
    expect(await cloud.next('hello')).toEqual({
      type: 'hello',
      v: 1,
      screen: { width: 1280, height: 800 },
      machineVersion: '1.2.3',
      capabilities: ['stream', 'lease', 'rfb-input-filter'],
    });

    control.send(JSON.stringify({ type: 'stream.open', streamId: 'nope' }));
    expect(await cloud.next('stream.failed')).toEqual({
      type: 'stream.failed',
      streamId: 'nope',
      reason: 'invalid_stream_id',
    });

    control.send(
      JSON.stringify({
        type: 'lease',
        revision: 1,
        mode: 'agent',
        holder: null,
        expiresAt: null,
      }),
    );
    expect(await cloud.next('lease.applied')).toEqual({
      type: 'lease.applied',
      revision: 1,
    });

    control.send(JSON.stringify({ type: 'stream.open', streamId: STREAM_ID }));
    const { socket: viewer, request: streamRequest } = await cloud.stream;
    expect(streamRequest.url).toBe(`/api/machine-desktop/streams/${STREAM_ID}`);
    expect(streamRequest.headers.authorization).toBe('Bearer machine-token');
    expect(await nextBinary(viewer)).toEqual(VERSION);

    viewer.send(Buffer.concat([handshake(), KEY, UPDATE]));
    const viewOnly = Buffer.concat([VERSION, Buffer.from([1, 1]), UPDATE]);
    expect(await vnc.bytes(viewOnly.length)).toEqual(viewOnly);

    control.send(
      JSON.stringify({
        type: 'lease',
        revision: 2,
        mode: 'human',
        holder: { userId: 'u1', name: 'Julian', streamId: STREAM_ID },
        expiresAt: null,
      }),
    );
    await cloud.next('lease.applied');
    expect(() => desktop.lease.authorize()).toThrow(DesktopInputDeniedError);
    viewer.send(KEY);
    expect(await vnc.bytes(viewOnly.length + KEY.length)).toEqual(
      Buffer.concat([viewOnly, KEY]),
    );

    const closed = new Promise<void>((resolve) =>
      viewer.once('close', () => resolve()),
    );
    control.send(JSON.stringify({ type: 'stream.close', streamId: STREAM_ID }));
    await closed;
  });

  it('does not acknowledge a human lease that already expired', async () => {
    cloud = await startCloud();
    const desktop = new DesktopService(fakeBackend());
    link = startDesktopLink({
      cloudBaseUrl: cloud.url,
      getToken: async () => 'machine-token',
      invalidateToken: () => undefined,
      desktop,
      machineVersion: '1.2.3',
      vncSocketPath: join(dir, 'missing.sock'),
    });
    const { socket: control } = await cloud.control;
    await cloud.next('hello');
    for (const [revision, mode, expiresAt] of [
      [1, 'human', new Date(Date.now() - 1000).toISOString()],
      [2, 'agent', null],
    ] as const)
      control.send(
        JSON.stringify({
          type: 'lease',
          revision,
          mode,
          holder: mode === 'human' ? { name: 'Julian' } : null,
          expiresAt,
        }),
      );
    expect(await cloud.next('lease.applied')).toEqual({
      type: 'lease.applied',
      revision: 2,
    });
    expect(desktop.lease.state.mode).toBe('agent');
  });

  it('reports a stream as failed when Xvnc drops before the stream connects', async () => {
    cloud = await startCloud();
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\klex-machine-vnc-${randomUUID()}`
        : join(dir, 'vnc.sock');
    const accepted = new Promise<Socket>((resolve) => {
      const server = createServer(resolve);
      server.listen(socketPath);
      vnc = {
        bytes: async () => Buffer.alloc(0),
        close: () => new Promise<void>((done) => server.close(() => done())),
      };
    });
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    let tokens = 0;
    link = startDesktopLink({
      cloudBaseUrl: cloud.url,
      getToken: async () => {
        if (tokens++ > 0) await tokenGate;
        return 'machine-token';
      },
      invalidateToken: () => undefined,
      desktop: new DesktopService(fakeBackend()),
      machineVersion: '1.2.3',
      vncSocketPath: socketPath,
    });
    const { socket: control } = await cloud.control;
    await cloud.next('hello');
    control.send(JSON.stringify({ type: 'stream.open', streamId: STREAM_ID }));
    (await accepted).destroy();
    expect(await cloud.next('stream.failed')).toEqual({
      type: 'stream.failed',
      streamId: STREAM_ID,
      reason: 'desktop_unavailable',
    });
    releaseToken();
  });

  it('refuses streams when the VNC socket is unreachable', async () => {
    cloud = await startCloud();
    link = startDesktopLink({
      cloudBaseUrl: cloud.url,
      getToken: async () => 'machine-token',
      invalidateToken: () => undefined,
      desktop: new DesktopService(fakeBackend()),
      machineVersion: '1.2.3',
      vncSocketPath: join(dir, 'missing.sock'),
    });
    const { socket: control } = await cloud.control;
    await cloud.next('hello');
    control.send(JSON.stringify({ type: 'stream.open', streamId: STREAM_ID }));
    expect(await cloud.next('stream.failed')).toMatchObject({
      streamId: STREAM_ID,
      reason: 'desktop_unavailable',
    });
  });
});
