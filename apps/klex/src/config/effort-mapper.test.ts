import { describe, expect, it } from 'vitest';

import { effortToProviderOptions } from './effort-mapper';
import type { ApiFormat } from './types';

describe('effortToProviderOptions', () => {
  describe('openai format', () => {
    it('maps low effort', () => {
      expect(effortToProviderOptions('low', 'openai')).toEqual({
        openai: { reasoningEffort: 'low' },
      });
    });

    it('maps medium effort', () => {
      expect(effortToProviderOptions('medium', 'openai')).toEqual({
        openai: { reasoningEffort: 'medium' },
      });
    });

    it('maps high effort', () => {
      expect(effortToProviderOptions('high', 'openai')).toEqual({
        openai: { reasoningEffort: 'high' },
      });
    });
  });

  describe('open-responses format', () => {
    it('uses the same openai key as the openai format', () => {
      expect(effortToProviderOptions('high', 'open-responses')).toEqual({
        openai: { reasoningEffort: 'high' },
      });
    });
  });

  describe('anthropic format', () => {
    it('maps low effort with thinking enabled and small budget', () => {
      expect(effortToProviderOptions('low', 'anthropic')).toEqual({
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: 4_000 },
        },
      });
    });

    it('maps medium effort with medium budget', () => {
      expect(effortToProviderOptions('medium', 'anthropic')).toEqual({
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: 10_000 },
        },
      });
    });

    it('maps high effort with large budget', () => {
      expect(effortToProviderOptions('high', 'anthropic')).toEqual({
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: 32_000 },
        },
      });
    });
  });

  describe('messages format', () => {
    it('uses the same anthropic key as the anthropic format', () => {
      expect(effortToProviderOptions('low', 'messages')).toEqual({
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: 4_000 },
        },
      });
    });
  });

  describe('google format', () => {
    it('maps low effort with zero thinking budget', () => {
      expect(effortToProviderOptions('low', 'google')).toEqual({
        google: { thinkingConfig: { thinkingBudget: 0 } },
      });
    });

    it('maps medium effort', () => {
      expect(effortToProviderOptions('medium', 'google')).toEqual({
        google: { thinkingConfig: { thinkingBudget: 8_192 } },
      });
    });

    it('maps high effort', () => {
      expect(effortToProviderOptions('high', 'google')).toEqual({
        google: { thinkingConfig: { thinkingBudget: 24_576 } },
      });
    });
  });

  describe('chat-completions format', () => {
    it('returns undefined — no standardized effort mapping', () => {
      expect(
        effortToProviderOptions('high', 'chat-completions'),
      ).toBeUndefined();
    });
  });

  describe('dynamic effort', () => {
    const formats: ApiFormat[] = [
      'openai',
      'anthropic',
      'google',
      'open-responses',
      'messages',
    ];

    for (const format of formats) {
      it(`maps dynamic to medium for ${format}`, () => {
        const dynamicResult = effortToProviderOptions('dynamic', format);
        const mediumResult = effortToProviderOptions('medium', format);
        expect(dynamicResult).toEqual(mediumResult);
      });
    }

    it('returns undefined for chat-completions (same as any effort)', () => {
      expect(
        effortToProviderOptions('dynamic', 'chat-completions'),
      ).toBeUndefined();
    });
  });
});
