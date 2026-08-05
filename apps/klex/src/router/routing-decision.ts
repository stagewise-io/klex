import { generateObject } from 'ai';
import z from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelId } from '@/config';
import type { ModelProvider } from '@/model-provider';
import type { ContextMetadataValue } from '@/session/inbox';

import SYSTEM_PROMPT from './routing-system-prompt.md';

const routingDecisionSchema = z.object({
  sessionId: z
    .string()
    .describe('Session ID to route to. Empty = new session.'),
  priority: z.enum(['low', 'medium', 'high']),
});

type RoutingDecision = z.infer<typeof routingDecisionSchema>;

/**
 * A single recorded event in a session's event log.
 * The router appends one of these for every event it dispatches.
 */
export interface EventLogEntry {
  sourceEnv: string;
  metadata: Record<string, ContextMetadataValue>;
  /** ISO timestamp of when the router received the event. */
  receivedAt: string;
}

/**
 * Static analysis of a session's event log, computed without an LLM.
 * Provides structural patterns the routing LLM uses for matching.
 */
export interface EventPatterns {
  /** Total number of events routed to this session. */
  eventCount: number;
  /** Distinct source environments that produced events. */
  sourceEnvs: string[];
  /**
   * For each metadata key (flattened with dot notation for nested objects),
   * a map of observed values to their occurrence count.
   * Capped at top 20 values per key to bound payload size.
   */
  metadataFrequency: Record<string, Record<string, number>>;
}

interface SessionRoutingInfo {
  shortId: string;
  status: string;
  runtimeState: string;
  eventPatterns: EventPatterns;
  /**
   * Free-text activity summary maintained by extensions. `null` when no
   * extension has set it. The LLM uses this to match incoming events
   * against what the session has been doing.
   */
  activitySummary: string | null;
}

interface RoutingDecisionParams {
  logger: ModuleLogger;
  modelProvider: ModelProvider;
  routingModels: readonly ModelId[];
  sessions: SessionRoutingInfo[];
  eventMetadata: Record<string, ContextMetadataValue>;
  sourceEnv: string;
  contentPreview: string;
  /**
   * When provided, the LLM should use this priority instead of
   * deciding its own. The router still calls the LLM for session
   * selection, but ignores the LLM's priority field.
   */
  presetPriority?: string;
}

export type { RoutingDecision, RoutingDecisionParams, SessionRoutingInfo };

/**
 * Flattens a metadata object into dot-notation key-value string pairs.
 * Nested objects are flattened (e.g. `{ a: { b: 1 } }` → `{ 'a.b': '1' }`).
 * Arrays and other non-object values are stringified as-is.
 * `null` and `undefined` values are skipped.
 */
function flattenMetadata(
  metadata: Record<string, ContextMetadataValue>,
  prefix = '',
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenMetadata(value, fullKey));
    } else {
      result[fullKey] = Array.isArray(value)
        ? JSON.stringify(value)
        : String(value);
    }
  }
  return result;
}

/**
 * Analyzes a session's event log and produces static patterns
 * that the routing LLM can use for structural matching.
 *
 * This is a pure function with no LLM calls — it computes
 * frequency counts of metadata values across all events.
 */
export function analyzeEventPatterns(eventLog: EventLogEntry[]): EventPatterns {
  const sourceEnvSet = new Set<string>();
  const metadataFreq: Record<string, Record<string, number>> = {};

  for (const entry of eventLog) {
    sourceEnvSet.add(entry.sourceEnv);

    const flat = flattenMetadata(entry.metadata);
    for (const [key, valueStr] of Object.entries(flat)) {
      if (!metadataFreq[key]) metadataFreq[key] = {};
      metadataFreq[key][valueStr] = (metadataFreq[key][valueStr] ?? 0) + 1;
    }
  }

  return {
    eventCount: eventLog.length,
    sourceEnvs: [...sourceEnvSet],
    metadataFrequency: metadataFreq,
  };
}

/** Max values per metadata key in the LLM payload. */
const MAX_FREQ_VALUES = 20;

/**
 * Builds a compact session object for the LLM prompt.
 * Omits default/null/empty fields and uses short key names to minimize tokens.
 */
function buildCompactSession(s: SessionRoutingInfo): Record<string, unknown> {
  const obj: Record<string, unknown> = { id: s.shortId };

  const { eventCount, sourceEnvs, metadataFrequency } = s.eventPatterns;
  if (eventCount > 0) obj.n = eventCount;
  if (sourceEnvs.length > 0) obj.envs = sourceEnvs;

  const freq: Record<string, Record<string, number>> = {};
  for (const [key, values] of Object.entries(metadataFrequency)) {
    const entries = Object.entries(values);
    if (entries.length === 0) continue;
    // Keep only the top MAX_FREQ_VALUES by count to bound payload size.
    const sorted = entries
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_FREQ_VALUES);
    freq[key] = Object.fromEntries(sorted);
  }
  if (Object.keys(freq).length > 0) obj.freq = freq;

  if (s.activitySummary) obj.act = s.activitySummary;

  // Include status/runtimeState only when non-default.
  if (s.status !== 'active') obj.status = s.status;
  if (s.runtimeState !== 'idle') obj.state = s.runtimeState;

  return obj;
}

export async function callRoutingLlm(
  params: RoutingDecisionParams,
): Promise<RoutingDecision | null> {
  const {
    logger,
    modelProvider,
    routingModels,
    sessions,
    eventMetadata,
    sourceEnv,
    contentPreview,
    presetPriority,
  } = params;

  if (routingModels.length === 0) {
    return null;
  }

  const prompt = JSON.stringify({
    sessions: sessions.map(buildCompactSession),
    event: {
      sourceEnv,
      metadata: eventMetadata,
      preview: contentPreview,
      ...(presetPriority ? { presetPriority } : {}),
    },
  });

  for (const modelId of routingModels) {
    try {
      const model = await modelProvider.get(modelId);
      const result = await generateObject({
        model,
        schema: routingDecisionSchema,
        system: SYSTEM_PROMPT,
        prompt,
        telemetry: {
          isEnabled: true,
          functionId: 'router',
        },
      });

      return result.object;
    } catch (error) {
      logger.warn({ error, modelId }, 'Routing LLM model failed — trying next');
    }
  }

  logger.warn('All routing models failed — falling back to default routing');
  return null;
}
