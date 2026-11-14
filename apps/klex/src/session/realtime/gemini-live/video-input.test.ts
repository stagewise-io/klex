import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EncodedImageFrame } from '../model-session';
import { GeminiLiveVideoInput } from './video-input';

function still(detail: 'low' | 'high' = 'high'): EncodedImageFrame {
  return {
    mimeType: 'image/jpeg',
    width: 1024,
    height: 576,
    timestampUs: 1,
    detail,
    data: new Uint8Array([0xff, 0xd8, 0xff]),
  };
}

function harness() {
  const frames: object[] = [];
  const descriptions: string[] = [];
  const state = { now: 0, busy: false, owed: false, sendSucceeds: true };
  const input = new GeminiLiveVideoInput({
    sendFrame: (message) => {
      if (!state.sendSucceeds) return false;
      frames.push(message);
      return true;
    },
    sendDescription: (text) => descriptions.push(text),
    isModelSpeaking: () => state.busy,
    isResponseOwed: () => state.owed,
    now: () => state.now,
  });
  return { input, frames, descriptions, state };
}

describe('GeminiLiveVideoInput', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends JPEG stills as realtime video with per-frame resolution', async () => {
    const { input, frames } = harness();
    input.connectionReady();
    await input.write(still('high'));
    await input.write(still('low'));
    expect(frames).toEqual([
      {
        realtimeInput: {
          video: { data: '/9j/', mimeType: 'image/jpeg' },
          mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' },
        },
      },
      {
        realtimeInput: {
          video: { data: '/9j/', mimeType: 'image/jpeg' },
          mediaResolution: { level: 'MEDIA_RESOLUTION_LOW' },
        },
      },
    ]);
    expect(input.stats()).toEqual({ framesSent: 2, framesResent: 0 });
  });

  it('rejects empty frames', async () => {
    const { input } = harness();
    await expect(
      input.write({ ...still(), data: new Uint8Array() }),
    ).rejects.toThrow('non-empty JPEG');
  });

  it('counts only frames the connection accepted', async () => {
    const { input, state } = harness();
    input.connectionReady();
    state.sendSucceeds = false;
    await input.write(still());
    expect(input.stats().framesSent).toBe(0);
  });

  it('holds frames while disconnected and resends the latest fresh one on reconnect', async () => {
    const { input, frames, state } = harness();
    input.connectionReady();
    input.connectionLost();
    await input.write(still());
    expect(frames).toEqual([]);
    state.now += 10_000;
    input.connectionReady();
    expect(frames).toHaveLength(1);
    expect(input.stats()).toEqual({ framesSent: 0, framesResent: 1 });
  });

  it('does not resend a stale frame', async () => {
    const { input, frames, state } = harness();
    input.connectionReady();
    await input.write(still());
    input.connectionLost();
    state.now += 30_001;
    input.connectionReady();
    expect(frames).toHaveLength(1);
  });

  it('defers descriptions until connected and the model is idle', async () => {
    const { input, descriptions, state } = harness();
    await input.describe('Dana started sharing.');
    expect(descriptions).toEqual([]);
    state.busy = true;
    input.connectionReady();
    await input.describe('Still sharing.');
    expect(descriptions).toEqual([]);
    state.busy = false;
    input.modelIdle();
    expect(descriptions).toEqual(['Dana started sharing.\nStill sharing.']);
  });

  it('waits a bounded time for an owed response that never starts', async () => {
    vi.useFakeTimers();
    const { input, descriptions, state } = harness();
    state.owed = true;
    input.connectionReady();
    await input.describe('Dana started sharing.');
    state.now += 9_999;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(descriptions).toEqual([]);
    state.now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(descriptions).toEqual(['Dana started sharing.']);
  });

  it('keeps waiting past the bound while the model speaks', async () => {
    vi.useFakeTimers();
    const { input, descriptions, state } = harness();
    state.owed = true;
    input.connectionReady();
    await input.describe('Dana started sharing.');
    state.busy = true;
    state.now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(descriptions).toEqual([]);
    state.busy = false;
    state.owed = false;
    input.modelIdle();
    expect(descriptions).toEqual(['Dana started sharing.']);
  });

  it('flushes a long-deferred description on the next connection', async () => {
    vi.useFakeTimers();
    const { input, descriptions, state } = harness();
    state.owed = true;
    await input.describe('Dana started sharing.');
    state.now += 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(descriptions).toEqual([]);
    input.connectionReady();
    expect(descriptions).toEqual(['Dana started sharing.']);
  });

  it('keeps descriptions when setup was implied by model audio', async () => {
    const { input, descriptions } = harness();
    await input.describe('Dana started sharing.');
    input.connectionReady({ flushDescriptions: false });
    expect(descriptions).toEqual([]);
    input.modelIdle();
    expect(descriptions).toEqual(['Dana started sharing.']);
  });

  it('drops frames and descriptions after close', async () => {
    const { input, frames, descriptions } = harness();
    input.connectionReady();
    input.close();
    await input.write(still());
    await input.describe('ignored');
    input.connectionReady();
    expect(frames).toEqual([]);
    expect(descriptions).toEqual([]);
  });
});
