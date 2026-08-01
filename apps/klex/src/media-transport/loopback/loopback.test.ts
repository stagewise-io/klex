import { describe, expect, it } from 'vitest';

import type { AudioFrame } from '../media-transport';
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

describe('createLoopbackProcessorFactory', () => {
  it('copies and emits frames in strict sequence', async () => {
    const processor = await createLoopbackProcessorFactory().create({
      namespace: 'calls',
      sessionId: 'session-1',
      signal: new AbortController().signal,
    });
    const iterator = processor.output[Symbol.asyncIterator]();
    const first = frame(1);
    await processor.writeInput(first);
    const firstOutput = await iterator.next();
    expect(firstOutput).toEqual({ done: false, value: first });
    expect(firstOutput.value?.data).not.toBe(first.data);

    const second = frame(2);
    await processor.writeInput(second);
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
    await processor.writeInput(frame(1));
    let secondResolved = false;
    const second = processor.writeInput(frame(2)).then(() => {
      secondResolved = true;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    const iterator = processor.output[Symbol.asyncIterator]();
    await iterator.next();
    await second;
    expect(secondResolved).toBe(true);
    await processor.close();
  });

  it('closes on abort and unblocks pending writers', async () => {
    const controller = new AbortController();
    const processor = await createLoopbackProcessorFactory().create({
      namespace: 'calls',
      sessionId: 'session-1',
      signal: controller.signal,
    });
    await processor.writeInput(frame(1));
    const pending = processor.writeInput(frame(2));
    controller.abort();
    await expect(pending).rejects.toThrow('Queue is closed');
    await expect(processor.closed).resolves.toEqual({
      type: 'closed',
      reason: 'aborted',
    });
  });
});
