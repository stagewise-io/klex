import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';

import { makeTestSpan, testLogger } from '../test-helpers';
import { ModelFallbackManager } from './model-fallback-manager';

const CHAT_MODELS: readonly `${string}:${string}`[] = [
  'provider:default',
  'provider:fallback-a',
  'provider:fallback-b',
];

function makeManager(
  cooldownMs = 1000,
  logger: ModuleLogger = testLogger,
  chatModels: readonly ModelId[] = CHAT_MODELS,
): ModelFallbackManager {
  return new ModelFallbackManager(
    {
      logger,
      span: makeTestSpan(),
      sessionId: 'test-session',
      getChatModels: () => chatModels,
    },
    cooldownMs,
  );
}

// --- tests ---

describe('ModelFallbackManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('getChatModelEntry — default state', () => {
    it('returns the first model when no fallback has occurred', () => {
      const mgr = makeManager();
      expect(mgr.getChatModelEntry()).toBe('provider:default');
    });

    it('returns undefined when no chat models are configured', () => {
      const mgr = makeManager(1000, undefined, []);
      expect(mgr.getChatModelEntry()).toBeUndefined();
    });
  });

  describe('fallbackToNextModel', () => {
    it('advances to the next model', () => {
      const mgr = makeManager();
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-a');
    });

    it('wraps around to the default model when reaching the end', () => {
      const mgr = makeManager();
      mgr.fallbackToNextModel(); // → fallback-a
      mgr.fallbackToNextModel(); // → fallback-b
      mgr.fallbackToNextModel(); // wraps to index 0 → default
      expect(mgr.getFallbackIndex()).toBe(0);
    });

    it('returns undefined when no chat models are configured', () => {
      const mgr = makeManager(1000, undefined, []);
      expect(mgr.fallbackToNextModel()).toBeUndefined();
    });

    it('records a span event on fallback', () => {
      const span = makeTestSpan();
      const mgr = new ModelFallbackManager(
        {
          logger: testLogger,
          span,
          sessionId: 'test-session',
          getChatModels: () => CHAT_MODELS,
        },
        1000,
      );
      mgr.fallbackToNextModel();
      expect(span.addEvent).toHaveBeenCalledWith(
        'session.model_fallback',
        expect.objectContaining({
          'session.modelFallbackIndex': 1,
        }),
      );
    });
  });

  describe('getFallbackIndex', () => {
    it('returns 0 before any fallback', () => {
      const mgr = makeManager();
      expect(mgr.getFallbackIndex()).toBe(0);
    });

    it('returns the current index after fallback', () => {
      const mgr = makeManager();
      mgr.fallbackToNextModel();
      expect(mgr.getFallbackIndex()).toBe(1);
    });
  });

  describe('cooldown expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('resets to default model after cooldown expires', () => {
      const mgr = makeManager(50);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-a');
      expect(mgr.getFallbackIndex()).toBe(1);

      vi.advanceTimersByTime(60);

      expect(mgr.getChatModelEntry()).toBe('provider:default');
      expect(mgr.getFallbackIndex()).toBe(0);
    });

    it('does NOT reset if cooldown has not expired', () => {
      const mgr = makeManager(60_000);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-a');
      expect(mgr.getFallbackIndex()).toBe(1);
    });

    it('logs debug when cooldown expires and resets', () => {
      const mgr = makeManager(50, testLogger);
      mgr.fallbackToNextModel();

      vi.advanceTimersByTime(60);
      mgr.getChatModelEntry();

      expect(testLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session',
          previousIndex: 1,
        }),
        'Fallback cooldown expired — resetting to default model',
      );
    });
  });

  describe('recordSuccessfulGeneration', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('is a no-op when on the default model (index 0)', () => {
      const mgr = makeManager(50);
      mgr.recordSuccessfulGeneration();
      expect(mgr.getFallbackIndex()).toBe(0);
      expect(mgr.getChatModelEntry()).toBe('provider:default');
    });

    it('refreshes the cooldown timer when on a fallback model', () => {
      const mgr = makeManager(80);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-a');

      // Advance past the original cooldown window (80ms from fallback)
      vi.advanceTimersByTime(30);

      // Record success — refreshes the timer to now + 80ms
      mgr.recordSuccessfulGeneration();

      // Advance past the original expiry but within the refreshed window
      vi.advanceTimersByTime(60);

      // Should still be on fallback because success refreshed the timer
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-a');

      // Now advance past the refreshed cooldown to expire
      vi.advanceTimersByTime(90);
      expect(mgr.getChatModelEntry()).toBe('provider:default');
    });

    it('keeps the session on fallback across multiple successful generations', () => {
      const mgr = makeManager(100);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-a');

      // First success refreshes timer
      mgr.recordSuccessfulGeneration();
      vi.advanceTimersByTime(50);

      // Second success refreshes timer again
      mgr.recordSuccessfulGeneration();
      vi.advanceTimersByTime(50);

      // Should still be on fallback — both refreshes kept it alive
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-a');
      expect(mgr.getFallbackIndex()).toBe(1);
    });
  });

  describe('multiple fallbacks', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('can fall back multiple times in sequence', () => {
      const mgr = makeManager(60_000);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-a');
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-b');
    });

    it('refreshes cooldown on each subsequent fallback', () => {
      const mgr = makeManager(80);
      mgr.fallbackToNextModel();
      vi.advanceTimersByTime(30);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-b');

      // Should still be on fallback-b (cooldown was refreshed by 2nd fallback)
      vi.advanceTimersByTime(50);
      expect(mgr.getChatModelEntry()).toBe('provider:fallback-b');

      // Now advance past the refreshed cooldown to expire
      vi.advanceTimersByTime(90);
      expect(mgr.getChatModelEntry()).toBe('provider:default');
    });
  });
});
