import { type Duplex, duplexPair } from 'node:stream';

import type { Region, ScreenSize } from '../provider.js';
import type {
  StreamBackend,
  StreamButton,
  StreamCapture,
  StreamKey,
  StreamSink,
  StreamWheel,
} from './backend.js';
import { MAX_CLIPBOARD_BYTES } from './clipboard.js';
import { Framebuffer } from './framebuffer.js';
import { RfbSession, type SessionHost } from './session.js';

/** A capture that sends no framebuffer within this time has failed. */
const READY_TIMEOUT_MS = 30_000;
const MAX_DIMENSION = 16_384;

export interface RfbServerOptions {
  /** Desktop name shown by viewers. */
  name?: string;
  readyTimeoutMs?: number;
  /** Receives why a capture failed. */
  onError?: (error: Error) => void;
}

interface Run {
  capture: StreamCapture;
  framebuffer: Framebuffer | undefined;
  ready: Promise<Framebuffer>;
  resolveReady(framebuffer: Framebuffer): void;
  rejectReady(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  clipboard: string | undefined;
  /** Text a viewer just put on the clipboard, so its echo is not announced. */
  fromViewer: string | undefined;
  quality: number | undefined;
}

/**
 * A built-in RFB server over in-memory streams: no listener, no password.
 * Each `open()` returns one end of a duplex pair for one viewer. Viewers share
 * one capture, which runs only while at least one is connected.
 */
export class RfbServer {
  readonly #backend: StreamBackend;
  readonly #name: string;
  readonly #readyTimeoutMs: number;
  readonly #onError: (error: Error) => void;
  readonly #sessions = new Set<RfbSession>();
  #run: Run | undefined;

  constructor(backend: StreamBackend, options: RfbServerOptions = {}) {
    this.#backend = backend;
    this.#name = options.name ?? 'klex-machine';
    this.#readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.#onError = options.onError ?? (() => undefined);
  }

  /** Number of connected viewers. */
  get viewers(): number {
    return this.#sessions.size;
  }

  /** Whether the capture is running. */
  get capturing(): boolean {
    return this.#run !== undefined;
  }

  open(): Duplex {
    const [viewer, server] = duplexPair();
    const session = new RfbSession(server, this.#host());
    this.#sessions.add(session);
    if (!this.#run) {
      try {
        this.#start();
      } catch (error) {
        session.close(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    return viewer;
  }

  /** Disconnects every viewer, which stops the capture. */
  close(): void {
    for (const session of [...this.#sessions]) session.close();
  }

  #start(): void {
    let resolveReady!: (framebuffer: Framebuffer) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<Framebuffer>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => undefined);
    const run = {
      framebuffer: undefined,
      ready,
      resolveReady,
      rejectReady,
      clipboard: undefined,
      fromViewer: undefined,
      quality: undefined,
    } as Omit<Run, 'capture' | 'timer'> as Run;
    this.#run = run;
    run.timer = setTimeout(
      () => this.#fail(run, new Error('The desktop capture did not start')),
      this.#readyTimeoutMs,
    );
    run.timer.unref?.();
    try {
      run.capture = this.#backend.start(this.#sink(run));
    } catch (error) {
      this.#run = undefined;
      clearTimeout(run.timer);
      throw error;
    }
  }

  #sink(run: Run): StreamSink {
    const current = () => this.#run === run;
    return {
      resize: (size: ScreenSize) => {
        if (!current()) return;
        if (
          !Number.isInteger(size.width) ||
          !Number.isInteger(size.height) ||
          size.width <= 0 ||
          size.height <= 0 ||
          size.width > MAX_DIMENSION ||
          size.height > MAX_DIMENSION
        ) {
          this.#fail(
            run,
            new Error(`Invalid desktop size ${size.width}x${size.height}`),
          );
          return;
        }
        const first = !run.framebuffer;
        const framebuffer = new Framebuffer(size);
        run.framebuffer = framebuffer;
        if (first) {
          clearTimeout(run.timer);
          run.resolveReady(framebuffer);
        } else {
          for (const session of this.#sessions) session.resized(framebuffer);
        }
      },
      raw: (tile, pixels) => {
        if (!current() || !run.framebuffer) return;
        if (!run.framebuffer.stageRaw(tile, pixels)) this.#badTile(run, tile);
      },
      jpeg: (tile, data) => {
        if (!current() || !run.framebuffer) return;
        if (!run.framebuffer.stageJpeg(tile, data)) this.#badTile(run, tile);
      },
      frame: () => {
        if (!current() || !run.framebuffer?.commit()) return;
        for (const session of this.#sessions) session.update();
      },
      clipboard: (text) => {
        if (!current() || Buffer.byteLength(text) > MAX_CLIPBOARD_BYTES) return;
        const echo = text === run.fromViewer;
        run.fromViewer = undefined;
        run.clipboard = text;
        if (echo) return;
        for (const session of this.#sessions) session.clipboardChanged();
      },
      ended: (error) => {
        if (current())
          this.#fail(run, error ?? new Error('The desktop capture stopped'));
      },
    };
  }

  #badTile(run: Run, tile: Region): void {
    this.#fail(
      run,
      new Error(
        `The desktop capture sent an invalid tile at ${tile.x},${tile.y} (${tile.width}x${tile.height})`,
      ),
    );
  }

  #fail(run: Run, error: Error): void {
    if (this.#run !== run) return;
    this.#onError(error);
    this.#stop();
    run.rejectReady(error);
    for (const session of [...this.#sessions]) session.close(error);
  }

  #stop(): void {
    const run = this.#run;
    if (!run) return;
    this.#run = undefined;
    clearTimeout(run.timer);
    run.rejectReady(new Error('The desktop capture stopped'));
    run.capture.stop();
  }

  #updateQuality(): void {
    const run = this.#run;
    if (!run) return;
    const accepted = [...this.#sessions]
      .map((session) => session.jpegQuality)
      .filter((quality) => quality !== null);
    if (accepted.length === 0) return;
    const quality = accepted.includes(undefined)
      ? undefined
      : Math.min(...(accepted as number[]));
    if (quality === run.quality) return;
    const wasLossy = run.quality !== undefined;
    run.quality = quality;
    run.capture.setQuality(quality);
    // Tiles already sent as JPEG cannot reach a viewer that takes none.
    if (wasLossy && quality === undefined) run.capture.refresh();
  }

  #host(): SessionHost {
    const capture = () => this.#run?.capture;
    return {
      name: this.#name,
      ready: () =>
        this.#run?.ready ??
        Promise.reject(new Error('The desktop capture is not running')),
      framebuffer: () => this.#run?.framebuffer,
      clipboardText: () => this.#run?.clipboard,
      move: (x, y) => capture()?.move(x, y),
      button: (button: StreamButton, down, x, y) =>
        capture()?.button(button, down, x, y),
      wheel: (direction: StreamWheel, x, y) =>
        capture()?.wheel(direction, x, y),
      key: (key: StreamKey) => capture()?.key(key),
      setClipboard: (text) => {
        const run = this.#run;
        if (!run || Buffer.byteLength(text) > MAX_CLIPBOARD_BYTES) return;
        run.fromViewer = text;
        run.clipboard = text;
        run.capture.setClipboard(text);
      },
      qualityChanged: () => this.#updateQuality(),
      closed: (session) => {
        if (!this.#sessions.delete(session)) return;
        if (this.#sessions.size === 0) this.#stop();
        else this.#updateQuality();
      },
    };
  }
}
