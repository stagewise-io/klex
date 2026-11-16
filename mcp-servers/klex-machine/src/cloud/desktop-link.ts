import { connect, type Socket } from 'node:net';

import WebSocket from 'ws';

import type { DesktopService } from '../desktop/index.js';
import { RfbClientFilter, RfbProtocolError } from '../desktop/index.js';
import { type MachineLogger, silentMachineLogger } from '../logger.js';

export const DEFAULT_VNC_SOCKET_PATH = '/run/klex/vnc.sock';
export const MAX_DESKTOP_STREAMS = 4;

const PROTOCOL_VERSION = 1;
const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;
const PING_MS = 30_000;
const PONG_TIMEOUT_MS = 60_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const STABLE_CONNECTION_MS = 60_000;
const AVAILABILITY_POLL_MS = 10_000;
const STREAM_CONNECT_TIMEOUT_MS = 15_000;
const HIGH_WATER_BYTES = 4 * 1024 * 1024;
const MAX_EARLY_VNC_BYTES = 64 * 1024;
const LOW_WATER_BYTES = 1024 * 1024;
const STREAM_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StreamFailureReason =
  | 'desktop_unavailable'
  | 'too_many_streams'
  | 'invalid_stream_id'
  | 'connect_failed'
  | 'rfb_protocol_error';

export interface DesktopLinkOptions {
  cloudBaseUrl: string;
  getToken(): Promise<string>;
  invalidateToken(): void;
  desktop: DesktopService;
  machineVersion: string;
  vncSocketPath?: string;
  logger?: MachineLogger;
  maxStreams?: number;
  /** Test seams. */
  connectUnix?: (path: string) => Socket;
  random?: () => number;
}

export interface DesktopLink {
  close(): Promise<void>;
}

interface Stream {
  close(code?: number): void;
}

/**
 * The daemon's outbound desktop link to Cloud: one control WebSocket for the
 * control lease and stream requests, and one WebSocket per viewer stream that
 * relays RFB to the local Xvnc Unix socket. See the desktop stream protocol.
 */
export function startDesktopLink(options: DesktopLinkOptions): DesktopLink {
  const logger = options.logger ?? silentMachineLogger;
  const lease = options.desktop.lease;
  const maxStreams = options.maxStreams ?? MAX_DESKTOP_STREAMS;
  const vncSocketPath = options.vncSocketPath ?? DEFAULT_VNC_SOCKET_PATH;
  const connectUnix = options.connectUnix ?? ((path: string) => connect(path));
  const random = options.random ?? Math.random;
  const base = toWebSocketBase(options.cloudBaseUrl);
  const streams = new Map<string, Stream>();
  let control: WebSocket | undefined;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loop: Promise<void> = Promise.resolve();

  const send = (message: Record<string, unknown>) => {
    if (control?.readyState === WebSocket.OPEN)
      control.send(JSON.stringify(message));
  };

  const schedule = (delay: number) => {
    if (closed) return;
    timer = setTimeout(() => {
      timer = undefined;
      loop = run();
    }, delay);
  };

  const reconnectDelay = () => {
    const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);
    attempt += 1;
    return Math.round(ceiling / 2 + (random() * ceiling) / 2);
  };

  async function run(): Promise<void> {
    if (closed) return;
    let screen: Awaited<ReturnType<DesktopService['screenSize']>>;
    try {
      screen = await options.desktop.screenSize();
    } catch {
      screen = undefined;
    }
    if (!screen) {
      schedule(AVAILABILITY_POLL_MS);
      return;
    }
    let token: string;
    try {
      token = await options.getToken();
    } catch (error) {
      logger.warn(
        { error: message(error) },
        'Desktop link token request failed',
      );
      schedule(reconnectDelay());
      return;
    }
    if (closed) return;
    const socket = new WebSocket(`${base}/api/machine-desktop/control`, {
      headers: { authorization: `Bearer ${token}` },
      maxPayload: MAX_CONTROL_MESSAGE_BYTES,
    });
    control = socket;
    let openedAt: number | undefined;
    let lastPong = Date.now();
    let ping: ReturnType<typeof setInterval> | undefined;
    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401 || response.statusCode === 403)
        options.invalidateToken();
      logger.warn(
        { status: response.statusCode },
        'Desktop control connection was refused',
      );
      socket.terminate();
    });
    socket.on('open', () => {
      openedAt = Date.now();
      logger.info('Desktop control connected');
      ping = setInterval(() => {
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) socket.terminate();
        else socket.ping();
      }, PING_MS);
      send({
        type: 'hello',
        v: PROTOCOL_VERSION,
        screen: { width: screen.width, height: screen.height },
        machineVersion: options.machineVersion,
        capabilities: ['stream', 'lease', 'rfb-input-filter'],
      });
    });
    socket.on('pong', () => {
      lastPong = Date.now();
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      handle(parsed);
    });
    socket.on('error', (error) => {
      logger.debug({ error: message(error) }, 'Desktop control socket error');
    });
    socket.on('close', (code) => {
      clearInterval(ping);
      if (control === socket) control = undefined;
      if (openedAt !== undefined)
        logger.info({ code }, 'Desktop control disconnected');
      lease.disconnected();
      if (
        openedAt !== undefined &&
        Date.now() - openedAt >= STABLE_CONNECTION_MS
      )
        attempt = 0;
      schedule(reconnectDelay());
    });
  }

  function handle(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const msg = value as Record<string, unknown>;
    if (msg.type === 'lease') {
      const mode =
        msg.mode === 'human'
          ? 'human'
          : msg.mode === 'agent'
            ? 'agent'
            : undefined;
      if (!mode) return;
      const holder =
        msg.holder &&
        typeof msg.holder === 'object' &&
        !Array.isArray(msg.holder)
          ? (msg.holder as Record<string, unknown>)
          : undefined;
      lease.apply({
        mode,
        holder: holder
          ? {
              ...(typeof holder.name === 'string' ? { name: holder.name } : {}),
              ...(typeof holder.streamId === 'string'
                ? { streamId: holder.streamId }
                : {}),
            }
          : null,
        expiresAt: typeof msg.expiresAt === 'string' ? msg.expiresAt : null,
      });
      // An already-expired human lease is not enforced, so it is not acknowledged.
      if (lease.state.mode !== mode) {
        logger.warn({ revision: msg.revision }, 'Ignored an expired lease');
        return;
      }
      logger.info({ revision: msg.revision, mode }, 'Desktop lease applied');
      if (typeof msg.revision === 'number')
        send({ type: 'lease.applied', revision: msg.revision });
      return;
    }
    if (msg.type === 'stream.open' && typeof msg.streamId === 'string') {
      void openStream(msg.streamId);
      return;
    }
    if (msg.type === 'stream.close' && typeof msg.streamId === 'string') {
      streams.get(msg.streamId)?.close(1000);
    }
  }

  async function openStream(streamId: string): Promise<void> {
    const fail = (reason: StreamFailureReason) =>
      send({ type: 'stream.failed', streamId, reason });
    if (!STREAM_ID.test(streamId)) return fail('invalid_stream_id');
    if (streams.has(streamId)) return;
    if (streams.size >= maxStreams) return fail('too_many_streams');
    let finished = false;
    let vnc: Socket | undefined;
    let ws: WebSocket | undefined;
    let filter: RfbClientFilter | undefined;
    const close = (code = 1000, reason?: StreamFailureReason) => {
      if (finished) return;
      finished = true;
      streams.delete(streamId);
      if (reason) fail(reason);
      logger.info(
        { streamId, code, reason, input: filter?.input },
        'Desktop stream closed',
      );
      vnc?.destroy();
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        if (ws.readyState === WebSocket.OPEN) ws.close(code);
        else ws.terminate();
      }
    };
    streams.set(streamId, { close });

    if (!(await options.desktop.available().catch(() => false)))
      return close(1000, 'desktop_unavailable');
    if (finished) return;
    try {
      vnc = await connectVnc(connectUnix, vncSocketPath);
    } catch (error) {
      logger.warn(
        { error: message(error) },
        'Desktop VNC socket is unreachable',
      );
      return close(1000, 'desktop_unavailable');
    }
    if (finished) {
      vnc.destroy();
      return;
    }
    // Keep reading until the stream opens so a dropped Xvnc is noticed; it only
    // sends its 12-byte version before the viewer answers.
    const early: Buffer[] = [];
    let earlyBytes = 0;
    const buffer = (chunk: Buffer) => {
      early.push(chunk);
      earlyBytes += chunk.length;
      if (earlyBytes > MAX_EARLY_VNC_BYTES) close(1011, 'rfb_protocol_error');
    };
    vnc.on('data', buffer);
    const vncEnded = (code: number) =>
      close(
        code,
        ws?.readyState === WebSocket.OPEN ? undefined : 'desktop_unavailable',
      );
    vnc.on('error', () => vncEnded(1011));
    vnc.on('close', () => vncEnded(1000));
    let token: string;
    try {
      token = await options.getToken();
    } catch {
      return close(1000, 'connect_failed');
    }
    if (finished) return;
    const socket = new WebSocket(
      `${base}/api/machine-desktop/streams/${streamId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    ws = socket;
    const connectTimer = setTimeout(
      () => close(1000, 'connect_failed'),
      STREAM_CONNECT_TIMEOUT_MS,
    );
    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401) options.invalidateToken();
      clearTimeout(connectTimer);
      close(1000, 'connect_failed');
    });
    socket.on('error', () => {
      clearTimeout(connectTimer);
      close(
        1011,
        socket.readyState === WebSocket.OPEN ? undefined : 'connect_failed',
      );
    });
    socket.on('close', () => {
      clearTimeout(connectTimer);
      close(1000);
    });
    socket.on('open', () => {
      clearTimeout(connectTimer);
      const local = vnc as Socket;
      const relay = new RfbClientFilter();
      filter = relay;
      logger.info({ streamId }, 'Desktop stream opened');
      let paused = false;
      local.off('data', buffer);
      for (const chunk of early.splice(0)) socket.send(chunk, { binary: true });
      local.on('data', (chunk: Buffer) => {
        socket.send(chunk, { binary: true }, () => {
          if (paused && socket.bufferedAmount < LOW_WATER_BYTES) {
            paused = false;
            local.resume();
          }
        });
        if (!paused && socket.bufferedAmount > HIGH_WATER_BYTES) {
          paused = true;
          local.pause();
        }
      });
      local.on('drain', () => socket.resume());
      socket.on('message', (data, isBinary) => {
        if (!isBinary) return;
        let forward: Buffer;
        try {
          forward = relay.push(
            toBuffer(data),
            lease.allowsStreamInput(streamId),
          );
        } catch (error) {
          logger.warn(
            { error: message(error) },
            'Desktop stream protocol error',
          );
          close(
            error instanceof RfbProtocolError ? 1008 : 1011,
            'rfb_protocol_error',
          );
          return;
        }
        if (forward.length > 0 && !local.write(forward)) socket.pause();
      });
    });
  }

  loop = run();

  return {
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const stream of [...streams.values()]) stream.close(1001);
      const socket = control;
      control = undefined;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          socket.once('close', () => resolve());
          if (socket.readyState === WebSocket.OPEN) socket.close(1001);
          else socket.terminate();
        });
      }
      await loop;
    },
  };
}

function connectVnc(
  connectUnix: (path: string) => Socket,
  path: string,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectUnix(path);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

function toWebSocketBase(cloudBaseUrl: string): string {
  const url = new URL(cloudBaseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Cloud base URL must use http or https');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href.replace(/\/+$/, '');
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
