import type { DrainInboxResult } from '../inbox';

/**
 * Builds the standard set of span attributes for an inbox drain event.
 * Used by both the Turn and Step modules to avoid attribute duplication.
 */
export function inboxDrainAttributes(
  result: DrainInboxResult,
  minPriorityLabel: string,
) {
  return {
    'inbox.minPriority': minPriorityLabel,
    'inbox.total': result.total,
    'inbox.low': result.byPriority.low,
    'inbox.medium': result.byPriority.medium,
    'inbox.high': result.byPriority.high,
    'inbox.nativeMessages': result.nativeMessages,
    'inbox.before.events': result.before.events,
    'inbox.before.messages': result.before.messages,
    'inbox.remaining.events': result.remaining.events,
    'inbox.remaining.messages': result.remaining.messages,
  };
}
