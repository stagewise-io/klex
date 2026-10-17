export const TRUNCATED_MARKER = '[truncated]';

// Any spelling of an opening or closing external-input tag, including
// whitespace and case variants a model would still read as the tag.
const FRAMING_TAG =
  /<(\s*\/?\s*(?:external-input|agent-activity|state|question|policy|extension)\b)/gi;

/**
 * Neutralises framing/declaration tag lookalikes by replacing their opening
 * angle bracket with a fullwidth counterpart. Evidence cannot close its wrapper
 * or introduce a fake policy/question. Other text is left untouched.
 */
export function escapeExternalContent(content: string): string {
  return content.replace(FRAMING_TAG, '\uFF1C$1');
}

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

export function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Instinct evidence only: no question instructions may come from these blocks. */
export function frameInstinctEvidence(
  activity: string,
  states: readonly { extension: string; content: string }[],
): string {
  return [
    ...states.map(
      ({ extension, content }) =>
        `<state extension="${escapeAttribute(extension)}">\n${escapeExternalContent(content)}\n</state>`,
    ),
    `<agent-activity>\n${escapeExternalContent(activity)}\n</agent-activity>`,
  ].join('\n');
}
