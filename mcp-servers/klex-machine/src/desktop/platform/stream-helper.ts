import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import type {
  StreamBackend,
  StreamButton,
  StreamCapture,
  StreamKey,
  StreamSink,
  StreamWheel,
} from '../rfb/backend.js';

/**
 * The helper stream protocol, documented in `native/stream-protocol.md`.
 * A helper prints `klex-stream-ready <version>` on its own line before its
 * binary output, so anything a shell prints first is skipped.
 */
export const STREAM_PROTOCOL_VERSION = 1;
export const STREAM_HELPER_READY = 'klex-stream-ready';

export const STREAM_MESSAGE = {
  size: 1,
  raw: 2,
  jpeg: 3,
  frame: 4,
  clipboard: 5,
  log: 6,
} as const;

const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_PREAMBLE_BYTES = 64 * 1024;
const STOP_TIMEOUT_MS = 3_000;
const STDERR_LIMIT = 4_096;

export interface StreamHelperOptions {
  /** Starts the helper process. */
  spawn(): ChildProcessWithoutNullStreams;
  /** Written to stdin before any command, such as a bootstrap script. */
  preamble?: string;
  /** The helper's token for a key, or undefined to drop the key. */
  keyToken(key: StreamKey): string | undefined;
  onLog?(message: string): void;
  stopTimeoutMs?: number;
}

/**
 * Runs a native stream helper per capture. Commands go to its stdin as
 * lines (`move x y`, `button left 1 x y`, `key 1 <token>`, `clipboard
 * <base64>`, `quality n`, `refresh`); closing stdin stops it.
 */
export class StreamHelperBackend implements StreamBackend {
  readonly #options: StreamHelperOptions;

  constructor(options: StreamHelperOptions) {
    this.#options = options;
  }

  start(sink: StreamSink): StreamCapture {
    return new HelperCapture(this.#options, sink);
  }
}

class HelperCapture implements StreamCapture {
  readonly #options: StreamHelperOptions;
  readonly #sink: StreamSink;
  readonly #child: ChildProcessWithoutNullStreams;
  #buffer: Buffer = Buffer.alloc(0);
  #ready = false;
  #stopped = false;
  #ended = false;
  #stderr = '';

  constructor(options: StreamHelperOptions, sink: StreamSink) {
    this.#options = options;
    this.#sink = sink;
    const child = options.spawn();
    this.#child = child;
    child.stdout.on('data', (chunk: Buffer) => this.#read(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => this.#end(error));
    child.once('close', (code, signal) => {
      if (this.#stopped) return this.#end();
      const detail = this.#stderr.trim().split('\n').at(-1)?.trim();
      this.#end(
        new Error(
          `The desktop stream helper exited with ${signal ?? `code ${code}`}${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
    if (options.preamble !== undefined) this.#send(options.preamble);
  }

  setQuality(quality: number | undefined): void {
    this.#send(`quality ${quality === undefined ? 0 : Math.round(quality)}`);
  }

  refresh(): void {
    this.#send('refresh');
  }

  move(x: number, y: number): void {
    this.#send(`move ${x} ${y}`);
  }

  button(button: StreamButton, down: boolean, x: number, y: number): void {
    this.#send(`button ${button} ${down ? 1 : 0} ${x} ${y}`);
  }

  wheel(direction: StreamWheel, x: number, y: number): void {
    this.#send(`wheel ${direction} ${x} ${y}`);
  }

  key(key: StreamKey): void {
    const token = this.#options.keyToken(key);
    if (token) this.#send(`key ${key.down ? 1 : 0} ${token}`);
  }

  setClipboard(text: string): void {
    this.#send(`clipboard ${Buffer.from(text, 'utf8').toString('base64')}`);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#ended) return;
    this.#child.stdin.end();
    const timer = setTimeout(
      () => this.#child.kill(),
      this.#options.stopTimeoutMs ?? STOP_TIMEOUT_MS,
    );
    timer.unref?.();
    this.#child.once('close', () => clearTimeout(timer));
  }

  #send(line: string): void {
    if (this.#ended || this.#stopped) return;
    this.#child.stdin.write(`${line}\n`);
  }

  #read(chunk: Buffer): void {
    if (this.#ended) return;
    this.#buffer =
      this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    if (!this.#ready) {
      const marker = this.#buffer.indexOf(`${STREAM_HELPER_READY} `);
      const end = marker === -1 ? -1 : this.#buffer.indexOf('\n', marker);
      if (end === -1) {
        if (this.#buffer.length > MAX_PREAMBLE_BYTES) {
          this.#fail('no ready line');
        }
        return;
      }
      const version = this.#buffer
        .subarray(marker + STREAM_HELPER_READY.length + 1, end)
        .toString('latin1')
        .trim();
      if (version !== String(STREAM_PROTOCOL_VERSION)) {
        this.#fail(
          `stream protocol version ${version}, expected ${STREAM_PROTOCOL_VERSION}`,
        );
        return;
      }
      this.#ready = true;
      this.#buffer = this.#buffer.subarray(end + 1);
    }
    while (this.#buffer.length >= 5) {
      const type = this.#buffer[0] as number;
      const length = this.#buffer.readUInt32BE(1);
      if (length > MAX_MESSAGE_BYTES) {
        this.#fail(`a message of ${length} bytes`);
        return;
      }
      if (this.#buffer.length < 5 + length) break;
      const payload = this.#buffer.subarray(5, 5 + length);
      this.#buffer = this.#buffer.subarray(5 + length);
      this.#dispatch(type, payload);
      if (this.#ended) return;
    }
  }

  #dispatch(type: number, payload: Buffer): void {
    switch (type) {
      case STREAM_MESSAGE.size:
        if (payload.length < 4) {
          this.#fail('a short size message');
          return;
        }
        this.#sink.resize({
          width: payload.readUInt16BE(0),
          height: payload.readUInt16BE(2),
        });
        return;
      case STREAM_MESSAGE.raw:
      case STREAM_MESSAGE.jpeg: {
        if (payload.length < 8) {
          this.#fail('a short tile message');
          return;
        }
        const tile = {
          x: payload.readUInt16BE(0),
          y: payload.readUInt16BE(2),
          width: payload.readUInt16BE(4),
          height: payload.readUInt16BE(6),
        };
        // Copied so a tile does not keep the whole read buffer alive.
        const data = Buffer.from(payload.subarray(8));
        if (type === STREAM_MESSAGE.raw) this.#sink.raw(tile, data);
        else this.#sink.jpeg(tile, data);
        return;
      }
      case STREAM_MESSAGE.frame:
        this.#sink.frame();
        return;
      case STREAM_MESSAGE.clipboard:
        this.#sink.clipboard(payload.toString('utf8'));
        return;
      case STREAM_MESSAGE.log:
        this.#options.onLog?.(payload.toString('utf8'));
        return;
      default:
        return;
    }
  }

  #fail(what: string): void {
    this.#end(new Error(`The desktop stream helper sent ${what}`));
    this.#child.kill();
  }

  #end(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#sink.ended(error);
  }
}
