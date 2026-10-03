export const TRUNCATED_MARKER = '[truncated]';

export type ExternalInputKind = 'state' | 'recent' | 'new';

export interface ExternalInputBlock {
  /** `conversation` or `extension:{identifier}`. */
  readonly source: string;
  readonly kind: ExternalInputKind;
  readonly content: string;
}

// Any spelling of an opening or closing external-input tag, including
// whitespace and case variants a model would still read as the tag.
const FRAMING_TAG = /<(\s*\/?\s*external-input)/gi;
const ATTRIBUTE_UNSAFE = /[^A-Za-z0-9_.:/@-]/g;

/**
 * Neutralises every `<external-input` / `</external-input` sequence by
 * replacing its `<` with a fullwidth `＜`, so content can neither close its
 * own wrapper nor open a fake one. Other text is left untouched.
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

export function frameExternalInput(block: ExternalInputBlock): string {
  const source = block.source.replace(ATTRIBUTE_UNSAFE, '_');
  return [
    `<external-input source="${source}" kind="${block.kind}">`,
    escapeExternalContent(block.content),
    '</external-input>',
  ].join('\n');
}

/** Joins framed blocks in the given order, separated by blank lines. */
export function assembleExternalInput(
  blocks: readonly ExternalInputBlock[],
): string {
  return blocks.map(frameExternalInput).join('\n\n');
}
