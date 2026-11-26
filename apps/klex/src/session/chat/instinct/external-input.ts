import { field, joinDataBlocks } from '@/session/chat/utils/history-view';

export const TRUNCATED_MARKER = '[truncated]';

/**
 * Truncates to at most `maxCharacters`, ending with a visible marker when
 * content was cut. A non-positive limit keeps nothing.
 */
export function truncateWithMarker(
  content: string,
  maxCharacters: number,
): string {
  if (maxCharacters <= 0) return '';
  if (content.length <= maxCharacters) return content;
  const suffix = `\n${TRUNCATED_MARKER}`;
  if (maxCharacters <= suffix.length) {
    return TRUNCATED_MARKER.slice(0, maxCharacters);
  }
  return `${content.slice(0, maxCharacters - suffix.length)}${suffix}`;
}

/** Instinct evidence only: no question instructions may come from these blocks. */
export function frameInstinctEvidence(
  activity: string,
  states: readonly { extension: string; content: string }[],
): string {
  return joinDataBlocks([
    ...states.map(({ extension, content }) => ({
      type: 'state',
      fields: [field('extension', extension), field('content', content)],
    })),
    { type: 'agent-activity', fields: [field('history', activity, 'bot')] },
  ]);
}
