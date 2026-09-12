import type { JSONValue } from '@ai-sdk/provider';
import WebSocket, { type ClientOptions, type RawData } from 'ws';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { ResolvedOpenAIRealtimeConfig } from '@/config';
import {
  type AudioFrame,
  type AudioSource,
  createPcmAudioMixer,
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
  assistantTextItem,
  type ConversationItem,
  functionOutputItem,
  toConversationItems,
  toSessionTools,
  userTextItem,
} from './conversation-items';
import { createPcmResampler } from './pcm-resampler';
import { type OpenAIServerEvent, parseServerEvent } from './wire-events';

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

/**
 * Bounded reconnection budget for a single provider session.
 *
 * A call survives one short provider hiccup: the adapter reconnects at
 * most `maxAttempts` times, always inside a single `graceMs` window that
 * starts at the first disconnect. Anything beyond that ends the call so
 * the lease is released instead of silently going deaf.
 */
export interface RealtimeReconnectPolicy {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly graceMs: number;
}

/** Conversation state that must be re-sent after a reconnect. */
type ReplayEntry =
  | {
      readonly kind: 'conversation';
      readonly item: ConversationItem;
    }
  | {
      readonly kind: 'update';
      readonly item: ConversationItem;
      readonly requestResponse: boolean;
    }
  | {
      readonly kind: 'tool-output';
      readonly callId: string;
      readonly output: string;
    };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const OPEN = 1;
const FRAME_BYTES = 960 * 2;
const FRAME_DURATION_MS = 20;
const OUTPUT_SAMPLE_RATE_HZ = 24_000;
const STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_VOICE = 'marin';
const DEFAULT_INSTRUCTIONS = 'You are Klex. Answer clearly and briefly.';
const TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const DEFAULT_RECONNECT: RealtimeReconnectPolicy = {
  maxAttempts: 1,
  delayMs: 250,
  graceMs: 5_000,
};

/**
 * Realtime model session backed by the OpenAI Realtime API.
 *
 * The adapter owns the full semantic surface of a call: it configures the
 * session from a prepared inference context, seeds canonical history,
 * surfaces transcripts and tool calls as provider-neutral events, and
 * accepts live context updates and tool results while the call runs.
 * Audio mixing, resampling, backpressure, and interruption handling stay
 * unchanged from the pure audio path.
 *
 * A transient provider disconnect is absorbed once: the adapter
 * reconnects inside a bounded grace window, reconfigures the session,
 * reseeds prepared history, and replays canonical updates the previous
 * connection had already received. Transcript and tool identity is kept
 * process-local so replayed provider events never commit twice or run a
 * tool a second time.
 */
class OpenAIRealtimeSession implements RealtimeModelSession {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly eventQueue = new BoundedAsyncQueue<RealtimeModelEvent>(32);
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly ready = deferred<void>();
  private readonly inputMixer = createPcmAudioMixer();
  private readonly inputResampler = createPcmResampler('48-to-24');
  private readonly outputResampler = createPcmResampler('24-to-48');
  private readonly inputTask: Promise<void>;
  private readonly functionNames = new Map<string, string>();
  private readonly committedTranscripts = new Set<string>();
  private readonly committedUserTranscripts = new Set<string>();
  private readonly handledToolCalls = new Set<string>();
  private readonly deliveredUpdates = new Set<string>();
  private readonly deliveredToolResults = new Set<string>();
  private readonly replayLog: ReplayEntry[] = [];
  private liveCallIds = new Set<string>();
  private socket: RealtimeWebSocket;
  private connectionToken = 0;
  private reconnecting = false;
  private reconnectReady: Deferred<void> | undefined;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private outputBuffer = new Uint8Array(0);
  private outputWork = Promise.resolve();
  private eventWork = Promise.resolve();
  private sequence = 0;
  private timestampUs = 0;
  private activeResponseId: string | undefined;
  private activeItemId: string | undefined;
  private activeTranscript: string | undefined;
  private generatedMs = 0;
  private playedMs = 0;
  private interruptedResponse: { id: string; ratio: number } | undefined;
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
    private readonly connect: () => RealtimeWebSocket,
    private readonly signal: AbortSignal,
    startupTimeoutMs: number,
    private readonly reconnectPolicy: RealtimeReconnectPolicy,
    private readonly logger: ModuleLogger,
    private readonly context: PreparedInferenceContext | undefined,
  ) {
    this.socket = this.attachSocket(connect());
    signal.addEventListener('abort', this.handleAbort, { once: true });
    this.startupTimer = setTimeout(
      () => this.fail(new Error('OpenAI realtime setup timed out')),
      startupTimeoutMs,
    );
    this.inputTask = this.consumeMixedInput();
    void this.inputTask.catch((error: unknown) => this.fail(error));
    if (signal.aborted) this.handleAbort();
  }

  waitUntilReady(): Promise<void> {
    return this.ready.promise;
  }

  /**
   * Binds a connection and stamps it with a token.
   *
   * The socket contract has no listener removal, so every handler checks
   * its token: events from a replaced connection are ignored instead of
   * corrupting the state of the current one.
   */
  private attachSocket(socket: RealtimeWebSocket): RealtimeWebSocket {
    const token = ++this.connectionToken;
    socket.on('open', () => this.handleOpen(token));
    socket.on('message', (data: RawData) => this.handleMessage(token, data));
    socket.on('error', (error: Error) => this.handleDisconnect(token, error));
    socket.on('close', () =>
      this.handleDisconnect(
        token,
        new Error('OpenAI realtime connection closed unexpectedly'),
      ),
    );
    return socket;
  }

  private async attachSource(source: AudioSource): Promise<void> {
    await this.ready.promise;
    if (this.settled) throw new Error('OpenAI realtime session is closed');
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
      throw new Error('OpenAI realtime input requires 48 kHz mono PCM16');
    if (frame.data.byteLength === 0 || frame.data.byteLength % 2 !== 0)
      throw new Error('OpenAI realtime input requires complete PCM16 samples');
    const audio = this.inputResampler.process(frame.data);
    this.send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(audio).toString('base64'),
    });
  }

  /**
   * Injects a canonical inbox event into the running conversation.
   *
   * The event becomes a user item so the model treats it as new context.
   * A response is requested only when the lease marked the update as
   * worth interrupting the current silence for.
   */
  async sendUpdate(update: InteractionUpdateEnvelope): Promise<void> {
    if (this.settled) return;
    if (this.deliveredUpdates.has(update.eventId)) return;
    this.deliveredUpdates.add(update.eventId);
    const item = userTextItem(renderInteractionUpdateText(update.event));
    this.replayLog.push({
      kind: 'update',
      item,
      requestResponse: update.requestResponse,
    });
    const reconnectReady = this.reconnectReady;
    if (reconnectReady) {
      await reconnectReady.promise;
      return;
    }
    this.createItem(item);
    if (update.requestResponse) this.send({ type: 'response.create' });
  }

  async sendToolResult(result: InteractionToolResult): Promise<void> {
    if (this.settled) return;
    if (this.deliveredToolResults.has(result.executionId)) return;
    this.deliveredToolResults.add(result.executionId);
    const output =
      result.status === 'success'
        ? safeStringify(result.output)
        : JSON.stringify({
            error: result.error,
            code: result.code,
            retryable: result.retryable,
          });
    this.replayLog.push({
      kind: 'tool-output',
      callId: result.executionId,
      output,
    });
    const reconnectReady = this.reconnectReady;
    if (reconnectReady) {
      await reconnectReady.promise;
      return;
    }
    this.createItem(this.toolResultItem(result.executionId, output));
    this.send({ type: 'response.create' });
  }

  /**
   * Chooses the wire shape for a tool result.
   *
   * A `function_call_output` item is only valid while the provider still
   * knows the originating call. After a reconnect the conversation is
   * new, so the result is delivered as plain context instead of a
   * dangling reference the provider would reject.
   */
  private toolResultItem(callId: string, output: string): ConversationItem {
    if (this.liveCallIds.has(callId)) return functionOutputItem(callId, output);
    return userTextItem(
      `<tool-result call-id="${callId}">${output}</tool-result>`,
    );
  }

  async close(): Promise<void> {
    this.settle({ type: 'closed', reason: 'local-close' });
  }

  private handleOpen(token: number): void {
    if (token !== this.connectionToken || this.settled) return;
    const tools = toSessionTools(this.context?.tools ?? []);
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.context?.instructions ?? DEFAULT_INSTRUCTIONS,
        ...(tools.length > 0 && { tools, tool_choice: 'auto' }),
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: OUTPUT_SAMPLE_RATE_HZ },
            transcription: { model: TRANSCRIPTION_MODEL },
            turn_detection: {
              type: 'server_vad',
              create_response: true,
              interrupt_response: true,
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: OUTPUT_SAMPLE_RATE_HZ },
            voice: DEFAULT_VOICE,
          },
        },
      },
    });
  }

  private handleMessage(token: number, raw: RawData): void {
    if (token !== this.connectionToken || this.settled) return;
    let event: OpenAIServerEvent;
    try {
      event = parseServerEvent(raw.toString());
    } catch (error) {
      this.fail(error);
      return;
    }
    switch (event.type) {
      case 'session-updated':
        this.seedConversation();
        this.replayPendingItems();
        this.completeHandshake();
        return;
      case 'provider-error':
        this.handleProviderError(event);
        return;
      case 'response-created':
        this.activeResponseId = event.responseId;
        this.activeTranscript = undefined;
        this.generatedMs = 0;
        this.playedMs = 0;
        this.generation += 1;
        return;
      case 'output-audio-delta':
        this.handleAudioDelta(event);
        return;
      case 'speech-started':
        this.interrupt();
        return;
      case 'input-transcript-done':
        this.commitUserTranscript(event.eventId, event.transcript);
        return;
      case 'output-transcript-done':
        this.handleAssistantTranscript(event);
        return;
      case 'function-call-started':
        this.functionNames.set(event.callId, event.name);
        this.liveCallIds.add(event.callId);
        return;
      case 'function-call-arguments-done':
        this.handleFunctionCall(event);
        return;
      case 'response-done':
        if (event.responseId !== this.activeResponseId) return;
        this.commitAssistantTranscript(event.responseId, false);
        this.activeResponseId = undefined;
        this.activeItemId = undefined;
        return;
    }
  }

  /**
   * Seeds prepared history into the fresh conversation.
   *
   * Ordering matters — the provider appends items in arrival order — so
   * the items are sent synchronously before readiness resolves, ensuring
   * the first spoken turn already sees canonical context.
   */
  private seedConversation(): void {
    if (this.seeded) return;
    this.seeded = true;
    const items = toConversationItems(this.context?.messages ?? []);
    for (const item of items) this.createItem(item);
    if (items.length > 0)
      this.logger.debug(
        {
          items: items.length,
          historyRevision: this.context?.historyRevision,
          updateWatermark: this.context?.updateWatermark,
        },
        'Seeded realtime conversation with canonical history',
      );
  }

  private createItem(item: ConversationItem): void {
    this.send({ type: 'conversation.item.create', item });
  }

  /**
   * Restores canonical updates the lost connection had already seen.
   *
   * Items are replayed in original order after reseeding history. At most
   * one response is requested at the end, so a reconnect cannot turn a
   * batch of queued notifications into a burst of spoken answers.
   */
  private replayPendingItems(): void {
    if (this.replayLog.length === 0) return;
    let requestResponse = false;
    for (const entry of this.replayLog) {
      if (entry.kind === 'conversation') {
        this.createItem(entry.item);
        continue;
      }
      if (entry.kind === 'update') {
        this.createItem(entry.item);
        requestResponse = requestResponse || entry.requestResponse;
        continue;
      }
      this.createItem(this.toolResultItem(entry.callId, entry.output));
      requestResponse = true;
    }
    if (requestResponse) this.send({ type: 'response.create' });
    this.logger.debug(
      {
        items: this.replayLog.length,
        reconnectAttempt: this.reconnectAttempts,
      },
      'Replayed canonical realtime updates after reconnect',
    );
  }

  /**
   * Finishes a connection handshake for the first or a replacement socket.
   *
   * The reconnect budget is intentionally not refilled: one grace window
   * per provider session keeps the failure mode bounded.
   */
  private completeHandshake(): void {
    if (this.reconnecting) {
      this.reconnecting = false;
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
      this.logger.warn(
        { reconnectAttempt: this.reconnectAttempts },
        'OpenAI realtime session reconnected',
      );
      this.reconnectReady?.resolve();
      this.reconnectReady = undefined;
    }
    this.resolveReady();
  }

  /**
   * Handles a dropped or failed connection.
   *
   * Startup failures and an exhausted budget end the session. Otherwise
   * the connection-scoped state is discarded, stale audio is fenced off
   * by a generation bump, and a replacement connection is scheduled
   * inside the remaining grace window.
   */
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
    if (!this.reconnectReady) {
      this.reconnectReady = deferred<void>();
      void this.reconnectReady.promise.catch(() => undefined);
    }
    this.seeded = false;
    this.liveCallIds = new Set();
    this.generation += 1;
    this.activeResponseId = undefined;
    this.activeItemId = undefined;
    this.activeTranscript = undefined;
    this.outputBuffer = new Uint8Array(0);
    this.outputResampler.reset();
    this.inputResampler.reset();
    this.logger.warn(
      { error, reconnectAttempt: this.reconnectAttempts },
      'OpenAI realtime connection lost, reconnecting',
    );
    this.graceTimer ??= setTimeout(
      () => this.fail(new Error('OpenAI realtime reconnect window expired')),
      this.reconnectPolicy.graceMs,
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

  private handleProviderError(
    event: Extract<OpenAIServerEvent, { type: 'provider-error' }>,
  ): void {
    const details = {
      eventId: event.eventId,
      providerError: {
        type: event.error.type,
        code: event.error.code,
        message: event.error.message,
        param: event.error.param,
      },
    };
    if (event.error.code === 'response_cancel_not_active') {
      this.logger.warn(
        details,
        'OpenAI realtime cancellation raced with response completion',
      );
      return;
    }
    this.logger.warn(details, 'OpenAI realtime provider error received');
    this.fail(new Error('OpenAI realtime provider reported an error'));
  }

  private handleAudioDelta(
    event: Extract<OpenAIServerEvent, { type: 'output-audio-delta' }>,
  ): void {
    if (
      event.responseId !== undefined &&
      this.activeResponseId !== undefined &&
      event.responseId !== this.activeResponseId
    )
      return;
    if (event.itemId !== undefined) this.activeItemId = event.itemId;
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
    this.generatedMs +=
      (decoded.byteLength / 2 / OUTPUT_SAMPLE_RATE_HZ) * 1_000;
    this.outputWork = this.outputWork
      .then(() => this.emitAudio(decoded, generation))
      .catch((error: unknown) => this.fail(error));
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
      await this.outputQueue.push({
        encoding: 'pcm-s16le',
        sampleRateHz: 48_000,
        channels: 1,
        sequence: this.sequence++,
        timestampUs: this.timestampUs,
        data: frameData,
      });
      this.timestampUs += 20_000;
      this.playedMs += FRAME_DURATION_MS;
      offset += FRAME_BYTES;
    }
    if (generation === this.generation)
      this.outputBuffer = combined.slice(offset);
  }

  /**
   * Cancels the in-flight response when the caller starts speaking.
   *
   * Server-side truncation is aligned with what was actually handed to
   * the transport, so the provider's conversation and the committed
   * transcript agree on how much of the answer the caller heard.
   */
  private interrupt(): void {
    const interruptedId = this.activeResponseId;
    const playedMs = Math.round(this.playedMs);
    if (interruptedId)
      this.send({ type: 'response.cancel', response_id: interruptedId });
    if (this.activeItemId)
      this.send({
        type: 'conversation.item.truncate',
        item_id: this.activeItemId,
        content_index: 0,
        audio_end_ms: playedMs,
      });
    if (interruptedId) {
      const ratio =
        this.generatedMs > 0 ? Math.min(1, playedMs / this.generatedMs) : 0;
      this.interruptedResponse = { id: interruptedId, ratio };
      this.commitAssistantTranscript(interruptedId, true);
    }
    this.generation += 1;
    this.activeResponseId = undefined;
    this.activeItemId = undefined;
    this.outputBuffer = new Uint8Array(0);
    this.outputResampler.reset();
  }

  private handleAssistantTranscript(
    event: Extract<OpenAIServerEvent, { type: 'output-transcript-done' }>,
  ): void {
    const responseId =
      event.responseId ?? this.activeResponseId ?? this.interruptedResponse?.id;
    this.activeTranscript = event.transcript;
    if (responseId !== undefined && responseId === this.interruptedResponse?.id)
      this.commitAssistantTranscript(responseId, true);
  }

  private commitUserTranscript(eventId: string, transcript: string): void {
    if (this.committedUserTranscripts.has(eventId)) return;
    this.committedUserTranscripts.add(eventId);
    if (transcript.length === 0) return;
    this.replayLog.push({
      kind: 'conversation',
      item: userTextItem(transcript),
    });
    this.emitEvent({
      type: 'user-transcript',
      eventId,
      text: transcript,
    });
  }

  /**
   * Commits the assistant transcript exactly once per response.
   *
   * A finished response commits its full text; an interrupted response
   * commits only the fraction that matches the audio the caller actually
   * received, so canonical history never claims words nobody heard.
   */
  private commitAssistantTranscript(
    responseId: string | undefined,
    interrupted: boolean,
  ): void {
    const key = responseId ?? 'unknown-response';
    const text = this.activeTranscript;
    if (text === undefined || this.committedTranscripts.has(key)) return;
    const interruption = this.interruptedResponse;
    const ratio =
      interrupted &&
      interruption !== undefined &&
      interruption.id === responseId
        ? interruption.ratio
        : 1;
    const committed = ratio >= 1 ? text : sliceByRatio(text, ratio);
    this.committedTranscripts.add(key);
    this.activeTranscript = undefined;
    if (committed.length === 0) return;
    this.replayLog.push({
      kind: 'conversation',
      item: assistantTextItem(committed),
    });
    this.emitEvent({
      type: 'assistant-transcript',
      eventId: key,
      text: committed,
      ...(interrupted && { interrupted: true }),
    });
  }

  private handleFunctionCall(
    event: Extract<OpenAIServerEvent, { type: 'function-call-arguments-done' }>,
  ): void {
    if (this.handledToolCalls.has(event.callId)) {
      this.logger.warn(
        { toolExecutionId: event.callId },
        'Ignoring repeated OpenAI realtime tool call',
      );
      return;
    }
    this.handledToolCalls.add(event.callId);
    this.liveCallIds.add(event.callId);
    const name = event.name ?? this.functionNames.get(event.callId);
    if (name === undefined) {
      this.logger.warn(
        { toolExecutionId: event.callId },
        'OpenAI realtime tool call has no resolvable tool name',
      );
      void this.sendToolResult({
        executionId: event.callId,
        status: 'error',
        code: 'tool-not-found',
        error: 'The realtime provider did not name the requested tool.',
        retryable: false,
      });
      return;
    }
    this.functionNames.delete(event.callId);
    let input: unknown;
    try {
      input =
        event.argumentsJson.length === 0 ? {} : JSON.parse(event.argumentsJson);
    } catch {
      this.logger.warn(
        { toolExecutionId: event.callId, toolName: name },
        'OpenAI realtime tool call arguments are not valid JSON',
      );
      void this.sendToolResult({
        executionId: event.callId,
        status: 'error',
        code: 'execution-failed',
        error: 'Tool arguments were not valid JSON.',
        retryable: true,
      });
      return;
    }
    this.emitEvent({
      type: 'tool-call',
      eventId: event.eventId,
      request: {
        executionId: event.callId,
        name,
        input: toJsonValue(input),
      },
    });
  }

  /**
   * Publishes a semantic event without letting a slow consumer reorder or
   * drop provider signals: pushes are chained, so backpressure delays
   * delivery instead of losing it.
   */
  private emitEvent(event: RealtimeModelEvent): void {
    if (this.settled) return;
    this.eventWork = this.eventWork
      .then(() => (this.settled ? undefined : this.eventQueue.push(event)))
      .catch((error: unknown) => this.fail(error));
  }

  private readonly handleAbort = (): void =>
    this.settle({ type: 'closed', reason: 'aborted' });

  private send(event: object): void {
    if (this.socket.readyState !== OPEN) {
      // While reconnecting, audio is intentionally dropped and canonical
      // items are already recorded for replay.
      if (this.reconnecting) return;
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
    this.logger.warn({ error }, 'OpenAI realtime session failed');
    this.settle({ type: 'failed', error });
  }

  private settle(closure: RealtimeEndpointClosure): void {
    if (this.settled) return;
    this.settled = true;
    this.reconnecting = false;
    this.reconnectReady?.reject(
      closure.type === 'failed'
        ? closure.error
        : new Error('OpenAI realtime reconnect cancelled'),
    );
    this.reconnectReady = undefined;
    clearTimeout(this.startupTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.graceTimer);
    this.signal.removeEventListener('abort', this.handleAbort);
    if (!this.readySettled) {
      this.readySettled = true;
      this.ready.reject(
        closure.type === 'failed'
          ? closure.error
          : new Error('OpenAI realtime setup cancelled'),
      );
    }
    void this.inputMixer.close();
    const closureError = closure.type === 'failed' ? closure.error : undefined;
    this.outputQueue.close(closureError);
    this.eventQueue.close(closureError);
    if (this.socket.readyState === OPEN) this.socket.close();
    else this.socket.terminate();
    this.closure.resolve(closure);
  }
}

class OpenAIRealtimeSessionFactory implements RealtimeModelSessionFactory {
  constructor(
    private readonly config: ResolvedOpenAIRealtimeConfig,
    private readonly connect: RealtimeWebSocketConnector,
    private readonly startupTimeoutMs: number,
    private readonly reconnectPolicy: RealtimeReconnectPolicy,
    private readonly logger: ModuleLogger,
  ) {}

  async create(options: {
    signal: AbortSignal;
    context?: PreparedInferenceContext;
  }): Promise<RealtimeModelSession> {
    if (options.signal.aborted) throw options.signal.reason;
    const session = new OpenAIRealtimeSession(
      () =>
        this.connect(this.config.websocketUrl, {
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
        }),
      options.signal,
      this.startupTimeoutMs,
      this.reconnectPolicy,
      this.logger,
      options.context,
    );
    await session.waitUntilReady();
    return session;
  }
}

export function createOpenAIRealtimeProcessorFactory(options: {
  logging: RootLogger;
  config: ResolvedOpenAIRealtimeConfig;
  connect?: RealtimeWebSocketConnector;
  startupTimeoutMs?: number;
  reconnect?: Partial<RealtimeReconnectPolicy>;
}): RealtimeModelSessionFactory {
  return new OpenAIRealtimeSessionFactory(
    options.config,
    options.connect ??
      ((url, socketOptions) => new WebSocket(url, socketOptions)),
    options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    { ...DEFAULT_RECONNECT, ...options.reconnect },
    options.logging.child({
      name: 'openai-realtime',
      bindings: { module: 'openai-realtime' },
    }),
  );
}

/**
 * Truncates a transcript to the fraction of audio that was played,
 * snapping to a word boundary so the committed text stays readable.
 */
function sliceByRatio(text: string, ratio: number): string {
  if (ratio <= 0) return '';
  const cut = Math.max(1, Math.round(text.length * ratio));
  if (cut >= text.length) return text;
  const head = text.slice(0, cut);
  const boundary = head.lastIndexOf(' ');
  return (boundary > 0 ? head.slice(0, boundary) : head).trimEnd();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '"[unserializable tool result]"';
  }
}

/** Normalizes parsed tool arguments into the shared JSON value shape. */
function toJsonValue(value: unknown): JSONValue {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'object': {
      if (value === null) return null;
      if (Array.isArray(value)) return value.map(toJsonValue);
      const record: Record<string, JSONValue> = {};
      for (const [key, entry] of Object.entries(value))
        record[key] = toJsonValue(entry);
      return record;
    }
    default:
      return null;
  }
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
