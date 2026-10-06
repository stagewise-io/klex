export const MAX_SENDER_NAME_CODE_POINTS = 256;
export const SENDER_HEADER_SEPARATOR = '\n\n';
export const SENDER_HEADER_MARKER = Object.freeze({
  type: 'stagewise.sender-header',
  version: 1,
} as const);

export function normalizeSenderName(value: unknown): string {
  if (typeof value !== 'string') return 'Unknown sender';
  const sanitized = value
    .replace(/\r\n|[\r\n\u2028\u2029]/gu, ' ')
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, '')
    .trim();
  const normalized = [...sanitized]
    .slice(0, MAX_SENDER_NAME_CODE_POINTS)
    .join('')
    .trim();
  return /^[\p{Cf}\s]*$/u.test(normalized) ? 'Unknown sender' : normalized;
}

export function hasTrustedSenderHeader(
  text: string,
  senderName: unknown,
  marker: unknown,
): boolean {
  if (
    typeof senderName !== 'string' ||
    normalizeSenderName(senderName) !== senderName ||
    typeof marker !== 'object' ||
    marker === null ||
    Reflect.ownKeys(marker).length !== 2 ||
    Object.getOwnPropertyDescriptor(marker, 'type')?.value !==
      SENDER_HEADER_MARKER.type ||
    Object.getOwnPropertyDescriptor(marker, 'version')?.value !==
      SENDER_HEADER_MARKER.version
  )
    return false;

  const senderLine = `From: ${senderName}`;
  return (
    text === senderLine ||
    text.startsWith(`${senderLine}${SENDER_HEADER_SEPARATOR}`)
  );
}
