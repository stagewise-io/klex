import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { AudioFrame, AudioSource } from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';
import type { SessionInboxEvent } from '@/session/inbox';
import type { PreparedInferenceContext } from '@/session/interaction';

import type { RealtimeModelSession } from '../model-session';
import {
  contextWindowCompression,
  createGeminiLiveProcessorFactory,
  type GeminiLiveDebugOptions,
  type GeminiLiveReconnectPolicy,
  type GeminiRealtimeWebSocket,
  geminiLiveDebugOptionsFromEnv,
} from './gemini-live-session';
import { parseGeminiLiveServerEvents } from './wire-events';

interface WireMessage {
  readonly setup?: {
    readonly sessionResumption?: unknown;
    readonly contextWindowCompression?: unknown;
    readonly tools?: readonly {
      readonly functionDeclarations: readonly { readonly name: string }[];
    }[];
  };
  readonly clientContent?: {
    readonly turns: readonly {
      readonly role: string;
      readonly parts: readonly { readonly text?: string }[];
    }[];
    readonly turnComplete: boolean;
  };
  readonly realtimeInput?: { readonly audio: { readonly mimeType: string } };
  readonly toolResponse?: unknown;
}

/** One WebSocket of the fake Gemini Live server. */
class FakeGeminiSocket extends EventEmitter implements GeminiRealtimeWebSocket {
  readyState = 0;
  readonly sent: WireMessage[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', 1000, Buffer.from('')));
  });
  terminate = vi.fn(() => {
    this.readyState = 3;
  });
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  message(event: object): void {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
  drop(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
  get setup(): NonNullable<WireMessage['setup']> {
    return this.sent[0]?.setup ?? {};
  }
  after(index: number): WireMessage[] {
    return this.sent.slice(index);
  }
}

const info = vi.fn();
const warn = vi.fn();
const debug = vi.fn();
const logging = {
  child: () => ({ info, warn, debug }),
} as unknown as RootLogger;

const policy: Partial<GeminiLiveReconnectPolicy> = {
  maxAttempts: 3,
  initialDelayMs: 1,
  maxDelayMs: 2,
  graceMs: 5_000,
  goAwayMarginMs: 0,
};

function context(
  override: Partial<PreparedInferenceContext> = {},
): PreparedInferenceContext {
  return {
    model: {
      modelId: 'gemini-3.8-live',
      contextSize: 100_000,
      inputCapabilities: {},
    },
    instructions: 'You are Klex Gemini.',
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather for a city',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    messages: [{ role: 'user', content: 'Earlier canonical message' }],
    historyRevision: 1,
    updateWatermark: 0,
    ...override,
  };
}

function frame(): AudioFrame {
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 48_000,
    channels: 1,
    sequence: 0,
    timestampUs: 0,
    data: new Uint8Array(960 * 2),
  };
}

function update(text: string, requestResponse = false) {
  return {
    sequence: 1,
    eventId: `evt-${text}`,
    requestResponse,
    event: {
      context: {
        sourceEnv: 'system',
        metadata: {},
        content: [{ type: 'text', text }],
      },
    } as unknown as SessionInboxEvent,
  };
}

const handleUpdate = (newHandle: string) => ({
  sessionResumptionUpdate: { newHandle, resumable: true },
});

async function start(options: { debug?: GeminiLiveDebugOptions } = {}) {
  const sockets: FakeGeminiSocket[] = [];
  const factory = createGeminiLiveProcessorFactory({
    logging,
    config: {
      modelId: 'gemini-3.8-live',
      apiKey: 'test-google-key',
      websocketUrl: 'wss://example.test/gemini-live',
    },
    connect: () => {
      const socket = new FakeGeminiSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectPolicy: policy,
    debug: options.debug ?? {},
  });
  const promise = factory.create({
    namespace: 'test',
    sessionId: 'session',
    signal: new AbortController().signal,
    context: context(),
  });
  sockets[0]?.open();
  sockets[0]?.message({ setupComplete: {} });
  const processor = await promise;
  const input = new BoundedAsyncQueue<AudioFrame>(4);
  const source: AudioSource = {
    id: 'microphone',
    metadata: { participantId: 'caller', trackId: 'microphone' },
    readable: input,
    closed: new Promise(() => undefined),
  };
  await processor.audioInputs.attach(source);
  return { sockets, processor, input };
}

async function nextSocket(
  sockets: FakeGeminiSocket[],
  index: number,
): Promise<FakeGeminiSocket> {
  await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(index));
  const socket = sockets[index];
  if (!socket) throw new Error('missing socket');
  return socket;
}

function texts(messages: WireMessage[]): (string | undefined)[] {
  return messages.flatMap(
    (message) =>
      message.clientContent?.turns.flatMap((turn) =>
        turn.parts.map((part) => part.text),
      ) ?? [],
  );
}

let processorUnderTest: RealtimeModelSession | undefined;

afterEach(async () => {
  await processorUnderTest?.close();
  processorUnderTest = undefined;
  info.mockClear();
  warn.mockClear();
  debug.mockClear();
});

describe('Gemini live session durability', () => {
  it('configures sliding-window compression and session resumption', async () => {
    const { sockets, processor } = await start();
    processorUnderTest = processor;
    expect(sockets[0]?.setup.contextWindowCompression).toEqual({
      triggerTokens: 75_000,
      slidingWindow: { targetTokens: 50_000 },
    });
    expect(sockets[0]?.setup.sessionResumption).toEqual({});
    expect(contextWindowCompression(undefined)).toEqual({
      triggerTokens: 98_304,
      slidingWindow: { targetTokens: 65_536 },
    });
  });

  it('resumes on goAway with the latest handle and keeps tools, history, and audio', async () => {
    const { sockets, processor, input } = await start();
    processorUnderTest = processor;
    const first = sockets[0] as FakeGeminiSocket;
    first.message(handleUpdate('handle-1'));
    first.message(handleUpdate('handle-2'));
    first.message({ goAway: { timeLeft: '30s' } });

    const second = await nextSocket(sockets, 1);
    expect(first.close).toHaveBeenCalled();
    await input.push(frame());
    second.open();
    expect(second.setup.sessionResumption).toEqual({ handle: 'handle-2' });
    expect(second.setup.tools?.[0]?.functionDeclarations[0]?.name).toBe(
      'get_weather',
    );
    expect(second.setup.contextWindowCompression).toBeDefined();
    // Let the mixer emit the frame while the setup is still pending.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(second.sent).toHaveLength(1);
    second.message({ setupComplete: {} });

    // Resumed state already holds canonical history: nothing is reseeded,
    // and audio captured during the switch is flushed.
    expect(texts(second.after(1))).toEqual([]);
    expect(second.sent.at(-1)?.realtimeInput?.audio.mimeType).toBe(
      'audio/pcm;rate=24000',
    );
    const flushed = second.sent.filter((message) => message.realtimeInput);
    await input.push(frame());
    await vi.waitFor(() =>
      expect(
        second.sent.filter((message) => message.realtimeInput).length,
      ).toBeGreaterThan(flushed.length),
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'go-away', outcome: 'resumed' }),
      'Gemini live session resumed',
    );
    await expect(
      Promise.race([processor.closed, Promise.resolve('open')]),
    ).resolves.toBe('open');
  });

  it('waits for an in-flight model turn and a fresh handle before acting on goAway', async () => {
    const { sockets, processor } = await start();
    processorUnderTest = processor;
    const first = sockets[0] as FakeGeminiSocket;
    first.message(handleUpdate('handle-1'));
    first.message({
      serverContent: { outputTranscription: { text: 'Speaking' } },
    });
    first.message({ goAway: { timeLeft: '30s' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets).toHaveLength(1);

    first.message({ serverContent: { turnComplete: true } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets).toHaveLength(1);

    first.message(handleUpdate('handle-after-turn'));
    const second = await nextSocket(sockets, 1);
    second.open();
    expect(second.setup.sessionResumption).toEqual({
      handle: 'handle-after-turn',
    });
  });

  it('reconnects by the goAway deadline even when no resumable point arrives', async () => {
    const { sockets, processor } = await start();
    processorUnderTest = processor;
    const first = sockets[0] as FakeGeminiSocket;
    first.message(handleUpdate('handle-1'));
    first.message({
      serverContent: { outputTranscription: { text: 'Long answer' } },
    });
    first.message({ goAway: { timeLeft: '0.02s' } });
    const second = await nextSocket(sockets, 1);
    second.open();
    expect(second.setup.sessionResumption).toEqual({ handle: 'handle-1' });
  });

  it('survives a mid-call drop and replays input the resumed state may lack', async () => {
    const { sockets, processor } = await start();
    processorUnderTest = processor;
    const events = processor.events[Symbol.asyncIterator]();
    const first = sockets[0] as FakeGeminiSocket;
    first.message(handleUpdate('handle-1'));
    await processor.sendUpdate(update('Sent after the handle'));
    first.message({
      toolCall: {
        functionCalls: [{ id: 'call-1', name: 'get_weather', args: {} }],
      },
    });
    await events.next();

    first.drop(1011, 'Internal error');
    const second = await nextSocket(sockets, 1);
    const pendingUpdate = processor.sendUpdate(update('Sent during the gap'));
    const pendingResult = processor.sendToolResult({
      executionId: 'call-1',
      status: 'success',
      output: { temperature: 18 },
    });
    second.open();
    expect(second.setup.sessionResumption).toEqual({ handle: 'handle-1' });
    second.message({ setupComplete: {} });
    await Promise.all([pendingUpdate, pendingResult]);

    const replayed = second.after(1);
    expect(texts(replayed)).toEqual([
      expect.stringContaining('Sent after the handle'),
      expect.stringContaining('Sent during the gap'),
      expect.stringContaining('<tool-result call-id="call-1"'),
    ]);
    // The call belongs to the lost connection, so no raw toolResponse.
    expect(replayed.some((message) => message.toolResponse)).toBe(false);
    expect(replayed.at(-1)?.clientContent?.turnComplete).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'connection-lost', closeCode: 1011 }),
      'Gemini live connection lost, reconnecting',
    );
  });

  it('falls back to a fresh session seeded with history and the call so far when the handle is rejected', async () => {
    const { sockets, processor } = await start();
    processorUnderTest = processor;
    const first = sockets[0] as FakeGeminiSocket;
    first.message({
      serverContent: { inputTranscription: { text: 'What is ' } },
    });
    first.message({
      serverContent: { inputTranscription: { text: 'the weather?' } },
    });
    first.message({
      serverContent: {
        outputTranscription: { text: 'Sunny in Berlin.' },
        turnComplete: true,
      },
    });
    first.message(handleUpdate('expired-handle'));
    first.drop();

    const second = await nextSocket(sockets, 1);
    second.open();
    expect(second.setup.sessionResumption).toEqual({
      handle: 'expired-handle',
    });
    second.drop(1008, 'Invalid session resumption handle');

    const third = await nextSocket(sockets, 2);
    third.open();
    expect(third.setup.sessionResumption).toEqual({});
    third.message({ setupComplete: {} });
    const seed = third.sent[1]?.clientContent;
    expect(seed?.turnComplete).toBe(false);
    expect(seed?.turns).toEqual([
      { role: 'user', parts: [{ text: 'Earlier canonical message' }] },
      { role: 'user', parts: [{ text: 'What is the weather?' }] },
      { role: 'model', parts: [{ text: 'Sunny in Berlin.' }] },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ closeCode: 1008 }),
      'Gemini live resumption handle rejected, falling back to a fresh session',
    );
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'fresh' }),
      'Gemini live session restarted without resumption',
    );
  });

  it('treats a provider error answering a resumed setup as a rejected handle', async () => {
    const { sockets, processor } = await start();
    processorUnderTest = processor;
    sockets[0]?.message(handleUpdate('handle-1'));
    sockets[0]?.drop();
    const second = await nextSocket(sockets, 1);
    second.open();
    second.message({
      error: { code: 400, message: 'Session handle not found' },
    });
    const third = await nextSocket(sockets, 2);
    third.open();
    expect(third.setup.sessionResumption).toEqual({});
  });

  it('ends the call after the retry cap', async () => {
    const { sockets, processor } = await start();
    sockets[0]?.message(handleUpdate('handle-1'));
    sockets[0]?.drop();
    for (let index = 1; index <= 3; index += 1) {
      const socket = await nextSocket(sockets, index);
      socket.drop(1011, 'Unavailable');
    }
    const closure = await processor.closed;
    expect(closure.type).toBe('failed');
    expect(closure.type === 'failed' && String(closure.error)).toContain(
      'reconnect failed after 3 attempts',
    );
    expect(sockets).toHaveLength(4);
    // A later stale event must not reopen anything.
    sockets[0]?.message(handleUpdate('late'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets).toHaveLength(4);
  });

  it('can force goAway and drops through debug options', async () => {
    const { sockets, processor } = await start({
      debug: { goAwayAfterMs: 5 },
    });
    processorUnderTest = processor;
    sockets[0]?.message(handleUpdate('handle-1'));
    const second = await nextSocket(sockets, 1);
    second.open();
    expect(second.setup.sessionResumption).toEqual({ handle: 'handle-1' });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'debug' }),
      'Gemini live goAway received, reconnecting at the next resumable point',
    );

    const dropping = await start({ debug: { dropAfterMs: 5 } });
    const reopened = await nextSocket(dropping.sockets, 1);
    reopened.open();
    reopened.message({ setupComplete: {} });
    await dropping.processor.close();
  });
});

describe('Gemini live durability wire events and debug flags', () => {
  it('parses goAway durations and resumption updates', () => {
    expect(
      parseGeminiLiveServerEvents(
        JSON.stringify({ goAway: { timeLeft: '12.5s' } }),
      ),
    ).toEqual([{ type: 'go-away', timeLeftMs: 12_500 }]);
    expect(
      parseGeminiLiveServerEvents(
        JSON.stringify({ goAway: { timeLeft: { seconds: '3', nanos: 5e8 } } }),
      ),
    ).toEqual([{ type: 'go-away', timeLeftMs: 3_500 }]);
    expect(parseGeminiLiveServerEvents(JSON.stringify({ goAway: {} }))).toEqual(
      [{ type: 'go-away' }],
    );
    expect(
      parseGeminiLiveServerEvents(
        JSON.stringify({ sessionResumptionUpdate: { resumable: false } }),
      ),
    ).toEqual([{ type: 'session-resumption-update', resumable: false }]);
    expect(
      parseGeminiLiveServerEvents(
        JSON.stringify({
          sessionResumptionUpdate: { resumable: true, newHandle: 'h' },
        }),
      ),
    ).toEqual([
      { type: 'session-resumption-update', resumable: true, newHandle: 'h' },
    ]);
  });

  it('reads debug flags from the environment', () => {
    expect(
      geminiLiveDebugOptionsFromEnv({
        KLEX_DEBUG_GEMINI_LIVE_GOAWAY_AFTER_MS: '60000',
        KLEX_DEBUG_GEMINI_LIVE_DROP_AFTER_MS: 'soon',
      }),
    ).toEqual({ goAwayAfterMs: 60_000 });
    expect(geminiLiveDebugOptionsFromEnv({})).toEqual({});
  });
});
