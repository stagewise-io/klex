import type { ClientRequest, IncomingMessage } from 'node:http';

import type { JSONValue } from '@ai-sdk/provider';
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import WebSocket, { type ClientOptions, type RawData } from 'ws';

import type { ModuleLogger, RootLogger } from '@stagewise/logger';

import type { ResolvedOpenAILiveConfig } from '@/config';
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
import { createGPTLiveProtocolState } from './gpt-live';
import {
  buildGPTLiveSessionConfig,
  type GPTLiveSessionConfig,
} from './session-config';
import { createGPTLiveTranscriptGrouper } from './transcript-groups';
import { type GPTLiveServerEvent, parseLiveServerEvent } from './wire-events';

export interface GPTLiveWebSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(
    event: 'unexpected-response',
    listener: (request: ClientRequest, response: IncomingMessage) => void,
  ): this;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type GPTLiveWebSocketConnector = (
  url: string,
  options: ClientOptions,
) => GPTLiveWebSocket;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const tracer = trace.getTracer('klex');

const OPEN = 1;
const INPUT_SAMPLE_RATE_HZ = 48_000;
const OUTPUT_FRAME_BYTES = 480 * 2;
const OUTPUT_FRAME_DURATION_MS = 20;
const STARTUP_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;
const FINALIZATION_TIMEOUT_MS = 2_000;
const EVENT_DRAIN_TIMEOUT_MS = 2_000;
const MAX_REPLAYED_UPDATES = 256;
const MAX_AUDIO_DELTA_BYTES = 96_000;
const MAX_PENDING_OUTPUT_BYTES = 480_000;
const DEFAULT_VOICE = 'marin';
const DEFAULT_FRONTEND_INSTRUCTIONS =
  'You are Klex in a live voice conversation. Speak clearly and briefly. Delegate requests that require reasoning, business rules, or tools to the Responses backend.';

class GPTLiveSession implements RealtimeModelSession {
  private readonly outputQueue = new BoundedAsyncQueue<AudioFrame>(1);
  private readonly eventQueue = new BoundedAsyncQueue<RealtimeModelEvent>(32);
  private readonly closure = deferred<RealtimeEndpointClosure>();
  private readonly ready = deferred<void>();
  private readonly inputMixer = createPcmAudioMixer();
  private readonly inputResampler = createPcmResampler('48-to-24');
  private readonly outputResampler = createPcmResampler('24-to-48');
  private protocolState = createGPTLiveProtocolState();
  private readonly transcriptGrouper = createGPTLiveTranscriptGrouper();
  private readonly delegationResponses = new Map<string, string>();
  private readonly calls = new Map<
    string,
    { responseId: string; resultSent: boolean }
  >();
  private readonly completedResponses = new Set<string>();
  private readonly failedResponses = new Set<string>();
  private readonly continuedResponses = new Set<string>();
  private readonly delegationStartedAt = new Map<string, number>();
  private readonly inputTask: Promise<void>;
  private startupTimer: ReturnType<typeof setTimeout>;
  private outputBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private outputWork = Promise.resolve();
  private pendingOutputBytes = 0;
  private eventWork = Promise.resolve();
  private sequence = 0;
  private timestampUs = 0;
  private settled = false;
  private acceptingUpdates = true;
  private replacementAttempt = 0;
  private socketReady = false;
  private reconnectReady: Deferred<void> | undefined;
  private readonly replayedUpdates: Array<{
    readonly item: Record<string, unknown>;
    readonly requestResponse: boolean;
  }> = [];
  private recoverySafe = true;
  private providerSessionId: string | undefined;
  private usageSeconds = 0;
  private contextWindowRatio: number | undefined;
  private finalUsageConfirmed = false;
  private readySettled = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  readonly audioInputs = {
    attach: (source: AudioSource) => this.attachSource(source),
  };
  readonly audioOutput = this.outputQueue;
  readonly events = this.eventQueue;
  readonly closed = this.closure.promise;

  constructor(
    private socket: GPTLiveWebSocket,
    private readonly reconnect: () => GPTLiveWebSocket,
    private readonly sessionConfig: GPTLiveSessionConfig,
    private readonly signal: AbortSignal,
    private readonly startupTimeoutMs: number,
    private readonly logger: ModuleLogger,
    private readonly span: Span,
  ) {
    this.bindSocket(socket);
    signal.addEventListener('abort', this.handleAbort, { once: true });
    this.startupTimer = this.readinessTimer('setup');
    this.inputTask = this.consumeMixedInput();
    void this.inputTask.catch((error: unknown) => this.fail(error));
    if (signal.aborted) this.handleAbort();
  }

  waitUntilReady(): Promise<void> {
    return this.ready.promise;
  }

  async sendUpdate(update: InteractionUpdateEnvelope): Promise<void> {
    await this.ready.promise;
    if (!this.acceptingUpdates)
      throw new Error('GPT-Live session is no longer accepting updates');
    const item = {
      type: 'response.item.create',
      event_id: update.eventId,
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: renderInteractionUpdateText(update.event),
          },
        ],
      },
    };
    if (this.replayedUpdates.length >= MAX_REPLAYED_UPDATES)
      this.recoverySafe = false;
    else
      this.replayedUpdates.push({
        item,
        requestResponse: update.requestResponse,
      });
    const reconnectReady = this.reconnectReady;
    if (reconnectReady !== undefined) {
      await reconnectReady.promise;
      return;
    }
    this.send(item);
    if (update.requestResponse)
      this.send({
        type: 'response.create',
        event_id: `${update.eventId}:respond`,
      });
  }

  async sendToolResult(result: InteractionToolResult): Promise<void> {
    await this.ready.promise;
    const call = this.calls.get(result.executionId);
    if (call === undefined)
      throw new Error(`Unknown GPT-Live tool call ${result.executionId}`);
    if (call.resultSent) return;
    call.resultSent = true;
    this.logger.debug(
      {
        providerSessionId: this.providerSessionId,
        toolExecutionId: result.executionId,
        status: result.status,
      },
      'GPT-Live tool result accepted',
    );
    this.send({
      type: 'response.item.create',
      event_id: `${result.executionId}:result`,
      item: {
        type: 'function_call_output',
        call_id: result.executionId,
        output: safeStringify(result),
      },
    });
    this.continueResponseIfReady(call.responseId);
  }

  async close(): Promise<void> {
    if (this.settled || !this.acceptingUpdates)
      return this.closed.then(() => undefined);
    this.acceptingUpdates = false;
    const deadline = Date.now() + FINALIZATION_TIMEOUT_MS;
    while (
      [...this.calls.values()].some((call) => !call.resultSent) &&
      Date.now() < deadline
    )
      await delay(10);
    if ([...this.calls.values()].some((call) => !call.resultSent)) {
      this.fail(new Error('GPT-Live tool finalization timed out'));
      await this.closed;
      return;
    }
    if (this.socket.readyState === OPEN) {
      this.send({ type: 'session.close' });
      this.closeTimer ??= setTimeout(
        () => this.fail(new Error('GPT-Live close confirmation timed out')),
        CLOSE_TIMEOUT_MS,
      );
    } else {
      this.finish({ type: 'closed', reason: 'closed-before-ready' });
    }
    await this.closed;
  }

  private bindSocket(socket: GPTLiveWebSocket): void {
    socket.on('open', this.handleOpen);
    socket.on('message', this.handleMessage);
    socket.on('error', this.handleError);
    socket.on('close', this.handleSocketClose);
    socket.on('unexpected-response', this.handleUnexpectedResponse);
  }

  private readonly handleOpen = (): void => {
    if (this.settled) return;
    this.span.addEvent('gpt_live.socket_opened', {
      'gpt_live.replacement_attempt': this.replacementAttempt,
    });
    this.send({ type: 'session.start', session: this.sessionConfig });
  };

  private readonly handleMessage = (data: RawData): void => {
    if (this.settled) return;
    let event: GPTLiveServerEvent;
    try {
      event = parseLiveServerEvent(data.toString());
      this.protocolState.apply(event);
    } catch (error) {
      this.fail(error);
      return;
    }

    switch (event.type) {
      case 'session-started':
        this.providerSessionId = event.sessionId;
        this.span.addEvent('gpt_live.session_started', {
          'gpt_live.provider_session_id': event.sessionId,
          'gpt_live.replacement_attempt': this.replacementAttempt,
        });
        this.span.setAttribute('gpt_live.provider_session_id', event.sessionId);
        this.logger.info(
          {
            providerSessionId: event.sessionId,
            replacementAttempt: this.replacementAttempt,
          },
          'GPT-Live session started',
        );
        this.markReady();
        break;
      case 'session-closed':
        this.usageSeconds = event.usageSeconds;
        this.finalUsageConfirmed = true;
        this.logger.info(
          {
            providerSessionId: event.sessionId,
            usageSeconds: event.usageSeconds,
            closeReason: event.reason,
            finalUsageConfirmed: true,
          },
          'GPT-Live session closed',
        );
        this.finish({ type: 'closed', reason: event.reason });
        break;
      case 'provider-error':
        this.fail(
          new Error(
            `GPT-Live provider error ${event.error.code}: ${event.error.message}`,
          ),
        );
        break;
      case 'output-audio-delta':
        this.handleOutputAudio(event.delta);
        break;
      case 'transcript-delta':
        for (const group of this.transcriptGrouper.add(event))
          this.emitEvent({ type: 'approximate-transcript-group', ...group });
        break;
      case 'delegation-created':
        this.delegationResponses.set(event.delegationId, event.responseId);
        this.delegationStartedAt.set(event.delegationId, Date.now());
        break;
      case 'response-started':
        this.delegationResponses.set(event.delegationId, event.responseId);
        break;
      case 'response-function-call':
        this.emitToolCall(event.delegationId, event.call);
        break;
      case 'response-terminal': {
        if (event.status === 'completed')
          this.completedResponses.add(event.responseId);
        else this.failedResponses.add(event.responseId);
        const startedAt = this.delegationStartedAt.get(event.delegationId);
        this.logger.info(
          {
            providerSessionId: this.providerSessionId,
            delegationId: event.delegationId,
            responseId: event.responseId,
            delegationLatencyMs:
              startedAt === undefined ? undefined : Date.now() - startedAt,
            backendInputTokens: event.inputTokens,
            backendOutputTokens: event.outputTokens,
            status: event.status,
          },
          'GPT-Live delegated response completed',
        );
        if (event.status === 'completed')
          this.continueResponseIfReady(event.responseId);
        break;
      }
      case 'response-error': {
        const responseId = this.delegationResponses.get(event.delegationId);
        if (responseId !== undefined) this.failedResponses.add(responseId);
        this.logger.warn(
          {
            providerSessionId: this.providerSessionId,
            delegationId: event.delegationId,
            responseId,
            errorCode: event.code,
            errorMessage: event.message,
          },
          'GPT-Live delegated response failed',
        );
        break;
      }
      case 'usage-updated':
        this.usageSeconds = event.usageSeconds;
        this.contextWindowRatio = event.contextWindowRatio;
        this.logger.debug(
          {
            providerSessionId: this.providerSessionId,
            usageSeconds: this.usageSeconds,
            contextWindowRatio: this.contextWindowRatio,
          },
          'GPT-Live usage updated',
        );
        break;
      default:
        break;
    }
  };

  private readonly handleUnexpectedResponse = (
    _request: ClientRequest,
    response: IncomingMessage,
  ): void => {
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    const maxCapturedBytes = 16_384;
    response.on('data', (chunk: Buffer | string) => {
      if (capturedBytes >= maxCapturedBytes) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxCapturedBytes - capturedBytes;
      chunks.push(buffer.subarray(0, remaining));
      capturedBytes += Math.min(buffer.length, remaining);
    });
    response.once('end', () => {
      if (this.settled) return;
      const body = Buffer.concat(chunks).toString('utf8');
      const status = [response.statusCode, response.statusMessage]
        .filter(Boolean)
        .join(' ');
      const error = new Error(
        `GPT-Live handshake rejected: ${status}${body ? ` — ${body}` : ''}`,
      );
      this.span.addEvent('gpt_live.handshake_rejected', {
        'error.message': error.message,
        'gpt_live.replacement_attempt': this.replacementAttempt,
        'http.response.status_code': response.statusCode ?? 0,
        'http.response.body': body,
        'server.request_id': response.headers['x-request-id'] ?? '',
      });
      this.handleError(error);
      this.handleSocketClose();
    });
    response.once('error', this.handleError);
  };

  private readonly handleError = (error: Error): void => {
    if (this.settled) return;
    this.span.recordException(error);
    this.span.addEvent('gpt_live.socket_error', {
      'error.type': error.name,
      'error.message': error.message,
      'gpt_live.replacement_attempt': this.replacementAttempt,
    });
    this.logger.warn({ error }, 'GPT-Live socket error');
  };

  private readonly handleSocketClose = (): void => {
    if (this.settled) return;
    this.socketReady = false;
    this.span.addEvent('gpt_live.socket_closed', {
      'gpt_live.provider_session_id': this.providerSessionId ?? '',
      'gpt_live.replacement_attempt': this.replacementAttempt,
    });
    const hasAmbiguousWork = [...this.calls.values()].some(
      (call) => !call.resultSent,
    );
    if (
      this.acceptingUpdates &&
      this.replacementAttempt === 0 &&
      !hasAmbiguousWork &&
      this.recoverySafe
    ) {
      this.replacementAttempt = 1;
      this.logger.warn(
        {
          providerSessionId: this.providerSessionId,
          replacementAttempt: this.replacementAttempt,
        },
        'GPT-Live connection lost; opening replacement',
      );
      this.protocolState = createGPTLiveProtocolState();
      this.delegationResponses.clear();
      this.delegationStartedAt.clear();
      this.completedResponses.clear();
      this.failedResponses.clear();
      this.continuedResponses.clear();
      this.reconnectReady = deferred<void>();
      void this.reconnectReady.promise.catch(() => undefined);
      clearTimeout(this.startupTimer);
      this.startupTimer = this.readinessTimer('replacement setup');
      try {
        this.socket = this.reconnect();
        this.bindSocket(this.socket);
        return;
      } catch (error) {
        this.fail(error);
        return;
      }
    }
    this.fail(
      new Error(
        hasAmbiguousWork
          ? 'GPT-Live socket closed during delegated work'
          : this.recoverySafe
            ? 'GPT-Live socket closed without session.closed'
            : 'GPT-Live recovery replay limit exceeded',
      ),
    );
  };

  private readonly handleAbort = (): void => {
    if (!this.settled)
      void this.close().catch((error: unknown) => this.fail(error));
  };

  private async attachSource(source: AudioSource): Promise<void> {
    await this.ready.promise;
    if (this.settled) throw new Error('GPT-Live session is closed');
    await this.inputMixer.audioInputs.attach(source);
  }

  private async consumeMixedInput(): Promise<void> {
    for await (const frame of this.inputMixer.audioOutput) {
      if (this.settled) return;
      if (
        frame.encoding !== 'pcm-s16le' ||
        frame.sampleRateHz !== INPUT_SAMPLE_RATE_HZ ||
        frame.channels !== 1
      )
        throw new Error('GPT-Live input requires 48 kHz mono PCM16');
      if (frame.data.byteLength === 0 || frame.data.byteLength % 2 !== 0)
        throw new Error('GPT-Live input requires complete PCM16 samples');
      const audio = this.inputResampler.process(frame.data);
      if (!this.socketReady) continue;
      this.send({
        type: 'session.input_audio.append',
        audio: Buffer.from(audio).toString('base64'),
      });
    }
  }

  private handleOutputAudio(delta: string): void {
    let chunk: Uint8Array;
    try {
      chunk = Buffer.from(delta, 'base64');
      if (
        chunk.byteLength === 0 ||
        chunk.byteLength % 2 !== 0 ||
        chunk.byteLength > MAX_AUDIO_DELTA_BYTES
      )
        throw new Error('GPT-Live audio delta exceeds its PCM16 bounds');
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.pendingOutputBytes + chunk.byteLength > MAX_PENDING_OUTPUT_BYTES) {
      this.fail(new Error('GPT-Live pending output audio limit exceeded'));
      return;
    }
    this.pendingOutputBytes += chunk.byteLength;
    this.outputWork = this.outputWork
      .then(() => this.emitOutputAudio(chunk))
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.pendingOutputBytes -= chunk.byteLength;
      });
  }

  private async emitOutputAudio(chunk: Uint8Array): Promise<void> {
    this.outputBuffer = concat(this.outputBuffer, chunk);
    while (this.outputBuffer.byteLength >= OUTPUT_FRAME_BYTES) {
      const providerFrame = this.outputBuffer.slice(0, OUTPUT_FRAME_BYTES);
      this.outputBuffer = this.outputBuffer.slice(OUTPUT_FRAME_BYTES);
      const frame: AudioFrame = {
        encoding: 'pcm-s16le',
        sampleRateHz: INPUT_SAMPLE_RATE_HZ,
        channels: 1,
        sequence: this.sequence++,
        timestampUs: this.timestampUs,
        data: this.outputResampler.process(providerFrame),
      };
      this.timestampUs += OUTPUT_FRAME_DURATION_MS * 1_000;
      await this.outputQueue.push(frame);
    }
  }

  private emitToolCall(
    delegationId: string,
    call: {
      readonly callId: string;
      readonly name: string;
      readonly argumentsJson: string;
    },
  ): void {
    const responseId = this.delegationResponses.get(delegationId);
    if (responseId === undefined) {
      this.fail(new Error(`Unknown GPT-Live delegation ${delegationId}`));
      return;
    }
    const existing = this.calls.get(call.callId);
    if (existing !== undefined) {
      if (existing.responseId !== responseId)
        this.fail(
          new Error(`GPT-Live tool call ${call.callId} changed response`),
        );
      return;
    }
    this.calls.set(call.callId, { responseId, resultSent: false });
    this.logger.debug(
      {
        providerSessionId: this.providerSessionId,
        delegationId,
        responseId,
        toolExecutionId: call.callId,
      },
      'GPT-Live tool call received',
    );
    let input: JSONValue;
    try {
      input = toJsonValue(JSON.parse(call.argumentsJson));
    } catch {
      this.emitEvent({
        type: 'invalid-tool-call',
        eventId: `${delegationId}:${call.callId}`,
        result: {
          executionId: call.callId,
          status: 'error',
          code: 'invalid-input',
          error: 'Tool arguments were not valid JSON',
          retryable: false,
        },
      });
      return;
    }
    this.emitEvent({
      type: 'tool-call',
      eventId: `${delegationId}:${call.callId}`,
      request: { executionId: call.callId, name: call.name, input },
    });
  }

  private emitEvent(event: RealtimeModelEvent): void {
    this.eventWork = this.eventWork
      .then(() => this.eventQueue.push(event))
      .catch((error: unknown) => this.fail(error));
  }

  private continueResponseIfReady(responseId: string): void {
    if (
      !this.completedResponses.has(responseId) ||
      this.failedResponses.has(responseId) ||
      this.continuedResponses.has(responseId)
    )
      return;
    const calls = [...this.calls.values()].filter(
      (call) => call.responseId === responseId,
    );
    if (calls.length === 0 || calls.some((call) => !call.resultSent)) return;
    this.continuedResponses.add(responseId);
    this.send({
      type: 'response.create',
      event_id: `${responseId}:continue`,
    });
  }

  private send(event: Record<string, unknown>): void {
    if (this.settled) throw new Error('GPT-Live session is closed');
    if (this.socket.readyState !== OPEN)
      throw new Error('GPT-Live socket is not open');
    this.socket.send(JSON.stringify(event));
  }

  private markReady(): void {
    this.socketReady = true;
    clearTimeout(this.startupTimer);
    if (this.reconnectReady !== undefined) {
      this.replayUpdates();
      this.reconnectReady.resolve();
      this.reconnectReady = undefined;
    }
    if (this.readySettled) return;
    this.readySettled = true;
    this.ready.resolve();
  }

  private replayUpdates(): void {
    let requestResponse = false;
    for (const update of this.replayedUpdates) {
      this.send(update.item);
      requestResponse = requestResponse || update.requestResponse;
    }
    if (requestResponse)
      this.send({
        type: 'response.create',
        event_id: 'replayed-updates:respond',
      });
  }

  private readinessTimer(phase: string): ReturnType<typeof setTimeout> {
    return setTimeout(
      () => this.fail(new Error(`GPT-Live ${phase} timed out`)),
      this.startupTimeoutMs,
    );
  }

  private fail(error: unknown): void {
    this.logger.error({ error }, 'GPT-Live session failed');
    this.finish({ type: 'failed', error });
  }

  private finish(closure: RealtimeEndpointClosure): void {
    if (this.settled) return;
    this.settled = true;
    this.span.setAttribute('gpt_live.closure_type', closure.type);
    if (closure.type === 'failed') {
      const error = closure.error;
      this.span.recordException(error instanceof Error ? error : String(error));
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    } else {
      this.span.setAttribute('gpt_live.close_reason', closure.reason ?? '');
      this.span.setStatus({ code: SpanStatusCode.OK });
    }
    if (!this.finalUsageConfirmed)
      this.logger.warn(
        {
          providerSessionId: this.providerSessionId,
          usageSeconds: this.usageSeconds,
          contextWindowRatio: this.contextWindowRatio,
          finalUsageConfirmed: false,
          closeReason:
            closure.type === 'closed' ? closure.reason : 'session-failed',
        },
        'GPT-Live session ended without confirmed final usage',
      );
    clearTimeout(this.startupTimer);
    if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
    this.reconnectReady?.reject(
      closure.type === 'failed'
        ? closure.error
        : new Error('GPT-Live session closed during recovery'),
    );
    this.reconnectReady = undefined;
    this.signal.removeEventListener('abort', this.handleAbort);
    this.inputMixer.close();
    for (const group of this.transcriptGrouper.flush())
      this.emitEvent({ type: 'approximate-transcript-group', ...group });
    this.outputQueue.close(
      closure.type === 'failed' ? closure.error : undefined,
    );
    if (!this.readySettled) {
      this.readySettled = true;
      if (closure.type === 'failed') this.ready.reject(closure.error);
      else
        this.ready.reject(
          new Error(`GPT-Live session closed: ${closure.reason}`),
        );
    }
    if (this.socket.readyState === OPEN) this.socket.close();
    else this.socket.terminate();
    void Promise.race([this.eventWork, delay(EVENT_DRAIN_TIMEOUT_MS)]).finally(
      () => {
        this.eventQueue.close(
          closure.type === 'failed' ? closure.error : undefined,
        );
        this.closure.resolve(closure);
        this.span.end();
      },
    );
  }
}

class GPTLiveSessionFactory implements RealtimeModelSessionFactory {
  constructor(
    private readonly config: ResolvedOpenAILiveConfig,
    private readonly connect: GPTLiveWebSocketConnector,
    private readonly startupTimeoutMs: number,
    private readonly frontendInstructions: string,
    private readonly voice: string,
    private readonly logger: ModuleLogger,
  ) {}

  async create(options: {
    namespace: string;
    sessionId: string;
    signal: AbortSignal;
    context?: PreparedInferenceContext;
  }): Promise<RealtimeModelSession> {
    const endpoint = new URL(toWebSocketUrl(this.config.baseUrl));
    const span = tracer.startSpan('gpt_live.session', {
      attributes: {
        'gpt_live.external_media_session_id': options.sessionId,
        'gpt_live.namespace': options.namespace,
        'gpt_live.model': 'gpt-live-1',
        'gpt_live.responses_model': this.config.responsesModelId,
        'server.address': endpoint.hostname,
        'server.port': endpoint.port,
        'url.path': endpoint.pathname,
        'url.scheme': endpoint.protocol.slice(0, -1),
      },
    });
    let spanTransferred = false;
    try {
      if (options.context === undefined)
        throw new Error('GPT-Live requires prepared inference context');
      const prepared = buildGPTLiveSessionConfig(options.context, {
        responsesModel: this.config.responsesModelId,
        frontendInstructions: this.frontendInstructions,
        voice: this.voice,
      });
      const reconnect = () =>
        this.connect(endpoint.toString(), {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
          },
        });
      const socket = reconnect();
      const session = new GPTLiveSession(
        socket,
        reconnect,
        prepared.session,
        options.signal,
        this.startupTimeoutMs,
        this.logger,
        span,
      );
      spanTransferred = true;
      await session.waitUntilReady();
      return session;
    } catch (error) {
      if (!spanTransferred) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        span.end();
      }
      throw error;
    }
  }
}

export function createGPTLiveProcessorFactory(options: {
  logging: RootLogger;
  config: ResolvedOpenAILiveConfig;
  connect?: GPTLiveWebSocketConnector;
  startupTimeoutMs?: number;
  frontendInstructions?: string;
  voice?: string;
}): RealtimeModelSessionFactory {
  return new GPTLiveSessionFactory(
    options.config,
    options.connect ??
      ((url, socketOptions) => new WebSocket(url, socketOptions)),
    options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
    options.frontendInstructions ?? DEFAULT_FRONTEND_INSTRUCTIONS,
    options.voice ?? DEFAULT_VOICE,
    options.logging.child({
      name: 'gpt-live',
      bindings: { module: 'gpt-live' },
    }),
  );
}

function toWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/live/sessions`;
  return url.toString();
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '"[unserializable tool result]"';
  }
}

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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
