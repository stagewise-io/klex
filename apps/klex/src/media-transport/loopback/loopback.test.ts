import { describe, expect, it } from 'vitest';

import { BoundedAsyncQueue } from '../async-queue';
import type { AudioFrame, AudioSource } from '../media-transport';
import { createLoopbackProcessorFactory } from './loopback';

function frame(sequence: number): AudioFrame {
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 48_000,
    channels: 1,
    sequence,
    timestampUs: sequence * 20_000,
    data: new Uint8Array([sequence, 0]),
  };
}

function source(
  queue: BoundedAsyncQueue<AudioFrame>,
  id = 'source',
): AudioSource {
  return {
    id,
    metadata: { participantId: 'participant', trackId: id },
    readable: queue,
    closed: new Promise(() => undefined),
  };
}

describe('createLoopbackProcessorFactory', () => {
  it('copies and emits frames in strict sequence', async () => {
    const processor = await createLoopbackProcessorFactory().create({
      namespace: 'calls',
      sessionId: 'session-1',
      signal: new AbortController().signal,
    });
    const queue = new BoundedAsyncQueue<AudioFrame>(1);
    await processor.audioInputs.attach(source(queue));
    const iterator = processor.audioOutput[Symbol.asyncIterator]();
    const first = frame(1);
    await queue.push(first);
    const firstOutput = await iterator.next();
    expect(firstOutput).toEqual({ done: false, value: first });
    expect(firstOutput.value?.data).not.toBe(first.data);

    const second = frame(2);
    await queue.push(second);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: second,
    });
    await processor.close();
    await expect(processor.closed).resolves.toEqual({
      type: 'closed',
      reason: 'local-close',
    });
  });

  it('bounds pending output to one frame', async () => {
    const processor = await createLoopbackProcessorFactory().create({
      namespace: 'calls',
      sessionId: 'session-1',
      signal: new AbortController().signal,
    });
    const queue = new BoundedAsyncQueue<AudioFrame>(1);
    await processor.audioInputs.attach(source(queue));
    await queue.push(frame(1));
    await queue.push(frame(2));
    let thirdResolved = false;
    const third = queue.push(frame(3)).then(() => {
      thirdResolved = true;
    });
    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    const iterator = processor.audioOutput[Symbol.asyncIterator]();
    await iterator.next();
    await third;
    expect(thirdResolved).toBe(true);
    await processor.close();
  });

  it('closes on abort and rejects blocked output consumption', async () => {
    const controller = new AbortController();
    const processor = await createLoopbackProcessorFactory().create({
      namespace: 'calls',
      sessionId: 'session-1',
      signal: controller.signal,
    });
    const queue = new BoundedAsyncQueue<AudioFrame>(1);
    await processor.audioInputs.attach(source(queue));
    const output = processor.audioOutput[Symbol.asyncIterator]();
    await queue.push(frame(1));
    await expect(output.next()).resolves.toMatchObject({ done: false });
    await queue.push(frame(2));
    controller.abort();
    await expect(processor.closed).resolves.toEqual({
      type: 'closed',
      reason: 'aborted',
    });
  });
});
