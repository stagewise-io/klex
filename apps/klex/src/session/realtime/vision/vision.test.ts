import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type {
  RawVideoFrame,
  RealtimeEndpointClosure,
  VideoSource,
  VideoSourceDescriptor,
  VideoSourceKind,
} from '@/media-transport';
import { BoundedAsyncQueue } from '@/media-transport/async-queue';

import type { EncodedImageFrame, RealtimeVideoInput } from '../model-session';
import { createRealtimeVision } from './vision';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
} as unknown as ModuleLogger;

function rawFrame(sequence: number, shade: number): RawVideoFrame {
  const width = 64;
  const height = 36;
  return {
    encoding: 'rgba',
    width,
    height,
    rotation: 0,
    sequence,
    timestampUs: sequence * 1_000,
    data: new Uint8Array(width * height * 4).fill(shade),
  };
}

class FakeDescriptor implements VideoSourceDescriptor {
  readonly closed: Promise<RealtimeEndpointClosure>;
  readonly opened: FakeSource[] = [];
  private resolveClosed!: (closure: RealtimeEndpointClosure) => void;

  constructor(
    readonly id: string,
    kind: VideoSourceKind,
    displayName?: string,
  ) {
    this.metadata = { participantId: id, trackId: id, kind, displayName };
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  readonly metadata: VideoSourceDescriptor['metadata'];

  open(): VideoSource {
    const source = new FakeSource(this.id, this.metadata);
    this.opened.push(source);
    return source;
  }

  async unpublish(): Promise<void> {
    await Promise.all(this.opened.map((source) => source.close()));
    this.resolveClosed({ type: 'closed', reason: 'track-unpublished' });
  }
}

class FakeSource implements VideoSource {
  readonly queue = new BoundedAsyncQueue<RawVideoFrame>(1, {
    overflow: 'drop-oldest',
  });
  readonly readable = this.queue;
  readonly closed = new Promise<RealtimeEndpointClosure>(() => undefined);
  isClosed = false;

  constructor(
    readonly id: string,
    readonly metadata: VideoSourceDescriptor['metadata'],
  ) {}

  push(frame: RawVideoFrame): void {
    void this.queue.push(frame);
  }

  async close(): Promise<void> {
    this.isClosed = true;
    this.queue.close();
  }
}

class Discovery implements AsyncIterable<VideoSourceDescriptor> {
  private readonly queue = new BoundedAsyncQueue<VideoSourceDescriptor>(8);
  add(descriptor: VideoSourceDescriptor): void {
    void this.queue.push(descriptor);
  }
  end(): void {
    this.queue.close();
  }
  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]();
  }
}

function fakeInput() {
  const frames: EncodedImageFrame[] = [];
  const descriptions: string[] = [];
  const gate = {
    held: undefined as Promise<void> | undefined,
    /** Extra microtasks before a matching note resolves. */
    delay: { match: '', ticks: 0 },
  };
  const input: RealtimeVideoInput = {
    maxFps: 1,
    write: vi.fn(async (frame: EncodedImageFrame) => {
      frames.push(frame);
    }),
    describe: vi.fn(async (text: string) => {
      descriptions.push(text);
      await gate.held;
      if (gate.delay.match && text.includes(gate.delay.match))
        for (let tick = 0; tick < gate.delay.ticks; tick += 1) await null;
    }),
  };
  return { input, frames, descriptions, gate };
}

function setup() {
  const discovery = new Discovery();
  const { input, frames, descriptions, gate } = fakeInput();
  let now = 0;
  const encode = vi.fn(async (frame: RawVideoFrame) => ({
    width: frame.width,
    height: frame.height,
    data: new Uint8Array([frame.data[0] ?? 0]),
  }));
  const vision = createRealtimeVision({
    logger,
    sources: discovery,
    input,
    encode,
    now: () => now,
  });
  const running = vision.run();
  return {
    discovery,
    vision,
    running,
    frames,
    descriptions,
    gate,
    encode,
    async tick(ms = 1_000) {
      now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}

describe('RealtimeVision', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('focuses a screen share, describes it, and sends sampled stills', async () => {
    const harness = setup();
    const share = new FakeDescriptor('share', 'screenshare', 'Dana');
    harness.discovery.add(share);
    await vi.waitFor(() => expect(share.opened).toHaveLength(1));
    expect(harness.descriptions[0]).toContain('Dana started sharing');

    share.opened[0]?.push(rawFrame(1, 10));
    await harness.tick();
    expect(harness.frames).toHaveLength(1);
    expect(harness.frames[0]).toMatchObject({
      mimeType: 'image/jpeg',
      width: 64,
      height: 36,
      detail: 'high',
    });
    expect(harness.encode).toHaveBeenCalledWith(expect.anything(), {
      maxLongEdge: 1024,
      quality: 75,
    });
    await harness.vision.close();
  });

  it('ignores cameras in phase one', async () => {
    const harness = setup();
    const camera = new FakeDescriptor('camera', 'camera');
    harness.discovery.add(camera);
    await harness.tick();
    expect(camera.opened).toHaveLength(0);
    expect(harness.descriptions).toEqual([]);
    await harness.vision.close();
  });

  it('skips unchanged frames until the keyframe interval passes', async () => {
    const harness = setup();
    const share = new FakeDescriptor('share', 'screenshare');
    harness.discovery.add(share);
    await vi.waitFor(() => expect(share.opened).toHaveLength(1));
    const source = share.opened[0];

    source?.push(rawFrame(1, 10));
    await harness.tick();
    source?.push(rawFrame(2, 12));
    await harness.tick();
    expect(harness.frames).toHaveLength(1);

    source?.push(rawFrame(3, 200));
    await harness.tick();
    expect(harness.frames).toHaveLength(2);

    await harness.tick(5_000);
    expect(harness.frames).toHaveLength(3);
    await harness.vision.close();
  });

  it('switches to the newest share and back when it stops', async () => {
    const harness = setup();
    const first = new FakeDescriptor('first', 'screenshare', 'Dana');
    const second = new FakeDescriptor('second', 'screenshare', 'Lee');
    harness.discovery.add(first);
    await vi.waitFor(() => expect(first.opened).toHaveLength(1));
    harness.discovery.add(second);
    await vi.waitFor(() => expect(second.opened).toHaveLength(1));
    expect(first.opened[0]?.isClosed).toBe(true);

    await second.unpublish();
    await vi.waitFor(() => expect(first.opened).toHaveLength(2));
    expect(harness.descriptions).toEqual([
      expect.stringContaining('Dana started sharing'),
      expect.stringContaining('Lee started sharing'),
      '[Video] Lee stopped sharing their screen. You can no longer see it.',
      "[Video] You now see Dana's shared screen again.",
    ]);
    await harness.vision.close();
  });

  it('reopens a source whose stream ended while the track is still published', async () => {
    const harness = setup();
    const share = new FakeDescriptor('share', 'screenshare');
    harness.discovery.add(share);
    await vi.waitFor(() => expect(share.opened).toHaveLength(1));
    await share.opened[0]?.close();
    await harness.tick();
    expect(share.opened).toHaveLength(2);
    expect(harness.descriptions).toHaveLength(1);
    await harness.vision.close();
  });

  it('keeps one source open when refocus and discovery race', async () => {
    // Shifting the stop note moves the refocus across discovery's focus.
    for (let ticks = 0; ticks < 8; ticks += 1) {
      const harness = setup();
      const first = new FakeDescriptor('first', 'screenshare', 'Dana');
      const second = new FakeDescriptor('second', 'screenshare', 'Lee');
      const third = new FakeDescriptor('third', 'screenshare', 'Kim');
      const all = [first, second, third];
      harness.discovery.add(first);
      await vi.waitFor(() => expect(first.opened).toHaveLength(1));
      let release!: () => void;
      harness.gate.held = new Promise((resolve) => {
        release = resolve;
      });
      harness.gate.delay = { match: 'stopped sharing', ticks };
      harness.discovery.add(second);
      await vi.waitFor(() => expect(second.opened).toHaveLength(1));
      await second.unpublish();
      harness.discovery.add(third);
      harness.gate.held = undefined;
      release();
      await harness.tick();
      await harness.tick();

      const open = all.flatMap((descriptor) =>
        descriptor.opened.filter((source) => !source.isClosed),
      );
      expect(open, `with ${ticks} extra ticks`).toHaveLength(1);
      await harness.vision.close();
      expect(
        all.every((descriptor) =>
          descriptor.opened.every((source) => source.isClosed),
        ),
      ).toBe(true);
    }
  });

  it('closes the focused source and returns from run on close', async () => {
    const harness = setup();
    const share = new FakeDescriptor('share', 'screenshare');
    harness.discovery.add(share);
    await vi.waitFor(() => expect(share.opened).toHaveLength(1));
    await harness.vision.close();
    expect(share.opened[0]?.isClosed).toBe(true);
    harness.discovery.end();
    await expect(harness.running).resolves.toBeUndefined();
  });
});
