import { beforeEach, describe, expect, it } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import { makeTestSpan, testLogger } from '../test-helpers';
import { BackoffManager } from './backoff-manager';

function makeManager(
  options?: {
    immediateRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  },
  logger: ModuleLogger = testLogger,
): BackoffManager {
  return new BackoffManager(
    {
      logger,
      span: makeTestSpan(),
      sessionId: 'test-session',
    },
    options,
  );
}

// --- tests ---

describe('BackoffManager', () => {
  let manager: BackoffManager;

  beforeEach(() => {
    manager = makeManager({
      immediateRetries: 0,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
    });
  });

  describe('getConsecutiveFailures', () => {
    it('starts at 0', () => {
      expect(manager.getConsecutiveFailures()).toBe(0);
    });

    it('increments after recordFailure', () => {
      manager.recordFailure();
      expect(manager.getConsecutiveFailures()).toBe(1);
      manager.recordFailure();
      expect(manager.getConsecutiveFailures()).toBe(2);
    });

    it('resets to 0 after recordSuccess', () => {
      manager.recordFailure();
      manager.recordFailure();
      manager.recordSuccess();
      expect(manager.getConsecutiveFailures()).toBe(0);
    });
  });

  describe('getDelay', () => {
    it('returns base delay on the first failure (no immediate retries)', () => {
      manager.recordFailure();
      expect(manager.getDelay()).toBe(100);
    });

    it('doubles the delay after each subsequent failure', () => {
      manager.recordFailure(); // 1st → 100 (2^0)
      expect(manager.getDelay()).toBe(100);
      manager.recordFailure(); // 2nd → 200 (2^1)
      expect(manager.getDelay()).toBe(200);
      manager.recordFailure(); // 3rd → 400 (2^2)
      expect(manager.getDelay()).toBe(400);
      manager.recordFailure(); // 4th → 800 (2^3)
      expect(manager.getDelay()).toBe(800);
    });

    it('caps at maxDelayMs', () => {
      for (let i = 0; i < 10; i++) {
        manager.recordFailure();
      }
      expect(manager.getDelay()).toBe(1_000);
    });

    it('resets to 0 after success', () => {
      for (let i = 0; i < 5; i++) {
        manager.recordFailure();
      }
      expect(manager.getDelay()).toBeGreaterThan(0);
      manager.recordSuccess();
      expect(manager.getDelay()).toBe(0);
    });

    it('returns 0 when immediateRetries is configured', () => {
      const mgr = makeManager({
        immediateRetries: 2,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
      });
      expect(mgr.getDelay()).toBe(0);
      mgr.recordFailure();
      expect(mgr.getDelay()).toBe(0);
      mgr.recordFailure();
      expect(mgr.getDelay()).toBe(0);
      // 2 failures — still within immediate budget (consecutiveFailures <= 2)
      mgr.recordFailure();
      // 3rd failure — enters exponential mode
      expect(mgr.getDelay()).toBe(100);
    });
  });

  describe('recordSuccess', () => {
    it('does not emit a reset event when there were no failures', () => {
      const span = makeTestSpan();
      const mgr = new BackoffManager(
        {
          logger: testLogger,
          span,
          sessionId: 'test-session',
        },
        { immediateRetries: 0, baseDelayMs: 100, maxDelayMs: 1_000 },
      );
      mgr.recordSuccess();
      expect(span.addEvent).not.toHaveBeenCalled();
    });

    it('emits a reset event when there were failures', () => {
      const span = makeTestSpan();
      const mgr = new BackoffManager(
        {
          logger: testLogger,
          span,
          sessionId: 'test-session',
        },
        { immediateRetries: 0, baseDelayMs: 100, maxDelayMs: 1_000 },
      );
      mgr.recordFailure();
      mgr.recordFailure();
      mgr.recordSuccess();
      expect(span.addEvent).toHaveBeenCalledWith(
        'session.backoff_reset',
        expect.objectContaining({ 'session.previousFailures': 2 }),
      );
    });
  });

  describe('recordFailure', () => {
    it('emits a failure event with the current count', () => {
      const span = makeTestSpan();
      const mgr = new BackoffManager(
        {
          logger: testLogger,
          span,
          sessionId: 'test-session',
        },
        { immediateRetries: 0, baseDelayMs: 100, maxDelayMs: 1_000 },
      );
      mgr.recordFailure();
      expect(span.addEvent).toHaveBeenCalledWith(
        'session.backoff_failure',
        expect.objectContaining({ 'session.consecutiveFailures': 1 }),
      );
    });
  });
});
