import type { DrainInboxResult } from '../inbox';

/**
 * Builds the standard set of span attributes for an inbox drain event.
 * Used by the Turn module to avoid attribute duplication.
 */
export function inboxDrainAttributes(result: DrainInboxResult, label: string) {
  return {
    'inbox.drainPoint': label,
    'inbox.total': result.total,
    'inbox.deferredEvents': result.deferredEvents,
    'inbox.nativeMessages': result.nativeMessages,
    'inbox.before.events': result.before.events,
    'inbox.before.messages': result.before.messages,
    'inbox.remaining.events': result.remaining.events,
    'inbox.remaining.messages': result.remaining.messages,
  };
}
