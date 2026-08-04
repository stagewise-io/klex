import type { ApiFormat, EffortLevel } from './types';

const ANTHROPIC_BUDGET: Record<Exclude<EffortLevel, 'dynamic'>, number> = {
  low: 4_000,
  medium: 10_000,
  high: 32_000,
};

const GOOGLE_BUDGET: Record<Exclude<EffortLevel, 'dynamic'>, number> = {
  low: 0,
  medium: 8_192,
  high: 24_576,
};

/**
 * Maps a klex-level effort level to provider-specific options, keyed by
 * {@link ApiFormat}. Returns `undefined` for formats without a known
 * effort mapping — the raw `providerOptions` on the selection entry
 * still passes through in that case.
 *
 * `dynamic` maps to `medium` for now. Real per-call dynamic selection
 * (based on task complexity) is a follow-up — the schema stays the same.
 */
export function effortToProviderOptions(
  effort: EffortLevel,
  format: ApiFormat,
): Record<string, unknown> | undefined {
  // TODO: implement real dynamic effort selection based on task complexity.
  const resolved = effort === 'dynamic' ? 'medium' : effort;

  switch (format) {
    case 'openai':
    case 'open-responses':
      return {
        openai: { reasoningEffort: resolved },
      };

    case 'anthropic':
    case 'messages':
      return {
        anthropic: {
          thinking: {
            type: 'enabled',
            budgetTokens: ANTHROPIC_BUDGET[resolved],
          },
        },
      };

    case 'google':
      return {
        google: {
          thinkingConfig: { thinkingBudget: GOOGLE_BUDGET[resolved] },
        },
      };

    case 'chat-completions':
      // No standardized effort mapping for generic OpenAI-compatible endpoints.
      return undefined;
  }
}
