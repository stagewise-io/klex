import { BoundedAsyncQueue } from './async-queue';
import type {
  AudioFrame,
  AudioSource,
  RealtimeEndpoint,
  RealtimeEndpointClosure,
  RealtimeSourceConsumer,
} from './media-transport';

const SAMPLE_RATE_HZ = 48_000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE_HZ * FRAME_DURATION_MS) / 1_000;
const FRAME_DURATION_US = FRAME_DURATION_MS * 1_000;
const DEFAULT_SOURCE_BUFFER_MS = 200;
const DEFAULT_OUTPUT_CAPACITY = 1;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface SourceState {
  readonly id: string;
  readonly chunks: Int16Array[];
  readonly spaceWaiters: Array<Deferred<void>>;
  readonly closed: Promise<RealtimeEndpointClosure>;
  iterator: AsyncIterator<AudioFrame>;
  chunkOffset: number;
  bufferedSamples: number;
  ended: boolean;
}

export interface PcmAudioMixer extends RealtimeEndpoint {
  readonly audioInputs: RealtimeSourceConsumer<
    AudioFrame,
    AudioSource['metadata']
  >;
  readonly audioOutput: AsyncIterable<AudioFrame>;
}

export interface PcmAudioMixerOptions {
  readonly sourceBufferMs?: number;
  readonly outputCapacity?: number;
}

class PcmAudioMixerModule implements PcmAudioMixer {
  private readonly outputQueue: BoundedAsyncQueue<AudioFrame>;
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly sources = new Set<SourceState>();
  private readonly activeSources = new Map<string, SourceState>();
  private readonly sourceTasks = new Set<Promise<void>>();
  private readonly sourceBufferSamples: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextPlayoutAtMs: number | undefined;
  private playoutInProgress = false;
  private sequence = 0;
  private timestampUs = 0;
  private settled = false;

  readonly audioInputs = {
    attach: (source: AudioSource) => this.attachSource(source),
  };
  readonly audioOutput: AsyncIterable<AudioFrame>;
  readonly closed = this.closure.promise;

  constructor(options: PcmAudioMixerOptions) {
    const sourceBufferMs = options.sourceBufferMs ?? DEFAULT_SOURCE_BUFFER_MS;
    const outputCapacity = options.outputCapacity ?? DEFAULT_OUTPUT_CAPACITY;
    if (!Number.isInteger(sourceBufferMs) || sourceBufferMs < FRAME_DURATION_MS)
      throw new Error('Mixer source buffer must be at least one 20 ms frame');
    if (!Number.isInteger(outputCapacity) || outputCapacity < 1)
      throw new Error('Mixer output capacity must be a positive integer');
    this.sourceBufferSamples = (SAMPLE_RATE_HZ * sourceBufferMs) / 1_000;
    if (!Number.isInteger(this.sourceBufferSamples))
      throw new Error('Mixer source buffer must contain complete samples');
    this.outputQueue = new BoundedAsyncQueue(outputCapacity);
    this.audioOutput = this.outputQueue;
  }

  private async attachSource(source: AudioSource): Promise<void> {
    if (this.settled) throw new Error('PCM audio mixer is closed');
    const active = this.activeSources.get(source.id);
    if (active) {
      const ended = await Promise.race([
        active.closed.then(() => true),
        new Promise<boolean>((resolve) => {
          queueMicrotask(() => resolve(false));
        }),
      ]);
      const current = this.activeSources.get(source.id);
      if (!ended || (current && current !== active))
        throw new Error(`Audio source already attached: ${source.id}`);
      if (current === active) this.activeSources.delete(source.id);
    }
    const state: SourceState = {
      id: source.id,
      chunks: [],
      spaceWaiters: [],
      closed: source.closed,
      iterator: source.readable[Symbol.asyncIterator](),
      chunkOffset: 0,
      bufferedSamples: 0,
      ended: false,
    };
    this.sources.add(state);
    this.activeSources.set(source.id, state);
    const task = this.consumeSource(state);
    this.sourceTasks.add(task);
    void task
      .catch((error: unknown) => this.fail(error))
      .finally(() => this.sourceTasks.delete(task));
  }

  private async consumeSource(state: SourceState): Promise<void> {
    try {
      while (!this.settled) {
        const result = await state.iterator.next();
        if (result.done || this.settled) break;
        validateFrame(result.value);
        await this.enqueue(state, decodePcm16(result.value.data));
      }
    } finally {
      state.ended = true;
      if (this.activeSources.get(state.id) === state)
        this.activeSources.delete(state.id);
      this.removeDrainedSources();
      this.ensureScheduled();
    }
  }

  private async enqueue(
    state: SourceState,
    samples: Int16Array,
  ): Promise<void> {
    let offset = 0;
    while (offset < samples.length) {
      if (this.settled) throw new Error('PCM audio mixer is closed');
      const available = this.sourceBufferSamples - state.bufferedSamples;
      if (available === 0) {
        const waiter = deferred<void>();
        state.spaceWaiters.push(waiter);
        await waiter.promise;
        continue;
      }
      const count = Math.min(available, samples.length - offset);
      state.chunks.push(samples.slice(offset, offset + count));
      state.bufferedSamples += count;
      offset += count;
      this.ensureScheduled();
    }
  }

  private ensureScheduled(): void {
    if (this.settled || this.timer || this.playoutInProgress) return;
    if (!this.hasReadySource()) {
      this.nextPlayoutAtMs = undefined;
      return;
    }
    const now = performance.now();
    const scheduledAt = this.nextPlayoutAtMs ?? now + FRAME_DURATION_MS;
    this.nextPlayoutAtMs = scheduledAt;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.playoutInProgress = true;
        const startedAt = performance.now();
        this.nextPlayoutAtMs =
          startedAt - scheduledAt >= FRAME_DURATION_MS
            ? startedAt + FRAME_DURATION_MS
            : scheduledAt + FRAME_DURATION_MS;
        void this.playout()
          .catch((error: unknown) => this.fail(error))
          .finally(() => {
            this.playoutInProgress = false;
            this.ensureScheduled();
          });
      },
      Math.max(0, scheduledAt - now),
    );
  }

  private async playout(): Promise<void> {
    if (this.settled) return;
    const mixed = new Int32Array(FRAME_SAMPLES);
    let contributed = false;
    for (const state of this.sources) {
      if (!this.sourceIsReady(state)) continue;
      const count = Math.min(FRAME_SAMPLES, state.bufferedSamples);
      for (let index = 0; index < count; index += 1)
        mixed[index] = (mixed[index] ?? 0) + this.shiftSample(state);
      contributed = contributed || count > 0;
      this.releaseSpace(state);
    }
    this.removeDrainedSources();
    if (!this.hasReadySource()) this.nextPlayoutAtMs = undefined;
    if (contributed) {
      const samples = new Int16Array(FRAME_SAMPLES);
      for (let index = 0; index < samples.length; index += 1)
        samples[index] = clampPcm16(mixed[index] ?? 0);
      await this.outputQueue.push({
        encoding: 'pcm-s16le',
        sampleRateHz: SAMPLE_RATE_HZ,
        channels: CHANNELS,
        sequence: this.sequence++,
        timestampUs: this.timestampUs,
        data: encodePcm16(samples),
      });
      this.timestampUs += FRAME_DURATION_US;
    }
  }

  private sourceIsReady(state: SourceState): boolean {
    return (
      state.bufferedSamples >= FRAME_SAMPLES ||
      (state.ended && state.bufferedSamples > 0)
    );
  }

  private hasReadySource(): boolean {
    for (const source of this.sources)
      if (this.sourceIsReady(source)) return true;
    return false;
  }

  private shiftSample(state: SourceState): number {
    const chunk = state.chunks[0];
    if (!chunk) throw new Error(`Audio source buffer underflow: ${state.id}`);
    const sample = chunk[state.chunkOffset];
    if (sample === undefined)
      throw new Error(`Audio source buffer underflow: ${state.id}`);
    state.chunkOffset += 1;
    state.bufferedSamples -= 1;
    if (state.chunkOffset === chunk.length) {
      state.chunks.shift();
      state.chunkOffset = 0;
    }
    return sample;
  }

  private releaseSpace(state: SourceState): void {
    for (const waiter of state.spaceWaiters.splice(0)) waiter.resolve();
  }

  private removeDrainedSources(): void {
    for (const state of this.sources) {
      if (!state.ended || state.bufferedSamples > 0) continue;
      this.sources.delete(state);
      this.releaseSpace(state);
    }
  }

  async close(): Promise<void> {
    const sourceTasks = [...this.sourceTasks];
    this.settle({ type: 'closed', reason: 'local-close' });
    await Promise.allSettled(sourceTasks);
  }

  private fail(error: unknown): void {
    this.settle({ type: 'failed', error }, error);
  }

  private settle(closure: RealtimeEndpointClosure, error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const state of this.sources.values()) {
      for (const waiter of state.spaceWaiters.splice(0))
        waiter.reject(error ?? new Error('PCM audio mixer is closed'));
      void state.iterator.return?.().catch(() => undefined);
    }
    this.sources.clear();
    this.activeSources.clear();
    this.outputQueue.close(error);
    this.closure.resolve(closure);
  }
}

export function createPcmAudioMixer(
  options: PcmAudioMixerOptions = {},
): PcmAudioMixer {
  return new PcmAudioMixerModule(options);
}

function validateFrame(frame: AudioFrame): void {
  if (
    frame.encoding !== 'pcm-s16le' ||
    frame.sampleRateHz !== SAMPLE_RATE_HZ ||
    frame.channels !== CHANNELS
  )
    throw new Error('PCM audio mixer requires 48 kHz mono PCM16');
  if (frame.data.byteLength === 0 || frame.data.byteLength % 2 !== 0)
    throw new Error('PCM audio mixer requires complete PCM16 samples');
}

function decodePcm16(data: Uint8Array): Int16Array {
  const samples = new Int16Array(data.byteLength / 2);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let index = 0; index < samples.length; index += 1)
    samples[index] = view.getInt16(index * 2, true);
  return samples;
}

function encodePcm16(samples: Int16Array): Uint8Array {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  for (let index = 0; index < samples.length; index += 1)
    view.setInt16(index * 2, samples[index] ?? 0, true);
  return data;
}

function clampPcm16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, value));
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
