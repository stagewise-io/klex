import type { JSONValue } from '@ai-sdk/provider';
import {
  type Counter,
  type Histogram,
  type MeterProvider,
  metrics,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
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
import voiceSystemPrompt from '../system-prompt.md';
import {
  type GeminiContentTurn,
  toGeminiContentTurns,
} from './conversation-items';
import { GeminiLiveVideoInput } from './video-input';
import {
  type GeminiLiveServerEvent,
  parseGeminiLiveServerEvents,
} from './wire-events';

export interface GeminiRealtimeWebSocket {
  readonly readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type GeminiRealtimeWebSocketConnector = (
  url: string,
  options: ClientOptions,
) => GeminiRealtimeWebSocket;

/**
 * Budget for carrying one Gemini Live session across connections.
 *
 * Google resets Live connections roughly every ten minutes, so a long call
 * reconnects many times. The budget applies per outage: attempts and the
 * grace window restart after every successful reconnect.
 */
export interface GeminiLiveReconnectPolicy {
  /** Connection attempts per outage before the call fails. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Wall-clock budget for one outage, measured from the first disconnect. */
  readonly graceMs: number;
  /** Reconnect at the latest this long before a goAway deadline. */
  readonly goAwayMarginMs: number;
}

/** Test-only switches that shorten the wait for a provider reset. */
export interface GeminiLiveDebugOptions {
  /** Synthesizes a server goAway this long after each connection is ready. */
  readonly goAwayAfterMs?: number;
  /** Drops the connection this long after each connection is ready. */
  readonly dropAfterMs?: number;
}

export const GEMINI_LIVE_DEBUG_GOAWAY_ENV =
  'KLEX_DEBUG_GEMINI_LIVE_GOAWAY_AFTER_MS';
export const GEMINI_LIVE_DEBUG_DROP_ENV =
  'KLEX_DEBUG_GEMINI_LIVE_DROP_AFTER_MS';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

type ReconnectReason = 'go-away' | 'connection-lost';

/** Client input sent after the latest resumable handle was issued. */
type UnconfirmedItem =
  | {
      readonly kind: 'content';
      readonly text: string;
      readonly turnComplete: boolean;
    }
  | { readonly kind: 'tool-result'; readonly text: string };

interface CallLogEntry {
  readonly role: 'user' | 'model';
  readonly kind: 'transcript' | 'context';
  text: string;
}

interface Outage {
  readonly reason: ReconnectReason;
  readonly startedAt: number;
  readonly ready: Deferred<void>;
  readonly graceTimer: ReturnType<typeof setTimeout>;
  attempts: number;
  resumeFailures: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

interface CloseDetails {
  readonly closeCode?: number;
  readonly closeReason?: string;
}

const OPEN = 1;
/** Bounds the wait for a closing socket's close event before declaring it lost. */
const CLOSE_EVENT_TIMEOUT_MS = 2_000;
const FRAME_BYTES = 960 * 2;
const STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_POLICY: GeminiLiveReconnectPolicy = {
  maxAttempts: 5,
  initialDelayMs: 250,
  maxDelayMs: 4_000,
  graceMs: 30_000,
  goAwayMarginMs: 3_000,
};
const DEFAULT_GO_AWAY_TIME_LEFT_MS = 10_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 131_072;
/**
 * Compress at 75% of the window down to 50%. Each compression adds latency,
 * so the gap between the two is wide: at ~25 audio tokens per second it is
 * roughly 20 minutes of audio-only conversation on a 128k window.
 */
const COMPRESSION_TRIGGER_RATIO = 0.75;
const COMPRESSION_TARGET_RATIO = 0.5;
/** One second of 20 ms input frames. */
const MAX_BUFFERED_AUDIO_CHUNKS = 50;
/** Five seconds of input sent after the latest handle, replayed on resume. */
const MAX_REPLAYED_AUDIO_CHUNKS = 250;
const MAX_UNCONFIRMED_ITEMS = 256;
const MAX_CALL_LOG_ENTRIES = 400;
const MAX_CALL_LOG_CHARS = 120_000;
const MAX_RESUME_FAILURES = 2;
const REJECTED_HANDLE_CLOSE_CODES = new Set([1007, 1008]);
const REJECTED_HANDLE_PATTERN = /handle|resum/i;
/**
 * Google refuses a resume while the previous client still holds the session.
 * The handle stays valid, so this is retried rather than treated as rejected.
 */
const RESUME_CONFLICT_PATTERN = /already connected/i;
/** How long a reconnect waits for the replaced socket to finish closing. */
const PREVIOUS_SOCKET_CLOSE_TIMEOUT_MS = 1_000;
/**
 * Google keeps a session claimed briefly after its socket closes, so the
 * first resume attempt waits this long after the close to avoid an
 * "already connected" refusal and the retry it costs.
 */
const RESUME_AFTER_CLOSE_DELAY_MS = 400;

/** Node clamps longer delays to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

const tracer = trace.getTracer('klex');

interface ReconnectInstruments {
  readonly provider: MeterProvider;
  readonly reconnects: Counter;
  readonly reconnectDuration: Histogram;
  readonly goAways: Counter;
}

let instruments: ReconnectInstruments | undefined;

/** The global meter provider is installed after module load, so resolve lazily. */
function reconnectInstruments(): ReconnectInstruments {
  const provider = metrics.getMeterProvider();
  if (instruments?.provider === provider) return instruments;
  const meter = provider.getMeter('klex.realtime');
  instruments = {
    provider,
    reconnects: meter.createCounter('klex.realtime.gemini_live.reconnects', {
      description:
        'Gemini Live reconnects by trigger and outcome (resumed, fresh, failed)',
    }),
    reconnectDuration: meter.createHistogram(
      'klex.realtime.gemini_live.reconnect.duration',
      {
        unit: 'ms',
        description: 'Time from losing a Gemini Live connection to a ready one',
      },
    ),
    goAways: meter.createCounter('klex.realtime.gemini_live.go_aways', {
      description: 'Gemini Live goAway notices by source (server, debug)',
    }),
  };
  return instruments;
}

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
  private readonly pendingToolCalls = new Set<string>();
  private readonly callLog: CallLogEntry[] = [];
  private callLogChars = 0;
  private liveCallIds = new Set<string>();
  private socket: GeminiRealtimeWebSocket | undefined;
  private socketClosed: Promise<void> = Promise.resolve();
  private connectionToken = 0;
  private connectionCount = 0;
  private connectionReady = false;
  /** Handle the current connection was opened with, if any. */
  private connectionHandle: string | undefined;
  private resumptionHandle: string | undefined;
  /** True while no model output or client input followed the latest handle. */
  private handleCurrent = false;
  private unconfirmed: UnconfirmedItem[] = [];
  private outage: Outage | undefined;
  private attemptTimer: ReturnType<typeof setTimeout> | undefined;
  private goAwayPending = false;
  private goAwayTimer: ReturnType<typeof setTimeout> | undefined;
  private closeEventTimer: ReturnType<typeof setTimeout> | undefined;
  private debugTimers: ReturnType<typeof setTimeout>[] = [];
  private audioBacklog: string[] = [];
  private audioSinceHandle: string[] = [];
  private droppedAudioChunks = 0;
  private modelTurnActive = false;
  private awaitingResponse = false;
  private outputBuffer = new Uint8Array(0);
  private outputWork = Promise.resolve();
  private sequence = 0;
  private timestampUs = 0;
  private activeTranscript: string | undefined;
  private generation = 0;
  private seeded = false;
  private settled = false;
  private readySettled = false;
  private readonly startupTimer: ReturnType<typeof setTimeout>;

  readonly audioInputs = {
    attach: (source: AudioSource) => this.attachSource(source),
  };
  readonly audioOutput = this.outputQueue;
  readonly videoInput: GeminiLiveVideoInput | undefined;
  readonly events = this.eventQueue;
  readonly closed = this.closure.promise;

  constructor(
    private readonly connect: () => GeminiRealtimeWebSocket,
    private readonly signal: AbortSignal,
    private readonly startupTimeoutMs: number,
    private readonly logger: ModuleLogger,
    private readonly context: PreparedInferenceContext | undefined,
    private readonly config: ResolvedGeminiLiveConfig,
    private readonly span: Span,
    private readonly reconnectPolicy: GeminiLiveReconnectPolicy = DEFAULT_RECONNECT_POLICY,
    private readonly debug: GeminiLiveDebugOptions = {},
    video = false,
  ) {
    this.videoInput = video
      ? new GeminiLiveVideoInput({
          sendFrame: (message) => this.sendLive(message),
          sendDescription: (text) => this.sendVideoDescription(text),
          isModelSpeaking: () => this.modelTurnActive,
          isResponseOwed: () => this.awaitingResponse,
        })
      : undefined;
    this.startupTimer = setTimeout(
      () => this.fail(new Error('Gemini live setup timed out')),
      startupTimeoutMs,
    );
    signal.addEventListener('abort', this.handleAbort, { once: true });
    this.inputTask = this.consumeMixedInput();
    void this.inputTask.catch((error: unknown) => this.fail(error));
    if (signal.aborted) this.handleAbort();
    else this.openConnection();
  }

  waitUntilReady(): Promise<void> {
    return this.ready.promise;
  }

  /**
   * Opens a connection stamped with a fresh token.
   *
   * The socket contract has no listener removal, so every handler checks its
   * token: events from a replaced connection are ignored.
   */
  private openConnection(): void {
    if (this.settled) return;
    const token = ++this.connectionToken;
    this.connectionReady = false;
    this.connectionHandle = this.resumptionHandle;
    this.connectionCount += 1;
    if (this.outage)
      this.attemptTimer = setTimeout(
        () =>
          this.handleConnectionLoss(
            token,
            new Error('Gemini live reconnect setup timed out'),
          ),
        this.startupTimeoutMs,
      );
    let socket: GeminiRealtimeWebSocket;
    try {
      socket = this.connect();
    } catch (error) {
      this.handleConnectionLoss(token, error);
      return;
    }
    this.socket = socket;
    const closed = deferred<void>();
    this.socketClosed = closed.promise;
    socket.on('close', () => closed.resolve());
    socket.on('open', () => this.handleOpen(token));
    socket.on('message', (data: RawData) => this.handleMessage(token, data));
    socket.on('error', (error: Error) =>
      this.handleConnectionLoss(token, error),
    );
    socket.on('close', (code: number, reason: Buffer) => {
      if (token !== this.connectionToken || this.settled) return;
      const closeReason = reason.toString();
      this.span.addEvent('gemini_live.socket_closed', {
        'gemini_live.close_code': code,
        'gemini_live.connection': this.connectionCount,
        ...(closeReason && { 'gemini_live.close_reason': closeReason }),
      });
      this.handleConnectionLoss(
        token,
        new Error(
          `Gemini live connection closed unexpectedly (code ${code}${closeReason ? `: ${closeReason}` : ''})`,
        ),
        { closeCode: code, closeReason },
      );
    });
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
    const data = Buffer.from(this.inputResampler.process(frame.data)).toString(
      'base64',
    );
    this.audioSinceHandle.push(data);
    if (this.audioSinceHandle.length > MAX_REPLAYED_AUDIO_CHUNKS)
      this.audioSinceHandle.shift();
    if (!this.outage && this.sendLive(audioMessage(data))) return;
    this.audioBacklog.push(data);
    if (this.audioBacklog.length > MAX_BUFFERED_AUDIO_CHUNKS) {
      this.audioBacklog.shift();
      this.droppedAudioChunks += 1;
    }
  }

  async sendUpdate(update: InteractionUpdateEnvelope): Promise<void> {
    if (this.settled) return;
    const text = renderInteractionUpdateText(update.event);
    if (!text.trim()) return;
    this.appendCallLog('user', 'context', text);
    this.trackUnconfirmed({
      kind: 'content',
      text,
      turnComplete: update.requestResponse,
    });
    if (update.requestResponse) this.awaitingResponse = true;
    const outage = this.outage;
    if (outage) {
      await outage.ready.promise.catch(() => undefined);
      return;
    }
    this.sendLive(textContent(text, update.requestResponse));
  }

  /** Video notes are call context, so resumes replay and restarts reseed them. */
  private sendVideoDescription(text: string): void {
    if (this.settled) return;
    this.appendCallLog('user', 'context', text);
    this.trackUnconfirmed({ kind: 'content', text, turnComplete: false });
    this.sendLive(textContent(text, false));
  }

  async sendToolResult(result: InteractionToolResult): Promise<void> {
    if (this.settled) return;
    this.pendingToolCalls.delete(result.executionId);
    const name =
      this.functionNames.get(result.executionId) ?? result.executionId;
    const responsePayload =
      result.status === 'success'
        ? { result: result.output ?? {} }
        : { error: result.error ?? 'Tool execution failed', code: result.code };
    const text = toolResultText(result.executionId, name, responsePayload);
    this.appendCallLog('user', 'context', text);
    this.trackUnconfirmed({ kind: 'tool-result', text });
    this.awaitingResponse = true;
    const outage = this.outage;
    if (outage) {
      await outage.ready.promise.catch(() => undefined);
      return;
    }
    // A call issued by a replaced connection is unknown to the current one,
    // so its result is delivered as context instead of a dangling reference.
    if (this.liveCallIds.delete(result.executionId))
      this.sendLive({
        toolResponse: {
          functionResponses: [
            {
              id: result.executionId,
              name,
              response: responsePayload,
            },
          ],
        },
      });
    else this.sendLive(textContent(text, true));
    this.maybeReconnectForGoAway();
  }

  async close(): Promise<void> {
    this.settle({ type: 'closed', reason: 'local-close' });
  }

  private handleOpen(token: number): void {
    if (token !== this.connectionToken || this.settled) return;
    const tools = this.context?.tools ?? [];
    this.span.addEvent('gemini_live.socket_opened', {
      'gemini_live.connection': this.connectionCount,
      'gemini_live.resuming': this.connectionHandle !== undefined,
    });
    const model = this.config.modelId.startsWith('models/')
      ? this.config.modelId
      : `models/${this.config.modelId}`;
    const setupMessage = {
      setup: {
        model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          ...(this.config.voiceId !== undefined && {
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: this.config.voiceId },
              },
            },
          }),
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: contextWindowCompression(
          this.context?.model.contextSize,
        ),
        sessionResumption:
          this.connectionHandle !== undefined
            ? { handle: this.connectionHandle }
            : {},
        systemInstruction: {
          parts: [
            {
              text: this.context?.instructions ?? voiceSystemPrompt,
            },
          ],
        },
        ...(tools.length > 0 && {
          tools: [
            {
              functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                ...(tool.description !== undefined && {
                  description: tool.description,
                }),
                parametersJsonSchema: tool.inputSchema,
              })),
            },
          ],
        }),
      },
    };
    this.span.addEvent('gemini_live.setup_sent', {
      'gemini_live.tool_count': tools.length,
      'gemini_live.connection': this.connectionCount,
    });
    this.sendOn(token, setupMessage);
  }

  private seedConversation(token: number): void {
    if (this.seeded) return;
    this.seeded = true;
    const turns = toGeminiContentTurns(this.context?.messages ?? []);
    if (turns.length > 0) {
      this.sendOn(token, {
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

  private handleMessage(token: number, raw: RawData): void {
    if (token !== this.connectionToken || this.settled) return;
    let events: GeminiLiveServerEvent[];
    try {
      events = parseGeminiLiveServerEvents(raw.toString());
    } catch (error) {
      this.fail(error);
      return;
    }
    for (const event of events) {
      if (token !== this.connectionToken || this.settled) return;
      switch (event.type) {
        case 'setup-complete':
          this.handleSetupComplete(token);
          break;
        case 'provider-error': {
          this.span.addEvent('gemini_live.provider_error', {
            'error.message': event.error.message ?? 'Unknown error',
          });
          this.logger.warn(
            { error: event.error, connection: this.connectionCount },
            'Gemini live provider error received',
          );
          const error = new Error(
            `Gemini live provider error: ${event.error.message ?? 'Unknown error'}`,
          );
          // During a reconnect the error answers our setup, typically a
          // rejected resumption handle; the outage logic decides what's next.
          if (this.outage && !this.connectionReady)
            this.handleConnectionLoss(token, error, {
              ...(event.error.message !== undefined && {
                closeReason: event.error.message,
              }),
            });
          else this.fail(error);
          return;
        }
        case 'interrupted':
          this.modelTurnActive = false;
          this.interrupt();
          this.videoInput?.modelIdle();
          break;
        case 'input-transcript':
          this.handleCurrent = false;
          this.appendCallLog('user', 'transcript', event.transcript);
          void this.eventQueue.push({
            type: 'user-transcript',
            eventId: `gemini-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: event.transcript,
          });
          break;
        case 'output-transcript':
          this.markModelOutput();
          this.activeTranscript =
            (this.activeTranscript ?? '') + event.transcript;
          break;
        case 'output-audio-delta': {
          if (!this.connectionReady) this.handleSetupComplete(token, true);
          this.markModelOutput();
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
          this.modelTurnActive = false;
          this.awaitingResponse = false;
          this.finishAssistantTranscript(false);
          this.videoInput?.modelIdle();
          break;
        case 'tool-call':
          this.markModelOutput();
          for (const call of event.calls) {
            this.functionNames.set(call.callId, call.name);
            this.liveCallIds.add(call.callId);
            this.pendingToolCalls.add(call.callId);
            this.appendCallLog(
              'model',
              'context',
              `<tool-call call-id="${call.callId}" name="${call.name}">${safeStringify(call.args)}</tool-call>`,
            );
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
          for (const id of event.ids) this.pendingToolCalls.delete(id);
          this.maybeReconnectForGoAway();
          break;
        case 'session-resumption-update':
          if (event.resumable && event.newHandle !== undefined) {
            this.resumptionHandle = event.newHandle;
            this.handleCurrent = true;
            this.unconfirmed = [];
            this.audioSinceHandle = [];
            this.maybeReconnectForGoAway();
          }
          break;
        case 'go-away':
          this.handleGoAway(event.timeLeftMs, 'server');
          break;
        case 'ignored':
          break;
      }
    }
  }

  private markModelOutput(): void {
    this.modelTurnActive = true;
    this.awaitingResponse = false;
    this.handleCurrent = false;
  }

  /**
   * Completes the handshake of the first or a replacement connection.
   * `modelSpeaking` marks setup implied by model audio arriving first.
   */
  private handleSetupComplete(token: number, modelSpeaking = false): void {
    if (this.connectionReady || token !== this.connectionToken) return;
    this.connectionReady = true;
    clearTimeout(this.attemptTimer);
    this.attemptTimer = undefined;
    this.span.addEvent('gemini_live.setup_completed', {
      'gemini_live.connection': this.connectionCount,
    });
    const outage = this.outage;
    if (!outage) {
      this.seedConversation(token);
      this.resolveReady();
      this.armDebugTimers(token);
      this.videoInput?.connectionReady({ flushDescriptions: !modelSpeaking });
      return;
    }
    this.outage = undefined;
    clearTimeout(outage.graceTimer);
    clearTimeout(outage.retryTimer);
    const resumed = this.connectionHandle !== undefined;
    // Gap audio must precede anything that completes a turn, or the model
    // starts answering before it heard the caller.
    let replayedItems: number;
    let bufferedAudioChunks: number;
    if (resumed) {
      bufferedAudioChunks = this.flushAudioBacklog(token, true);
      replayedItems = this.replayUnconfirmed(token);
    } else {
      const seed = this.freshSessionSeed();
      if (seed.history.length > 0)
        this.sendOn(token, {
          clientContent: { turns: seed.history, turnComplete: false },
        });
      bufferedAudioChunks = this.flushAudioBacklog(token, false);
      if (seed.pending.length > 0)
        this.sendOn(token, {
          clientContent: { turns: seed.pending, turnComplete: true },
        });
      replayedItems = seed.history.length + seed.pending.length;
    }
    const durationMs = Date.now() - outage.startedAt;
    const outcome = resumed ? 'resumed' : 'fresh';
    const metric = reconnectInstruments();
    metric.reconnects.add(1, { reason: outage.reason, outcome });
    metric.reconnectDuration.record(durationMs, {
      reason: outage.reason,
      outcome,
    });
    this.span.addEvent('gemini_live.reconnected', {
      'gemini_live.reconnect.reason': outage.reason,
      'gemini_live.reconnect.outcome': outcome,
      'gemini_live.reconnect.attempts': outage.attempts,
      'gemini_live.reconnect.duration_ms': durationMs,
      'gemini_live.connection': this.connectionCount,
    });
    this.logger.info(
      {
        reason: outage.reason,
        outcome,
        attempts: outage.attempts,
        durationMs,
        replayedItems,
        bufferedAudioChunks,
        droppedAudioChunks: this.droppedAudioChunks,
        connection: this.connectionCount,
      },
      resumed
        ? 'Gemini live session resumed'
        : 'Gemini live session restarted without resumption',
    );
    this.droppedAudioChunks = 0;
    this.armDebugTimers(token);
    // After gap audio and replay, so the frame lands in the current turn.
    this.videoInput?.connectionReady({ flushDescriptions: !modelSpeaking });
    outage.ready.resolve();
  }

  /**
   * Resends client input the server may not have folded into the resumed
   * state. Tool results become context: the resumed state predates the call.
   */
  private replayUnconfirmed(token: number): number {
    if (this.unconfirmed.length === 0) return 0;
    this.sendOn(token, {
      clientContent: {
        turns: this.unconfirmed.map((item) => ({
          role: 'user',
          parts: [{ text: item.text }],
        })),
        turnComplete: this.unconfirmed.some(
          (item) => item.kind === 'tool-result' || item.turnComplete,
        ),
      },
    });
    return this.unconfirmed.length;
  }

  /**
   * Rebuilds a new provider session from canonical history plus this call.
   * When a response is still owed, the user input since the last model turn
   * is split off so it can complete the turn after the gap audio.
   */
  private freshSessionSeed(): {
    history: GeminiContentTurn[];
    pending: GeminiContentTurn[];
  } {
    this.unconfirmed = [];
    this.audioSinceHandle = [];
    const callTurns: GeminiContentTurn[] = this.callLog.map((entry) => ({
      role: entry.role,
      parts: [{ text: entry.text }],
    }));
    let split = callTurns.length;
    if (this.awaitingResponse)
      while (split > 0 && callTurns[split - 1]?.role === 'user') split -= 1;
    return {
      history: [
        ...toGeminiContentTurns(this.context?.messages ?? []),
        ...callTurns.slice(0, split),
      ],
      pending: callTurns.slice(split),
    };
  }

  /**
   * Sends input captured during the outage. A resumed state predates
   * everything since its handle, so that audio is replayed too; the gap
   * backlog is its tail and is not sent twice.
   */
  private flushAudioBacklog(token: number, resumed: boolean): number {
    const audio = resumed ? this.audioSinceHandle : this.audioBacklog;
    this.audioBacklog = [];
    for (const data of audio) this.sendOn(token, audioMessage(data));
    return audio.length;
  }

  private handleGoAway(
    timeLeftMs: number | undefined,
    source: 'server' | 'debug',
  ): void {
    if (this.settled || this.goAwayPending || this.outage) return;
    this.goAwayPending = true;
    const timeLeft = timeLeftMs ?? DEFAULT_GO_AWAY_TIME_LEFT_MS;
    const reconnectDeadlineMs = Math.max(
      0,
      timeLeft - this.reconnectPolicy.goAwayMarginMs,
    );
    reconnectInstruments().goAways.add(1, { source });
    this.span.addEvent('gemini_live.go_away', {
      'gemini_live.go_away.time_left_ms': timeLeft,
      'gemini_live.go_away.source': source,
    });
    this.logger.info(
      {
        source,
        timeLeftMs: timeLeft,
        reconnectDeadlineMs,
        hasResumptionHandle: this.resumptionHandle !== undefined,
        connection: this.connectionCount,
      },
      'Gemini live goAway received, reconnecting at the next resumable point',
    );
    this.goAwayTimer = setTimeout(() => {
      if (!this.outage) this.startReconnect('go-away');
    }, reconnectDeadlineMs);
    this.maybeReconnectForGoAway();
  }

  /**
   * Switches connections early once nothing would be lost: no model turn or
   * tool call in flight, and a handle newer than the last exchanged content.
   */
  private maybeReconnectForGoAway(): void {
    if (
      this.goAwayPending &&
      !this.outage &&
      !this.modelTurnActive &&
      this.pendingToolCalls.size === 0 &&
      this.handleCurrent
    )
      this.startReconnect('go-away');
  }

  private handleConnectionLoss(
    token: number,
    error: unknown,
    details: CloseDetails = {},
  ): void {
    if (token !== this.connectionToken || this.settled) return;
    if (!this.readySettled) {
      this.fail(error);
      return;
    }
    const outage = this.outage;
    if (
      outage &&
      !this.connectionReady &&
      this.connectionHandle !== undefined
    ) {
      if (resumeConflict(details)) {
        this.logger.warn(
          { error, ...details, connection: this.connectionCount },
          'Gemini live resume conflicted with the previous connection, retrying',
        );
        this.startReconnect('connection-lost', error, details);
        return;
      }
      outage.resumeFailures += 1;
      if (
        rejectsHandle(details) ||
        outage.resumeFailures >= MAX_RESUME_FAILURES
      ) {
        this.resumptionHandle = undefined;
        this.span.addEvent('gemini_live.resumption_rejected');
        this.logger.warn(
          {
            error,
            ...details,
            resumeFailures: outage.resumeFailures,
            connection: this.connectionCount,
          },
          'Gemini live resumption handle rejected, falling back to a fresh session',
        );
      }
    }
    this.startReconnect('connection-lost', error, details);
  }

  /**
   * Fences off the current connection and schedules a replacement.
   *
   * The first call opens an outage with its own grace window; each failed
   * attempt backs off exponentially until the attempt cap ends the call.
   */
  private startReconnect(
    reason: ReconnectReason,
    error?: unknown,
    details: CloseDetails = {},
  ): void {
    if (this.settled) return;
    const previous = this.socket;
    const previousClosed = this.socketClosed;
    this.socket = undefined;
    this.connectionToken += 1;
    this.connectionReady = false;
    this.videoInput?.connectionLost();
    this.goAwayPending = false;
    clearTimeout(this.goAwayTimer);
    clearTimeout(this.attemptTimer);
    clearTimeout(this.closeEventTimer);
    this.closeEventTimer = undefined;
    this.clearDebugTimers();
    closeSocket(previous);
    if (!this.outage) {
      const ready = deferred<void>();
      void ready.promise.catch(() => undefined);
      this.outage = {
        reason,
        startedAt: Date.now(),
        ready,
        attempts: 0,
        resumeFailures: 0,
        graceTimer: setTimeout(
          () =>
            this.failReconnect(
              new Error('Gemini live reconnect window expired'),
            ),
          this.reconnectPolicy.graceMs,
        ),
      };
      // Audio already received keeps playing; only the turn bookkeeping of
      // the lost connection is closed out.
      this.modelTurnActive = false;
      this.liveCallIds = new Set();
      this.finishAssistantTranscript(true);
      this.span.addEvent('gemini_live.reconnect_started', {
        'gemini_live.reconnect.reason': reason,
        'gemini_live.connection': this.connectionCount,
      });
      const fields = {
        reason,
        hasResumptionHandle: this.resumptionHandle !== undefined,
        pendingToolCalls: this.pendingToolCalls.size,
        connection: this.connectionCount,
        ...details,
      };
      if (reason === 'go-away')
        this.logger.info(fields, 'Gemini live reconnecting before goAway');
      else
        this.logger.warn(
          { ...fields, error },
          'Gemini live connection lost, reconnecting',
        );
    }
    const outage = this.outage;
    if (outage.attempts >= this.reconnectPolicy.maxAttempts) {
      this.failReconnect(
        new Error(
          `Gemini live reconnect failed after ${outage.attempts} attempts`,
          { cause: error },
        ),
      );
      return;
    }
    const delayMs =
      outage.attempts === 0 && reason === 'go-away'
        ? 0
        : Math.min(
            this.reconnectPolicy.maxDelayMs,
            this.reconnectPolicy.initialDelayMs * 2 ** outage.attempts,
          );
    outage.attempts += 1;
    const resume = this.resumptionHandle !== undefined;
    const settleMs =
      resume && previous && outage.attempts === 1
        ? RESUME_AFTER_CLOSE_DELAY_MS
        : 0;
    this.logger.info(
      {
        reason: outage.reason,
        attempt: outage.attempts,
        maxAttempts: this.reconnectPolicy.maxAttempts,
        delayMs,
        settleMs,
        resume,
      },
      'Gemini live reconnect attempt scheduled',
    );
    const scheduledToken = this.connectionToken;
    const closeWait = this.waitForClose(previous, previousClosed).then(() =>
      settleMs > 0 && this.resumptionHandle !== undefined
        ? new Promise<void>((resolve) => setTimeout(resolve, settleMs))
        : undefined,
    );
    outage.retryTimer = setTimeout(() => {
      void closeWait.then(() => {
        if (this.connectionToken === scheduledToken && this.outage === outage)
          this.openConnection();
      });
    }, delayMs);
  }

  /**
   * Resolves once the replaced socket has closed, so the resumed connection
   * doesn't race the old client for the provider session.
   */
  private async waitForClose(
    socket: GeminiRealtimeWebSocket | undefined,
    closed: Promise<void>,
  ): Promise<void> {
    if (!socket) return;
    if (await closesWithin(closed, PREVIOUS_SOCKET_CLOSE_TIMEOUT_MS)) return;
    this.logger.warn(
      { timeoutMs: PREVIOUS_SOCKET_CLOSE_TIMEOUT_MS },
      'Gemini live previous connection did not close in time, terminating it',
    );
    try {
      socket.terminate();
    } catch {
      // A socket that fails to terminate is already unusable.
    }
    await closesWithin(closed, PREVIOUS_SOCKET_CLOSE_TIMEOUT_MS);
  }

  private failReconnect(error: Error): void {
    if (this.settled) return;
    const outage = this.outage;
    if (outage) {
      reconnectInstruments().reconnects.add(1, {
        reason: outage.reason,
        outcome: 'failed',
      });
      this.span.addEvent('gemini_live.reconnect_failed', {
        'gemini_live.reconnect.reason': outage.reason,
        'gemini_live.reconnect.attempts': outage.attempts,
      });
    }
    this.fail(error);
  }

  private armDebugTimers(token: number): void {
    const { goAwayAfterMs, dropAfterMs } = this.debug;
    if (goAwayAfterMs !== undefined)
      this.debugTimers.push(
        setTimeout(() => {
          if (token === this.connectionToken)
            this.handleGoAway(DEFAULT_GO_AWAY_TIME_LEFT_MS, 'debug');
        }, goAwayAfterMs),
      );
    if (dropAfterMs !== undefined)
      this.debugTimers.push(
        setTimeout(
          () =>
            this.handleConnectionLoss(
              token,
              new Error(
                `Simulated Gemini live connection drop (${GEMINI_LIVE_DEBUG_DROP_ENV})`,
              ),
            ),
          dropAfterMs,
        ),
      );
  }

  private clearDebugTimers(): void {
    for (const timer of this.debugTimers) clearTimeout(timer);
    this.debugTimers = [];
  }

  private trackUnconfirmed(item: UnconfirmedItem): void {
    this.handleCurrent = false;
    this.unconfirmed.push(item);
    // Without fresh handles a resume would lose too much; start fresh instead.
    if (this.unconfirmed.length > MAX_UNCONFIRMED_ITEMS) {
      this.unconfirmed = [];
      this.resumptionHandle = undefined;
    }
  }

  private appendCallLog(
    role: CallLogEntry['role'],
    kind: CallLogEntry['kind'],
    text: string,
  ): void {
    const last = this.callLog.at(-1);
    if (
      kind === 'transcript' &&
      last?.kind === 'transcript' &&
      last.role === role
    )
      last.text += text;
    else this.callLog.push({ role, kind, text });
    this.callLogChars += text.length;
    const newest = this.callLog.at(-1);
    if (newest && newest.text.length > MAX_CALL_LOG_CHARS) {
      this.callLogChars -= newest.text.length - MAX_CALL_LOG_CHARS;
      newest.text = newest.text.slice(-MAX_CALL_LOG_CHARS);
    }
    while (
      this.callLog.length > 1 &&
      (this.callLog.length > MAX_CALL_LOG_ENTRIES ||
        this.callLogChars > MAX_CALL_LOG_CHARS)
    )
      this.callLogChars -= this.callLog.shift()?.text.length ?? 0;
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

  private finishAssistantTranscript(interrupted: boolean): void {
    const text = this.activeTranscript;
    if (!text) return;
    this.activeTranscript = undefined;
    this.appendCallLog('model', 'context', text);
    void this.eventQueue.push({
      type: 'assistant-transcript',
      eventId: `gemini-asst-${interrupted ? 'interrupted-' : ''}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      ...(interrupted && { interrupted: true }),
    });
  }

  private interrupt(): void {
    this.generation += 1;
    this.outputBuffer = new Uint8Array(0);
    this.outputResampler.reset();
    this.outputQueue.clear({ discardPendingWriters: true });
    this.finishAssistantTranscript(true);
  }

  private readonly handleAbort = (): void =>
    this.settle({ type: 'closed', reason: 'aborted' });

  /** Sends on the current connection once its setup completed. */
  private sendLive(event: object): boolean {
    if (!this.connectionReady) return false;
    return this.sendOn(this.connectionToken, event);
  }

  private sendOn(token: number, event: object): boolean {
    if (token !== this.connectionToken || this.settled) return false;
    const socket = this.socket;
    if (socket && socket.readyState > OPEN) {
      this.awaitCloseEvent(token);
      return false;
    }
    if (socket?.readyState !== OPEN) {
      this.handleConnectionLoss(
        token,
        new Error('Gemini live connection is not open'),
      );
      return false;
    }
    socket.send(JSON.stringify(event));
    return true;
  }

  /**
   * A provider close moves the socket to closing before its close event
   * arrives. Writes in between are dropped so the provider's close code and
   * reason, not a failed write, end the connection.
   */
  private awaitCloseEvent(token: number): void {
    if (this.closeEventTimer !== undefined) return;
    this.closeEventTimer = setTimeout(() => {
      this.closeEventTimer = undefined;
      this.handleConnectionLoss(
        token,
        new Error('Gemini live connection closed without a close event'),
      );
    }, CLOSE_EVENT_TIMEOUT_MS);
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
    clearTimeout(this.attemptTimer);
    clearTimeout(this.goAwayTimer);
    clearTimeout(this.closeEventTimer);
    this.clearDebugTimers();
    const outage = this.outage;
    this.outage = undefined;
    if (outage) {
      clearTimeout(outage.graceTimer);
      clearTimeout(outage.retryTimer);
      outage.ready.reject(
        closure.type === 'failed'
          ? closure.error
          : new Error('Gemini live session closed'),
      );
    }
    this.audioBacklog = [];
    this.audioSinceHandle = [];
    if (this.videoInput) {
      const { framesSent, framesResent } = this.videoInput.stats();
      this.span.setAttributes({
        'gemini_live.video.frames_sent': framesSent,
        'gemini_live.video.frames_resent': framesResent,
      });
      this.videoInput.close();
    }
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
    closeSocket(this.socket);
    this.socket = undefined;
    this.span.setAttribute('gemini_live.connections', this.connectionCount);
    if (closure.type === 'failed') {
      this.span.recordException(
        closure.error instanceof Error ? closure.error : String(closure.error),
      );
      this.span.setStatus({
        code: SpanStatusCode.ERROR,
        message:
          closure.error instanceof Error
            ? closure.error.message
            : String(closure.error),
      });
    } else {
      if (closure.reason !== undefined)
        this.span.setAttribute('gemini_live.close_reason', closure.reason);
      this.span.setStatus({ code: SpanStatusCode.OK });
    }
    this.span.end();
    this.closure.resolve(closure);
  }
}

export class GeminiLiveSessionFactory implements RealtimeModelSessionFactory {
  constructor(
    private readonly config: ResolvedGeminiLiveConfig,
    private readonly connect: GeminiRealtimeWebSocketConnector,
    private readonly startupTimeoutMs: number,
    private readonly logger: ModuleLogger,
    private readonly reconnectPolicy: GeminiLiveReconnectPolicy = DEFAULT_RECONNECT_POLICY,
    private readonly debug: GeminiLiveDebugOptions = {},
    private readonly video = false,
  ) {}

  async create(options: {
    namespace?: string;
    sessionId?: string;
    signal: AbortSignal;
    context?: PreparedInferenceContext;
  }): Promise<RealtimeModelSession> {
    if (options.signal.aborted) throw options.signal.reason;
    const endpoint = new URL(this.config.websocketUrl);
    const span = tracer.startSpan('gemini_live.session', {
      attributes: {
        ...(options.sessionId !== undefined && {
          'gemini_live.external_media_session_id': options.sessionId,
        }),
        ...(options.namespace !== undefined && {
          'gemini_live.namespace': options.namespace,
        }),
        'gemini_live.model': this.config.modelId,
        'server.address': endpoint.hostname,
        'server.port': endpoint.port,
        'url.path': endpoint.pathname,
        'url.scheme': endpoint.protocol.slice(0, -1),
      },
    });
    if (
      this.debug.goAwayAfterMs !== undefined ||
      this.debug.dropAfterMs !== undefined
    )
      this.logger.warn(
        { ...this.debug },
        'Gemini live debug connection resets are enabled',
      );
    let spanTransferred = false;
    try {
      const session = new GeminiLiveSession(
        () => this.connect(this.config.websocketUrl, {}),
        options.signal,
        this.startupTimeoutMs,
        this.logger,
        options.context,
        this.config,
        span,
        this.reconnectPolicy,
        this.debug,
        this.video,
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

export function createGeminiLiveProcessorFactory(options: {
  logging: RootLogger;
  config: ResolvedGeminiLiveConfig;
  connect?: GeminiRealtimeWebSocketConnector;
  startupTimeoutMs?: number;
  reconnectPolicy?: Partial<GeminiLiveReconnectPolicy>;
  debug?: GeminiLiveDebugOptions;
  /** Enables the video lane; only for models that accept image input. */
  video?: boolean;
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
    { ...DEFAULT_RECONNECT_POLICY, ...options.reconnectPolicy },
    options.debug ?? geminiLiveDebugOptionsFromEnv(process.env),
    options.video ?? false,
  );
}

export function geminiLiveDebugOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): GeminiLiveDebugOptions {
  const goAwayAfterMs = positiveMs(env[GEMINI_LIVE_DEBUG_GOAWAY_ENV]);
  const dropAfterMs = positiveMs(env[GEMINI_LIVE_DEBUG_DROP_ENV]);
  return {
    ...(goAwayAfterMs !== undefined && { goAwayAfterMs }),
    ...(dropAfterMs !== undefined && { dropAfterMs }),
  };
}

function positiveMs(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_MS
    ? parsed
    : undefined;
}

export function contextWindowCompression(contextSize: number | undefined): {
  triggerTokens: number;
  slidingWindow: { targetTokens: number };
} {
  const windowTokens =
    contextSize !== undefined && contextSize > 0
      ? contextSize
      : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return {
    triggerTokens: Math.floor(windowTokens * COMPRESSION_TRIGGER_RATIO),
    slidingWindow: {
      targetTokens: Math.floor(windowTokens * COMPRESSION_TARGET_RATIO),
    },
  };
}

function rejectsHandle(details: CloseDetails): boolean {
  return (
    (details.closeCode !== undefined &&
      REJECTED_HANDLE_CLOSE_CODES.has(details.closeCode)) ||
    (details.closeReason !== undefined &&
      REJECTED_HANDLE_PATTERN.test(details.closeReason))
  );
}

async function closesWithin(
  closed: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

function resumeConflict(details: CloseDetails): boolean {
  return (
    details.closeReason !== undefined &&
    RESUME_CONFLICT_PATTERN.test(details.closeReason)
  );
}

function audioMessage(data: string): object {
  return {
    realtimeInput: {
      audio: { data, mimeType: 'audio/pcm;rate=24000' },
    },
  };
}

function textContent(text: string, turnComplete: boolean): object {
  return {
    clientContent: {
      turns: [{ role: 'user', parts: [{ text }] }],
      turnComplete,
    },
  };
}

function toolResultText(
  callId: string,
  name: string,
  response: Record<string, unknown>,
): string {
  return `<tool-result call-id="${callId}" name="${name}">${safeStringify(response)}</tool-result>`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}

function closeSocket(socket: GeminiRealtimeWebSocket | undefined): void {
  if (!socket) return;
  try {
    if (socket.readyState === OPEN) socket.close();
    else socket.terminate();
  } catch {
    // A socket that fails to close is already unusable.
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
