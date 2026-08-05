import WebSocket, { type ClientOptions, type RawData } from 'ws';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { ResolvedOpenAIRealtimeConfig } from '@/config';
import type {
  AudioFrame,
  AudioSource,
  RealtimeEndpointClosure,
  RealtimeProcessor,
  RealtimeProcessorFactory,
} from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';
import { createPcmResampler } from '@/media-transport/pcm-resampler';

export interface RealtimeWebSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type RealtimeWebSocketConnector = (
  url: string,
  options: ClientOptions,
) => RealtimeWebSocket;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

const OPEN = 1;
const FRAME_BYTES = 960 * 2;
const STARTUP_TIMEOUT_MS = 10_000;

class OpenAIRealtimeProcessor implements RealtimeProcessor {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly ready = deferred<void>();
  private readonly inputResampler = createPcmResampler('48-to-24');
  private readonly outputResampler = createPcmResampler('24-to-48');
  private outputBuffer = new Uint8Array(0);
  private activeSourceId: string | undefined;
  private inputTask: Promise<void> | undefined;
  private outputWork = Promise.resolve();
  private sequence = 0;
  private timestampUs = 0;
  private activeResponseId: string | undefined;
  private activeItemId: string | undefined;
  private generation = 0;
  private settled = false;
  private readySettled = false;
  private startupTimer: ReturnType<typeof setTimeout>;

  readonly audioInputs = {
    attach: (source: AudioSource) => this.attachSource(source),
  };
  readonly audioOutput = this.outputQueue;
  readonly closed = this.closure.promise;

  constructor(
    private readonly socket: RealtimeWebSocket,
    private readonly config: ResolvedOpenAIRealtimeConfig,
    private readonly signal: AbortSignal,
    startupTimeoutMs: number,
    private readonly logger: ModuleLogger,
  ) {
    socket.on('open', this.handleOpen);
    socket.on('message', this.handleMessage);
    socket.on('error', this.handleError);
    socket.on('close', this.handleSocketClose);
    signal.addEventListener('abort', this.handleAbort, { once: true });
    this.startupTimer = setTimeout(
      () => this.fail(new Error('OpenAI realtime setup timed out')),
      startupTimeoutMs,
    );
    if (signal.aborted) this.handleAbort();
  }

  waitUntilReady(): Promise<void> {
    return this.ready.promise;
  }

  private async attachSource(source: AudioSource): Promise<void> {
    await this.ready.promise;
    if (this.settled) throw new Error('OpenAI realtime processor is closed');
    if (this.activeSourceId !== undefined)
      throw new Error('OpenAI realtime supports one active audio source');
    this.activeSourceId = source.id;
    const task = this.consumeSource(source).finally(() => {
      if (this.inputTask === task) this.inputTask = undefined;
      if (this.activeSourceId === source.id) this.activeSourceId = undefined;
      this.inputResampler.reset();
    });
    this.inputTask = task;
    void task.catch((error: unknown) => this.fail(error));
  }

  private async consumeSource(source: AudioSource): Promise<void> {
    for await (const frame of source.readable) {
      if (this.settled) return;
      this.writeAudio(frame);
    }
  }

  private writeAudio(frame: AudioFrame): void {
    if (
      frame.encoding !== 'pcm-s16le' ||
      frame.sampleRateHz !== 48_000 ||
      frame.channels !== 1
    )
      throw new Error('OpenAI realtime input requires 48 kHz mono PCM16');
    if (frame.data.byteLength === 0 || frame.data.byteLength % 2 !== 0)
      throw new Error('OpenAI realtime input requires complete PCM16 samples');
    const audio = this.inputResampler.process(frame.data);
    this.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(audio).toString('base64'),
    });
  }

  async close(): Promise<void> {
    this.settle({ type: 'closed', reason: 'local-close' });
  }

  private readonly handleOpen = (): void => {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.config.instructions,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24_000 },
            turn_detection: {
              type: 'server_vad',
              create_response: true,
              interrupt_response: true,
              ...(this.config.serverVad.threshold === undefined
                ? {}
                : { threshold: this.config.serverVad.threshold }),
              ...(this.config.serverVad.prefixPaddingMs === undefined
                ? {}
                : { prefix_padding_ms: this.config.serverVad.prefixPaddingMs }),
              ...(this.config.serverVad.silenceDurationMs === undefined
                ? {}
                : {
                    silence_duration_ms:
                      this.config.serverVad.silenceDurationMs,
                  }),
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24_000 },
            voice: this.config.voice,
          },
        },
      },
    });
  };

  private readonly handleMessage = (raw: RawData): void => {
    let event: ServerEvent;
    try {
      const parsed: unknown = JSON.parse(raw.toString());
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('type' in parsed) ||
        typeof parsed.type !== 'string'
      )
        throw new Error('OpenAI realtime event has no type');
      event = parsed as ServerEvent;
    } catch (error) {
      this.fail(error);
      return;
    }
    if (event.type === 'session.updated') {
      this.resolveReady();
      return;
    }
    if (event.type === 'error') {
      const providerError =
        event.error && typeof event.error === 'object'
          ? (event.error as Record<string, unknown>)
          : {};
      const details = {
        eventId: sanitizedString(event.event_id),
        providerError: {
          type: sanitizedString(providerError.type),
          code: sanitizedString(providerError.code),
          message: sanitizedString(providerError.message),
          param: sanitizedString(providerError.param),
        },
      };
      if (providerError.code === 'response_cancel_not_active') {
        this.logger.warn(
          details,
          'OpenAI realtime cancellation raced with response completion',
        );
        return;
      }
      this.logger.warn(details, 'OpenAI realtime provider error received');
      this.fail(new Error('OpenAI realtime provider reported an error'));
      return;
    }
    if (event.type === 'response.created') {
      const response = event.response;
      if (
        response &&
        typeof response === 'object' &&
        'id' in response &&
        typeof response.id === 'string'
      )
        this.activeResponseId = response.id;
      this.generation += 1;
      return;
    }
    if (event.type === 'response.output_audio.delta') {
      if (typeof event.delta !== 'string') {
        this.fail(new Error('OpenAI audio delta is malformed'));
        return;
      }
      if (
        typeof event.response_id === 'string' &&
        this.activeResponseId &&
        event.response_id !== this.activeResponseId
      )
        return;
      if (typeof event.item_id === 'string') this.activeItemId = event.item_id;
      const generation = this.generation;
      let decoded: Uint8Array;
      try {
        decoded = Uint8Array.from(Buffer.from(event.delta, 'base64'));
        if (decoded.byteLength === 0 || decoded.byteLength % 2 !== 0)
          throw new Error();
      } catch {
        this.fail(new Error('OpenAI audio delta contains invalid PCM16'));
        return;
      }
      this.outputWork = this.outputWork
        .then(() => this.emitAudio(decoded, generation))
        .catch((error: unknown) => this.fail(error));
      return;
    }
    if (event.type === 'input_audio_buffer.speech_started') this.interrupt();
    if (event.type === 'response.done') {
      this.activeResponseId = undefined;
      this.activeItemId = undefined;
    }
  };

  private async emitAudio(data: Uint8Array, generation: number): Promise<void> {
    if (generation !== this.generation || this.settled) return;
    const converted = this.outputResampler.process(data);
    const combined = new Uint8Array(
      this.outputBuffer.length + converted.length,
    );
    combined.set(this.outputBuffer);
    combined.set(converted, this.outputBuffer.length);
    let offset = 0;
    while (combined.length - offset >= FRAME_BYTES) {
      if (generation !== this.generation || this.settled) return;
      const frameData = combined.slice(offset, offset + FRAME_BYTES);
      await this.outputQueue.push({
        encoding: 'pcm-s16le',
        sampleRateHz: 48_000,
        channels: 1,
        sequence: this.sequence++,
        timestampUs: this.timestampUs,
        data: frameData,
      });
      this.timestampUs += 20_000;
      offset += FRAME_BYTES;
    }
    if (generation === this.generation)
      this.outputBuffer = combined.slice(offset);
  }

  private interrupt(): void {
    if (this.activeResponseId)
      this.send({
        type: 'response.cancel',
        response_id: this.activeResponseId,
      });
    if (this.activeItemId)
      this.send({
        type: 'conversation.item.truncate',
        item_id: this.activeItemId,
        content_index: 0,
        audio_end_ms: 0,
      });
    this.generation += 1;
    this.activeResponseId = undefined;
    this.activeItemId = undefined;
    this.outputBuffer = new Uint8Array(0);
    this.outputResampler.reset();
  }

  private readonly handleError = (error: Error): void => this.fail(error);
  private readonly handleSocketClose = (): void => {
    if (!this.settled)
      this.fail(new Error('OpenAI realtime connection closed unexpectedly'));
  };
  private readonly handleAbort = (): void =>
    this.settle({ type: 'closed', reason: 'aborted' });

  private send(event: object): void {
    if (this.socket.readyState !== OPEN) {
      this.fail(new Error('OpenAI realtime connection is not open'));
      return;
    }
    this.socket.send(JSON.stringify(event));
  }

  private resolveReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    clearTimeout(this.startupTimer);
    this.ready.resolve();
  }

  private fail(error: unknown): void {
    this.logger.warn({ error }, 'OpenAI realtime processor failed');
    this.settle({ type: 'failed', error });
  }

  private settle(closure: RealtimeEndpointClosure): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.startupTimer);
    this.signal.removeEventListener('abort', this.handleAbort);
    if (!this.readySettled) {
      this.readySettled = true;
      this.ready.reject(
        closure.type === 'failed'
          ? closure.error
          : new Error('OpenAI realtime setup cancelled'),
      );
    }
    this.outputQueue.close(
      closure.type === 'failed' ? closure.error : undefined,
    );
    if (this.socket.readyState === OPEN) this.socket.close();
    else this.socket.terminate();
    this.closure.resolve(closure);
  }
}

class OpenAIRealtimeProcessorFactory implements RealtimeProcessorFactory {
  constructor(
    private readonly config: ResolvedOpenAIRealtimeConfig,
    private readonly connect: RealtimeWebSocketConnector,
    private readonly startupTimeoutMs: number,
    private readonly logger: ModuleLogger,
  ) {}

  async create(options: { signal: AbortSignal }): Promise<RealtimeProcessor> {
    if (options.signal.aborted) throw options.signal.reason;
    const socket = this.connect(this.config.websocketUrl, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    const processor = new OpenAIRealtimeProcessor(
      socket,
      this.config,
      options.signal,
      this.startupTimeoutMs,
      this.logger,
    );
    await processor.waitUntilReady();
    return processor;
  }
}

export function createOpenAIRealtimeProcessorFactory(options: {
  logging: RootLogger;
  config: ResolvedOpenAIRealtimeConfig;
  connect?: RealtimeWebSocketConnector;
  startupTimeoutMs?: number;
}): RealtimeProcessorFactory {
  return new OpenAIRealtimeProcessorFactory(
    options.config,
    options.connect ??
      ((url, socketOptions) => new WebSocket(url, socketOptions)),
    options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    options.logging.child({
      name: 'openai-realtime',
      bindings: { module: 'openai-realtime' },
    }),
  );
}

function sanitizedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, 1_000) : undefined;
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
