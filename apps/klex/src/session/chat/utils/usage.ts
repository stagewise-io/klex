import type { LanguageModelUsage } from 'ai';

import type { Usage } from '@/session/types';

/**
 * Extracts the four usage fields the session tracks from a raw
 * `LanguageModelUsage` object returned by the AI SDK.
 *
 * Cache token details are nested under `inputTokenDetails` and may be
 * absent when the provider does not report them — they default to 0.
 */
export function extractUsage(
  usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'> &
    Partial<Pick<LanguageModelUsage, 'inputTokenDetails'>>,
): Usage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    inputCacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    inputCacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}
