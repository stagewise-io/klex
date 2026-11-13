import type { ModelCapabilities } from '@/config';
import type { EffortIntent } from '@/provider-registry';

/** No-progress budgets for one streamed generation attempt. */
export interface StreamDeadlines {
  /** From the request start (including the header wait) to the first usable output. */
  firstOutputMs: number;
  /** Longest gap between usable outputs after the first one. */
  idleMs: number;
}

/**
 * Models that may reason without streaming it (hidden reasoning, Gemini
 * thinking without thought summaries) produce no usable output while they
 * think, so they get the longer budgets.
 */
const REASONING_DEADLINES: StreamDeadlines = {
  firstOutputMs: 180_000,
  idleMs: 120_000,
};
const NON_REASONING_DEADLINES: StreamDeadlines = {
  firstOutputMs: 60_000,
  idleMs: 60_000,
};

const EFFORT_SCALE: Record<EffortIntent, number> = {
  off: 1,
  low: 0.75,
  medium: 1,
  'provider-default': 1,
  high: 1.5,
  exceptional: 2,
};

/** Local servers load the model before they respond. */
const FIRST_OUTPUT_SCALE_BY_PROVIDER: Partial<Record<string, number>> = {
  ollama: 2,
};

export function resolveStreamDeadlines(input: {
  providerType: string;
  capabilities?: ModelCapabilities;
  /** Effort applied to this request, if any. */
  effort?: EffortIntent;
}): StreamDeadlines {
  const reasons =
    input.capabilities?.reasoning !== false && input.effort !== 'off';
  const base = reasons ? REASONING_DEADLINES : NON_REASONING_DEADLINES;
  const effortScale = reasons ? EFFORT_SCALE[input.effort ?? 'medium'] : 1;
  const providerScale = FIRST_OUTPUT_SCALE_BY_PROVIDER[input.providerType] ?? 1;
  return {
    firstOutputMs: Math.round(base.firstOutputMs * effortScale * providerScale),
    idleMs: Math.round(base.idleMs * effortScale),
  };
}
