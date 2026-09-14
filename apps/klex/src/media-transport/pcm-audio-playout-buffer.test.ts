import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AudioFrame } from './media-transport';
import {
  createPcmAudioPlayoutBuffer,
  type PcmAudioPlayoutEvent,
} from './pcm-audio-playout-buffer';

function frame(value: number, overrides: Partial<AudioFrame> = {}): AudioFrame {
  const samples = new Int16Array(960);
  samples.fill(value);
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 48_000,
    channels: 1,
    sequence: value,
    timestampUs: value * 20_000,
    data: new Uint8Array(samples.buffer),
    ...overrides,
  };
}

function sample(frame: AudioFrame): number {
  return new DataView(
    frame.data.buffer,
    frame.data.byteOffset,
    frame.data.byteLength,
  ).getInt16(0, true);
}

async function nextFrame(iterator: AsyncIterator<AudioFrame>) {
  const result = await iterator.next();
  if (result.done) throw new Error('Expected an audio frame');
  return result.value;
}

afterEach(() => vi.useRealTimers());

describe('PcmAudioPlayoutBuffer', () => {
  it('buffers to its target and emits exact frames on a 20 ms clock', async () => {
    vi.useFakeTimers();
    const buffer = createPcmAudioPlayoutBuffer({
      targetBufferMs: 60,
      maxBufferMs: 100,
    });
    const iterator = buffer.audioOutput[Symbol.asyncIterator]();
    const first = iterator.next();
    await buffer.write(frame(1));
    await buffer.write(frame(2));
    await vi.advanceTimersByTimeAsync(100);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await buffer.write(frame(3));
    expect(sample(await nextFrameFrom(first))).toBe(1);
    const second = iterator.next();
    await vi.advanceTimersByTimeAsync(19);
    await Promise.resolve();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sample(await nextFrameFrom(second))).toBe(2);

    const third = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    expect(sample(await nextFrameFrom(third))).toBe(3);
    await buffer.close({ drain: true });
  });

  it('absorbs a sub-target provider gap without inserting silence', async () => {
    vi.useFakeTimers();
    const events: PcmAudioPlayoutEvent[] = [];
    const buffer = createPcmAudioPlayoutBuffer({
      targetBufferMs: 60,
      maxBufferMs: 200,
      onEvent: (event) => events.push(event),
    });
    const iterator = buffer.audioOutput[Symbol.asyncIterator]();
    for (let value = 1; value <= 5; value += 1)
      await buffer.write(frame(value));

    for (let value = 1; value <= 3; value += 1) {
      const next = iterator.next();
      if (value > 1) await vi.advanceTimersByTimeAsync(20);
      expect(sample(await nextFrameFrom(next))).toBe(value);
    }
    await buffer.write(frame(6));
    await buffer.write(frame(7));
    for (let value = 4; value <= 7; value += 1) {
      const next = iterator.next();
      await vi.advanceTimersByTimeAsync(20);
      expect(sample(await nextFrameFrom(next))).toBe(value);
    }
    expect(
      events.filter((event) => event.type === 'frame' && event.silence),
    ).toHaveLength(0);
    await buffer.close({ drain: true });
  });

  it('does not burst frames to catch up after a late deadline', async () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const buffer = createPcmAudioPlayoutBuffer({
      targetBufferMs: 40,
      maxBufferMs: 100,
      now: () => nowMs,
    });
    const iterator = buffer.audioOutput[Symbol.asyncIterator]();
    await buffer.write(frame(1));
    await buffer.write(frame(2));
    await buffer.write(frame(3));
    await nextFrame(iterator);

    const late = iterator.next();
    nowMs = 100;
    await vi.advanceTimersByTimeAsync(20);
    expect(sample(await nextFrameFrom(late))).toBe(2);

    let settled = false;
    const paced = iterator.next().then((result) => {
      settled = true;
      return result;
    });
    nowMs = 119;
    await vi.advanceTimersByTimeAsync(19);
    expect(settled).toBe(false);
    nowMs = 120;
    await vi.advanceTimersByTimeAsync(1);
    expect(sample(await nextFrameFrom(paced))).toBe(3);
    await buffer.close();
  });

  it('inserts paced silence on underrun and rebuffers before resuming', async () => {
    vi.useFakeTimers();
    const buffer = createPcmAudioPlayoutBuffer({
      targetBufferMs: 60,
      maxBufferMs: 100,
    });
    const iterator = buffer.audioOutput[Symbol.asyncIterator]();
    for (let value = 1; value <= 3; value += 1)
      await buffer.write(frame(value));
    for (let value = 1; value <= 3; value += 1) {
      const next = iterator.next();
      if (value > 1) await vi.advanceTimersByTimeAsync(20);
      expect(sample(await nextFrameFrom(next))).toBe(value);
    }

    const silence = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    expect(sample(await nextFrameFrom(silence))).toBe(0);
    await buffer.write(frame(4));
    await buffer.write(frame(5));
    const moreSilence = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    expect(sample(await nextFrameFrom(moreSilence))).toBe(0);
    await buffer.write(frame(6));
    const resumed = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    expect(sample(await nextFrameFrom(resumed))).toBe(4);

    await buffer.close();
  });

  it('backpressures writes at capacity and releases them as frames play', async () => {
    vi.useFakeTimers();
    const buffer = createPcmAudioPlayoutBuffer({
      targetBufferMs: 40,
      maxBufferMs: 60,
    });
    const iterator = buffer.audioOutput[Symbol.asyncIterator]();
    await buffer.write(frame(1));
    await buffer.write(frame(2));
    await nextFrame(iterator);
    await buffer.write(frame(3));
    await buffer.write(frame(4));
    const blocked = buffer.write(frame(5));
    let settled = false;
    void blocked.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const next = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    await nextFrameFrom(next);
    await expect(blocked).resolves.toBeUndefined();
    await buffer.close();
  });

  it('discards buffered prior-revision frames on reset', async () => {
    vi.useFakeTimers();
    const buffer = createPcmAudioPlayoutBuffer({
      targetBufferMs: 60,
      maxBufferMs: 60,
    });
    await buffer.write(frame(1));
    await buffer.write(frame(2));
    buffer.reset();
    await buffer.write(frame(7));
    await buffer.write(frame(8));
    await buffer.write(frame(9));

    const iterator = buffer.audioOutput[Symbol.asyncIterator]();
    expect(sample(await nextFrame(iterator))).toBe(7);
    await buffer.close();
  });

  it('discards a pending pre-reset output frame', async () => {
    vi.useFakeTimers();
    const buffer = createPcmAudioPlayoutBuffer({
      targetBufferMs: 40,
      maxBufferMs: 40,
    });
    const iterator = buffer.audioOutput[Symbol.asyncIterator]();
    await buffer.write(frame(1));
    await buffer.write(frame(2));
    await vi.advanceTimersByTimeAsync(20);

    buffer.reset();
    await buffer.write(frame(7));
    await buffer.write(frame(8));
    const next = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    expect(sample(await nextFrameFrom(next))).toBe(7);
    await buffer.close();
  });

  it('forces a blocked output write to settle on discard close', async () => {
    vi.useFakeTimers();
    const buffer = createPcmAudioPlayoutBuffer({
      targetBufferMs: 40,
      maxBufferMs: 40,
    });
    await buffer.write(frame(1));
    await buffer.write(frame(2));
    await vi.advanceTimersByTimeAsync(20);

    await expect(buffer.close()).resolves.toBeUndefined();
    await expect(
      buffer.audioOutput[Symbol.asyncIterator]().next(),
    ).resolves.toEqual({ value: undefined, done: true });
  });

  it('drains a response shorter than the target and propagates failure', async () => {
    vi.useFakeTimers();
    const draining = createPcmAudioPlayoutBuffer({
      targetBufferMs: 60,
      maxBufferMs: 100,
    });
    await draining.write(frame(1));
    await draining.write(frame(2));
    const iterator = draining.audioOutput[Symbol.asyncIterator]();
    const closing = draining.close({ drain: true });
    expect(sample(await nextFrame(iterator))).toBe(1);
    const second = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    expect(sample(await nextFrameFrom(second))).toBe(2);
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    await closing;

    const failed = createPcmAudioPlayoutBuffer();
    await failed.write(frame(3));
    const failure = new Error('failed');
    await failed.close({ error: failure });
    await expect(
      failed.audioOutput[Symbol.asyncIterator]().next(),
    ).rejects.toBe(failure);
  });

  it('discards queued output and propagates failed closure immediately', async () => {
    const error = new Error('provider failed');
    const buffer = createPcmAudioPlayoutBuffer({
      targetBufferMs: 40,
      maxBufferMs: 40,
    });
    await buffer.write(frame(1));
    await buffer.write(frame(2));
    await buffer.close({ error });

    const iterator = buffer.audioOutput[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(error);
  });

  it('validates format, frame size, and buffer durations', async () => {
    const buffer = createPcmAudioPlayoutBuffer();
    await expect(
      buffer.write(frame(1, { sampleRateHz: 24_000 })),
    ).rejects.toThrow('48000 Hz');
    await expect(
      buffer.write(frame(1, { data: new Uint8Array(2) })),
    ).rejects.toThrow('exact 20 ms');
    await buffer.close();
    expect(() => createPcmAudioPlayoutBuffer({ targetBufferMs: 21 })).toThrow(
      'positive multiple of 20 ms',
    );
    expect(() =>
      createPcmAudioPlayoutBuffer({
        targetBufferMs: 100,
        maxBufferMs: 80,
      }),
    ).toThrow('cannot exceed');
  });
});

async function nextFrameFrom(
  result: Promise<IteratorResult<AudioFrame>>,
): Promise<AudioFrame> {
  const resolved = await result;
  if (resolved.done) throw new Error('Expected an audio frame');
  return resolved.value;
}
