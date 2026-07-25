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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- tests ---

describe('ModelFallbackManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getChatModelId — default state', () => {
    it('returns the first model when no fallback has occurred', () => {
      const mgr = makeManager();
      expect(mgr.getChatModelId()).toBe('provider:default');
    });

    it('throws when no chat models are configured', () => {
      const mgr = makeManager(1000, undefined, []);
      expect(() => mgr.getChatModelId()).toThrow('No chat models configured');
    });
  });

  describe('fallbackToNextModel', () => {
    it('advances to the next model', () => {
      const mgr = makeManager();
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelId()).toBe('provider:fallback-a');
    });

    it('wraps around to the default model when reaching the end', () => {
      const mgr = makeManager();
      mgr.fallbackToNextModel(); // → fallback-a
      mgr.fallbackToNextModel(); // → fallback-b
      mgr.fallbackToNextModel(); // wraps to index 0 → default
      expect(mgr.getFallbackIndex()).toBe(0);
    });

    it('throws when no chat models are configured', () => {
      const mgr = makeManager(1000, undefined, []);
      expect(() => mgr.fallbackToNextModel()).toThrow(
        'No chat models configured',
      );
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
    it('resets to default model after cooldown expires', async () => {
      const mgr = makeManager(50);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelId()).toBe('provider:fallback-a');
      expect(mgr.getFallbackIndex()).toBe(1);

      await sleep(60);

      expect(mgr.getChatModelId()).toBe('provider:default');
      expect(mgr.getFallbackIndex()).toBe(0);
    });

    it('does NOT reset if cooldown has not expired', () => {
      const mgr = makeManager(60_000);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelId()).toBe('provider:fallback-a');
      expect(mgr.getFallbackIndex()).toBe(1);
    });

    it('logs debug when cooldown expires and resets', async () => {
      const mgr = makeManager(50, testLogger);
      mgr.fallbackToNextModel();

      await sleep(60);
      mgr.getChatModelId();

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
    it('is a no-op when on the default model (index 0)', () => {
      const mgr = makeManager(50);
      mgr.recordSuccessfulGeneration();
      expect(mgr.getFallbackIndex()).toBe(0);
      expect(mgr.getChatModelId()).toBe('provider:default');
    });

    it('refreshes the cooldown timer when on a fallback model', async () => {
      const mgr = makeManager(80);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelId()).toBe('provider:fallback-a');

      // Wait past the original cooldown window (80ms from fallback)
      await sleep(30);

      // Record success — refreshes the timer to now + 80ms
      mgr.recordSuccessfulGeneration();

      // Wait past the original expiry but within the refreshed window
      await sleep(60);

      // Should still be on fallback because success refreshed the timer
      expect(mgr.getChatModelId()).toBe('provider:fallback-a');

      // Now wait for the refreshed cooldown to expire
      await sleep(90);
      expect(mgr.getChatModelId()).toBe('provider:default');
    });

    it('keeps the session on fallback across multiple successful generations', async () => {
      const mgr = makeManager(100);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelId()).toBe('provider:fallback-a');

      // First success refreshes timer
      mgr.recordSuccessfulGeneration();
      await sleep(50);

      // Second success refreshes timer again
      mgr.recordSuccessfulGeneration();
      await sleep(50);

      // Should still be on fallback — both refreshes kept it alive
      expect(mgr.getChatModelId()).toBe('provider:fallback-a');
      expect(mgr.getFallbackIndex()).toBe(1);
    });
  });

  describe('multiple fallbacks', () => {
    it('can fall back multiple times in sequence', () => {
      const mgr = makeManager(60_000);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelId()).toBe('provider:fallback-a');
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelId()).toBe('provider:fallback-b');
    });

    it('refreshes cooldown on each subsequent fallback', async () => {
      const mgr = makeManager(80);
      mgr.fallbackToNextModel();
      await sleep(30);
      mgr.fallbackToNextModel();
      expect(mgr.getChatModelId()).toBe('provider:fallback-b');

      // Should still be on fallback-b (cooldown was refreshed by 2nd fallback)
      await sleep(50);
      expect(mgr.getChatModelId()).toBe('provider:fallback-b');

      // Now wait for the refreshed cooldown to expire
      await sleep(90);
      expect(mgr.getChatModelId()).toBe('provider:default');
    });
  });
});
