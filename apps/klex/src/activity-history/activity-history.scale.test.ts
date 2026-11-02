import { performance } from 'node:perf_hooks';

import { expect, it, vi } from 'vitest';

import type { ExtendedUIMessage } from '@/session/chat/message-types';

import { activityOrdinal } from './activity-history';
import { createActivityFixture, TEST_ACTIVITY_LIMITS } from './test-support';

it('bounds body reads and consumer catch-up over 10,000 retained messages', async () => {
  const fixture = await createActivityFixture();
  try {
    const messages: ExtendedUIMessage[] = Array.from(
      { length: 10_000 },
      (_, index) => ({
        id: `scale-${index}`,
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text: `Evidence ${index}: ${'bounded activity '.repeat(80)}`,
          },
        ],
      }),
    );
    await fixture.sync(messages);
    const start = performance.now();
    const manifest = await fixture.activities.manifest();
    const manifestMs = performance.now() - start;
    expect(manifest).toHaveLength(10_000);
    expect(manifest.every((source) => !('message' in source))).toBe(true);

    const read = vi.spyOn(fixture.history, 'readActivity');
    const recentStart = performance.now();
    const latest = await fixture.activities.latest(20);
    const latestMs = performance.now() - recentStart;
    expect(latest).toHaveLength(20);
    expect(await read.mock.results[0]?.value).toEqual(
      latest.map((source) => ({ ...source, message: null })),
    );
    expect(read).toHaveBeenLastCalledWith({
      descending: true,
      limit: 20,
      maxBytes: 0,
    });

    const catchupStart = performance.now();
    const batch = await fixture.activities.readPending(
      manifest[9_899]?.id ?? null,
      {
        ...TEST_ACTIVITY_LIMITS,
        maxCharacters: 1_000_000,
        active: false,
        now: fixture.now() + 600_000,
        lastActivityAt: 0,
      },
    );
    const catchupMs = performance.now() - catchupStart;
    expect(batch?.text).toContain('Evidence 9900');
    expect(batch?.text).toContain('Evidence 9999');
    expect(batch?.text).not.toContain('Evidence 9899');
    expect(activityOrdinal(batch?.id ?? null)).toBe(9_999);
    expect(batch?.scannedBytes).toBeLessThanOrEqual(2_000_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await read.mock.results[1]?.value)?.length).toBe(100);
    // Observational timing, not a hardware-dependent/flaky CI latency assertion.
    console.info('activity scale (10,000 sources)', {
      manifestMs,
      latestMs,
      catchupMs,
    });
  } finally {
    await fixture.close();
  }
}, 30_000);
