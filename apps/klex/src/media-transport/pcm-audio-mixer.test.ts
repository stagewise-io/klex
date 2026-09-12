import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BoundedAsyncQueue } from './async-queue';
import type {
  AudioFrame,
  AudioSource,
  RealtimeEndpointClosure,
} from './media-transport';
import { createPcmAudioMixer } from './pcm-audio-mixer';

interface TestSource extends AudioSource {
  push(frame: AudioFrame): Promise<void>;
  close(): void;
  fail(error: unknown): void;
}

function source(id: string, capacity = 8): TestSource {
  const queue = new BoundedAsyncQueue<AudioFrame>(capacity);
  const closure = Promise.withResolvers<RealtimeEndpointClosure>();
  return {
    id,
    metadata: { participantId: `participant-${id}`, trackId: id },
    readable: queue,
    closed: closure.promise,
    push: (item) => queue.push(item),
    close: () => {
      queue.close();
      closure.resolve({ type: 'closed' });
    },
    fail: (error) => {
      queue.close(error);
      closure.resolve({ type: 'failed', error });
    },
  };
}

function frame(
  samples: readonly number[],
  overrides: Partial<Omit<AudioFrame, 'data'>> = {},
): AudioFrame {
  const data = new Uint8Array(samples.length * 2);
  const view = new DataView(data.buffer);
  samples.forEach((sample, index) => {
    view.setInt16(index * 2, sample, true);
  });
  return {
    encoding: 'pcm-s16le',
    sampleRateHz: 48_000,
    channels: 1,
    sequence: 0,
    timestampUs: 0,
    data,
    ...overrides,
  };
}

function constantFrame(value: number, sampleCount = 960): AudioFrame {
  return frame(Array.from({ length: sampleCount }, () => value));
}

function samplesOf(item: AudioFrame): Int16Array {
  const samples = new Int16Array(item.data.byteLength / 2);
  const view = new DataView(
    item.data.buffer,
    item.data.byteOffset,
    item.data.byteLength,
  );
  for (let index = 0; index < samples.length; index += 1)
    samples[index] = view.getInt16(index * 2, true);
  return samples;
}

async function nextFrame(
  mixer: ReturnType<typeof createPcmAudioMixer>,
): Promise<AudioFrame> {
  const next = mixer.audioOutput[Symbol.asyncIterator]().next();
  await vi.advanceTimersByTimeAsync(20);
  const result = await next;
  if (result.done) throw new Error('Mixer output ended');
  return result.value;
}

describe('PCM audio mixer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('preserves one source and assigns aggregate frame timing', async () => {
    const mixer = createPcmAudioMixer();
    const input = source('first');
    await mixer.audioInputs.attach(input);
    await input.push(constantFrame(1_234));

    const output = await nextFrame(mixer);
    expect(output).toMatchObject({
      encoding: 'pcm-s16le',
      sampleRateHz: 48_000,
      channels: 1,
      sequence: 0,
      timestampUs: 0,
    });
    expect([...samplesOf(output)]).toEqual(
      Array.from({ length: 960 }, () => 1_234),
    );
    await mixer.close();
  });

  it('mixes overlapping sources with saturating PCM16 addition', async () => {
    const mixer = createPcmAudioMixer();
    const first = source('first');
    const second = source('second');
    await Promise.all([
      mixer.audioInputs.attach(first),
      mixer.audioInputs.attach(second),
    ]);
    await Promise.all([
      first.push(frame([20_000, -20_000, 1_000, ...new Array(957).fill(0)])),
      second.push(frame([20_000, -20_000, 2_000, ...new Array(957).fill(0)])),
    ]);

    expect([...samplesOf(await nextFrame(mixer)).slice(0, 3)]).toEqual([
      32_767, -32_768, 3_000,
    ]);
    await mixer.close();
  });

  it('does not let an incomplete source stall a ready source', async () => {
    const mixer = createPcmAudioMixer();
    const incomplete = source('incomplete');
    const ready = source('ready');
    await mixer.audioInputs.attach(incomplete);
    await mixer.audioInputs.attach(ready);
    await incomplete.push(constantFrame(9_000, 480));
    await ready.push(constantFrame(2_000));

    expect(samplesOf(await nextFrame(mixer))[0]).toBe(2_000);
    await incomplete.push(constantFrame(9_000, 480));
    expect(samplesOf(await nextFrame(mixer))[0]).toBe(9_000);
    await mixer.close();
  });

  it('assembles arbitrary input chunks into complete playout frames', async () => {
    const mixer = createPcmAudioMixer();
    const input = source('fragmented');
    await mixer.audioInputs.attach(input);
    await input.push(constantFrame(111, 300));
    await input.push(constantFrame(222, 660));

    const samples = samplesOf(await nextFrame(mixer));
    expect(samples.slice(0, 300).every((sample) => sample === 111)).toBe(true);
    expect(samples.slice(300).every((sample) => sample === 222)).toBe(true);
    await mixer.close();
  });

  it('supports late attachment, independent completion, and ID reuse', async () => {
    const mixer = createPcmAudioMixer();
    const first = source('speaker');
    await mixer.audioInputs.attach(first);
    await expect(mixer.audioInputs.attach(source('speaker'))).rejects.toThrow(
      'already attached',
    );
    await first.push(constantFrame(100));
    await first.push(constantFrame(100));
    first.close();
    await Promise.resolve();

    const replacement = source('speaker');
    await mixer.audioInputs.attach(replacement);
    expect(samplesOf(await nextFrame(mixer))[0]).toBe(100);
    const late = source('late');
    await mixer.audioInputs.attach(late);
    await Promise.all([
      replacement.push(constantFrame(200)),
      late.push(constantFrame(300)),
    ]);
    expect(samplesOf(await nextFrame(mixer))[0]).toBe(600);
    await mixer.close();
  });

  it.each([
    ['encoding', { encoding: 'pcm-f32le' }],
    ['sample rate', { sampleRateHz: 24_000 }],
    ['channel count', { channels: 2 }],
  ])('fails on an invalid %s', async (_name, overrides) => {
    const mixer = createPcmAudioMixer();
    const input = source('invalid');
    await mixer.audioInputs.attach(input);
    await input.push(Object.assign(frame(new Array(960).fill(0)), overrides));
    await expect(mixer.closed).resolves.toMatchObject({ type: 'failed' });
  });

  it('fails on empty or incomplete PCM samples', async () => {
    for (const data of [new Uint8Array(0), new Uint8Array(1)]) {
      const mixer = createPcmAudioMixer();
      const input = source(`invalid-${data.byteLength}`);
      await mixer.audioInputs.attach(input);
      await input.push({ ...constantFrame(0), data });
      await expect(mixer.closed).resolves.toMatchObject({ type: 'failed' });
    }
  });

  it('propagates source iterable failures', async () => {
    const mixer = createPcmAudioMixer();
    const input = source('failed');
    await mixer.audioInputs.attach(input);
    const failure = new Error('source failed');
    input.fail(failure);
    await expect(mixer.closed).resolves.toEqual({
      type: 'failed',
      error: failure,
    });
  });

  it('bounds source buffering while output consumption is slow', async () => {
    const mixer = createPcmAudioMixer({ sourceBufferMs: 20 });
    const input = source('backpressured', 1);
    await mixer.audioInputs.attach(input);
    const pushes = [1, 2, 3, 4].map((value) =>
      input.push(constantFrame(value)),
    );
    const fourthPush = pushes[3];
    if (!fourthPush) throw new Error('Expected a fourth input push');
    let fourthSettled = false;
    void fourthPush.then(() => {
      fourthSettled = true;
    });
    await Promise.resolve();
    expect(fourthSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() => expect(fourthSettled).toBe(true));
    await Promise.all(pushes);
    await mixer.close();
  });

  it('keeps playout on an absolute clock when a frame is backpressured', async () => {
    const mixer = createPcmAudioMixer({ sourceBufferMs: 100 });
    const input = source('clocked');
    await mixer.audioInputs.attach(input);
    await Promise.all(
      [1, 2, 3].map((value) => input.push(constantFrame(value))),
    );

    await vi.advanceTimersByTimeAsync(45);
    const iterator = mixer.audioOutput[Symbol.asyncIterator]();
    await iterator.next();
    await Promise.resolve();
    await iterator.next();
    const thirdPromise = iterator.next();
    let thirdSettled = false;
    void thirdPromise.then(() => {
      thirdSettled = true;
    });

    await vi.advanceTimersByTimeAsync(14);
    expect(thirdSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(thirdPromise).resolves.toMatchObject({
      value: { sequence: 2, timestampUs: 40_000 },
      done: false,
    });
    await mixer.close();
  });

  it('restarts the playout clock after draining while backpressured', async () => {
    const mixer = createPcmAudioMixer({ sourceBufferMs: 100 });
    const input = source('restarted');
    await mixer.audioInputs.attach(input);
    await Promise.all([1, 2].map((value) => input.push(constantFrame(value))));

    await vi.advanceTimersByTimeAsync(45);
    await input.push(constantFrame(3));
    await vi.advanceTimersByTimeAsync(55);

    const iterator = mixer.audioOutput[Symbol.asyncIterator]();
    await iterator.next();
    await Promise.resolve();
    await iterator.next();
    const thirdPromise = iterator.next();
    let thirdSettled = false;
    void thirdPromise.then(() => {
      thirdSettled = true;
    });

    await vi.advanceTimersByTimeAsync(19);
    expect(thirdSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(thirdPromise).resolves.toMatchObject({
      value: { sequence: 2, timestampUs: 40_000 },
      done: false,
    });
    await mixer.close();
  });

  it('serializes playout while output is backpressured', async () => {
    const mixer = createPcmAudioMixer({ sourceBufferMs: 100 });
    const input = source('buffered');
    await mixer.audioInputs.attach(input);
    await Promise.all(
      [1, 2, 3, 4].map((value) => input.push(constantFrame(value))),
    );

    await vi.advanceTimersByTimeAsync(100);
    const iterator = mixer.audioOutput[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    const thirdPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const third = await thirdPromise;

    expect([first, second, third]).toMatchObject([
      { value: { sequence: 0, timestampUs: 0 }, done: false },
      { value: { sequence: 1, timestampUs: 20_000 }, done: false },
      { value: { sequence: 2, timestampUs: 40_000 }, done: false },
    ]);
    await mixer.close();
  });

  it('closes idempotently and rejects later attachment', async () => {
    const mixer = createPcmAudioMixer();
    const input = source('blocked');
    await mixer.audioInputs.attach(input);
    await Promise.all([mixer.close(), mixer.close()]);
    await expect(mixer.closed).resolves.toMatchObject({ type: 'closed' });
    await expect(mixer.audioInputs.attach(source('late'))).rejects.toThrow(
      'closed',
    );
  });
});
