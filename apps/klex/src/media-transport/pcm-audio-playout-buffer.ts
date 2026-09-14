import { BoundedAsyncQueue } from './async-queue';
import type { AudioFrame } from './media-transport';

const SAMPLE_RATE_HZ = 48_000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const FRAME_BYTES =
  (SAMPLE_RATE_HZ *
    CHANNELS *
    Int16Array.BYTES_PER_ELEMENT *
    FRAME_DURATION_MS) /
  1_000;
const DEFAULT_TARGET_BUFFER_MS = 300;
const DEFAULT_MAX_BUFFER_MS = 1_000;

export type PcmAudioPlayoutState = 'buffering' | 'playing' | 'underrun';

export type PcmAudioPlayoutEvent =
  | {
      readonly type: 'state';
      readonly state: PcmAudioPlayoutState;
      readonly bufferedFrames: number;
      readonly bufferedDurationMs: number;
      readonly underrunCount: number;
      readonly insertedSilenceCount: number;
    }
  | {
      readonly type: 'frame';
      readonly state: PcmAudioPlayoutState;
      readonly frame: AudioFrame;
      readonly silence: boolean;
      readonly bufferedFrames: number;
      readonly bufferedDurationMs: number;
      readonly underrunCount: number;
      readonly insertedSilenceCount: number;
      readonly deadlineLatenessMs: number;
    };

export interface PcmAudioPlayoutBuffer {
  readonly audioOutput: AsyncIterable<AudioFrame>;
  write(frame: AudioFrame): Promise<void>;
  reset(): void;
  close(options?: {
    readonly drain?: boolean;
    readonly error?: unknown;
  }): Promise<void>;
}

export interface PcmAudioPlayoutBufferOptions {
  readonly targetBufferMs?: number;
  readonly maxBufferMs?: number;
  readonly onEvent?: (event: PcmAudioPlayoutEvent) => void;
  readonly now?: () => number;
}

class PcmAudioPlayoutBufferModule implements PcmAudioPlayoutBuffer {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly frames: Uint8Array[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly timerWaiters = new Set<() => void>();
  private readonly targetFrames: number;
  private readonly maxFrames: number;
  private readonly now: () => number;
  private readonly task: Promise<void>;
  private state: PcmAudioPlayoutState = 'buffering';
  private sequence = 0;
  private timestampUs = 0;
  private underrunCount = 0;
  private insertedSilenceCount = 0;
  private revision = 0;
  private started = false;
  private closing: 'drain' | 'discard' | undefined;
  private failure: unknown;

  readonly audioOutput = this.outputQueue;

  constructor(private readonly options: PcmAudioPlayoutBufferOptions) {
    const targetBufferMs = options.targetBufferMs ?? DEFAULT_TARGET_BUFFER_MS;
    const maxBufferMs = options.maxBufferMs ?? DEFAULT_MAX_BUFFER_MS;
    validateDuration('Target buffer', targetBufferMs);
    validateDuration('Maximum buffer', maxBufferMs);
    if (targetBufferMs > maxBufferMs)
      throw new Error('Target buffer cannot exceed maximum buffer');
    this.targetFrames = targetBufferMs / FRAME_DURATION_MS;
    this.maxFrames = maxBufferMs / FRAME_DURATION_MS;
    this.now = options.now ?? (() => performance.now());
    this.task = this.run();
    void this.task.catch(() => undefined);
    this.emitState();
  }

  async write(frame: AudioFrame): Promise<void> {
    validateFrame(frame);
    if (this.closing !== undefined) throw this.closedError();
    const revision = this.revision;
    while (this.frames.length >= this.maxFrames) {
      await this.wait();
      if (this.closing !== undefined) throw this.closedError();
      if (revision !== this.revision) return;
    }
    if (revision !== this.revision) return;
    this.frames.push(frame.data.slice());
    this.wake();
  }

  reset(): void {
    if (this.closing !== undefined) return;
    this.revision += 1;
    this.frames.length = 0;
    this.outputQueue.clear();
    this.setState(this.started ? 'underrun' : 'buffering');
    this.wake();
  }

  async close(
    options: { readonly drain?: boolean; readonly error?: unknown } = {},
  ): Promise<void> {
    if (this.closing === undefined) {
      this.failure = options.error;
      this.closing =
        options.drain === true && options.error === undefined
          ? 'drain'
          : 'discard';
    } else if (
      this.closing === 'drain' &&
      (options.drain !== true || options.error !== undefined)
    ) {
      this.failure = options.error;
      this.closing = 'discard';
    }
    if (this.closing === 'discard') this.frames.length = 0;
    this.wake(true);
    await this.task;
  }

  private async run(): Promise<void> {
    try {
      let deadlineMs = this.now();
      while (true) {
        if (this.shouldDiscard()) break;
        if (!this.started) {
          if (
            this.frames.length < this.targetFrames &&
            !(this.closing === 'drain' && this.frames.length > 0)
          ) {
            if (this.closing === 'drain' && this.frames.length === 0) break;
            await this.wait();
            continue;
          }
          this.started = true;
          this.setState('playing');
          deadlineMs = this.now();
        }

        if (this.closing === 'drain' && this.frames.length === 0) break;
        await this.waitUntil(deadlineMs);
        if (this.shouldDiscard()) break;
        if (this.closing === 'drain' && this.frames.length === 0) break;

        const hasBufferedTarget = this.frames.length >= this.targetFrames;
        const draining = this.closing === 'drain';
        let silence = false;
        let data: Uint8Array;
        if (this.state === 'underrun' && !hasBufferedTarget && !draining) {
          silence = true;
          data = new Uint8Array(FRAME_BYTES);
        } else if (this.frames.length > 0) {
          data = this.frames.shift() as Uint8Array;
          this.wake();
          this.setState('playing');
        } else {
          this.underrunCount += 1;
          this.setState('underrun');
          silence = true;
          data = new Uint8Array(FRAME_BYTES);
        }

        const emittedAtMs = this.now();
        const frame: AudioFrame = {
          encoding: 'pcm-s16le',
          sampleRateHz: SAMPLE_RATE_HZ,
          channels: CHANNELS,
          sequence: this.sequence++,
          timestampUs: this.timestampUs,
          data,
        };
        this.timestampUs += FRAME_DURATION_MS * 1_000;
        if (silence) this.insertedSilenceCount += 1;
        await this.outputQueue.push(frame);
        this.options.onEvent?.({
          type: 'frame',
          state: this.state,
          frame,
          silence,
          bufferedFrames: this.frames.length,
          bufferedDurationMs: this.frames.length * FRAME_DURATION_MS,
          underrunCount: this.underrunCount,
          insertedSilenceCount: this.insertedSilenceCount,
          deadlineLatenessMs: Math.max(0, emittedAtMs - deadlineMs),
        });
        deadlineMs =
          emittedAtMs - deadlineMs >= FRAME_DURATION_MS
            ? emittedAtMs + FRAME_DURATION_MS
            : deadlineMs + FRAME_DURATION_MS;
      }
      if (this.failure !== undefined || this.closing === 'discard')
        this.outputQueue.clear();
      this.outputQueue.close(this.failure);
    } catch (error) {
      this.outputQueue.clear();
      this.outputQueue.close(error);
      throw error;
    } finally {
      this.wake(true);
    }
  }

  private shouldDiscard(): boolean {
    return this.closing === 'discard';
  }

  private setState(state: PcmAudioPlayoutState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitState();
  }

  private emitState(): void {
    this.options.onEvent?.({
      type: 'state',
      state: this.state,
      bufferedFrames: this.frames.length,
      bufferedDurationMs: this.frames.length * FRAME_DURATION_MS,
      underrunCount: this.underrunCount,
      insertedSilenceCount: this.insertedSilenceCount,
    });
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  private waitUntil(deadlineMs: number): Promise<void> {
    const durationMs = Math.max(0, deadlineMs - this.now());
    if (durationMs === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        this.timerWaiters.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, durationMs);
      this.timerWaiters.add(finish);
    });
  }

  private wake(interruptTimers = false): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
    if (!interruptTimers) return;
    for (const resolve of this.timerWaiters) resolve();
    this.timerWaiters.clear();
  }

  private closedError(): unknown {
    return this.failure ?? new Error('PCM audio playout buffer is closed');
  }
}

export function createPcmAudioPlayoutBuffer(
  options: PcmAudioPlayoutBufferOptions = {},
): PcmAudioPlayoutBuffer {
  return new PcmAudioPlayoutBufferModule(options);
}

function validateDuration(name: string, durationMs: number): void {
  if (
    !Number.isInteger(durationMs) ||
    durationMs < FRAME_DURATION_MS ||
    durationMs % FRAME_DURATION_MS !== 0
  )
    throw new Error(`${name} must be a positive multiple of 20 ms`);
}

function validateFrame(frame: AudioFrame): void {
  if (frame.encoding !== 'pcm-s16le')
    throw new Error('PCM audio playout requires pcm-s16le audio');
  if (frame.sampleRateHz !== SAMPLE_RATE_HZ)
    throw new Error('PCM audio playout requires 48000 Hz audio');
  if (frame.channels !== CHANNELS)
    throw new Error('PCM audio playout requires mono audio');
  if (frame.data.byteLength !== FRAME_BYTES)
    throw new Error('PCM audio playout requires exact 20 ms frames');
}
