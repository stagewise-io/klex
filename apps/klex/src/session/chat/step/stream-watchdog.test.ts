import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GenerationStallError } from '@/utils/llm';

import { resolveStreamDeadlines } from './stream-deadlines';
import { StreamWatchdog } from './stream-watchdog';

const deadlines = { firstOutputMs: 100, idleMs: 50 };

describe('StreamWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stalls at the response stage when the provider never responds', () => {
    const watchdog = new StreamWatchdog(deadlines);
    vi.advanceTimersByTime(99);
    expect(watchdog.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(watchdog.signal.reason).toBe(watchdog.stall);
    expect(watchdog.stall).toBeInstanceOf(GenerationStallError);
    expect(watchdog.stall).toMatchObject({
      stage: 'response',
      elapsedMs: 100,
      budgetMs: 100,
    });
  });

  it('counts the header wait against the first-output budget', () => {
    const watchdog = new StreamWatchdog(deadlines);
    vi.advanceTimersByTime(80);
    watchdog.record('response');
    vi.advanceTimersByTime(20);
    expect(watchdog.stall).toMatchObject({ stage: 'first-output' });
    expect(watchdog.timeToResponseMs).toBe(80);
    expect(watchdog.timeToFirstOutputMs).toBeUndefined();
  });

  it('resets on every usable output and stalls when output stops', () => {
    const watchdog = new StreamWatchdog(deadlines);
    vi.advanceTimersByTime(90);
    expect(watchdog.record('output')).toBe(true);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(49);
      expect(watchdog.record('output')).toBe(false);
    }
    expect(watchdog.signal.aborted).toBe(false);
    vi.advanceTimersByTime(50);
    expect(watchdog.stall).toMatchObject({
      stage: 'idle',
      elapsedMs: 90 + 490 + 50,
      budgetMs: 50,
    });
    expect(watchdog.timeToFirstOutputMs).toBe(90);
  });

  it('never fires after stop', () => {
    const watchdog = new StreamWatchdog(deadlines);
    watchdog.stop();
    vi.advanceTimersByTime(1_000);
    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.record('output')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('resolveStreamDeadlines', () => {
  it('gives models that may think silently the longer budgets', () => {
    expect(
      resolveStreamDeadlines({ providerType: 'google-generative' }),
    ).toEqual({ firstOutputMs: 180_000, idleMs: 120_000 });
    expect(
      resolveStreamDeadlines({
        providerType: 'responses',
        capabilities: { reasoning: false },
      }),
    ).toEqual({ firstOutputMs: 60_000, idleMs: 60_000 });
  });

  it('scales reasoning budgets with the applied effort', () => {
    const at = (
      effort: Parameters<typeof resolveStreamDeadlines>[0]['effort'],
    ) =>
      resolveStreamDeadlines({
        providerType: 'anthropic-messages',
        capabilities: { reasoning: true },
        effort,
      });
    expect(at('low')).toEqual({ firstOutputMs: 135_000, idleMs: 90_000 });
    expect(at('high')).toEqual({ firstOutputMs: 270_000, idleMs: 180_000 });
    expect(at('exceptional')).toEqual({
      firstOutputMs: 360_000,
      idleMs: 240_000,
    });
    expect(at('off')).toEqual({ firstOutputMs: 60_000, idleMs: 60_000 });
  });

  it('extends the first-output budget for local model servers', () => {
    expect(
      resolveStreamDeadlines({
        providerType: 'ollama',
        capabilities: { reasoning: false },
      }),
    ).toEqual({ firstOutputMs: 120_000, idleMs: 60_000 });
  });
});
