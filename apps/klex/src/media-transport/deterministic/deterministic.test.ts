import { describe, expect, it, vi } from 'vitest';

import type { AudioFrame } from '@/media-transport';

import {
  createDeterministicEchoProcessorFactory,
  createDeterministicMediaTransport,
  createDeterministicMediaTransportConnector,
} from './deterministic';

function frame(sequence: number, value = sequence): AudioFrame {
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 16_000,
    channels: 1,
    sequence,
    timestampUs: sequence * 20_000,
    data: Uint8Array.from([value, 0]),
  };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  const settled = vi.fn();
  void promise.then(settled, settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
}

describe('deterministic media transport', () => {
  it('delivers copied incoming and outgoing frames in order', async () => {
    const transport = createDeterministicMediaTransport();
    const input = transport.incoming[Symbol.asyncIterator]();
    const first = frame(1, 7);

    await transport.inject(first);
    first.data[0] = 99;
    await expect(input.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1, data: Uint8Array.from([7, 0]) },
    });

    const outbound = frame(2, 8);
    await transport.send(outbound);
    outbound.data[0] = 88;
    await expect(transport.receiveSent()).resolves.toMatchObject({
      sequence: 2,
      data: Uint8Array.from([8, 0]),
    });
    await transport.close();
  });

  it('applies bounded backpressure and cancels blocked producers', async () => {
    const transport = createDeterministicMediaTransport({ capacity: 1 });
    await transport.inject(frame(1));
    const blockedInput = transport.inject(frame(2));
    await expectPending(blockedInput);

    const input = transport.incoming[Symbol.asyncIterator]();
    await expect(input.next()).resolves.toMatchObject({
      value: { sequence: 1 },
    });
    await expect(blockedInput).resolves.toBeUndefined();
    await expect(input.next()).resolves.toMatchObject({
      value: { sequence: 2 },
    });

    await transport.send(frame(3));
    const blockedSend = transport.send(frame(4));
    await expectPending(blockedSend);
    await expect(transport.receiveSent()).resolves.toMatchObject({
      sequence: 3,
    });
    await expect(blockedSend).resolves.toBeUndefined();
    await expect(transport.receiveSent()).resolves.toMatchObject({
      sequence: 4,
    });

    await transport.inject(frame(5));
    const cancelled = transport.inject(frame(6));
    await transport.close();
    await expect(cancelled).rejects.toThrow('Queue is closed');
  });

  it('reports remote closure, failure, abort, and idempotent close', async () => {
    const remote = createDeterministicMediaTransport();
    remote.remoteClose('participant-left');
    await expect(remote.closed).resolves.toEqual({
      type: 'closed',
      reason: 'participant-left',
    });
    await remote.close();
    await remote.close();
    expect(remote.closeCount).toBe(1);

    const error = new Error('media failed');
    const failed = createDeterministicMediaTransport();
    failed.fail(error);
    await expect(failed.closed).resolves.toEqual({ type: 'failed', error });
    await expect(failed.inject(frame(1))).rejects.toBe(error);

    const controller = new AbortController();
    const aborted = createDeterministicMediaTransport({
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted.closed).resolves.toMatchObject({ type: 'closed' });
    expect(aborted.closeCount).toBe(1);
  });

  it('connects opaque descriptors and exposes created transports', async () => {
    const connector = createDeterministicMediaTransportConnector();
    const controller = new AbortController();
    const descriptor = {
      profile: 'livekit-room' as const,
      url: 'wss://livekit.example.test',
      token: 'secret',
    };

    const connected = await connector.connect(descriptor, {
      signal: controller.signal,
    });
    expect(await connector.nextTransport()).toBe(connected);
    expect(connector.descriptors).toEqual([descriptor]);
    controller.abort();
    await connected.closed;
  });
});

describe('deterministic echo processor', () => {
  it('echoes copied frames with backpressure and closes exactly once', async () => {
    const factory = createDeterministicEchoProcessorFactory();
    const controller = new AbortController();
    const processor = await factory.create({
      namespace: 'voice',
      sessionId: 'session-1',
      signal: controller.signal,
    });
    expect(await factory.nextProcessor()).toBe(processor);

    const source = frame(1, 42);
    await processor.writeInput(source);
    source.data[0] = 0;
    const output = processor.output[Symbol.asyncIterator]();
    await expect(output.next()).resolves.toMatchObject({
      value: { data: Uint8Array.from([42, 0]) },
    });

    await processor.close();
    await processor.close();
    expect(processor.closeCount).toBe(1);
    await expect(processor.closed).resolves.toMatchObject({ type: 'closed' });
  });

  it('surfaces processor failure to output consumers', async () => {
    const factory = createDeterministicEchoProcessorFactory();
    const processor = await factory.create({
      namespace: 'voice',
      sessionId: 'session-1',
      signal: new AbortController().signal,
    });
    const error = new Error('processor failed');
    processor.fail(error);
    await expect(processor.closed).resolves.toEqual({ type: 'failed', error });
    await expect(processor.output[Symbol.asyncIterator]().next()).rejects.toBe(
      error,
    );
  });
});
