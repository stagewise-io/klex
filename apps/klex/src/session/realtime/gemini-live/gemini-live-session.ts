import type { JSONValue } from '@ai-sdk/provider';
import WebSocket, { type ClientOptions, type RawData } from 'ws';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { ResolvedGeminiLiveConfig } from '@/config';
import type {
  AudioFrame,
  AudioSource,
  RealtimeEndpointClosure,
} from '@/media-transport';
import {
  BoundedAsyncQueue,
  QueueWriteCancelledError,
} from '@/media-transport/async-queue';
import { createPcmAudioMixer } from '@/media-transport/pcm-audio-mixer';
import { createPcmResampler } from '@/media-transport/pcm-resampler';
import {
  type InteractionToolResult,
  type InteractionUpdateEnvelope,
  type PreparedInferenceContext,
  renderInteractionUpdateText,
} from '@/session/interaction';

import type {
  RealtimeModelEvent,
  RealtimeModelSession,
  RealtimeModelSessionFactory,
} from '../model-session';
import { toGeminiContentTurns } from './conversation-items';
import {
  type GeminiLiveServerEvent,
  parseGeminiLiveServerEvents,
} from './wire-events';

export interface GeminiRealtimeWebSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type GeminiRealtimeWebSocketConnector = (
  url: string,
  options: ClientOptions,
) => GeminiRealtimeWebSocket;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const OPEN = 1;
const FRAME_BYTES = 960 * 2;
const STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_INSTRUCTIONS = 'You are Klex. Answer clearly and briefly.';

export class GeminiLiveSession implements RealtimeModelSession {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly eventQueue = new BoundedAsyncQueue<RealtimeModelEvent>(32);
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly ready = deferred<void>();
  private readonly inputMixer = createPcmAudioMixer();
  private readonly inputResampler = createPcmResampler('48-to-24');
  private readonly outputResampler = createPcmResampler('24-to-48');
  private readonly inputTask: Promise<void>;
  private readonly functionNames = new Map<string, string>();
  private socket: GeminiRealtimeWebSocket;
  private outputBuffer = new Uint8Array(0);
  private outputWork = Promise.resolve();
  private sequence = 0;
  private timestampUs = 0;
  private activeTranscript: string | undefined;
  private generation = 0;
  private seeded = false;
  private settled = false;
  private readySettled = false;
  private startupTimer: ReturnType<typeof setTimeout>;

  readonly audioInputs = {
    attach: (source: AudioSource) => this.attachSource(source),
  };
  readonly audioOutput = this.outputQueue;
  readonly events = this.eventQueue;
  readonly closed = this.closure.promise;

  constructor(
    connect: () => GeminiRealtimeWebSocket,
    private readonly signal: AbortSignal,
    startupTimeoutMs: number,
    private readonly logger: ModuleLogger,
    private readonly context: PreparedInferenceContext | undefined,
    private readonly config: ResolvedGeminiLiveConfig,
  ) {
    this.socket = this.attachSocket(connect());
    signal.addEventListener('abort', this.handleAbort, { once: true });
    this.startupTimer = setTimeout(
      () => this.fail(new Error('Gemini live setup timed out')),
      startupTimeoutMs,
    );
    this.inputTask = this.consumeMixedInput();
    void this.inputTask.catch((error: unknown) => this.fail(error));
    if (signal.aborted) this.handleAbort();
  }

  waitUntilReady(): Promise<void> {
    return this.ready.promise;
  }

  private attachSocket(
    socket: GeminiRealtimeWebSocket,
  ): GeminiRealtimeWebSocket {
    socket.on('open', () => this.handleOpen());
    socket.on('message', (data: RawData) => this.handleMessage(data));
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => {
      if (!this.settled) {
        this.fail(new Error('Gemini live connection closed unexpectedly'));
      }
    });
    return socket;
  }

  private async attachSource(source: AudioSource): Promise<void> {
    await this.ready.promise;
    if (this.settled) throw new Error('Gemini live session is closed');
    await this.inputMixer.audioInputs.attach(source);
  }

  private async consumeMixedInput(): Promise<void> {
    for await (const frame of this.inputMixer.audioOutput) {
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
      throw new Error('Gemini live input requires 48 kHz mono PCM16');
    if (frame.data.byteLength === 0 || frame.data.byteLength % 2 !== 0)
      throw new Error('Gemini live input requires complete PCM16 samples');
    const audio = this.inputResampler.process(frame.data);
    this.send({
      realtimeInput: {
        audio: {
          data: Buffer.from(audio).toString('base64'),
          mimeType: 'audio/pcm;rate=24000',
        },
      },
    });
  }

  async sendUpdate(update: InteractionUpdateEnvelope): Promise<void> {
    if (this.settled) return;
    const text = renderInteractionUpdateText(update.event);
    if (!text.trim()) return;
    this.send({
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [{ text }],
          },
        ],
        turnComplete: update.requestResponse,
      },
    });
  }

  async sendToolResult(result: InteractionToolResult): Promise<void> {
    if (this.settled) return;
    const name =
      this.functionNames.get(result.executionId) ?? result.executionId;
    const responsePayload =
      result.status === 'success'
        ? { result: result.output ?? {} }
        : { error: result.error ?? 'Tool execution failed', code: result.code };
    const toolResponse = {
      toolResponse: {
        functionResponses: [
          {
            id: result.executionId,
            name,
            response: responsePayload,
          },
        ],
      },
    };
    this.send(toolResponse);
  }

  async close(): Promise<void> {
    this.settle({ type: 'closed', reason: 'local-close' });
  }

  private handleOpen(): void {
    if (this.settled) return;
    const tools = this.context?.tools ?? [];
    const model = this.config.modelId.startsWith('models/')
      ? this.config.modelId
      : `models/${this.config.modelId}`;
    const setupMessage = {
      setup: {
        model,
        generationConfig: {
          responseModalities: ['AUDIO'],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: {
          parts: [{ text: this.context?.instructions ?? DEFAULT_INSTRUCTIONS }],
        },
        ...(tools.length > 0 && {
          tools: [
            {
              functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                ...(tool.description !== undefined && {
                  description: tool.description,
                }),
                parameters: tool.inputSchema,
              })),
            },
          ],
        }),
      },
    };
    this.send(setupMessage);
  }

  private seedConversation(): void {
    if (this.seeded) return;
    this.seeded = true;
    const turns = toGeminiContentTurns(this.context?.messages ?? []);
    if (turns.length > 0) {
      this.send({
        clientContent: {
          turns,
          turnComplete: false,
        },
      });
      this.logger.debug(
        {
          turns: turns.length,
          historyRevision: this.context?.historyRevision,
          updateWatermark: this.context?.updateWatermark,
        },
        'Seeded Gemini live conversation with canonical history',
      );
    }
  }

  private handleMessage(raw: RawData): void {
    if (this.settled) return;
    let events: GeminiLiveServerEvent[];
    try {
      events = parseGeminiLiveServerEvents(raw.toString());
    } catch (error) {
      this.fail(error);
      return;
    }
    for (const event of events) {
      switch (event.type) {
        case 'setup-complete':
          this.seedConversation();
          this.resolveReady();
          break;
        case 'provider-error':
          this.logger.warn(
            { error: event.error },
            'Gemini live provider error received',
          );
          this.fail(
            new Error(
              `Gemini live provider error: ${event.error.message ?? 'Unknown error'}`,
            ),
          );
          return;
        case 'interrupted':
          this.interrupt();
          break;
        case 'input-transcript':
          void this.eventQueue.push({
            type: 'user-transcript',
            eventId: `gemini-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: event.transcript,
          });
          break;
        case 'output-transcript':
          this.activeTranscript =
            (this.activeTranscript ?? '') + event.transcript;
          break;
        case 'output-audio-delta': {
          this.seedConversation();
          this.resolveReady();
          const generation = this.generation;
          let decoded: Uint8Array;
          try {
            decoded = Uint8Array.from(Buffer.from(event.delta, 'base64'));
            if (decoded.byteLength === 0 || decoded.byteLength % 2 !== 0)
              throw new Error();
          } catch {
            this.fail(
              new Error('Gemini live audio delta contains invalid PCM16'),
            );
            return;
          }
          this.outputWork = this.outputWork
            .then(() => this.emitAudio(decoded, generation))
            .catch((error: unknown) => this.fail(error));
          break;
        }
        case 'turn-complete':
          if (this.activeTranscript) {
            void this.eventQueue.push({
              type: 'assistant-transcript',
              eventId: `gemini-asst-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              text: this.activeTranscript,
            });
            this.activeTranscript = undefined;
          }
          break;
        case 'tool-call':
          for (const call of event.calls) {
            this.functionNames.set(call.callId, call.name);
            void this.eventQueue.push({
              type: 'tool-call',
              eventId: call.callId,
              request: {
                executionId: call.callId,
                name: call.name,
                input: call.args as JSONValue,
              },
            });
          }
          break;
        case 'tool-call-cancellation':
          break;
        case 'ignored':
          break;
      }
    }
  }

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
      try {
        await this.outputQueue.push({
          encoding: 'pcm-s16le',
          sampleRateHz: 48_000,
          channels: 1,
          sequence: this.sequence++,
          timestampUs: this.timestampUs,
          data: frameData,
        });
      } catch (error) {
        if (error instanceof QueueWriteCancelledError) return;
        throw error;
      }
      this.timestampUs += 20_000;
      offset += FRAME_BYTES;
    }
    if (generation === this.generation)
      this.outputBuffer = combined.slice(offset);
  }

  private interrupt(): void {
    this.generation += 1;
    this.outputBuffer = new Uint8Array(0);
    this.outputResampler.reset();
    this.outputQueue.clear({ discardPendingWriters: true });
    if (this.activeTranscript) {
      void this.eventQueue.push({
        type: 'assistant-transcript',
        eventId: `gemini-asst-interrupted-${Date.now()}`,
        text: this.activeTranscript,
        interrupted: true,
      });
      this.activeTranscript = undefined;
    }
  }

  private readonly handleAbort = (): void =>
    this.settle({ type: 'closed', reason: 'aborted' });

  private send(event: object): void {
    if (this.socket.readyState !== OPEN) {
      this.fail(new Error('Gemini live connection is not open'));
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
    this.logger.warn({ error }, 'Gemini live processor failed');
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
          : new Error('Gemini live setup cancelled'),
      );
    }
    this.outputQueue.close(
      closure.type === 'failed' ? closure.error : undefined,
    );
    this.eventQueue.close(
      closure.type === 'failed' ? closure.error : undefined,
    );
    if (this.socket.readyState === OPEN) this.socket.close();
    else this.socket.terminate();
    this.closure.resolve(closure);
  }
}

export class GeminiLiveSessionFactory implements RealtimeModelSessionFactory {
  constructor(
    private readonly config: ResolvedGeminiLiveConfig,
    private readonly connect: GeminiRealtimeWebSocketConnector,
    private readonly startupTimeoutMs: number,
    private readonly logger: ModuleLogger,
  ) {}

  async create(options: {
    namespace?: string;
    sessionId?: string;
    signal: AbortSignal;
    context?: PreparedInferenceContext;
  }): Promise<RealtimeModelSession> {
    if (options.signal.aborted) throw options.signal.reason;
    const session = new GeminiLiveSession(
      () => this.connect(this.config.websocketUrl, {}),
      options.signal,
      this.startupTimeoutMs,
      this.logger,
      options.context,
      this.config,
    );
    await session.waitUntilReady();
    return session;
  }
}

export function createGeminiLiveProcessorFactory(options: {
  logging: RootLogger;
  config: ResolvedGeminiLiveConfig;
  connect?: GeminiRealtimeWebSocketConnector;
  startupTimeoutMs?: number;
}): RealtimeModelSessionFactory {
  return new GeminiLiveSessionFactory(
    options.config,
    options.connect ??
      ((url, socketOptions) => new WebSocket(url, socketOptions)),
    options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    options.logging.child({
      name: 'gemini-live',
      bindings: { module: 'gemini-live' },
    }),
  );
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
