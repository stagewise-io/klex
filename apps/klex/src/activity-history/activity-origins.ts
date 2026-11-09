import type { ExtendedUIMessage } from '@/session/chat/message-types';

/** An environment whose input an activity batch handled. */
export interface ActivityOrigin {
  /** MCP namespace that delivered the input (`sourceEnv`). */
  env: string;
  /** Push Notification `sourceId`, e.g. `chat:<conversationId>`. */
  sourceId: string | null;
}

/**
 * Collects the origins of the `data-context` inputs in `messages`,
 * deduplicated in order of first appearance. Batches without environment
 * input, such as scheduled or internal work, yield an empty list.
 */
export function collectActivityOrigins(
  messages: readonly (ExtendedUIMessage | null)[],
): ActivityOrigin[] {
  const origins: ActivityOrigin[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const part of message?.parts ?? []) {
      if (part.type !== 'data-context') continue;
      // Persisted history is not revalidated; tolerate malformed parts.
      const data: unknown = part.data;
      if (typeof data !== 'object' || data === null) continue;
      const env = 'sourceEnv' in data ? data.sourceEnv : undefined;
      if (typeof env !== 'string' || env === '') continue;
      const metadata = 'metadata' in data ? data.metadata : undefined;
      const rawSourceId =
        typeof metadata === 'object' && metadata !== null
          ? (metadata as Record<string, unknown>).sourceId
          : undefined;
      const sourceId =
        typeof rawSourceId === 'string' && rawSourceId !== ''
          ? rawSourceId
          : null;
      const key = JSON.stringify([env, sourceId]);
      if (seen.has(key)) continue;
      seen.add(key);
      origins.push({ env, sourceId });
    }
  }
  return origins;
}
