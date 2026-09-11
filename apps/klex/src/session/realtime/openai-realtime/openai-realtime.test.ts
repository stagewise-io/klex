import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { AudioFrame, AudioSource } from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';
import { SessionInboxUrgency } from '@/session/inbox';
import type { PreparedInferenceContext } from '@/session/interaction';

import {
  createOpenAIRealtimeProcessorFactory,
  type RealtimeReconnectPolicy,
  type RealtimeWebSocket,
} from './openai-realtime';

class FakeSocket extends EventEmitter implements RealtimeWebSocket {
  readyState = 0;
  sent: string[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
  });
  terminate = vi.fn(() => {
    this.readyState = 3;
  });
  send(data: string): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  message(event: object): void {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}

const warn = vi.fn();
const debug = vi.fn();
const logging = {
  child: () => ({ warn, debug }),
} as unknown as RootLogger;

const config = {
  modelId: 'gpt-realtime-test',
  apiKey: 'secret-test-key',
  websocketUrl: 'wss://example.test/v1/realtime?model=gpt-realtime-test',
  voice: 'marin',
  instructions: 'Answer briefly.',
  serverVad: { threshold: 0.6 },
};

function frame(sampleCount = 960): AudioFrame {
  const data = new Uint8Array(sampleCount * 2);
  const view = new DataView(data.buffer);
  for (let index = 0; index < sampleCount; index += 1)
    view.setInt16(index * 2, index % 100, true);
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 48_000,
    channels: 1,
    sequence: 0,
    timestampUs: 0,
    data,
  };
}

const preparedContext: PreparedInferenceContext = {
  instructions: 'You are Klex, on a call.',
  messages: [
    { role: 'user', content: 'Remind me about the deploy.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Deploy is queued.' },
        {
          type: 'tool-call',
          toolCallId: 'call-history',
          toolName: 'list_deploys',
          input: { limit: 1 },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-history',
          toolName: 'list_deploys',
          output: { type: 'json', value: { deploys: 1 } },
        },
      ],
    },
  ],
  tools: [
    {
      name: 'send_message',
      description: 'Send a message.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
      },
    },
  ],
  model: {
    modelId: 'gpt-realtime-test',
    contextSize: 128_000,
    inputCapabilities: {},
  },
  historyRevision: 4,
  updateWatermark: 2,
};

async function setup(
  startupTimeoutMs = 1_000,
  context?: PreparedInferenceContext,
) {
  const socket = new FakeSocket();
  let authorization: string | undefined;
  const factory = createOpenAIRealtimeProcessorFactory({
    logging,
    config,
    startupTimeoutMs,
    // Reconnection is opt-in per test so unexpected closes stay terminal.
    reconnect: { maxAttempts: 0 },
    connect: (_url, options) => {
      authorization = options.headers?.Authorization as string;
      return socket;
    },
  });
  const controller = new AbortController();
  const promise = factory.create({
    namespace: 'test',
    sessionId: 'session',
    signal: controller.signal,
    ...(context && { context }),
  });
  return { socket, promise, controller, authorization: () => authorization };
}

async function activate(context?: PreparedInferenceContext) {
  const harness = await setup(1_000, context);
  harness.socket.open();
  const update = JSON.parse(harness.socket.sent[0] ?? '{}');
  harness.socket.message({ type: 'session.updated' });
  return { ...harness, update, processor: await harness.promise };
}

function source(
  queue: BoundedAsyncQueue<AudioFrame>,
  id = 'microphone',
): AudioSource {
  return {
    id,
    metadata: { participantId: `caller-${id}`, trackId: id },
    readable: queue,
    closed: new Promise(() => undefined),
  };
}

const flush = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const inboxEvent = {
  eventId: 'update-1',
  sourceEnv: 'telegram',
  urgency: SessionInboxUrgency.Default,
  context: {
    sourceEnv: 'telegram',
    metadata: { chatId: '7' },
    content: [{ type: 'text' as const, text: 'Anna: are we live?' }],
  },
};

/**
 * Harness that hands out a fresh socket per connection attempt so a
 * reconnect can be observed end to end.
 */
async function setupReconnecting(
  reconnect: Partial<RealtimeReconnectPolicy>,
  context = preparedContext,
) {
  const sockets: FakeSocket[] = [];
  const factory = createOpenAIRealtimeProcessorFactory({
    logging,
    config,
    startupTimeoutMs: 1_000,
    reconnect,
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  const controller = new AbortController();
  const promise = factory.create({
    namespace: 'test',
    sessionId: 'session',
    signal: controller.signal,
    context,
  });
  const handshake = (socket: FakeSocket) => {
    socket.open();
    socket.message({ type: 'session.updated' });
  };
  const drop = (socket: FakeSocket) => {
    socket.readyState = 3;
    socket.emit('close');
  };
  const socketAt = (index: number) => {
    const socket = sockets[index];
    if (!socket) throw new Error(`socket ${index} was never created`);
    return socket;
  };
  handshake(socketAt(0));
  return {
    sockets,
    socketAt,
    controller,
    handshake,
    drop,
    processor: await promise,
  };
}

function sent(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent.map((entry) => JSON.parse(entry));
}

function pcm24(sampleCount: number, value = 1_000): string {
  const samples = new Int16Array(sampleCount);
  samples.fill(value);
  return Buffer.from(samples.buffer).toString('base64');
}

describe('OpenAI realtime processor', () => {
  afterEach(() => vi.useRealTimers());

  it('authenticates, configures PCM and waits for readiness', async () => {
    const harness = await setup();
    expect(harness.authorization()).toBe('Bearer secret-test-key');
    let settled = false;
    void harness.promise.then(() => {
      settled = true;
    });
    harness.socket.open();
    await Promise.resolve();
    expect(settled).toBe(false);
    const update = JSON.parse(harness.socket.sent[0] ?? '{}');
    expect(update.session.audio.input.format.rate).toBe(24_000);
    expect(update.session.audio.input.turn_detection).toMatchObject({
      type: 'server_vad',
      create_response: true,
      interrupt_response: true,
      threshold: 0.5,
    });
    harness.socket.message({ type: 'session.updated' });
    await expect(harness.promise).resolves.toBeDefined();
  });

  it('downsamples input and packetizes fragmented response audio', async () => {
    vi.useFakeTimers();
    const { socket, processor } = await activate();
    const input = new BoundedAsyncQueue<AudioFrame>(1);
    await processor.audioInputs.attach(source(input));
    await input.push(frame());
    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(1));
    const append = JSON.parse(socket.sent.at(-1) ?? '{}');
    expect(Buffer.from(append.audio, 'base64')).toHaveLength(960);

    socket.message({
      type: 'response.created',
      response: { id: 'response-1' },
    });
    const audio24 = Buffer.alloc(480 * 2, 1).toString('base64');
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'response-1',
      item_id: 'item-1',
      delta: audio24,
    });
    const output = await processor.audioOutput[Symbol.asyncIterator]().next();
    expect(output.value).toMatchObject({
      sampleRateHz: 48_000,
      channels: 1,
      sequence: 0,
      timestampUs: 0,
    });
    expect(output.value?.data).toHaveLength(1_920);
    await processor.close();
  });

  it('mixes concurrent inputs and keeps remaining sources active', async () => {
    vi.useFakeTimers();
    const { socket, processor } = await activate();
    const first = new BoundedAsyncQueue<AudioFrame>(1);
    const second = new BoundedAsyncQueue<AudioFrame>(1);
    await processor.audioInputs.attach(source(first, 'first'));
    await processor.audioInputs.attach(source(second, 'second'));
    const constant = (value: number): AudioFrame => {
      const data = new Uint8Array(960 * 2);
      const view = new DataView(data.buffer);
      for (let index = 0; index < 960; index += 1)
        view.setInt16(index * 2, value, true);
      return { ...frame(), data };
    };

    await Promise.all([
      first.push(constant(1_000)),
      second.push(constant(2_000)),
    ]);
    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(1));
    const mixedAppend = JSON.parse(socket.sent.at(-1) ?? '{}');
    const mixed = Buffer.from(mixedAppend.audio, 'base64');
    expect(mixed.readInt16LE(mixed.byteLength - 2)).toBe(3_000);

    first.close();
    await second.push(constant(2_000));
    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(2));
    const remainingAppend = JSON.parse(socket.sent.at(-1) ?? '{}');
    const remaining = Buffer.from(remainingAppend.audio, 'base64');
    expect(remaining.readInt16LE(remaining.byteLength - 2)).toBe(2_000);
    let closed = false;
    void processor.closed.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await processor.close();
  });

  it('fails when an attached source fails', async () => {
    const { processor } = await activate();
    const input = new BoundedAsyncQueue<AudioFrame>(1);
    await processor.audioInputs.attach(source(input));
    const failure = new Error('input source failed');
    input.close(failure);
    await expect(processor.closed).resolves.toMatchObject({
      type: 'failed',
      error: failure,
    });
  });

  it('serializes adjacent response deltas while output is backpressured', async () => {
    const { socket, processor } = await activate();
    const output = processor.audioOutput[Symbol.asyncIterator]();
    socket.message({
      type: 'response.created',
      response: { id: 'response-1' },
    });
    const first = new Int16Array(960);
    const second = new Int16Array(480);
    first.fill(1_000);
    second.fill(2_000);
    for (const audio of [first, second]) {
      socket.message({
        type: 'response.output_audio.delta',
        response_id: 'response-1',
        item_id: 'item-1',
        delta: Buffer.from(audio.buffer).toString('base64'),
      });
    }

    const firstFrame = await output.next();
    const secondFrame = await output.next();
    const thirdFrame = await output.next();
    expect([
      firstFrame.value,
      secondFrame.value,
      thirdFrame.value,
    ]).toMatchObject([
      { sequence: 0, timestampUs: 0 },
      { sequence: 1, timestampUs: 20_000 },
      { sequence: 2, timestampUs: 40_000 },
    ]);
    const secondSamples = new Int16Array(
      secondFrame.value?.data.buffer,
      secondFrame.value?.data.byteOffset,
      (secondFrame.value?.data.byteLength ?? 0) / 2,
    );
    const thirdSamples = new Int16Array(
      thirdFrame.value?.data.buffer,
      thirdFrame.value?.data.byteOffset,
      (thirdFrame.value?.data.byteLength ?? 0) / 2,
    );
    expect(secondSamples.at(-1)).toBe(1_000);
    expect(thirdSamples[1]).toBe(2_000);
    await processor.close();
  });

  it('cancels active output and suppresses stale response deltas', async () => {
    const { socket, processor } = await activate();
    socket.message({
      type: 'response.created',
      response: { id: 'response-1' },
    });
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'response-1',
      item_id: 'item-1',
      delta: Buffer.alloc(100).toString('base64'),
    });
    socket.message({ type: 'input_audio_buffer.speech_started' });
    expect(socket.sent.map((item) => JSON.parse(item).type)).toEqual(
      expect.arrayContaining(['response.cancel', 'conversation.item.truncate']),
    );
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'response-1',
      delta: Buffer.alloc(960).toString('base64'),
    });
    await processor.close();
    expect(await processor.closed).toMatchObject({ type: 'closed' });
  });

  it('logs sanitized provider error details before failing', async () => {
    warn.mockClear();
    const { socket, processor } = await activate();
    socket.message({
      type: 'error',
      event_id: 'event-1',
      error: {
        type: 'invalid_request_error',
        code: 'invalid_value',
        message: 'Invalid truncation request',
        param: 'audio_end_ms',
        ignored: 'not logged',
      },
    });
    await expect(processor.closed).resolves.toMatchObject({ type: 'failed' });
    expect(warn).toHaveBeenCalledWith(
      {
        eventId: 'event-1',
        providerError: {
          type: 'invalid_request_error',
          code: 'invalid_value',
          message: 'Invalid truncation request',
          param: 'audio_end_ms',
        },
      },
      'OpenAI realtime provider error received',
    );
  });

  it('keeps the session active when cancellation races with completion', async () => {
    warn.mockClear();
    const { socket, processor } = await activate();
    let closed = false;
    void processor.closed.then(() => {
      closed = true;
    });
    socket.message({
      type: 'error',
      event_id: 'event-race',
      error: {
        type: 'invalid_request_error',
        code: 'response_cancel_not_active',
        message: 'Cancellation failed: no active response found',
      },
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-race',
        providerError: expect.objectContaining({
          code: 'response_cancel_not_active',
        }),
      }),
      'OpenAI realtime cancellation raced with response completion',
    );
    await processor.close();
    expect(await processor.closed).toMatchObject({ type: 'closed' });
  });

  it('fails on provider errors and malformed consumed events', async () => {
    for (const event of [
      { type: 'error', error: { message: 'secret provider detail' } },
      { type: 'response.output_audio.delta', delta: 42 },
    ]) {
      const { socket, processor } = await activate();
      socket.message(event);
      await expect(processor.closed).resolves.toMatchObject({ type: 'failed' });
    }
  });

  it('surfaces tool calls and returns tool results to the conversation', async () => {
    const { socket, processor } = await activate(preparedContext);
    const events = processor.events[Symbol.asyncIterator]();
    socket.message({ type: 'response.created', response: { id: 'r-1' } });
    socket.message({
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'call-1', name: 'send_message' },
    });
    socket.message({
      type: 'response.function_call_arguments.done',
      event_id: 'event-call',
      call_id: 'call-1',
      arguments: '{"text":"hi"}',
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'tool-call',
        eventId: 'event-call',
        request: {
          executionId: 'call-1',
          name: 'send_message',
          input: { text: 'hi' },
        },
      },
    });

    await processor.sendToolResult({
      executionId: 'call-1',
      status: 'success',
      output: { ok: true },
    });
    const tail = sent(socket).slice(-2);
    expect(tail).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{"ok":true}',
        },
      },
      { type: 'response.create' },
    ]);
    await processor.close();
  });

  it('answers unusable tool calls locally instead of failing the call', async () => {
    const { socket, processor } = await activate(preparedContext);
    socket.message({
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'call-2', name: 'send_message' },
    });
    socket.message({
      type: 'response.function_call_arguments.done',
      call_id: 'call-2',
      arguments: 'not json',
    });
    await flush();
    const output = sent(socket)
      .filter((event) => event.type === 'conversation.item.create')
      .at(-1);
    expect(output).toMatchObject({
      item: { type: 'function_call_output', call_id: 'call-2' },
    });
    const item = (output?.item ?? {}) as Record<string, unknown>;
    expect(JSON.parse(String(item.output ?? '{}'))).toMatchObject({
      code: 'execution-failed',
      retryable: true,
    });
    let closed = false;
    void processor.closed.then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    await processor.close();
  });

  it('injects inbox updates and only requests a response when asked', async () => {
    const { socket, processor } = await activate(preparedContext);
    const before = socket.sent.length;
    const event = {
      eventId: 'update-1',
      sourceEnv: 'telegram',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'telegram',
        metadata: { chatId: '7' },
        content: [{ type: 'text' as const, text: 'Anna: are we live?' }],
      },
    };
    await processor.sendUpdate({
      sequence: 1,
      eventId: 'update-1',
      event,
      requestResponse: false,
    });
    expect(sent(socket).slice(before)).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<context source-env="telegram"><metadata>{"chatId":"7"}</metadata><content>Anna: are we live?</content></context>',
            },
          ],
        },
      },
    ]);

    await processor.sendUpdate({
      sequence: 2,
      eventId: 'update-2',
      event,
      requestResponse: true,
    });
    expect(sent(socket).at(-1)).toEqual({ type: 'response.create' });
    await processor.close();
  });

  it('emits caller and assistant transcripts as semantic events', async () => {
    const { socket, processor } = await activate(preparedContext);
    const events = processor.events[Symbol.asyncIterator]();
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'event-user',
      item_id: 'item-user',
      transcript: 'Ship it please.',
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'user-transcript',
        eventId: 'event-user',
        text: 'Ship it please.',
      },
    });

    socket.message({ type: 'response.created', response: { id: 'r-1' } });
    socket.message({
      type: 'response.output_audio_transcript.done',
      event_id: 'event-assistant',
      response_id: 'r-1',
      item_id: 'item-1',
      transcript: 'Shipping now.',
    });
    socket.message({ type: 'response.done', response: { id: 'r-1' } });
    const assistant = await events.next();
    expect(assistant.value).toEqual({
      type: 'assistant-transcript',
      eventId: 'r-1',
      text: 'Shipping now.',
    });
    await processor.close();
  });

  it('truncates an interrupted answer to the audio the caller heard', async () => {
    const { socket, processor } = await activate(preparedContext);
    const events = processor.events[Symbol.asyncIterator]();
    socket.message({ type: 'response.created', response: { id: 'r-1' } });
    // Two 20 ms deltas generated, one 20 ms frame handed to the transport.
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'r-1',
      item_id: 'item-1',
      delta: pcm24(480),
    });
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'r-1',
      item_id: 'item-1',
      delta: pcm24(480),
    });
    await flush();
    socket.message({
      type: 'response.output_audio_transcript.done',
      event_id: 'event-assistant',
      response_id: 'r-1',
      item_id: 'item-1',
      transcript: 'one two three four',
    });
    socket.message({ type: 'input_audio_buffer.speech_started' });

    const truncate = sent(socket).find(
      (event) => event.type === 'conversation.item.truncate',
    );
    expect(truncate).toMatchObject({ item_id: 'item-1', audio_end_ms: 20 });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: 'assistant-transcript',
        eventId: 'r-1',
        text: 'one two',
        interrupted: true,
      },
    });

    // A late response.done must not commit the same transcript twice.
    socket.message({ type: 'response.done', response: { id: 'r-1' } });
    await flush();
    await processor.close();
    await expect(events.next()).resolves.toMatchObject({ done: true });
  });

  it('configures instructions, tools and transcription from the prepared context', async () => {
    const { update } = await activate(preparedContext);
    expect(update.session.instructions).toBe('You are Klex, on a call.');
    expect(update.session.audio.input.transcription).toEqual({
      model: 'gpt-4o-mini-transcribe',
    });
    expect(update.session.tool_choice).toBe('auto');
    expect(update.session.tools).toEqual([
      {
        type: 'function',
        name: 'send_message',
        description: 'Send a message.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
        },
      },
    ]);
  });

  it('seeds canonical history in order before readiness resolves', async () => {
    const { socket, processor } = await activate(preparedContext);
    const items = sent(socket)
      .filter((event) => event.type === 'conversation.item.create')
      .map((event) => event.item);
    expect(items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Remind me about the deploy.' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Deploy is queued.' }],
      },
      {
        type: 'function_call',
        call_id: 'call-history',
        name: 'list_deploys',
        arguments: '{"limit":1}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-history',
        output: '{"deploys":1}',
      },
    ]);

    socket.message({ type: 'session.updated' });
    expect(
      sent(socket).filter((event) => event.type === 'conversation.item.create'),
    ).toHaveLength(4);
    await processor.close();
  });

  it('times out setup and handles abort before open', async () => {
    const timeout = await setup(5);
    await expect(timeout.promise).rejects.toThrow('timed out');
    const aborted = await setup();
    aborted.controller.abort('done');
    await expect(aborted.promise).rejects.toThrow('cancelled');
  });

  it('handles unexpected close and idempotent local close', async () => {
    const { socket, processor } = await activate();
    socket.emit('close');
    await expect(processor.closed).resolves.toMatchObject({ type: 'failed' });

    const active = await activate();
    await Promise.all([active.processor.close(), active.processor.close()]);
    expect(active.socket.close).toHaveBeenCalledOnce();
    expect(await active.processor.closed).toMatchObject({ type: 'closed' });
  });

  it('reconnects once, reseeds history and replays pending updates', async () => {
    const harness = await setupReconnecting({
      maxAttempts: 1,
      delayMs: 1,
      graceMs: 500,
    });
    await harness.processor.sendUpdate({
      sequence: 1,
      eventId: 'update-1',
      event: inboxEvent,
      requestResponse: true,
    });
    harness.drop(harness.socketAt(0));
    await flush();
    expect(harness.sockets).toHaveLength(2);
    const replacement = harness.socketAt(1);
    harness.handshake(replacement);
    await flush();

    const types = sent(replacement).map((event) => event.type);
    expect(types).toEqual([
      'session.update',
      'conversation.item.create',
      'conversation.item.create',
      'conversation.item.create',
      'conversation.item.create',
      'conversation.item.create',
      'response.create',
    ]);
    expect(sent(replacement).at(-2)).toMatchObject({
      item: {
        role: 'user',
        content: [
          { text: expect.stringContaining('Anna: are we live?') as string },
        ],
      },
    });
    let closed = false;
    void harness.processor.closed.then(() => {
      closed = true;
    });
    await flush();
    expect(closed).toBe(false);
    await harness.processor.close();
  });

  it('replays completed user transcripts after reconnect', async () => {
    const harness = await setupReconnecting({
      maxAttempts: 1,
      delayMs: 1,
      graceMs: 500,
    });
    harness.socketAt(0).message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'event-user-replay',
      item_id: 'item-user-replay',
      transcript: 'Remember this across reconnects.',
    });

    harness.drop(harness.socketAt(0));
    await flush();
    const replacement = harness.socketAt(1);
    harness.handshake(replacement);
    await flush();

    expect(sent(replacement)).toContainEqual(
      expect.objectContaining({
        type: 'conversation.item.create',
        item: expect.objectContaining({
          role: 'user',
          content: [
            expect.objectContaining({
              text: 'Remember this across reconnects.',
            }),
          ],
        }),
      }),
    );
    await harness.processor.close();
  });

  it('coalesces reconnect-waiting updates into one replay response', async () => {
    const harness = await setupReconnecting({
      maxAttempts: 1,
      delayMs: 1,
      graceMs: 500,
    });
    await harness.processor.sendUpdate({
      sequence: 1,
      eventId: 'update-before-reconnect',
      event: inboxEvent,
      requestResponse: true,
    });
    harness.drop(harness.socketAt(0));
    await flush();
    const replacement = harness.socketAt(1);
    let delivered = false;

    const delivery = harness.processor
      .sendUpdate({
        sequence: 2,
        eventId: 'update-during-reconnect',
        event: inboxEvent,
        requestResponse: true,
      })
      .then(() => {
        delivered = true;
      });
    await flush();
    expect(delivered).toBe(false);
    expect(sent(replacement)).toEqual([]);

    harness.handshake(replacement);
    await delivery;
    expect(
      sent(replacement).filter((event) => event.type === 'response.create'),
    ).toHaveLength(1);
    expect(
      sent(replacement).filter(
        (event) => event.type === 'conversation.item.create',
      ),
    ).toHaveLength(6);
    await harness.processor.close();
  });

  it('retains reconnect waiters across a failed reconnect attempt', async () => {
    const sockets: FakeSocket[] = [];
    let attempt = 0;
    const factory = createOpenAIRealtimeProcessorFactory({
      logging,
      config,
      startupTimeoutMs: 1_000,
      reconnect: { maxAttempts: 2, delayMs: 1, graceMs: 500 },
      connect: () => {
        attempt += 1;
        if (attempt === 2) throw new Error('temporary connect failure');
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const controller = new AbortController();
    const creating = factory.create({
      namespace: 'test',
      sessionId: 'session',
      signal: controller.signal,
      context: preparedContext,
    });
    const first = sockets[0];
    if (!first) throw new Error('initial socket was never created');
    first.open();
    first.message({ type: 'session.updated' });
    const processor = await creating;
    first.readyState = 3;
    first.emit('close');
    const delivery = processor.sendUpdate({
      sequence: 1,
      eventId: 'update-across-retries',
      event: inboxEvent,
      requestResponse: true,
    });
    await flush(20);
    const replacement = sockets[1];
    if (!replacement) throw new Error('replacement socket was never created');
    replacement.open();
    replacement.message({ type: 'session.updated' });

    await expect(delivery).resolves.toBeUndefined();
    await processor.close();
  });

  it('does not replay empty provider transcripts', async () => {
    const harness = await setupReconnecting({
      maxAttempts: 1,
      delayMs: 1,
      graceMs: 500,
    });
    const first = harness.socketAt(0);
    first.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'empty-user',
      item_id: 'empty-user-item',
      transcript: '',
    });
    first.message({
      type: 'response.created',
      response: { id: 'empty-response' },
    });
    first.message({
      type: 'response.output_audio_transcript.done',
      event_id: 'empty-assistant',
      response_id: 'empty-response',
      item_id: 'empty-assistant-item',
      transcript: '',
    });
    first.message({
      type: 'response.done',
      response: { id: 'empty-response' },
    });

    harness.drop(first);
    await flush();
    const replacement = harness.socketAt(1);
    harness.handshake(replacement);
    await flush();

    expect(
      sent(replacement).filter(
        (event) => event.type === 'conversation.item.create',
      ),
    ).toHaveLength(4);
    await harness.processor.close();
  });

  it('ignores duplicate updates and replays a tool result as context', async () => {
    const harness = await setupReconnecting({
      maxAttempts: 1,
      delayMs: 1,
      graceMs: 500,
    });
    const first = harness.socketAt(0);
    first.message({
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'call-1', name: 'send_message' },
    });
    first.message({
      type: 'response.function_call_arguments.done',
      event_id: 'event-call',
      call_id: 'call-1',
      arguments: '{"text":"hi"}',
    });
    await harness.processor.sendToolResult({
      executionId: 'call-1',
      status: 'success',
      output: { ok: true },
    });
    // The provider still knows the call, so a native output item is used.
    expect(sent(first).at(-2)).toMatchObject({
      item: { type: 'function_call_output', call_id: 'call-1' },
    });
    // A repeated result for the same execution is not sent twice.
    const before = first.sent.length;
    await harness.processor.sendToolResult({
      executionId: 'call-1',
      status: 'success',
      output: { ok: true },
    });
    expect(first.sent).toHaveLength(before);

    harness.drop(first);
    await flush();
    const replacement = harness.socketAt(1);
    harness.handshake(replacement);
    await flush();
    const replayed = sent(replacement)
      .filter((event) => event.type === 'conversation.item.create')
      .at(-1);
    expect(replayed).toMatchObject({
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            text: '<tool-result call-id="call-1">{"ok":true}</tool-result>',
          },
        ],
      },
    });

    // A replayed provider tool call must not execute a second time.
    const events = harness.processor.events[Symbol.asyncIterator]();
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'tool-call', request: { executionId: 'call-1' } },
    });
    replacement.message({
      type: 'response.function_call_arguments.done',
      event_id: 'event-call-replayed',
      call_id: 'call-1',
      name: 'send_message',
      arguments: '{"text":"hi"}',
    });
    replacement.message({
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'event-user',
      item_id: 'item-user',
      transcript: 'Ship it.',
    });
    await expect(events.next()).resolves.toMatchObject({
      value: { type: 'user-transcript', eventId: 'event-user' },
    });

    await harness.processor.sendUpdate({
      sequence: 1,
      eventId: 'update-1',
      event: inboxEvent,
      requestResponse: false,
    });
    const afterUpdate = replacement.sent.length;
    await harness.processor.sendUpdate({
      sequence: 2,
      eventId: 'update-1',
      event: inboxEvent,
      requestResponse: true,
    });
    expect(replacement.sent).toHaveLength(afterUpdate);
    await harness.processor.close();
  });

  it('fails terminally when the reconnect window expires', async () => {
    const harness = await setupReconnecting({
      maxAttempts: 1,
      delayMs: 1,
      graceMs: 10,
    });
    harness.drop(harness.socketAt(0));
    await flush(40);
    // The replacement connection never completes its handshake.
    await expect(harness.processor.closed).resolves.toMatchObject({
      type: 'failed',
    });
  });

  it('ends the call once the reconnect budget is exhausted', async () => {
    const harness = await setupReconnecting({
      maxAttempts: 1,
      delayMs: 1,
      graceMs: 500,
    });
    harness.drop(harness.socketAt(0));
    await flush();
    harness.handshake(harness.socketAt(1));
    await flush();
    harness.drop(harness.socketAt(1));
    await flush();
    expect(harness.sockets).toHaveLength(2);
    await expect(harness.processor.closed).resolves.toMatchObject({
      type: 'failed',
    });
  });

  it('honours cancellation while a reconnect is pending', async () => {
    const harness = await setupReconnecting({
      maxAttempts: 1,
      delayMs: 50,
      graceMs: 500,
    });
    harness.drop(harness.socketAt(0));
    harness.controller.abort('call ended');
    await expect(harness.processor.closed).resolves.toMatchObject({
      type: 'closed',
      reason: 'aborted',
    });
    await flush(80);
    expect(harness.sockets).toHaveLength(1);
  });
});
