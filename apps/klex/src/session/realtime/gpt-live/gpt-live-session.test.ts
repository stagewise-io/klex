import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { AudioFrame, AudioSource } from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';
import { SessionInboxUrgency } from '@/session/inbox';
import type { PreparedInferenceContext } from '@/session/interaction';

import {
  createGPTLiveProcessorFactory,
  type GPTLiveWebSocket,
} from './gpt-live-session';

class FakeSocket extends EventEmitter implements GPTLiveWebSocket {
  readyState = 0;
  sent: string[] = [];
  sendError: Error | undefined;
  close = vi.fn(() => {
    this.readyState = 3;
  });
  terminate = vi.fn(() => {
    this.readyState = 3;
  });
  send(data: string): void {
    if (this.sendError !== undefined) throw this.sendError;
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

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};
const logging = {
  child: () => logger,
} as unknown as RootLogger;

const context: PreparedInferenceContext = {
  instructions: 'backend policy',
  messages: [{ role: 'user', content: 'existing history' }],
  tools: [],
  model: {
    modelId: 'gpt-live-1',
    contextSize: 128_000,
    inputCapabilities: {},
  },
  historyRevision: 1,
  updateWatermark: 0,
};

function setup() {
  const socket = new FakeSocket();
  let replacementSocket: FakeSocket | undefined;
  let connectionCount = 0;
  let connectedUrl: string | undefined;
  let authorization: string | string[] | undefined;
  const factory = createGPTLiveProcessorFactory({
    logging,
    config: {
      modelId: 'gpt-live-1',
      apiKey: 'secret-test-key',
      baseUrl: 'https://example.test/v1',
      responsesModelId: 'gpt-5.2',
    },
    connect: (url, options) => {
      connectedUrl = url;
      authorization = options.headers?.Authorization;
      connectionCount += 1;
      if (connectionCount === 1) return socket;
      replacementSocket = new FakeSocket();
      return replacementSocket;
    },
    startupTimeoutMs: 1_000,
    frontendInstructions: 'frontend voice policy',
  });
  const controller = new AbortController();
  const creating = factory.create({
    namespace: 'test',
    sessionId: 'call-1',
    signal: controller.signal,
    context,
  });
  return {
    socket,
    creating,
    controller,
    connection: () => ({ connectedUrl, authorization }),
    replacementSocket: () => replacementSocket,
  };
}

function source(queue: BoundedAsyncQueue<AudioFrame>): AudioSource {
  return {
    id: 'participant-1',
    metadata: { participantId: 'participant-1', trackId: 'track-1' },
    readable: queue,
    closed: new Promise(() => {}),
  };
}

function inputFrame(): AudioFrame {
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 48_000,
    channels: 1,
    sequence: 0,
    timestampUs: 0,
    data: new Uint8Array(1_920),
  };
}

describe('GPT-Live model session', () => {
  it('authenticates, starts with Responses delegation, and waits for readiness', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    await Promise.resolve();

    expect(setupResult.connection()).toEqual({
      connectedUrl: 'wss://example.test/v1/live/sessions',
      authorization: 'Bearer secret-test-key',
    });
    expect(JSON.parse(setupResult.socket.sent[0] ?? '{}')).toMatchObject({
      type: 'session.start',
      session: {
        model: 'gpt-live-1',
        instructions: 'frontend voice policy',
        input: [{ role: 'user' }],
        delegation: {
          type: 'responses',
          responses: { model: 'gpt-5.2', instructions: 'backend policy' },
        },
      },
    });

    let resolved = false;
    void setupResult.creating.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    setupResult.socket.message({
      type: 'session.started',
      event_id: 'started-1',
      session: { id: 'live-1' },
    });
    await expect(setupResult.creating).resolves.toBeDefined();
  });

  it('mixes and resamples attached 48 kHz PCM input to Live audio appends', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      event_id: 'started-1',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const queue = new BoundedAsyncQueue<AudioFrame>(1);
    await session.audioInputs.attach(source(queue));
    await queue.push(inputFrame());
    await vi.waitFor(() => {
      expect(
        setupResult.socket.sent.some((entry) =>
          entry.includes('session.input_audio.append'),
        ),
      ).toBe(true);
    });
    const append = setupResult.socket.sent
      .map((entry) => JSON.parse(entry))
      .find((entry) => entry.type === 'session.input_audio.append');
    expect(Buffer.from(append.audio, 'base64')).toHaveLength(960);
  });

  it('buffers Live output and publishes resampled frames at 20 ms cadence', async () => {
    vi.useFakeTimers();
    try {
      const setupResult = setup();
      setupResult.socket.open();
      setupResult.socket.message({
        type: 'session.started',
        event_id: 'started-1',
        session: { id: 'live-1' },
      });
      const session = await setupResult.creating;
      const iterator = session.audioOutput[Symbol.asyncIterator]();
      const first = iterator.next();
      setupResult.socket.message({
        type: 'session.output_audio.delta',
        event_id: 'audio-1',
        delta: Buffer.alloc(15 * 960).toString('base64'),
      });
      await expect(first).resolves.toMatchObject({
        done: false,
        value: {
          encoding: 'pcm-s16le',
          sampleRateHz: 48_000,
          channels: 1,
          sequence: 0,
          timestampUs: 0,
          data: expect.any(Uint8Array),
        },
      });
      expect((await first).value?.data).toHaveLength(1_920);

      let secondSettled = false;
      const second = iterator.next().then((result) => {
        secondSettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(19);
      expect(secondSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(second).resolves.toMatchObject({
        value: { sequence: 1, timestampUs: 20_000 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('pads and flushes a partial final output frame', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const next = session.audioOutput[Symbol.asyncIterator]().next();
    setupResult.socket.message({
      type: 'session.output_audio.delta',
      event_id: 'partial-audio',
      delta: Buffer.alloc(480).toString('base64'),
    });
    setupResult.socket.message({
      type: 'session.closed',
      session: { id: 'live-1' },
      reason: 'content',
      usage: { seconds: 1 },
    });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: { data: expect.any(Uint8Array) },
    });
    expect((await next).value?.data).toHaveLength(1_920);
    await expect(session.closed).resolves.toMatchObject({ type: 'closed' });
  });

  it('correlates tool results and continues only after every call settles', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const events = session.events[Symbol.asyncIterator]();
    setupResult.socket.message({
      type: 'session.delegation.created',
      offset_ms: 1,
      delegation: {
        id: 'delegation-1',
        target: 'responses',
        response_id: 'response-1',
      },
    });
    for (const [callId, name] of [
      ['call-1', 'first'],
      ['call-2', 'second'],
    ])
      setupResult.socket.message({
        type: 'response.event',
        delegation_id: 'delegation-1',
        event: {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: callId,
            name,
            arguments: '{}',
          },
        },
      });
    setupResult.socket.message({
      type: 'response.event',
      delegation_id: 'delegation-1',
      event: {
        type: 'response.completed',
        response: { id: 'response-1' },
      },
    });
    expect((await events.next()).value).toMatchObject({
      type: 'tool-call',
      request: { executionId: 'call-1' },
    });
    expect((await events.next()).value).toMatchObject({
      type: 'tool-call',
      request: { executionId: 'call-2' },
    });
    await session.sendToolResult({
      executionId: 'call-2',
      status: 'success',
      output: { ok: 2 },
    });
    expect(
      JSON.parse(
        setupResult.socket.sent.find((entry) =>
          entry.includes('call-2:result'),
        ) ?? '{}',
      ),
    ).toMatchObject({ item: { output: '{"ok":2}' } });
    expect(
      setupResult.socket.sent.some((entry) =>
        entry.includes('response-1:continue'),
      ),
    ).toBe(false);
    await session.sendToolResult({
      executionId: 'call-1',
      status: 'error',
      code: 'timeout',
      error: 'timed out',
      retryable: true,
    });
    expect(
      JSON.parse(
        setupResult.socket.sent.find((entry) =>
          entry.includes('call-1:result'),
        ) ?? '{}',
      ),
    ).toMatchObject({
      item: {
        output: '{"error":"timed out","code":"timeout","retryable":true}',
      },
    });
    expect(
      setupResult.socket.sent.filter((entry) =>
        entry.includes('response-1:continue'),
      ),
    ).toHaveLength(1);
    await session.sendToolResult({
      executionId: 'call-1',
      status: 'error',
      code: 'timeout',
      error: 'timed out',
      retryable: true,
    });
    expect(
      setupResult.socket.sent.filter((entry) =>
        entry.includes('response-1:continue'),
      ),
    ).toHaveLength(1);
  });

  it('bounds serialized tool results before sending them', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const nextEvent = session.events[Symbol.asyncIterator]().next();
    setupResult.socket.message({
      type: 'session.delegation.created',
      offset_ms: 0,
      delegation: { id: 'd1', target: 'responses', response_id: 'r1' },
    });
    setupResult.socket.message({
      type: 'response.event',
      delegation_id: 'd1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'large-result',
          name: 'large',
          arguments: '{}',
        },
      },
    });
    await nextEvent;

    await session.sendToolResult({
      executionId: 'large-result',
      status: 'success',
      output: { value: 'x'.repeat(1_000_000) },
    });
    const sent = setupResult.socket.sent.find((entry) =>
      entry.includes('large-result:result'),
    );
    const output = JSON.parse(sent ?? '{}').item?.output as string;
    expect(output.length).toBeLessThanOrEqual(65_536);
    expect(JSON.parse(output)).toEqual({ value: `${'x'.repeat(4_096)}…` });
  });

  it('fails closed without settling a tool call when result sending fails', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const nextEvent = session.events[Symbol.asyncIterator]().next();
    setupResult.socket.message({
      type: 'session.delegation.created',
      offset_ms: 0,
      delegation: { id: 'd1', target: 'responses', response_id: 'r1' },
    });
    setupResult.socket.message({
      type: 'response.event',
      delegation_id: 'd1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'lookup',
          arguments: '{}',
        },
      },
    });
    await nextEvent;
    setupResult.socket.sendError = new Error('socket send failed');

    await expect(
      session.sendToolResult({
        executionId: 'call-1',
        status: 'success',
        output: { ok: true },
      }),
    ).rejects.toThrow('socket send failed');
    await expect(session.closed).resolves.toMatchObject({ type: 'failed' });
    expect(setupResult.replacementSocket()).toBeUndefined();
  });

  it('returns invalid JSON as invalid-input without emitting an executable call', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const next = session.events[Symbol.asyncIterator]().next();
    setupResult.socket.message({
      type: 'session.delegation.created',
      offset_ms: 0,
      delegation: { id: 'd1', target: 'responses', response_id: 'r1' },
    });
    setupResult.socket.message({
      type: 'response.event',
      delegation_id: 'd1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'bad',
          name: 'unsafe',
          arguments: '{',
        },
      },
    });
    await expect(next).resolves.toMatchObject({
      value: {
        type: 'invalid-tool-call',
        result: { executionId: 'bad', status: 'error', code: 'invalid-input' },
      },
    });
  });

  it('preserves own prototype keys in tool-call input', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const nextEvent = session.events[Symbol.asyncIterator]().next();
    setupResult.socket.message({
      type: 'session.delegation.created',
      offset_ms: 0,
      delegation: { id: 'd1', target: 'responses', response_id: 'r1' },
    });
    setupResult.socket.message({
      type: 'response.event',
      delegation_id: 'd1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'prototype-input',
          name: 'prototype',
          arguments: '{"__proto__":{"preserved":true}}',
        },
      },
    });

    const event = (await nextEvent).value;
    expect(event).toMatchObject({ type: 'tool-call' });
    if (event?.type !== 'tool-call') throw new Error('Expected tool call');
    expect(event.request.input).toEqual(
      JSON.parse('{"__proto__":{"preserved":true}}'),
    );
    expect(Object.hasOwn(event.request.input, '__proto__')).toBe(true);
  });

  it('appends canonical updates and only requests explicitly responsive speech', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const event = {
      eventId: 'notice-1',
      sourceEnv: 'telegram',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'telegram',
        metadata: { channel: 'alerts' },
        content: [{ type: 'text' as const, text: 'Deployment complete' }],
      },
    };
    await session.sendUpdate({
      sequence: 7,
      eventId: 'notice-1',
      event,
      requestResponse: false,
    });
    expect(JSON.parse(setupResult.socket.sent.at(-1) ?? '{}')).toMatchObject({
      type: 'response.item.create',
      event_id: 'notice-1',
      item: { role: 'user' },
    });
    expect(setupResult.socket.sent.at(-1)).toContain('source-env');
    expect(setupResult.socket.sent.at(-1)).toContain('Deployment complete');
    await session.sendUpdate({
      sequence: 8,
      eventId: 'notice-2',
      event: { ...event, eventId: 'notice-2' },
      requestResponse: true,
    });
    expect(JSON.parse(setupResult.socket.sent.at(-1) ?? '{}')).toEqual({
      type: 'response.create',
      event_id: 'notice-2:respond',
    });

    const closing = session.close();
    await expect(
      session.sendUpdate({
        sequence: 9,
        eventId: 'notice-3',
        event: { ...event, eventId: 'notice-3' },
        requestResponse: false,
      }),
    ).rejects.toThrow('no longer accepting updates');
    setupResult.socket.message({
      type: 'session.closed',
      session: { id: 'live-1' },
      reason: 'close_requested',
      usage: { seconds: 1 },
    });
    await closing;
  });

  it('opens one safe replacement and refuses recovery during delegated work', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    setupResult.socket.readyState = 3;
    setupResult.socket.emit('close');
    const replacement = setupResult.replacementSocket();
    expect(replacement).toBeDefined();
    replacement?.open();
    expect(JSON.parse(replacement?.sent[0] ?? '{}').type).toBe('session.start');
    replacement?.message({
      type: 'session.started',
      session: { id: 'live-2' },
    });
    replacement?.message({
      type: 'session.delegation.created',
      offset_ms: 0,
      delegation: { id: 'd1', target: 'responses', response_id: 'r1' },
    });
    replacement?.message({
      type: 'response.event',
      delegation_id: 'd1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'pending-call',
          name: 'side_effect',
          arguments: '{}',
        },
      },
    });
    replacement?.emit('close');
    await expect(session.closed).resolves.toMatchObject({ type: 'failed' });
  });

  it('disables replacement after conversation state advances', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const queue = new BoundedAsyncQueue<AudioFrame>(1);
    await session.audioInputs.attach(source(queue));
    await queue.push(inputFrame());
    await vi.waitFor(() =>
      expect(
        setupResult.socket.sent.some((entry) =>
          entry.includes('session.input_audio.append'),
        ),
      ).toBe(true),
    );

    setupResult.socket.readyState = 3;
    setupResult.socket.emit('close');

    await expect(session.closed).resolves.toMatchObject({ type: 'failed' });
    expect(setupResult.replacementSocket()).toBeUndefined();
  });

  it('ignores late events from a replaced socket', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    setupResult.socket.readyState = 3;
    setupResult.socket.emit('close');
    const replacement = setupResult.replacementSocket();
    replacement?.open();
    replacement?.message({
      type: 'session.started',
      session: { id: 'live-2' },
    });

    setupResult.socket.emit('error', new Error('late stale error'));
    setupResult.socket.emit('close');
    setupResult.socket.message({
      type: 'error',
      error: { type: 'server_error', code: 'stale', message: 'late' },
    });
    await Promise.resolve();

    expect(replacement?.readyState).toBe(1);
    let closed = false;
    void session.closed.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
  });

  it('replays accepted updates and defers new updates until recovery is ready', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const event = {
      eventId: 'notice-1',
      sourceEnv: 'telegram',
      urgency: SessionInboxUrgency.Default,
      context: {
        sourceEnv: 'telegram',
        metadata: {},
        content: [{ type: 'text' as const, text: 'first update' }],
      },
    };
    await session.sendUpdate({
      sequence: 1,
      eventId: event.eventId,
      event,
      requestResponse: false,
    });

    setupResult.socket.readyState = 3;
    setupResult.socket.emit('close');
    const replacement = setupResult.replacementSocket();
    const deferredUpdate = session.sendUpdate({
      sequence: 2,
      eventId: 'notice-2',
      event: {
        ...event,
        eventId: 'notice-2',
        context: {
          ...event.context,
          content: [{ type: 'text', text: 'second update' }],
        },
      },
      requestResponse: false,
    });
    await Promise.resolve();
    expect(replacement?.sent).toEqual([]);

    replacement?.open();
    replacement?.message({
      type: 'session.started',
      session: { id: 'live-2' },
    });
    await deferredUpdate;
    const replacementEvents = replacement?.sent.map((entry) =>
      JSON.parse(entry),
    );
    expect(replacementEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'session.start' }),
        expect.objectContaining({
          type: 'response.item.create',
          event_id: 'notice-1',
        }),
        expect.objectContaining({
          type: 'response.item.create',
          event_id: 'notice-2',
        }),
      ]),
    );
  });

  it('fails boundedly when a replacement never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const setupResult = setup();
      setupResult.socket.open();
      setupResult.socket.message({
        type: 'session.started',
        session: { id: 'live-1' },
      });
      const session = await setupResult.creating;
      setupResult.socket.readyState = 3;
      setupResult.socket.emit('close');
      expect(setupResult.replacementSocket()).toBeDefined();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(session.closed).resolves.toMatchObject({ type: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not continue a failed delegated response after tool completion', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const nextEvent = session.events[Symbol.asyncIterator]().next();
    setupResult.socket.message({
      type: 'session.delegation.created',
      offset_ms: 0,
      delegation: { id: 'd1', target: 'responses', response_id: 'r1' },
    });
    setupResult.socket.message({
      type: 'response.event',
      delegation_id: 'd1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'side_effect',
          arguments: '{}',
        },
      },
    });
    setupResult.socket.message({
      type: 'response.event',
      delegation_id: 'd1',
      event: { type: 'response.failed', response: { id: 'r1' } },
    });
    await expect(nextEvent).resolves.toMatchObject({
      value: { type: 'tool-call', request: { executionId: 'call-1' } },
    });
    await session.sendToolResult({
      executionId: 'call-1',
      status: 'success',
      output: { ok: true },
    });
    expect(
      setupResult.socket.sent.some((entry) => entry.includes('r1:continue')),
    ).toBe(false);
  });

  it('rejects oversized provider audio deltas', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    setupResult.socket.message({
      type: 'session.output_audio.delta',
      event_id: 'oversized-audio',
      delta: Buffer.alloc(96_002).toString('base64'),
    });
    await expect(session.closed).resolves.toMatchObject({ type: 'failed' });
  });

  it('retains final transcripts when ordinary event delivery is blocked', async () => {
    vi.useFakeTimers();
    try {
      const setupResult = setup();
      setupResult.socket.open();
      setupResult.socket.message({
        type: 'session.started',
        session: { id: 'live-1' },
      });
      const session = await setupResult.creating;
      setupResult.socket.message({
        type: 'session.delegation.created',
        offset_ms: 0,
        delegation: { id: 'd1', target: 'responses', response_id: 'r1' },
      });
      for (let index = 0; index < 33; index += 1)
        setupResult.socket.message({
          type: 'response.event',
          delegation_id: 'd1',
          event: {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: `blocked-${index}`,
              name: 'blocked',
              arguments: '{}',
            },
          },
        });
      setupResult.socket.message({
        type: 'session.input_transcript.delta',
        event_id: 'final-transcript',
        delta: 'final words',
        start_ms: 10,
        end_ms: 20,
      });
      setupResult.socket.message({
        type: 'session.closed',
        session: { id: 'live-1' },
        reason: 'content',
        usage: { seconds: 1 },
      });

      await vi.advanceTimersByTimeAsync(2_001);
      await expect(session.closed).resolves.toMatchObject({ type: 'closed' });
      const observed = [];
      for await (const event of session.events) observed.push(event);
      expect(observed.slice(0, 32)).toHaveLength(32);
      expect(observed.at(-1)).toMatchObject({
        type: 'approximate-transcript-group',
        text: 'final words',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the graceful provider close handshake when aborted', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    setupResult.controller.abort();
    await vi.waitFor(() => {
      expect(JSON.parse(setupResult.socket.sent.at(-1) ?? '{}')).toEqual({
        type: 'session.close',
      });
    });
    setupResult.socket.message({
      type: 'session.closed',
      session: { id: 'live-1' },
      reason: 'close_requested',
      usage: { seconds: 1 },
    });
    await expect(session.closed).resolves.toEqual({
      type: 'closed',
      reason: 'close_requested',
    });
  });

  it('requires session.closed confirmation during teardown', async () => {
    const setupResult = setup();
    setupResult.socket.open();
    setupResult.socket.message({
      type: 'session.started',
      event_id: 'started-1',
      session: { id: 'live-1' },
    });
    const session = await setupResult.creating;
    const closing = session.close();
    expect(JSON.parse(setupResult.socket.sent.at(-1) ?? '{}')).toEqual({
      type: 'session.close',
    });
    setupResult.socket.message({
      type: 'session.closed',
      event_id: 'closed-1',
      reason: 'close_requested',
      session: { id: 'live-1' },
      usage: { seconds: 3 },
    });
    await expect(closing).resolves.toBeUndefined();
    await expect(session.closed).resolves.toEqual({
      type: 'closed',
      reason: 'close_requested',
    });
  });
});
