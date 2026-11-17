import type { Duplex } from 'node:stream';

import WebSocket from 'ws';

import type { DesktopService } from '../desktop/index.js';
import { RfbClientFilter, RfbProtocolError } from '../desktop/index.js';
import { type MachineLogger, silentMachineLogger } from '../logger.js';

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
const CLOSE_TIMEOUT_MS = 2000;
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
  logger?: MachineLogger;
  maxStreams?: number;
  /** Test seams. */
  availabilityPollMs?: number;
  pingMs?: number;
  pongTimeoutMs?: number;
  random?: () => number;
}

export interface DesktopLink {
  close(): Promise<void>;
}

interface Stream {
  close(code?: number): void;
  /** Settles once the stream socket has closed. */
  done: Promise<void>;
}

/**
 * The daemon's outbound desktop link to Cloud: one control WebSocket for the
 * control lease and stream requests, and one WebSocket per viewer stream that
 * relays RFB to the provider's stream source. See the desktop stream protocol.
 * The desktop is offered only while the provider reports `stream`.
 */
export function startDesktopLink(options: DesktopLinkOptions): DesktopLink {
  const logger = options.logger ?? silentMachineLogger;
  const lease = options.desktop.lease;
  const maxStreams = options.maxStreams ?? MAX_DESKTOP_STREAMS;
  const availabilityPollMs = options.availabilityPollMs ?? AVAILABILITY_POLL_MS;
  const random = options.random ?? Math.random;
  const pingMs = options.pingMs ?? PING_MS;
  const pongTimeoutMs = options.pongTimeoutMs ?? PONG_TIMEOUT_MS;
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

  /** Stops offering the desktop until a fresh probe reports `stream` again. */
  const withdraw = () => {
    options.desktop.invalidate();
    for (const stream of [...streams.values()]) stream.close(1001);
    control?.terminate();
  };

  async function run(): Promise<void> {
    if (closed) return;
    const { stream, screen } = await options.desktop.capabilities();
    if (!stream) {
      schedule(availabilityPollMs);
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
    let stopKeepAlive: (() => void) | undefined;
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
      stopKeepAlive = keepAlive(socket, pingMs, pongTimeoutMs);
      send({
        type: 'hello',
        v: PROTOCOL_VERSION,
        ...(screen
          ? { screen: { width: screen.width, height: screen.height } }
          : {}),
        machineVersion: options.machineVersion,
        capabilities: ['stream', 'lease', 'rfb-input-filter'],
      });
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
      stopKeepAlive?.();
      if (control === socket) control = undefined;
      if (openedAt !== undefined)
        logger.info({ code }, 'Desktop control disconnected');
      // Cloud routes stream requests over this link and reopens them after a
      // reconnect, so streams must not outlive it.
      for (const stream of [...streams.values()]) stream.close(1001);
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
    // Shutdown snapshots the open streams, so none may start after it.
    if (closed) return;
    if (!STREAM_ID.test(streamId)) return fail('invalid_stream_id');
    if (streams.has(streamId)) return;
    if (streams.size >= maxStreams) return fail('too_many_streams');
    let finished = false;
    let vnc: Duplex | undefined;
    let ws: WebSocket | undefined;
    let filter: RfbClientFilter | undefined;
    let markDone!: () => void;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
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
      const socket = ws;
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        markDone();
        return;
      }
      const force = setTimeout(() => socket.terminate(), CLOSE_TIMEOUT_MS);
      socket.once('close', () => {
        clearTimeout(force);
        markDone();
      });
      if (socket.readyState === WebSocket.OPEN) socket.close(code);
      else socket.terminate();
    };
    streams.set(streamId, { close, done });

    try {
      vnc = await options.desktop.openStream();
    } catch (error) {
      logger.warn(
        { error: message(error) },
        'Desktop stream source is unreachable',
      );
      close(1000, 'desktop_unavailable');
      withdraw();
      return;
    }
    if (finished) {
      vnc.destroy();
      return;
    }
    // Keep reading until the stream opens so a dropped source is noticed; it only
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
    let stopKeepAlive: (() => void) | undefined;
    socket.on('close', () => {
      clearTimeout(connectTimer);
      stopKeepAlive?.();
      close(1000);
    });
    socket.on('open', () => {
      clearTimeout(connectTimer);
      // A static desktop sends nothing, so without pings a vanished Cloud pod
      // would hold the stream source and its slot indefinitely.
      stopKeepAlive = keepAlive(socket, pingMs, pongTimeoutMs);
      const local = vnc as Duplex;
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
      const closingStreams = [...streams.values()].map((stream) => {
        stream.close(1001);
        return stream.done;
      });
      const socket = control;
      control = undefined;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          // ws waits up to 30 s for the peer's close frame, longer than
          // supervisors wait before SIGKILL.
          const force = setTimeout(() => socket.terminate(), CLOSE_TIMEOUT_MS);
          socket.once('close', () => {
            clearTimeout(force);
            resolve();
          });
          if (socket.readyState === WebSocket.OPEN) socket.close(1001);
          else socket.terminate();
        });
      }
      await Promise.all([loop, ...closingStreams]);
    },
  };
}

/** Pings the peer and terminates the socket once it stops answering. */
function keepAlive(
  socket: WebSocket,
  pingMs: number,
  pongTimeoutMs: number,
): () => void {
  let lastPong = Date.now();
  const onPong = () => {
    lastPong = Date.now();
  };
  socket.on('pong', onPong);
  const timer = setInterval(() => {
    if (Date.now() - lastPong > pongTimeoutMs) socket.terminate();
    else socket.ping();
  }, pingMs);
  return () => {
    clearInterval(timer);
    socket.off('pong', onPong);
  };
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
