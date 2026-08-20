import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@stagewise/logger';

import { createModelCallLogger } from './model-call-logger';
import type { ModelCallRecord } from './types';

const logger = createLogger({ name: 'test' });

const directories: string[] = [];

function makeRecord(overrides: Partial<ModelCallRecord> = {}): ModelCallRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    sessionId: 'session-001',
    providerId: 'openai',
    endpointId: 'default',
    modelId: 'gpt-4o',
    source: 'chat',
    extensionId: null,
    inputTokens: 100,
    outputTokens: 50,
    inputCacheWriteTokens: 10,
    inputCacheReadTokens: 20,
    ttftMs: 500,
    totalDurationMs: 2000,
    finishReason: 'stop',
    isError: false,
    errorType: null,
    startedAt: now.toISOString(),
    finishedAt: new Date(now.getTime() + 2000).toISOString(),
    ...overrides,
  };
}

async function createLoggerModule() {
  const directory = await mkdtemp(join(tmpdir(), 'klex-modelcall-'));
  directories.push(directory);
  const module = createModelCallLogger({
    logging: logger,
    dataDirectory: directory,
  });
  await module.start();
  return { directory, module };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelCallLogger', () => {
  describe('recordCall + queryUsage with event granularity', () => {
    it('returns recorded calls as individual data points', async () => {
      const { module } = await createLoggerModule();

      const record1 = makeRecord({
        id: 'call-001',
        inputTokens: 200,
        outputTokens: 100,
        startedAt: '2026-08-14T10:00:00.000Z',
        finishedAt: '2026-08-14T10:00:02.000Z',
      });
      const record2 = makeRecord({
        id: 'call-002',
        inputTokens: 300,
        outputTokens: 150,
        startedAt: '2026-08-14T11:00:00.000Z',
        finishedAt: '2026-08-14T11:00:03.000Z',
      });

      module.recordCall(record1);
      module.recordCall(record2);
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: null,
        to: null,
        granularity: 'event',
        limit: 1000,
      });

      expect(result).toHaveLength(2);
      expect(
        result.every((dp) => dp.callCount === 1 && dp.bucket === null),
      ).toBe(true);
      expect(result.some((dp) => dp.inputTokens === 200)).toBe(true);
      expect(result.some((dp) => dp.inputTokens === 300)).toBe(true);
      // Event-level fields should be populated
      expect(
        result.every(
          (dp) =>
            dp.id != null &&
            dp.sessionId != null &&
            dp.providerId != null &&
            dp.modelId != null &&
            dp.source != null &&
            dp.startedAt != null &&
            dp.finishedAt != null,
        ),
      ).toBe(true);

      await module.close();
    });

    it('populates splitKey for event granularity with splitBy', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-1',
          modelId: 'gpt-4o',
          providerId: 'openai',
          endpointId: 'default',
          startedAt: '2026-08-14T10:00:00.000Z',
          finishedAt: '2026-08-14T10:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-2',
          modelId: 'claude-3-5-sonnet',
          providerId: 'anthropic',
          endpointId: 'default',
          startedAt: '2026-08-14T11:00:00.000Z',
          finishedAt: '2026-08-14T11:00:01.000Z',
        }),
      );
      await module.flush();

      // splitBy=model
      const byModel = await module.queryUsage({
        splitBy: 'model',
        from: null,
        to: null,
        granularity: 'event',
        limit: 1000,
      });
      expect(byModel).toHaveLength(2);
      expect(byModel.find((dp) => dp.id === 'call-1')?.splitKey).toBe('gpt-4o');
      expect(byModel.find((dp) => dp.id === 'call-2')?.splitKey).toBe(
        'claude-3-5-sonnet',
      );

      // splitBy=provider
      const byProvider = await module.queryUsage({
        splitBy: 'provider',
        from: null,
        to: null,
        granularity: 'event',
        limit: 1000,
      });
      expect(byProvider.find((dp) => dp.id === 'call-1')?.splitKey).toBe(
        'openai',
      );
      expect(byProvider.find((dp) => dp.id === 'call-2')?.splitKey).toBe(
        'anthropic',
      );

      // splitBy=none → null
      const noSplit = await module.queryUsage({
        splitBy: 'none',
        from: null,
        to: null,
        granularity: 'event',
        limit: 1000,
      });
      expect(noSplit.every((dp) => dp.splitKey === null)).toBe(true);

      await module.close();
    });

    it('filters by time range', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-old',
          inputTokens: 999,
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-new',
          inputTokens: 888,
          startedAt: '2026-08-14T00:00:00.000Z',
          finishedAt: '2026-08-14T00:00:01.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: '2026-06-01T00:00:00.000Z',
        to: null,
        granularity: 'event',
        limit: 1000,
      });

      // Should only include the August record, not the January one
      expect(result).toHaveLength(1);
      expect(result[0]!.inputTokens).toBe(888);

      await module.close();
    });

    it('respects the limit parameter', async () => {
      const { module } = await createLoggerModule();

      for (let i = 0; i < 10; i++) {
        module.recordCall(
          makeRecord({
            id: `call-${i}`,
            startedAt: new Date(2026, 7, 14, 10, i).toISOString(),
            finishedAt: new Date(2026, 7, 14, 10, i, 1).toISOString(),
          }),
        );
      }
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: null,
        to: null,
        granularity: 'event',
        limit: 5,
      });

      expect(result).toHaveLength(5);

      await module.close();
    });
  });

  describe('queryUsage with aggregated granularity', () => {
    it('aggregates by day with daily granularity', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-1',
          inputTokens: 100,
          outputTokens: 50,
          startedAt: '2026-08-14T10:00:00.000Z',
          finishedAt: '2026-08-14T10:00:02.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-2',
          inputTokens: 200,
          outputTokens: 100,
          startedAt: '2026-08-14T14:00:00.000Z',
          finishedAt: '2026-08-14T14:00:03.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-3',
          inputTokens: 400,
          outputTokens: 200,
          startedAt: '2026-08-15T10:00:00.000Z',
          finishedAt: '2026-08-15T10:00:04.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: '2026-08-14T00:00:00.000Z',
        to: '2026-08-16T00:00:00.000Z',
        granularity: 'daily',
        limit: 1000,
      });

      expect(result).toHaveLength(2);

      const day14 = result.find((dp) => dp.bucket === '2026-08-14');
      const day15 = result.find((dp) => dp.bucket === '2026-08-15');

      expect(day14).toBeDefined();
      expect(day14?.callCount).toBe(2);
      expect(day14?.inputTokens).toBe(300);
      expect(day14?.outputTokens).toBe(150);
      expect(day14?.inputCacheWriteTokens).toBe(20);
      expect(day14?.inputCacheReadTokens).toBe(40);

      expect(day15).toBeDefined();
      expect(day15?.callCount).toBe(1);
      expect(day15?.inputTokens).toBe(400);

      await module.close();
    });

    it('aggregates by hour with hourly granularity', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-1',
          inputTokens: 100,
          startedAt: '2026-08-14T10:00:00.000Z',
          finishedAt: '2026-08-14T10:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-2',
          inputTokens: 200,
          startedAt: '2026-08-14T10:30:00.000Z',
          finishedAt: '2026-08-14T10:30:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-3',
          inputTokens: 400,
          startedAt: '2026-08-14T11:00:00.000Z',
          finishedAt: '2026-08-14T11:00:01.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: '2026-08-14T00:00:00.000Z',
        to: '2026-08-15T00:00:00.000Z',
        granularity: 'hourly',
        limit: 1000,
      });

      const hour10 = result.find((dp) => dp.bucket === '2026-08-14T10:00:00');
      const hour11 = result.find((dp) => dp.bucket === '2026-08-14T11:00:00');

      expect(hour10).toBeDefined();
      expect(hour10?.callCount).toBe(2);
      expect(hour10?.inputTokens).toBe(300);

      expect(hour11).toBeDefined();
      expect(hour11?.callCount).toBe(1);
      expect(hour11?.inputTokens).toBe(400);

      await module.close();
    });

    it('aggregates by week with weekly granularity', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-1',
          inputTokens: 100,
          startedAt: '2026-08-11T10:00:00.000Z',
          finishedAt: '2026-08-11T10:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-2',
          inputTokens: 200,
          startedAt: '2026-08-13T14:00:00.000Z',
          finishedAt: '2026-08-13T14:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-3',
          inputTokens: 400,
          startedAt: '2026-08-18T10:00:00.000Z',
          finishedAt: '2026-08-18T10:00:01.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
        granularity: 'weekly',
        limit: 1000,
      });

      // Aug 11 (Tue) and Aug 13 (Thu) fall in the week starting Mon Aug 10.
      // Aug 18 (Tue) falls in the week starting Mon Aug 17.
      const week1 = result.find((dp) => dp.bucket === '2026-08-10');
      const week2 = result.find((dp) => dp.bucket === '2026-08-17');

      expect(week1).toBeDefined();
      expect(week1?.callCount).toBe(2);
      expect(week1?.inputTokens).toBe(300);

      expect(week2).toBeDefined();
      expect(week2?.callCount).toBe(1);
      expect(week2?.inputTokens).toBe(400);

      await module.close();
    });

    it('groups by model when splitBy=model', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-1',
          providerId: 'openai',
          modelId: 'gpt-4o',
          inputTokens: 100,
          startedAt: '2026-08-14T10:00:00.000Z',
          finishedAt: '2026-08-14T10:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-2',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          inputTokens: 200,
          startedAt: '2026-08-14T11:00:00.000Z',
          finishedAt: '2026-08-14T11:00:01.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'model',
        from: '2026-08-14T00:00:00.000Z',
        to: '2026-08-15T00:00:00.000Z',
        granularity: 'daily',
        limit: 1000,
      });

      const gpt4o = result.find((dp) => dp.splitKey === 'gpt-4o');
      const gpt4oMini = result.find((dp) => dp.splitKey === 'gpt-4o-mini');

      expect(gpt4o).toBeDefined();
      expect(gpt4o?.inputTokens).toBe(100);
      expect(gpt4oMini).toBeDefined();
      expect(gpt4oMini?.inputTokens).toBe(200);

      await module.close();
    });

    it('groups by provider when splitBy=provider', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-1',
          providerId: 'openai',
          inputTokens: 100,
          startedAt: '2026-08-14T10:00:00.000Z',
          finishedAt: '2026-08-14T10:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-2',
          providerId: 'anthropic',
          inputTokens: 200,
          startedAt: '2026-08-14T11:00:00.000Z',
          finishedAt: '2026-08-14T11:00:01.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'provider',
        from: '2026-08-14T00:00:00.000Z',
        to: '2026-08-15T00:00:00.000Z',
        granularity: 'daily',
        limit: 1000,
      });

      const openai = result.find((dp) => dp.splitKey === 'openai');
      const anthropic = result.find((dp) => dp.splitKey === 'anthropic');

      expect(openai).toBeDefined();
      expect(openai?.inputTokens).toBe(100);
      expect(anthropic).toBeDefined();
      expect(anthropic?.inputTokens).toBe(200);

      await module.close();
    });

    it('groups by endpoint when splitBy=endpoint', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-1',
          providerId: 'openai',
          endpointId: 'default',
          modelId: 'gpt-4o',
          inputTokens: 100,
          startedAt: '2026-08-14T10:00:00.000Z',
          finishedAt: '2026-08-14T10:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-2',
          providerId: 'openai',
          endpointId: 'eu-proxy',
          modelId: 'gpt-4o',
          inputTokens: 200,
          startedAt: '2026-08-14T11:00:00.000Z',
          finishedAt: '2026-08-14T11:00:01.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'endpoint',
        from: '2026-08-14T00:00:00.000Z',
        to: '2026-08-15T00:00:00.000Z',
        granularity: 'daily',
        limit: 1000,
      });

      const defaultEp = result.find((dp) => dp.splitKey === 'default');
      const euProxy = result.find((dp) => dp.splitKey === 'eu-proxy');

      expect(defaultEp).toBeDefined();
      expect(defaultEp?.inputTokens).toBe(100);
      expect(euProxy).toBeDefined();
      expect(euProxy?.inputTokens).toBe(200);

      await module.close();
    });

    it('counts errors correctly', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-ok',
          isError: false,
          inputTokens: 100,
          startedAt: '2026-08-14T10:00:00.000Z',
          finishedAt: '2026-08-14T10:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-err',
          isError: true,
          errorType: 'generation_error',
          inputTokens: 50,
          finishReason: 'error',
          startedAt: '2026-08-14T11:00:00.000Z',
          finishedAt: '2026-08-14T11:00:01.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: '2026-08-14T00:00:00.000Z',
        to: '2026-08-15T00:00:00.000Z',
        granularity: 'daily',
        limit: 1000,
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.errorCount).toBe(1);
      expect(result[0]!.callCount).toBe(2);

      await module.close();
    });
  });

  describe('queryUsage edge cases', () => {
    it('filters by "to" date alone', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-old',
          inputTokens: 111,
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-new',
          inputTokens: 222,
          startedAt: '2026-08-14T00:00:00.000Z',
          finishedAt: '2026-08-14T00:00:01.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: null,
        to: '2026-06-01T00:00:00.000Z',
        granularity: 'event',
        limit: 1000,
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.inputTokens).toBe(111);

      await module.close();
    });

    it('combines from + to with daily aggregation', async () => {
      const { module } = await createLoggerModule();

      for (let i = 0; i < 5; i++) {
        const day = i + 1;
        module.recordCall(
          makeRecord({
            id: `call-${i}`,
            inputTokens: 100 + i,
            startedAt: `2026-08-${day.toString().padStart(2, '0')}T10:00:00.000Z`,
            finishedAt: `2026-08-${day.toString().padStart(2, '0')}T10:00:01.000Z`,
          }),
        );
      }
      await module.flush();

      // Only Aug 2–4
      const result = await module.queryUsage({
        splitBy: 'none',
        from: '2026-08-02T00:00:00.000Z',
        to: '2026-08-05T00:00:00.000Z',
        granularity: 'daily',
        limit: 1000,
      });

      expect(result).toHaveLength(3);
      expect(result[0]!.bucket).toBe('2026-08-02');
      expect(result[2]!.bucket).toBe('2026-08-04');
      // inputTokens: 100+1, 100+2, 100+3
      expect(result[0]!.inputTokens).toBe(101);
      expect(result[1]!.inputTokens).toBe(102);
      expect(result[2]!.inputTokens).toBe(103);

      await module.close();
    });

    it('averages ttftMs and totalDurationMs in aggregated queries', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-1',
          ttftMs: 100,
          totalDurationMs: 1000,
          startedAt: '2026-08-14T10:00:00.000Z',
          finishedAt: '2026-08-14T10:00:01.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-2',
          ttftMs: 300,
          totalDurationMs: 3000,
          startedAt: '2026-08-14T14:00:00.000Z',
          finishedAt: '2026-08-14T14:00:03.000Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: '2026-08-14T00:00:00.000Z',
        to: '2026-08-15T00:00:00.000Z',
        granularity: 'daily',
        limit: 1000,
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.ttftMs).toBe(200); // avg(100, 300)
      expect(result[0]!.totalDurationMs).toBe(2000); // avg(1000, 3000)

      await module.close();
    });

    it('handles null ttftMs and totalDurationMs in aggregation', async () => {
      const { module } = await createLoggerModule();

      module.recordCall(
        makeRecord({
          id: 'call-1',
          ttftMs: 200,
          totalDurationMs: 2000,
          startedAt: '2026-08-14T10:00:00.000Z',
          finishedAt: '2026-08-14T10:00:02.000Z',
        }),
      );
      module.recordCall(
        makeRecord({
          id: 'call-2',
          ttftMs: null,
          totalDurationMs: null,
          startedAt: '2026-08-14T14:00:00.000Z',
          finishedAt: '2026-08-14T14:00:00.500Z',
        }),
      );
      await module.flush();

      const result = await module.queryUsage({
        splitBy: 'none',
        from: '2026-08-14T00:00:00.000Z',
        to: '2026-08-15T00:00:00.000Z',
        granularity: 'daily',
        limit: 1000,
      });

      expect(result).toHaveLength(1);
      // SQLite AVG ignores NULLs, so this is avg(200) = 200, not avg(200, 0)
      expect(result[0]!.ttftMs).toBe(200);
      expect(result[0]!.totalDurationMs).toBe(2000);

      await module.close();
    });
  });

  describe('recordCall safety', () => {
    it('recordCall before start() is a no-op (does not throw)', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'klex-modelcall-'));
      directories.push(directory);
      const module = createModelCallLogger({
        logging: logger,
        dataDirectory: directory,
      });

      // Should not throw — just silently dropped
      expect(() =>
        module.recordCall(makeRecord({ id: 'pre-start-call' })),
      ).not.toThrow();

      await module.close();
    });
  });

  describe('retention cleanup', () => {
    it('deletes rows older than 365 days on startup', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'klex-modelcall-'));
      directories.push(directory);

      // First instance: record an old call and a recent call
      const module1 = createModelCallLogger({
        logging: logger,
        dataDirectory: directory,
      });
      await module1.start();

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 400);
      const recentDate = new Date();

      module1.recordCall(
        makeRecord({
          id: 'call-old',
          inputTokens: 777,
          startedAt: oldDate.toISOString(),
          finishedAt: oldDate.toISOString(),
        }),
      );
      module1.recordCall(
        makeRecord({
          id: 'call-recent',
          inputTokens: 888,
          startedAt: recentDate.toISOString(),
          finishedAt: recentDate.toISOString(),
        }),
      );
      await module1.flush();
      await module1.close();

      // Second instance: startup should trigger retention cleanup
      const module2 = createModelCallLogger({
        logging: logger,
        dataDirectory: directory,
      });
      await module2.start();

      // Query for the old record's time range — it should be gone
      const oldRangeResult = await module2.queryUsage({
        splitBy: 'none',
        from: new Date(oldDate.getTime() - 86_400_000).toISOString(),
        to: new Date(oldDate.getTime() + 86_400_000).toISOString(),
        granularity: 'event',
        limit: 1000,
      });
      expect(oldRangeResult).toHaveLength(0);

      // The recent record should still be present
      const recentResult = await module2.queryUsage({
        splitBy: 'none',
        from: new Date(recentDate.getTime() - 86_400_000).toISOString(),
        to: new Date(recentDate.getTime() + 86_400_000).toISOString(),
        granularity: 'event',
        limit: 1000,
      });
      expect(recentResult).toHaveLength(1);
      expect(recentResult[0]!.inputTokens).toBe(888);

      await module2.close();
    });
  });
});
