import { generateObject } from 'ai';
import z from 'zod';

import type { ModuleLogger } from '@stagewise/logger';

import type { ModelSelectionEntry } from '@/config';
import type { ProviderModelResolver } from '@/provider-registry';
import type { ContextMetadataValue, SessionInboxEvent } from '@/session/inbox';
import { SessionInboxUrgency } from '@/session/inbox';

import SYSTEM_PROMPT from './routing-system-prompt.md';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A routing rule bound to a session. The `match` field is a set of
 * flattened metadata key-value pairs. An incoming event matches this rule
 * when every pair in `match` is present in the event's flattened metadata
 * with a matching value.
 */
export type RoutingRule = Record<string, string>;

/**
 * Read-only view of a session that the routing LLM can inspect.
 * Terminated sessions are filtered before building this list.
 */
interface SessionRoutingInfo {
  shortId: string;
  runtimeState: string;
  /**
   * Free-text activity summary maintained by extensions. `null` when no
   * extension has set it. The LLM uses this to match generic events
   * against what the session has been doing.
   */
  activitySummary: string | null;
}

const routingDecisionSchema = z.object({
  decision: z.enum(['new_conversation', 'existing_session']),
  sessionId: z
    .string()
    .describe('Session shortId to route to. Empty when new_conversation.'),
  routingRule: z
    .record(z.string(), z.string())
    .describe(
      'Metadata key-value pairs that identify this conversation. ' +
        'Empty object when existing_session.',
    ),
  priority: z.enum(['low', 'medium', 'high']),
});

type RoutingDecision = z.infer<typeof routingDecisionSchema>;

interface RoutingDecisionParams {
  logger: ModuleLogger;
  modelProvider: ProviderModelResolver;
  routingModels: readonly ModelSelectionEntry[];
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

// ---------------------------------------------------------------------------
// Metadata flattening
// ---------------------------------------------------------------------------

/**
 * Flattens a metadata object into dot-notation key-value string pairs.
 * Nested objects are flattened (e.g. `{ a: { b: 1 } }` → `{ 'a.b': '1' }`).
 * Arrays and other non-object values are stringified as-is.
 * `null` and `undefined` values are skipped.
 */
export function flattenMetadata(
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

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

/**
 * Checks whether an incoming event satisfies a routing rule.
 *
 * Flattens the event's metadata into dot-notation, then verifies that
 * every key-value pair in `rule` is present in the flattened metadata
 * with a matching value.
 */
export function matchesRule(
  event: SessionInboxEvent,
  rule: RoutingRule,
): boolean {
  const flat = flattenMetadata(event.context.metadata);
  return Object.entries(rule).every(([key, value]) => flat[key] === value);
}

/**
 * Compares two routing rules for equality (same keys, same values).
 * Used to dedup: when the LLM returns a `new_conversation` decision whose
 * rule already matches an existing session, route to that session instead
 * of creating a duplicate.
 */
export function sameMatch(a: RoutingRule, b: RoutingRule): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return (
    ak.length === bk.length && ak.every((k, i) => k === bk[i] && a[k] === b[k])
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Max characters for activitySummary in the prompt. */
const MAX_ACT_LENGTH = 200;
/** Max flattened keys for the incoming event's metadata. */
const MAX_EVENT_METADATA_KEYS = 20;

/**
 * Builds a compact session object for the LLM prompt.
 * Omits default/null/empty fields and uses short key names to minimize tokens.
 */
function buildCompactSession(s: SessionRoutingInfo): Record<string, unknown> {
  const obj: Record<string, unknown> = { id: s.shortId };

  if (s.activitySummary) obj.act = s.activitySummary.slice(0, MAX_ACT_LENGTH);

  // status is always 'active' here (terminated sessions are filtered
  // before building the list), so only runtimeState carries signal.
  if (s.runtimeState !== 'idle') obj.state = s.runtimeState;

  return obj;
}

/**
 * Builds a short text preview of an event's content blocks for the LLM prompt.
 */
export function buildContentPreview(
  content: SessionInboxEvent['context']['content'],
): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(
        block.text.length > 32 ? `${block.text.slice(0, 32)}…` : block.text,
      );
    } else if (block.type === 'image') {
      parts.push('[image]');
    } else if (block.type === 'audio') {
      const bytes = Math.floor((block.data.length * 3) / 4);
      const seconds = Math.max(1, Math.round(bytes / 16000));
      parts.push(`[audio: ${seconds}sec]`);
    } else if (block.type === 'resource_link') {
      parts.push(`[resource_link: ${block.name}]`);
    } else if (block.type === 'resource') {
      parts.push(`[resource: ${block.resource.uri}]`);
    }
  }
  return parts.join(' ');
}

/** Maps an LLM priority string to a `SessionInboxUrgency` value. */
export function mapPriority(p: 'low' | 'medium' | 'high'): SessionInboxUrgency {
  return p === 'high'
    ? SessionInboxUrgency.Critical
    : p === 'low'
      ? SessionInboxUrgency.Deferrable
      : SessionInboxUrgency.Default;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

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

  // Flatten and cap the incoming event's metadata so it uses the same
  // dot-notation as the prompt and is bounded.
  const flatEventMeta = flattenMetadata(eventMetadata);
  const cappedEventMeta = Object.fromEntries(
    Object.entries(flatEventMeta).slice(0, MAX_EVENT_METADATA_KEYS),
  );

  const prompt = JSON.stringify({
    sessions: sessions.map(buildCompactSession),
    event: {
      sourceEnv,
      metadata: cappedEventMeta,
      preview: contentPreview,
      ...(presetPriority ? { presetPriority } : {}),
    },
  });

  for (const entry of routingModels) {
    try {
      const model = modelProvider.getLanguageModel(entry);
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
      logger.warn(
        { error, modelId: entry.modelId },
        'Routing LLM model failed — trying next',
      );
    }
  }

  logger.warn('All routing models failed — falling back to default routing');
  return null;
}
