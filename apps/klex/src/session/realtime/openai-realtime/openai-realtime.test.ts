import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { RootLogger } from '@stagewise/logger';

import type { AudioFrame, AudioSource } from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';

import {
  createOpenAIRealtimeProcessorFactory,
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
const logging = {
  child: () => ({ warn }),
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

async function setup(startupTimeoutMs = 1_000) {
  const socket = new FakeSocket();
  let authorization: string | undefined;
  const factory = createOpenAIRealtimeProcessorFactory({
    logging,
    config,
    startupTimeoutMs,
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
  });
  return { socket, promise, controller, authorization: () => authorization };
}

async function activate() {
  const harness = await setup();
  harness.socket.open();
  const update = JSON.parse(harness.socket.sent[0] ?? '{}');
  harness.socket.message({ type: 'session.updated' });
  return { ...harness, update, processor: await harness.promise };
}

function source(queue: BoundedAsyncQueue<AudioFrame>): AudioSource {
  return {
    id: 'microphone',
    metadata: { participantId: 'caller', trackId: 'microphone' },
    readable: queue,
    closed: new Promise(() => undefined),
  };
}

describe('OpenAI realtime processor', () => {
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
      threshold: 0.6,
    });
    harness.socket.message({ type: 'session.updated' });
    await expect(harness.promise).resolves.toBeDefined();
  });

  it('downsamples input and packetizes fragmented response audio', async () => {
    const { socket, processor } = await activate();
    const input = new BoundedAsyncQueue<AudioFrame>(1);
    await processor.audioInputs.attach(source(input));
    await input.push(frame());
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
});
