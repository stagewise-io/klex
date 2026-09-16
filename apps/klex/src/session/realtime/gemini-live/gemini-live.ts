import type { JSONValue } from '@ai-sdk/provider';
import WebSocket, { type ClientOptions, type RawData } from 'ws';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { ResolvedGeminiLiveConfig } from '@/config';
import {
  type AudioFrame,
  type AudioSource,
  createPcmAudioMixer,
  createPcmResampler,
  type RealtimeEndpointClosure,
} from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';
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
import {
  geminiAudioMessage,
  geminiHistoryMessages,
  geminiSetupMessage,
  geminiTextMessage,
  geminiToolResponseMessage,
} from './session-config';
import { type GeminiServerEvent, parseGeminiServerEvent } from './wire-events';

export interface GeminiLiveWebSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type GeminiLiveWebSocketConnector = (
  url: string,
  options: ClientOptions,
) => GeminiLiveWebSocket;

export interface GeminiLiveReconnectPolicy {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly graceMs: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const OPEN = 1;
const FRAME_BYTES = 960 * 2;
const OUTPUT_SAMPLE_RATE_HZ = 24_000;
const STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT: GeminiLiveReconnectPolicy = {
  maxAttempts: 2,
  delayMs: 250,
  graceMs: 8_000,
};

class GeminiLiveSession implements RealtimeModelSession {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly eventQueue = new BoundedAsyncQueue<RealtimeModelEvent>(32);
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly ready = deferred<void>();
  private readonly inputMixer = createPcmAudioMixer();
  private readonly outputResampler = createPcmResampler('24-to-48');
  private readonly inputTask: Promise<void>;
  private socket: GeminiLiveWebSocket;
  private connectionToken = 0;
  private startupTimer: ReturnType<typeof setTimeout>;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private resumeHandle: string | undefined;
  private resuming = false;
  private settled = false;
  private readySettled = false;
  private seeded = false;
  private sequence = 0;
  private timestampUs = 0;
  private outputBuffer = new Uint8Array(0);
  private outputWork = Promise.resolve();
  private eventWork = Promise.resolve();
  private generation = 0;
  private generatedMs = 0;
  private deliveredMs = 0;
  private userTranscript = '';
  private assistantTranscript = '';
  private turnSequence = 0;
  private interactionInProgress = false;
  private readonly deliveredUpdates = new Set<string>();
  private readonly deliveredToolResults = new Set<string>();
  private readonly handledToolCalls = new Set<string>();
  private readonly canceledToolCalls = new Set<string>();
  private readonly toolNames = new Map<string, string>();
  private readonly replayMessages: object[] = [];

  readonly audioInputs = {
    attach: (source: AudioSource) => this.attachSource(source),
  };
  readonly audioOutput = this.outputQueue;
  readonly events = this.eventQueue;
  readonly closed = this.closure.promise;

  constructor(
    private readonly connect: () => GeminiLiveWebSocket,
    private readonly signal: AbortSignal,
    private readonly config: ResolvedGeminiLiveConfig,
    private readonly context: PreparedInferenceContext | undefined,
    private readonly startupTimeoutMs: number,
    private readonly reconnectPolicy: GeminiLiveReconnectPolicy,
    private readonly logger: ModuleLogger,
  ) {
    this.socket = this.attachSocket(connect());
    this.startupTimer = setTimeout(
      () => this.fail(new Error('Gemini Live setup timed out')),
      startupTimeoutMs,
    );
    signal.addEventListener('abort', this.handleAbort, { once: true });
    this.inputTask = this.consumeInput();
    void this.inputTask.catch((error: unknown) => this.fail(error));
    if (signal.aborted) this.handleAbort();
  }

  waitUntilReady(): Promise<void> {
    return this.ready.promise;
  }

  async sendUpdate(update: InteractionUpdateEnvelope): Promise<void> {
    if (this.settled || this.deliveredUpdates.has(update.eventId)) return;
    this.deliveredUpdates.add(update.eventId);
    const message = geminiTextMessage(
      renderInteractionUpdateText(update.event),
      update.requestResponse,
    );
    this.replayMessages.push(message);
    this.send(message);
  }

  async sendToolResult(result: InteractionToolResult): Promise<void> {
    if (
      this.settled ||
      this.canceledToolCalls.has(result.executionId) ||
      this.deliveredToolResults.has(result.executionId)
    )
      return;
    this.deliveredToolResults.add(result.executionId);
    const response =
      result.status === 'success'
        ? result.output
        : {
            error: result.error,
            code: result.code,
            retryable: result.retryable,
          };
    const message = geminiToolResponseMessage(
      result.executionId,
      this.toolNames.get(result.executionId) ?? 'unknown_tool',
      response,
    );
    this.replayMessages.push(message);
    this.send(message);
  }

  async close(): Promise<void> {
    this.settle({ type: 'closed', reason: 'local-close' });
  }

  private attachSocket(socket: GeminiLiveWebSocket): GeminiLiveWebSocket {
    const token = ++this.connectionToken;
    socket.on('open', () => this.handleOpen(token));
    socket.on('message', (data) => this.handleMessage(token, data));
    socket.on('error', (error) => this.handleDisconnect(token, error));
    socket.on('close', () =>
      this.handleDisconnect(token, new Error('Gemini Live connection closed')),
    );
    return socket;
  }

  private handleOpen(token: number): void {
    if (token !== this.connectionToken || this.settled) return;
    this.send(geminiSetupMessage(this.config, this.context, this.resumeHandle));
  }

  private handleMessage(token: number, raw: RawData): void {
    if (token !== this.connectionToken || this.settled) return;
    let event: GeminiServerEvent;
    try {
      event = parseGeminiServerEvent(raw.toString());
    } catch (error) {
      this.fail(error);
      return;
    }
    switch (event.type) {
      case 'setup-complete':
        this.completeHandshake();
        return;
      case 'server-content':
        this.handleServerContent(event);
        return;
      case 'tool-call':
        for (const call of event.calls) this.handleToolCall(call);
        return;
      case 'tool-call-cancellation':
        for (const id of event.ids) this.cancelToolCall(id);
        return;
      case 'resumption-update':
        if (event.resumable && event.handle) this.resumeHandle = event.handle;
        else if (!event.resumable) this.resumeHandle = undefined;
        return;
      case 'go-away':
        this.rotateConnection();
        return;
      case 'provider-error':
        this.logger.warn(
          { providerCode: event.code },
          'Gemini Live provider error received',
        );
        this.fail(new Error('Gemini Live provider reported an error'));
        return;
      case 'ignored':
        return;
    }
  }

  private completeHandshake(): void {
    if (!this.resuming) {
      if (!this.seeded) {
        for (const message of geminiHistoryMessages(
          this.context?.messages ?? [],
        ))
          this.send(message);
        this.seeded = true;
      }
      for (const message of this.replayMessages) this.send(message);
    }
    this.resuming = false;
    this.reconnecting = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.graceTimer);
    if (!this.readySettled) {
      this.readySettled = true;
      clearTimeout(this.startupTimer);
      this.ready.resolve();
    }
  }

  private handleServerContent(
    event: Extract<GeminiServerEvent, { type: 'server-content' }>,
  ): void {
    if (event.interactionStatus === 'IN_PROGRESS')
      this.interactionInProgress = true;
    if (event.inputTranscript) this.userTranscript += event.inputTranscript;
    if (event.outputTranscript)
      this.assistantTranscript += event.outputTranscript;
    for (const text of event.text) this.assistantTranscript += text;
    for (const audio of event.audio) this.handleAudio(audio);
    if (event.interrupted) this.interrupt();
    if (event.interactionStatus === 'IDLE') {
      this.interactionInProgress = false;
      this.commitTurn(false);
    } else if (
      event.turnComplete &&
      (this.config.modelId === 'gemini-3.8-live' || !this.interactionInProgress)
    ) {
      this.commitTurn(false);
    }
  }

  private handleAudio(encoded: string): void {
    const data = Uint8Array.from(Buffer.from(encoded, 'base64'));
    if (data.byteLength === 0 || data.byteLength % 2 !== 0) {
      this.fail(new Error('Gemini Live audio contains invalid PCM16'));
      return;
    }
    const generation = this.generation;
    this.generatedMs += (data.byteLength / 2 / OUTPUT_SAMPLE_RATE_HZ) * 1_000;
    this.outputWork = this.outputWork
      .then(() => this.emitAudio(data, generation))
      .catch((error: unknown) => this.fail(error));
  }

  private async emitAudio(data: Uint8Array, generation: number): Promise<void> {
    if (this.settled || generation !== this.generation) return;
    const converted = this.outputResampler.process(data);
    const combined = new Uint8Array(
      this.outputBuffer.length + converted.length,
    );
    combined.set(this.outputBuffer);
    combined.set(converted, this.outputBuffer.length);
    let offset = 0;
    while (combined.length - offset >= FRAME_BYTES) {
      if (this.settled || generation !== this.generation) return;
      await this.outputQueue.push({
        encoding: 'pcm-s16le',
        sampleRateHz: 48_000,
        channels: 1,
        sequence: this.sequence++,
        timestampUs: this.timestampUs,
        data: combined.slice(offset, offset + FRAME_BYTES),
      });
      this.timestampUs += 20_000;
      this.deliveredMs += 20;
      offset += FRAME_BYTES;
    }
    if (generation === this.generation)
      this.outputBuffer = combined.slice(offset);
  }

  private interrupt(): void {
    const ratio =
      this.generatedMs > 0
        ? Math.min(1, this.deliveredMs / this.generatedMs)
        : 0;
    if (this.assistantTranscript.length > 0) {
      const text = sliceByRatio(this.assistantTranscript, ratio);
      this.commitTranscripts(text, true);
    } else this.commitTranscripts('', true);
    this.generation += 1;
    this.outputBuffer = new Uint8Array(0);
    this.outputResampler.reset();
    this.generatedMs = 0;
    this.deliveredMs = 0;
  }

  private commitTurn(interrupted: boolean): void {
    this.commitTranscripts(this.assistantTranscript, interrupted);
    this.generatedMs = 0;
    this.deliveredMs = 0;
  }

  private commitTranscripts(assistant: string, interrupted: boolean): void {
    const turn = this.turnSequence++;
    const user = this.userTranscript.trim();
    const model = assistant.trim();
    this.userTranscript = '';
    this.assistantTranscript = '';
    if (user.length > 0)
      this.emitEvent({
        type: 'user-transcript',
        eventId: `gemini-user-${turn}`,
        text: user,
      });
    if (model.length > 0)
      this.emitEvent({
        type: 'assistant-transcript',
        eventId: `gemini-assistant-${turn}`,
        text: model,
        ...(interrupted && { interrupted: true }),
      });
  }

  private handleToolCall(call: {
    id: string;
    name: string;
    args: unknown;
  }): void {
    if (this.handledToolCalls.has(call.id)) return;
    this.handledToolCalls.add(call.id);
    this.toolNames.set(call.id, call.name);
    this.emitEvent({
      type: 'tool-call',
      eventId: call.id,
      request: {
        executionId: call.id,
        name: call.name,
        input: toJsonValue(call.args),
      },
    });
  }

  private cancelToolCall(id: string): void {
    if (this.canceledToolCalls.has(id)) return;
    this.canceledToolCalls.add(id);
    this.emitEvent({
      type: 'tool-call-cancelled',
      eventId: id,
      executionId: id,
    });
  }

  private async attachSource(source: AudioSource): Promise<void> {
    await this.ready.promise;
    if (this.settled) throw new Error('Gemini Live session is closed');
    await this.inputMixer.audioInputs.attach(source);
  }

  private async consumeInput(): Promise<void> {
    for await (const frame of this.inputMixer.audioOutput) {
      if (this.settled) return;
      if (
        frame.encoding !== 'pcm-s16le' ||
        frame.sampleRateHz !== 48_000 ||
        frame.channels !== 1 ||
        frame.data.byteLength === 0 ||
        frame.data.byteLength % 2 !== 0
      )
        throw new Error('Gemini Live input requires 48 kHz mono PCM16');
      this.send(geminiAudioMessage(frame.data), true);
    }
  }

  private rotateConnection(): void {
    if (this.settled || this.reconnecting) return;
    const token = this.connectionToken;
    const oldSocket = this.socket;
    this.handleDisconnect(
      token,
      new Error('Gemini Live requested connection rotation'),
    );
    oldSocket.close();
  }

  private handleDisconnect(token: number, error: unknown): void {
    if (token !== this.connectionToken || this.settled) return;
    if (
      !this.readySettled ||
      this.reconnectAttempts >= this.reconnectPolicy.maxAttempts
    ) {
      this.fail(error);
      return;
    }
    this.connectionToken += 1;
    this.reconnectAttempts += 1;
    this.reconnecting = true;
    this.resuming = this.resumeHandle !== undefined;
    if (!this.resuming) this.seeded = false;
    this.generation += 1;
    this.outputBuffer = new Uint8Array(0);
    this.outputResampler.reset();
    this.graceTimer ??= setTimeout(
      () => this.fail(new Error('Gemini Live reconnect window expired')),
      this.reconnectPolicy.graceMs,
    );
    this.logger.warn(
      { error, reconnectAttempt: this.reconnectAttempts },
      'Gemini Live connection lost, reconnecting',
    );
    this.reconnectTimer = setTimeout(
      () => this.reconnectNow(),
      this.reconnectPolicy.delayMs,
    );
  }

  private reconnectNow(): void {
    if (this.settled || !this.reconnecting) return;
    const token = this.connectionToken;
    try {
      this.socket = this.attachSocket(this.connect());
    } catch (error) {
      this.reconnecting = false;
      this.handleDisconnect(token, error);
    }
  }

  private send(message: object, dropWhileReconnecting = false): void {
    if (this.socket.readyState !== OPEN) {
      if (this.reconnecting || dropWhileReconnecting) return;
      this.fail(new Error('Gemini Live connection is not open'));
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private emitEvent(event: RealtimeModelEvent): void {
    if (this.settled) return;
    this.eventWork = this.eventWork
      .then(() => (this.settled ? undefined : this.eventQueue.push(event)))
      .catch((error: unknown) => this.fail(error));
  }

  private readonly handleAbort = (): void =>
    this.settle({ type: 'closed', reason: 'aborted' });

  private fail(error: unknown): void {
    this.logger.warn({ error }, 'Gemini Live session failed');
    this.settle({ type: 'failed', error });
  }

  private settle(closure: RealtimeEndpointClosure): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.startupTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.graceTimer);
    this.signal.removeEventListener('abort', this.handleAbort);
    if (!this.readySettled) {
      this.readySettled = true;
      this.ready.reject(
        closure.type === 'failed'
          ? closure.error
          : new Error('Gemini Live setup cancelled'),
      );
    }
    void this.inputMixer.close();
    const error = closure.type === 'failed' ? closure.error : undefined;
    this.outputQueue.close(error);
    this.eventQueue.close(error);
    if (this.socket.readyState === OPEN) this.socket.close();
    else this.socket.terminate();
    this.closure.resolve(closure);
  }
}

class GeminiLiveSessionFactory implements RealtimeModelSessionFactory {
  constructor(
    private readonly config: ResolvedGeminiLiveConfig,
    private readonly connect: GeminiLiveWebSocketConnector,
    private readonly startupTimeoutMs: number,
    private readonly reconnect: GeminiLiveReconnectPolicy,
    private readonly logger: ModuleLogger,
  ) {}

  async create(options: {
    signal: AbortSignal;
    context?: PreparedInferenceContext;
  }): Promise<RealtimeModelSession> {
    if (options.signal.aborted) throw options.signal.reason;
    const session = new GeminiLiveSession(
      () => this.connect(authenticatedUrl(this.config), {}),
      options.signal,
      this.config,
      options.context,
      this.startupTimeoutMs,
      this.reconnect,
      this.logger,
    );
    await session.waitUntilReady();
    return session;
  }
}

export function createGeminiLiveProcessorFactory(options: {
  logging: RootLogger;
  config: ResolvedGeminiLiveConfig;
  connect?: GeminiLiveWebSocketConnector;
  startupTimeoutMs?: number;
  reconnect?: Partial<GeminiLiveReconnectPolicy>;
}): RealtimeModelSessionFactory {
  return new GeminiLiveSessionFactory(
    options.config,
    options.connect ??
      ((url, socketOptions) => new WebSocket(url, socketOptions)),
    options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    { ...DEFAULT_RECONNECT, ...options.reconnect },
    options.logging.child({
      name: 'gemini-live',
      bindings: { module: 'gemini-live' },
    }),
  );
}

function authenticatedUrl(config: ResolvedGeminiLiveConfig): string {
  const url = new URL(config.websocketUrl);
  url.searchParams.set('key', config.apiKey);
  return url.toString();
}

function toJsonValue(value: unknown): JSONValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    const result: Record<string, JSONValue> = {};
    for (const [key, item] of Object.entries(value))
      result[key] = toJsonValue(item);
    return result;
  }
  return null;
}

function sliceByRatio(text: string, ratio: number): string {
  if (ratio <= 0) return '';
  const cut = Math.max(1, Math.round(text.length * ratio));
  if (cut >= text.length) return text;
  const head = text.slice(0, cut);
  const boundary = head.lastIndexOf(' ');
  return (boundary > 0 ? head.slice(0, boundary) : head).trimEnd();
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
